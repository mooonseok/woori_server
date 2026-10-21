#!/bin/bash
# Puts one verified server release (scripts/release-image.mjs output) on both
# Lightsail hosts over SSH, in the documented order (SETUP.md "릴리스 이미지",
# "운영 migration 절차"). Run by .github/workflows/deploy.yml; works the same
# from a trusted Mac (bash 3.2, BSD tools). Each remote step is a fixed command
# of deploy/lightsail/woori-deploy.sh, the forced command of the woori-deploy
# key (its header has the host setup).
#   prepare        both hosts receive and verify the image, worker --check,
#                  read-only DB plan on the API host (prints plan_hash; 21 =
#                  pending statements need the manual procedure). Nothing on
#                  the hosts changes.
#   deploy         DB step (only the approved plan) -> API -> public check ->
#                  worker. A failed public check rolls the API back; a failed
#                  worker swap is undone on its host and the API goes back too,
#                  so both run the same commit.
#   reconcile      for `if: always()`: waits for running host jobs, recovers an
#                  interrupted one, puts the API back if the worker did not get
#                  this release, and reports both hosts
#   rollback-to <name> <release>   fast rollback to a release still loaded on
#                  both hosts (no build, no DB step)
# Settings (environment):
#   RELEASE_DIR        release.json, SHA256SUMS (and for prepare the tar.gz)
#   DEPLOY_SSH_CONFIG  from deploy/lightsail/ssh-config.sh
#   DEPLOY_PUBLIC_URL  default https://api.woori.stream (through Caddy)
#   DEPLOY_DB_APPROVAL none (default) or the API host's plan hash, given only
#                      after a person checked the Supabase backup
#   DEPLOY_EXPECT_RELEASE  optional: the commit release.json must carry
#   DEPLOY_RELEASE_NAME / DEPLOY_RELEASE / DEPLOY_OUTCOME  for reconcile
#   DEPLOY_CHECK_ATTEMPTS / DEPLOY_CHECK_INTERVAL  public check (20 x 6 s)
#   DEPLOY_RESOLVE_TIMEOUT  seconds to wait for a host job after a dropped
#                      connection (900)
# A dropped connection (ssh 255) is not a failure: the host job keeps running
# detached and its result is read back with `job`/`status` before deciding.
# Exit codes: 0 ok, 1 failed (nothing replaced, or rolled back), 2 settings,
# 3 a rollback failed (act by hand now), 4 outcome unknown (host unreachable,
# or a job vanished; reconcile/recover next), 20/21/22 DB gate (nothing
# replaced; see woori-deploy.sh).
# Prints release names and check results only (public Actions logs).
set -euo pipefail

say() { printf '[deploy] %s\n' "$*"; }
note() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >>"$GITHUB_STEP_SUMMARY"; fi; }
die() {
  printf '[deploy] 실패: %s\n' "$1" >&2
  note "- 결과: 실패 — $1"
  exit "${2:-1}"
}
output() { if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"; fi; }
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

mode=${1:-}
[ -n "${DEPLOY_SSH_CONFIG:-}" ] && [ -r "$DEPLOY_SSH_CONFIG" ] || die "DEPLOY_SSH_CONFIG 설정이 없습니다" 2
url=${DEPLOY_PUBLIC_URL:-https://api.woori.stream}
attempts=${DEPLOY_CHECK_ATTEMPTS:-20}
interval=${DEPLOY_CHECK_INTERVAL:-6}
resolve_timeout=${DEPLOY_RESOLVE_TIMEOUT:-900}
for tool in ssh jq curl; do command -v "$tool" >/dev/null 2>&1 || die "$tool 이 필요합니다" 2; done

NAME_RE='^[0-9]{8}-[0-9a-f]{7}$'
SHA_RE='^[0-9a-f]{40}$'
name='' release='' contract=- file='' sum=''

read_release() { # needs_archive
  local manifest=${RELEASE_DIR:-}/release.json image
  [ -n "${RELEASE_DIR:-}" ] && [ -r "$manifest" ] || die "release.json이 없습니다" 2
  jq -e '.schemaVersion == 1 and .deployable == true and .platform == "linux/amd64"
    and (.release | type == "string")' "$manifest" >/dev/null ||
    die "release.json이 배포 가능한 릴리스가 아닙니다 (deployable)" 2
  image=$(jq -r .image "$manifest")
  name=${image#*:}
  release=$(jq -r .release "$manifest")
  file=$(jq -r .archive.file "$manifest")
  sum=$(jq -r .archive.sha256 "$manifest")
  contract=$(jq -r '.contract // "-"' "$manifest")
  if ! [[ $name =~ $NAME_RE && $release =~ $SHA_RE &&
    $sum =~ ^[0-9a-f]{64}$ && $file =~ ^[A-Za-z0-9._-]+$ ]] ||
    ! { [ "$contract" = - ] || [[ $contract =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }; then
    die "release.json 값 형식 오류" 2
  fi
  [ -z "${DEPLOY_EXPECT_RELEASE:-}" ] || [ "$release" = "$DEPLOY_EXPECT_RELEASE" ] ||
    die "release.json 커밋이 배포 대상과 다릅니다" 2
  grep -qx "$sum  $file" "$RELEASE_DIR/SHA256SUMS" || die "SHA256SUMS가 release.json과 다릅니다" 2
  if [ "$1" = yes ]; then
    [ "$(sha256 "$RELEASE_DIR/$file")" = "$sum" ] || die "이미지 SHA256이 release.json과 다릅니다" 2
  fi
}

remote() { # host words... (read-only commands)
  local host=$1
  shift
  ssh -n -F "$DEPLOY_SSH_CONFIG" "$host" "$*"
}
value() { printf '%s\n' "$1" | awk -v key="$2=" 'index($0, key) == 1 { print substr($0, length(key) + 1); exit }'; }

# Mutating host commands run as detached jobs. Sets JOB_RC and JOB_RESULT
# (replaced, unchanged, rolledback, recovered). Codes outside the host's own
# set mean the outcome is unknown: the job is looked up and awaited instead.
JOB_RC=0 JOB_RESULT=''
remote_job() { # host command args...
  local host=$1 prior out rc id
  shift
  prior=$(value "$(remote "$host" status 2>/dev/null || true)" job)
  out=$(mktemp)
  set +e
  ssh -n -F "$DEPLOY_SSH_CONFIG" "$host" "$*" 2>&1 | tee "$out"
  rc=${PIPESTATUS[0]}
  set -e
  id=$(sed -n 's/^\[woori-deploy\] job=//p' "$out" | head -n 1)
  JOB_RESULT=$(sed -n 's/^\[woori-deploy\] result=//p' "$out" | tail -n 1)
  rm -f "$out"
  case $rc in
  0 | 1 | 2 | 3 | 20 | 21 | 22 | 75) JOB_RC=$rc ;;
  *)
    say "$host: 연결이 끊겼거나 결과를 받지 못했습니다 (코드 $rc). 호스트 작업 결과를 확인합니다"
    resolve_job "$host" "$id" "$prior" "$1"
    ;;
  esac
}

# 5 = the command never started (nothing changed), 4 = unknown.
resolve_job() { # host id prior-job command
  local host=$1 id=$2 prior=$3 command=$4 deadline=$((SECONDS + resolve_timeout)) status report state rest
  while :; do
    if status=$(remote "$host" status 2>/dev/null); then
      if [ -z "$id" ]; then
        id=$(value "$status" job)
        # Job ids are <UTC time>-<pid>-<command>.
        rest=${id#*-}
        if [ "$id" = "$prior" ] || [ "${rest#*-}" != "$command" ]; then
          if [ "$(value "$status" job_state)" != running ]; then
            say "$host: $command 작업이 시작되지 않았습니다"
            JOB_RC=5 JOB_RESULT=''
            return
          fi
          id=''
        fi
      fi
      if [ -n "$id" ] && report=$(remote "$host" job "$id" 2>/dev/null); then
        state=$(value "$report" job_state)
        if [ "$state" = finished ]; then
          JOB_RC=$(value "$report" job_rc)
          JOB_RESULT=$(printf '%s\n' "$report" | sed -n 's/^\[woori-deploy\] result=//p' | tail -n 1)
          printf '%s\n' "$report" | grep '^\[woori-deploy\]' || true
          say "$host: 작업 $id 결과 코드 $JOB_RC"
          return
        fi
        if [ "$state" = died ]; then
          say "$host: 작업 $id 가 결과 없이 끝났습니다"
          JOB_RC=4 JOB_RESULT=''
          return
        fi
      fi
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      say "$host: 작업 결과를 확인하지 못했습니다"
      JOB_RC=4 JOB_RESULT=''
      return
    fi
    sleep 5
  done
}

# Public /healthz release (+ contract) and /readyz 200, as users reach the API.
public_ok() { # release|null contract|-
  local body i
  for i in $(seq 1 "$attempts"); do
    if body=$(curl -fsS --max-time 10 "$url/healthz" 2>/dev/null) &&
      [ "$(printf '%s' "$body" | jq -r '.release // "null"')" = "$1" ] &&
      { [ "$2" = - ] || [ "$(printf '%s' "$body" | jq -r '.contract // ""')" = "$2" ]; } &&
      curl -fsS -o /dev/null --max-time 10 "$url/readyz" 2>/dev/null; then
      return 0
    fi
    [ "$i" -eq "$attempts" ] || sleep "$interval"
  done
  return 1
}

check_roles() {
  api_status=$(remote woori-api status) || die "API 호스트 상태 확인 실패 (SSH)"
  worker_status=$(remote woori-worker status) || die "워커 호스트 상태 확인 실패 (SSH)"
  [ "$(value "$api_status" role)" = api ] || die "woori-api 호스트의 역할 설정이 api가 아닙니다" 2
  [ "$(value "$worker_status" role)" = worker ] || die "woori-worker 호스트의 역할 설정이 worker가 아닙니다" 2
  api_before=$(value "$api_status" release)
  worker_before=$(value "$worker_status" release)
  say "실행 중: API ${api_before:0:7}, 워커 ${worker_before:0:7}"
}

api_changed=false
# Back to the API that ran before this release (same commit as the worker).
rollback_api() {
  local restored
  [ "$api_changed" = true ] || return 0
  remote_job woori-api rollback-api "$name"
  case $JOB_RC in
  0) ;;
  4) die "API 되돌리기 결과 불명: reconcile 또는 수동 확인 필요" 4 ;;
  *) die "API 되돌리기 실패: 즉시 수동 확인 (코드 $JOB_RC)" 3 ;;
  esac
  restored=$(value "$(remote woori-api status 2>/dev/null || true)" release)
  public_ok "${restored:-null}" - || die "API를 되돌린 뒤 공개 주소 확인 실패: 즉시 수동 확인" 3
  say "API가 이전 release ${restored:0:7} 로 돌아왔습니다"
}

# An interrupted job leaves its host "deploying": bring it back first.
recover_host() { # host
  remote_job "$1" recover
  [ "$JOB_RC" = 0 ] || die "$1 복구 실패: 즉시 수동 확인 (코드 $JOB_RC)" 3
}

swap_api() { # contract
  remote_job woori-api deploy-api "$name" "$release" "$1"
  case $JOB_RC in
  0) [ "$JOB_RESULT" != replaced ] || api_changed=true ;;
  3) die "API 교체와 복구 모두 실패: 즉시 수동 확인" 3 ;;
  4)
    recover_host woori-api
    die "API 교체 결과 불명: 이전 API로 복구했습니다"
    ;;
  5) die "API 교체가 시작되지 않았습니다 (서비스는 그대로)" ;;
  *) die "API 교체 실패 (이전 API 유지 또는 복구됨, 코드 $JOB_RC)" ;;
  esac
  if ! public_ok "$release" "$1"; then
    say "공개 주소에서 새 release를 확인하지 못했습니다: API를 되돌립니다"
    rollback_api
    die "공개 주소 확인 실패 (${url}/healthz·/readyz)"
  fi
  say "공개 확인: /healthz release ${release:0:7} contract $1, /readyz 200"
  note "- API: 교체·공개 확인 완료 (${JOB_RESULT:-?})"
}

swap_worker() {
  local worker_rc
  remote_job woori-worker deploy-worker "$name" "$release"
  worker_rc=$JOB_RC
  case $worker_rc in
  0)
    note "- 워커: 교체·시작 로그 확인 완료 (${JOB_RESULT:-?})"
    return 0
    ;;
  4)
    remote_job woori-worker recover
    [ "$JOB_RC" = 0 ] || worker_rc=3
    ;;
  esac
  say "워커 교체 실패: API도 이전 release로 되돌립니다 (같은 커밋 유지)"
  # Also when an earlier attempt already put the API on this release.
  api_status=$(remote woori-api status 2>/dev/null || true)
  if [ "$(value "$api_status" last)" = "$name" ] && [ "$(value "$api_status" last_status)" = deployed ]; then
    api_changed=true
  fi
  rollback_api
  [ "$worker_rc" != 3 ] || die "워커 교체와 복구 모두 실패: 즉시 수동 확인" 3
  die "워커 교체 실패 (워커·API 모두 이전 release)"
}

need_images() {
  local host
  for host in woori-api woori-worker; do
    remote "$host" has-image "$name" "$release" >/dev/null 2>&1 ||
      die "$host 에 $name 이미지가 없습니다 (prepare 먼저)" 2
  done
}

case $mode in
prepare)
  read_release yes
  say "릴리스 $name (커밋 ${release:0:7}, contract $contract)"
  note "### 서버 배포 준비"
  note ""
  note "- 릴리스: \`$name\` (커밋 \`$release\`), contract \`$contract\`"
  check_roles
  note "- 배포 전: API \`${api_before:-?}\`, 워커 \`${worker_before:-?}\`"
  for host in woori-api woori-worker; do
    if remote "$host" has-image "$name" "$release" >/dev/null 2>&1; then
      say "$host: 이미지가 이미 있습니다"
    else
      say "$host: 이미지 전송 중"
      ssh -F "$DEPLOY_SSH_CONFIG" "$host" "receive $name $release $sum" <"$RELEASE_DIR/$file" ||
        die "$host 이미지 전송·검증 실패 (서비스는 그대로)"
    fi
  done
  remote woori-worker check-worker "$name" "$release" || die "워커 --check 실패 (서비스는 그대로)"
  set +e
  plan=$(remote woori-api db-plan "$name" "$release" 2>&1)
  code=$?
  set -e
  printf '%s\n' "$plan"
  case $code in
  0) ;;
  21) die "대기 중인 migration에 자동 적용할 수 없는 문장이 있습니다: 수동 절차로 적용한 뒤 다시 실행하세요" 21 ;;
  *) die "DB 계획 실패 (코드 $code)" "$code" ;;
  esac
  changes=$(value "$plan" plan_changes)
  hash=$(value "$plan" plan_hash)
  if ! [[ $hash =~ ^[0-9a-f]{64}$ ]] || { [ "$changes" != true ] && [ "$changes" != false ]; }; then
    die "DB 계획을 읽지 못했습니다" 1
  fi
  output plan_changes "$changes"
  output plan_hash "$hash"
  output plan_mode "$(value "$plan" plan_mode)"
  note "- DB 계획: 변경 $changes, 방식 $(value "$plan" plan_mode), 대기 migration \`$(value "$plan" plan_pending)\`, grants 변경 $(value "$plan" plan_grants_changed)"
  note "- 승인 값(plan hash): \`$hash\`"
  say "준비 완료: DB 변경 $changes"
  ;;
deploy)
  read_release no
  approval=${DEPLOY_DB_APPROVAL:-none}
  [ "$approval" = none ] || [[ $approval =~ ^[0-9a-f]{64}$ ]] || die "DB 승인 값 형식 오류" 2
  say "릴리스 $name (커밋 ${release:0:7}, contract $contract)"
  note "### 서버 운영 배포"
  note ""
  note "- 릴리스: \`$name\` (커밋 \`$release\`), contract \`$contract\`, DB 승인: \`$approval\`"
  check_roles
  need_images
  remote woori-worker check-worker "$name" "$release" || die "워커 --check 실패 (서비스는 그대로)"
  remote_job woori-api db "$name" "$release" "$approval"
  case $JOB_RC in
  0) note "- 운영 DB: ${JOB_RESULT:-?}" ;;
  20 | 21 | 22) die "운영 DB 단계에서 멈췄습니다 (코드 $JOB_RC, API·워커는 그대로)" "$JOB_RC" ;;
  5) die "운영 DB 단계가 시작되지 않았습니다 (서비스는 그대로)" ;;
  4) die "운영 DB 단계 결과 불명: migration 진행 여부를 확인하기 전에는 API를 교체하지 않습니다" 4 ;;
  *) die "운영 DB 단계 실패 (코드 $JOB_RC, API·워커는 그대로)" ;;
  esac
  swap_api "$contract"
  swap_worker
  note "- 결과: 성공"
  say "배포 완료: $name"
  ;;
rollback-to)
  name=${2:-}
  release=${3:-}
  [[ $name =~ $NAME_RE && $release =~ $SHA_RE ]] && [ "${name#*-}" = "${release:0:7}" ] ||
    die "사용법: rollback-to <name> <release>" 2
  note "### 서버 빠른 롤백"
  note ""
  note "- 대상: \`$name\` (커밋 \`$release\`), DB 단계 없음"
  check_roles
  need_images
  remote woori-worker check-worker "$name" "$release" || die "워커 --check 실패 (서비스는 그대로)"
  swap_api -
  swap_worker
  note "- 결과: 성공"
  say "롤백 완료: $name"
  ;;
reconcile)
  name=${DEPLOY_RELEASE_NAME:-}
  release=${DEPLOY_RELEASE:-}
  outcome=${DEPLOY_OUTCOME:-unknown}
  note "### 배포 후 상태 확인 ($outcome)"
  note ""
  for host in woori-api woori-worker; do
    deadline=$((SECONDS + resolve_timeout))
    while status=$(remote "$host" status 2>/dev/null) && [ "$(value "$status" job_state)" = running ] &&
      [ "$SECONDS" -lt "$deadline" ]; do
      say "$host: 진행 중인 작업을 기다립니다"
      sleep 10
    done
    [ -n "${status:-}" ] || die "$host 상태를 확인하지 못했습니다" 4
    case $(value "$status" last_status) in
    deploying | rolling-back)
      [ "$(value "$status" job_state)" != running ] || die "$host 작업이 아직 진행 중입니다" 4
      say "$host: 중단된 작업을 복구합니다"
      recover_host "$host"
      ;;
    esac
  done
  api_status=$(remote woori-api status) || die "API 호스트 상태 확인 실패" 4
  worker_status=$(remote woori-worker status) || die "워커 호스트 상태 확인 실패" 4
  if [ "$outcome" != success ] && [[ $name =~ $NAME_RE ]] &&
    [ "$(value "$api_status" last)" = "$name" ] && [ "$(value "$api_status" last_status)" = deployed ] &&
    [ "$(value "$worker_status" release)" != "$(value "$api_status" release)" ]; then
    say "워커가 이 릴리스를 받지 못했습니다: API를 이전 release로 되돌립니다"
    remote_job woori-api rollback-api "$name"
    [ "$JOB_RC" = 0 ] || die "API 되돌리기 실패: 즉시 수동 확인 (코드 $JOB_RC)" 3
    api_status=$(remote woori-api status) || die "API 호스트 상태 확인 실패" 4
  fi
  api_now=$(value "$api_status" release)
  worker_now=$(value "$worker_status" release)
  note "- API: \`$api_now\` ($(value "$api_status" last_status)), 워커: \`$worker_now\` ($(value "$worker_status" last_status))"
  say "API ${api_now:0:7}, 워커 ${worker_now:0:7}"
  if [ "$api_now" != "$worker_now" ]; then
    printf '::error::API(%s)와 워커(%s)의 release가 다릅니다\n' "${api_now:0:7}" "${worker_now:0:7}"
    exit 1
  fi
  [ "$outcome" != success ] || [ -z "$release" ] || [ "$api_now" = "$release" ] ||
    die "성공으로 끝났는데 운영 release가 $release 가 아닙니다" 1
  ;;
*) die "사용법: deploy-release.sh prepare|deploy|reconcile|rollback-to <name> <release>" 2 ;;
esac
