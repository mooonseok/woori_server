#!/bin/bash
# Release replacement on the Lightsail API and worker hosts, driven over SSH by
# deploy/lightsail/deploy-release.sh (.github/workflows/deploy.yml, or a
# trusted Mac). It automates the manual order recorded in SETUP.md ("API 서버
# 실제 구성", "릴리스 이미지", "운영 migration 절차"):
#   receive   image tar.gz on stdin -> /opt/woori/images/<name>/ + SHA256SUMS
#             -> sha256sum -c -> strict check of the archive's tags (python3)
#             -> docker load, then every repo:tag -> ID is compared with before:
#             any change besides the new tag is undone and refused
#   db-plan   (API) read-only plan: pending migrations from the ledger (read-only
#             role), statements outside the automatic allowlist, plan hash
#   db        (API) same plan; nothing to do -> the owner credential is not used;
#             otherwise only with the approved plan hash: migrate deploy +
#             runtime grants (scripts/release-db.mjs in the release image)
#   deploy-api    woori-api-next with the same settings -> /healthz release
#             (+ contract) and /readyz 200 -> stop woori-api, rename it
#             woori-api-<old tag> -> start the new woori-api -> check again
#             after a settle period; on failure the old one comes back
#   check-worker / deploy-worker   worker --check without network -> stop
#             woori-worker first (never two workers) -> rename -> start the new
#             one -> start log "polling" with the release -> settle. Then
#             /etc/woori/r2-backup.conf WOORI_IMAGE (if the backup is installed)
#             moves to the same image: the daily copy runs the code that knows
#             the current storage layout; a worker rollback restores the value
#   rollback-api / rollback-worker <name>   bring back what <name> replaced
#   recover   finish an interrupted replacement: back to the previous container
#   status, has-image, job <id>
# Mutating commands (db, deploy-*, rollback-*, recover) run as a detached job
# (setsid; or systemd-run, see detach_mode): the SSH session only follows its log, so a
# cancelled run, timeout or dropped connection never stops a replacement
# halfway. The runner reads the outcome afterwards with `job <id>` / `status`.
# A job killed outright (reboot, kill -9) leaves state "deploying"; the next
# mutating command, or `recover`, first returns that host to the previous
# container. Each job's output goes to /var/lib/woori-deploy/jobs/<id>.log.
# Never removes images or archives (they stay for rollback; receive refuses
# below WOORI_MIN_FREE_MB and pruning stays a human decision) and never prints
# configuration values, DB URLs, docker error text or container logs: Actions
# logs of a public repository are public. Those go to the root-only logs under
# /var/lib/woori-deploy/logs. Replaced containers stay stopped as
# <prefix>-<role>-failed-<name>-* (or -rolledback-).
# Limits: the lock is per command, so a manual run from a Mac can slip in
# between two steps of an Actions deployment (e.g. receive and deploy-api);
# state checks make that fail rather than mix releases, but check that no
# Actions deployment runs before deploying by hand.
#
# One-time host setup (the user applies it; nothing here changes SSH, sudo or
# the firewall). On each host, as root:
#   install -d -m 0755 /usr/local/lib/woori /etc/woori /etc/ssh/authorized_keys
#   install -m 0755 deploy/lightsail/woori-deploy.sh /usr/local/lib/woori/
#   install -m 0440 deploy/lightsail/woori-deploy.sudoers /etc/sudoers.d/woori-deploy
#   visudo -cf /etc/sudoers.d/woori-deploy
#   useradd --system --create-home --shell /bin/sh woori-deploy   # sh runs the forced command
#   usermod -p '*' woori-deploy                                    # key login only
#   /etc/woori/deploy.conf (root 0644): WOORI_ROLE=api or WOORI_ROLE=worker
#   /etc/ssh/authorized_keys/woori-deploy (root:root 0644, so the user cannot
#   change it), one line:
#     worker: restrict,command="sudo -n /usr/local/lib/woori/woori-deploy.sh ssh" ssh-ed25519 <public key> woori-deploy
#     API:    restrict,port-forwarding,permitopen="<worker private IP>:22",command="sudo -n /usr/local/lib/woori/woori-deploy.sh ssh" ssh-ed25519 <public key> woori-deploy
#   deploy/lightsail/woori-deploy-sshd.conf -> /etc/ssh/sshd_config.d/woori-deploy.conf
#   (worker IP filled in; see that file), `sshd -t`, `systemctl reload ssh`.
#   python3 must exist (Ubuntu ships it), and setsid (util-linux).
#   API only: /opt/woori/env/migration.env (root 0600), one line
#   MIGRATION_DATABASE_URL=<owner URL> as on the trusted Mac but with the CA at
#   the container path /run/certs/supabase-ca.crt; recommended
#   /opt/woori/env/ledger.env (root 0600), LEDGER_DATABASE_URL=<read-only
#   ledger role, see scripts/release-db.mjs>. Each is copied for one container
#   run (0400, the image's node user) and mounted read-only; migration.env
#   only for an approved `db` apply.
# Undo: delete /etc/ssh/authorized_keys/woori-deploy (access ends at once),
# then the sshd drop-in (reload ssh), /etc/sudoers.d/woori-deploy, the user and
# /usr/local/lib/woori/woori-deploy.sh. Nothing else changes.
# Manual runs: sudo /usr/local/lib/woori/woori-deploy.sh status
#
# /etc/woori/deploy.conf (KEY=value, no quotes, not secret) needs WOORI_ROLE and
# may override these defaults (the local simulation and tests use other names):
#   WOORI_ROOT=/opt/woori  WOORI_PREFIX=woori  WOORI_NETWORK=woori
#   WOORI_WORKER_NETWORK= (default bridge)  WOORI_DB_NETWORK= (default bridge)
#   WOORI_IMAGE_REPO=woori-server  WOORI_EXPECT_ARCH=amd64  WOORI_API_PORT=3001
#   WOORI_STATE_DIR=/var/lib/woori-deploy  WOORI_LOCK_FILE=/run/woori-deploy.lock
#   WOORI_BACKUP_CONF=/etc/woori/r2-backup.conf  WOORI_MIN_FREE_MB=6144
#   WOORI_MAX_ARCHIVE_MB=3072  WOORI_HEALTH_TIMEOUT=120  WOORI_SETTLE_SECONDS=15
#   WOORI_WORKER_START_TIMEOUT=120  WOORI_DETACH=auto (systemd|setsid|background)
#   WOORI_LOCK_TIMEOUT=10s (migration lock_timeout, or off)  WOORI_CONTAINER_UID=1000
# Environment variables are ignored, except WOORI_DEPLOY_CONF (another config
# path) when not started through sudo.
# Exit codes: 0 ok, 1 failed (nothing changed, or rolled back), 2 usage or
# settings, 3 rollback failed too (act by hand), 4 job ended without a result
# (run recover), 20 DB changes not approved (or approval does not match the
# plan), 21 pending statements need the manual procedure, 22 migration ledger
# problem, 75 another deployment holds the lock. Results: result=replaced |
# unchanged | rolledback | recovered.
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true
umask 077
# A closed SSH channel must never kill a step halfway; output errors are ignored.
trap '' PIPE
if [ -n "${SUDO_USER:-}" ] || [ "$(id -u)" = 0 ]; then
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  export PATH
fi

say() { printf '[woori-deploy] %s\n' "$*" 2>/dev/null || true; }
die() {
  printf '[woori-deploy] 실패: %s\n' "$1" >&2 2>/dev/null || true
  exit "${2:-1}"
}

WOORI_ROLE=
WOORI_ROOT=/opt/woori
WOORI_PREFIX=woori
WOORI_NETWORK=woori
WOORI_WORKER_NETWORK=
WOORI_DB_NETWORK=
WOORI_IMAGE_REPO=woori-server
WOORI_EXPECT_ARCH=amd64
WOORI_API_PORT=3001
WOORI_STATE_DIR=/var/lib/woori-deploy
WOORI_LOCK_FILE=/run/woori-deploy.lock
WOORI_BACKUP_CONF=/etc/woori/r2-backup.conf
WOORI_MIN_FREE_MB=6144
WOORI_MAX_ARCHIVE_MB=3072
WOORI_HEALTH_TIMEOUT=120
WOORI_SETTLE_SECONDS=15
WOORI_WORKER_START_TIMEOUT=120
WOORI_DETACH=auto
WOORI_LOCK_TIMEOUT=10s
WOORI_CONTAINER_UID=1000

conf=/etc/woori/deploy.conf
if [ -z "${SUDO_USER:-}" ] && [ -n "${WOORI_DEPLOY_CONF:-}" ]; then
  conf=$WOORI_DEPLOY_CONF
fi

# KEY=value lines only; nothing in the file is executed.
read_settings() {
  local file=$1 allowed=$2 line key value
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in '' | '#'*) continue ;; esac
    key=${line%%=*}
    value=${line#*=}
    [ "$key" != "$line" ] || die "$file: KEY=value 형식이 아닙니다" 2
    case " $allowed " in *" $key "*) ;; *) die "$file: 알 수 없는 키 $key" 2 ;; esac
    [[ $value =~ ^[A-Za-z0-9._/:@-]*$ ]] || die "$file: $key 값 형식 오류" 2
    printf -v "$key" '%s' "$value"
  done <"$file"
}

[ -r "$conf" ] || die "설정 파일이 없습니다: $conf" 2
read_settings "$conf" "WOORI_ROLE WOORI_ROOT WOORI_PREFIX WOORI_NETWORK WOORI_WORKER_NETWORK WOORI_DB_NETWORK WOORI_IMAGE_REPO WOORI_EXPECT_ARCH WOORI_API_PORT WOORI_STATE_DIR WOORI_LOCK_FILE WOORI_BACKUP_CONF WOORI_MIN_FREE_MB WOORI_MAX_ARCHIVE_MB WOORI_HEALTH_TIMEOUT WOORI_SETTLE_SECONDS WOORI_WORKER_START_TIMEOUT WOORI_DETACH WOORI_LOCK_TIMEOUT WOORI_CONTAINER_UID"
case $WOORI_ROLE in api | worker) ;; *) die "WOORI_ROLE은 api 또는 worker여야 합니다" 2 ;; esac
case $WOORI_DETACH in auto | systemd | setsid | background) ;; *) die "WOORI_DETACH 값 오류" 2 ;; esac
[[ $WOORI_LOCK_TIMEOUT =~ ^([0-9]{1,5}(ms|s)|off)$ ]] || die "WOORI_LOCK_TIMEOUT 값 오류" 2
for number in WOORI_API_PORT WOORI_MIN_FREE_MB WOORI_MAX_ARCHIVE_MB WOORI_HEALTH_TIMEOUT WOORI_SETTLE_SECONDS WOORI_WORKER_START_TIMEOUT WOORI_CONTAINER_UID; do
  [[ ${!number} =~ ^[0-9]+$ ]] || die "$number 값은 숫자여야 합니다" 2
done

SELF=$0
case $SELF in /*) ;; *) SELF="$(cd "$(dirname "$SELF")" && pwd)/$(basename "$SELF")" ;; esac
ENV_DIR=$WOORI_ROOT/env
CA_FILE=$WOORI_ROOT/certs/supabase-ca.crt
IMAGES_DIR=$WOORI_ROOT/images
API=$WOORI_PREFIX-api
WORKER=$WOORI_PREFIX-worker
LOG_DIR=$WOORI_STATE_DIR/logs
JOBS=$WOORI_STATE_DIR/jobs
DOCKER_LOG=$LOG_DIR/docker.log
LABEL='{{index .Config.Labels "org.opencontainers.image.revision"}}'

NAME_RE='^[0-9]{8}-[0-9a-f]{7}$'
SHA_RE='^[0-9a-f]{40}$'
SUM_RE='^[0-9a-f]{64}$'
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
JOB_RE='^[0-9]{14}-[0-9]+-[a-z-]+$'

mkdir -p "$WOORI_STATE_DIR" "$LOG_DIR" "$JOBS"
chmod 700 "$WOORI_STATE_DIR" "$LOG_DIR" "$JOBS"

# /healthz release (+ contract unless "-") and /readyz 200, from inside the
# container (the API port is not published on the host). Prints one line;
# exit 2 = wrong release or contract (waiting will not help), 1 = not ready.
# shellcheck disable=SC2016 # JavaScript, not shell expansions
API_CHECK_JS='
const [release, contract, port] = process.argv.slice(1);
const get = (path) => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3000) });
(async () => {
  const health = await get("/healthz");
  if (health.status !== 200) throw new Error(`healthz ${health.status}`);
  const body = await health.json();
  if (body.status !== "alive") throw new Error("healthz status");
  const wrong = (text) => Object.assign(new Error(text), { code: 2 });
  if ((body.release ?? null) !== (release === "null" ? null : release)) throw wrong("release 불일치");
  if (contract !== "-" && body.contract !== contract) throw wrong(`contract 불일치 (${body.contract ?? "없음"})`);
  const ready = await get("/readyz");
  if (ready.status !== 200) throw new Error(`readyz ${ready.status}`);
  console.log(`healthz release ${String(body.release).slice(0, 7)} contract ${body.contract ?? "-"}, readyz 200`);
})().catch((error) => { console.log(error.message); process.exit(error.code === 2 ? 2 : 1); });
'

# worker --check judged by the image's own release-plan helper.
# shellcheck disable=SC2016 # JavaScript, not shell expansions
WORKER_CHECK_JS='
const { spawnSync } = require("node:child_process");
const { workerCheckProblems } = require("/app/dist/src/common/release/release-plan.js");
const run = spawnSync(process.execPath, ["dist/src/worker/main.js", "--check"], { cwd: "/app", encoding: "utf8" });
const line = (run.stdout || "").trim().split("\n").pop() || "";
const problems = run.status === 0 ? workerCheckProblems(line, process.argv[1]) : [`worker --check exit ${run.status}`];
console.log(problems.length ? problems.join("; ") : "worker --check 통과 (ffmpeg·libx264·AAC·preset·release)");
process.exit(problems.length ? 1 : 0);
'

# The archive may load exactly one image under exactly this release's tag.
# Parsed as JSON (escaped keys decode, duplicate keys are refused) from the
# tar itself; anything unexpected fails closed. Prints a reason on failure.
ARCHIVE_CHECK_PY='
import json, sys, tarfile
path, ref = sys.argv[1], sys.argv[2]
repo, tag = ref.rsplit(":", 1)
def strict(pairs):
    keys = [k for k, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate JSON key")
    return dict(pairs)
def fail(reason):
    print(reason)
    sys.exit(1)
files = {}
blobs = {}
with tarfile.open(path, "r:gz") as tar:
    for member in tar:
        name = member.name[2:] if member.name.startswith("./") else member.name
        if member.isdir():
            continue
        if not member.isfile():
            fail("link or special file in archive: " + name)
        if name in ("index.json", "manifest.json", "oci-layout", "repositories"):
            files[name] = tar.extractfile(member).read()
        elif name.startswith("blobs/sha256/") and len(name) == 77:
            if member.size < 1 << 20:
                blobs[name[13:]] = tar.extractfile(member).read()
        else:
            fail("unexpected file in archive: " + name)
try:
    manifest = json.loads(files["manifest.json"], object_pairs_hook=strict)
    index = json.loads(files["index.json"], object_pairs_hook=strict)
except (KeyError, ValueError) as error:
    fail("archive metadata unreadable: " + str(error))
if not isinstance(manifest, list) or len(manifest) != 1 or not isinstance(manifest[0], dict):
    fail("manifest.json must describe one image")
if not set(manifest[0]) <= {"Config", "RepoTags", "Layers", "LayerSources"}:
    fail("manifest.json has unknown keys")
if manifest[0].get("RepoTags") != [ref]:
    fail("manifest.json tags are not exactly " + ref)
if not isinstance(index, dict) or not set(index) <= {"schemaVersion", "mediaType", "manifests", "annotations"}:
    fail("index.json has unknown keys")
if index.get("annotations"):
    fail("index.json has top-level annotations")
entries = index.get("manifests")
if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict):
    fail("index.json must list one image")
entry = entries[0]
if not set(entry) <= {"mediaType", "digest", "size", "annotations", "platform", "artifactType"}:
    fail("index.json entry has unknown keys")
notes = entry.get("annotations") or {}
if not isinstance(notes, dict) or not set(notes) <= {"io.containerd.image.name", "org.opencontainers.image.ref.name"}:
    fail("index.json entry has unknown annotations")
if notes.get("io.containerd.image.name", ref) not in (ref, "docker.io/library/" + ref):
    fail("index.json names another image")
if notes.get("org.opencontainers.image.ref.name", tag) != tag:
    fail("index.json names another tag")
# A nested index must not name images either.
digest = str(entry.get("digest", ""))
nested = blobs.get(digest[7:]) if digest.startswith("sha256:") else None
if nested is not None and entry.get("mediaType", "").endswith("index.v1+json"):
    try:
        inner = json.loads(nested, object_pairs_hook=strict)
    except ValueError as error:
        fail("nested index unreadable: " + str(error))
    for item in inner.get("manifests", []):
        if set((item.get("annotations") or {})) & {"io.containerd.image.name", "org.opencontainers.image.ref.name"}:
            fail("nested index names an image")
if "repositories" in files:
    try:
        repos = json.loads(files["repositories"], object_pairs_hook=strict)
    except ValueError as error:
        fail("repositories unreadable: " + str(error))
    if list(repos) != [repo] or list(repos[repo]) != [tag]:
        fail("repositories names another tag")
'

valid_release() {
  [[ $1 =~ $NAME_RE ]] && [[ $2 =~ $SHA_RE ]] && [ "${1#*-}" = "${2:0:7}" ] ||
    die "릴리스 이름·커밋 형식이 맞지 않습니다" 2
}
need_role() { [ "$WOORI_ROLE" = "$1" ] || die "이 명령은 $1 호스트 전용입니다" 2; }
image_ref() { printf '%s:%s' "$WOORI_IMAGE_REPO" "$1"; }
exists() { docker container inspect "$1" >/dev/null 2>&1; }
field() { docker container inspect -f "$2" "$1" 2>/dev/null || true; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
size_of() { wc -c <"$1" | tr -d ' '; }

# Deployments fail fast on a busy host; recover waits a little, since a
# command a killed job had started (e.g. docker stop) may still hold the lock.
lock() { # [seconds to wait]
  exec 9>"$WOORI_LOCK_FILE"
  if [ -n "${1:-}" ]; then flock -w "$1" 9; else flock -n 9; fi || {
    say "다른 배포가 진행 중입니다"
    exit 75
  }
}

# The loaded tag must be this release's: amd64, non-root, revision label.
verify_image() {
  local ref meta
  ref=$(image_ref "$1")
  meta=$(docker image inspect -f "{{.Architecture}}|{{.Config.User}}|$LABEL" "$ref" 2>/dev/null) ||
    die "이미지가 없습니다: $ref (receive 먼저)"
  [ "$meta" = "$WOORI_EXPECT_ARCH|node|$2" ] || die "이미지 정보가 릴리스와 다릅니다: $ref"
}

free_mb() { df -Pm "$1" | awk 'NR == 2 { print $4 }'; }

state_file() { printf '%s/%s.state' "$WOORI_STATE_DIR" "$WOORI_ROLE"; }
state_name='' state_previous='' state_backup='' state_status='' state_phase=''
read_state() {
  local file
  file=$(state_file)
  state_name='' state_previous='' state_backup='' state_status='' state_phase=''
  [ -r "$file" ] || return 0
  read_settings "$file" "state_name state_previous state_backup state_status state_phase"
}
# name previous backup status phase; written before each step it describes.
write_state() {
  local file
  file=$(state_file)
  printf 'state_name=%s\nstate_previous=%s\nstate_backup=%s\nstate_status=%s\nstate_phase=%s\n' \
    "$1" "$2" "$3" "$4" "$5" >"$file.tmp"
  mv "$file.tmp" "$file"
}

# woori-api -> woori-api-<tag of its image>; a taken name gets a time suffix.
previous_name() {
  local base=$1 image tag name
  image=$(field "$base" '{{.Config.Image}}')
  tag=${image##*:}
  tag=$(printf '%s' "$tag" | tr -c 'A-Za-z0-9_.-' '-' | cut -c1-40)
  name="$base-${tag:-old}"
  if exists "$name"; then name="$name-$(date +%Y%m%d%H%M%S)"; fi
  printf '%s' "$name"
}

save_logs() {
  docker logs "$1" >"$LOG_DIR/$1-$(date +%Y%m%d%H%M%S).log" 2>&1 || true
  say "$1 로그는 호스트 $LOG_DIR 에 저장했습니다 (출력하지 않음)"
}

# Keep a replaced container stopped, renamed out of the way, for diagnosis.
park() { # container name failed|rolledback
  local parked
  exists "$1" || return 0
  save_logs "$1"
  parked="$1-$3-$2-$(date +%Y%m%d%H%M%S)"
  docker stop -t 30 "$1" >/dev/null 2>>"$DOCKER_LOG" || true
  docker update --restart no "$1" >/dev/null 2>>"$DOCKER_LOG" || true
  docker rename "$1" "$parked" 2>>"$DOCKER_LOG" || return 1
  say "교체된 컨테이너를 $parked 로 정지 보관했습니다"
}

# docker run errors can quote env-file lines: they go to the host log only.
run_api() { # container restart-policy image
  docker run -d --name "$1" --network "$WOORI_NETWORK" --restart "$2" --init \
    --log-opt max-size=10m --log-opt max-file=3 \
    --env-file "$ENV_DIR/common.env" --env-file "$ENV_DIR/api.env" \
    -v "$CA_FILE:/run/certs/supabase-ca.crt:ro" \
    "$3" node dist/src/main.js >/dev/null 2>>"$DOCKER_LOG"
}

run_worker() { # container image
  local network=()
  [ -z "$WOORI_WORKER_NETWORK" ] || network=(--network "$WOORI_WORKER_NETWORK")
  docker run -d --name "$1" ${network[@]+"${network[@]}"} --restart unless-stopped --init \
    --stop-timeout 120 --log-opt max-size=10m --log-opt max-file=3 \
    --env-file "$ENV_DIR/common.env" \
    -v "$CA_FILE:/run/certs/supabase-ca.crt:ro" \
    "$2" node dist/src/worker/main.js >/dev/null 2>>"$DOCKER_LOG"
}

# Running, not restarted since the wait began, and answering the API check
# before the timeout.
wait_api() { # container release contract timeout
  local deadline=$((SECONDS + $4)) out='' status base code
  base=running/$(field "$1" '{{.RestartCount}}')
  while :; do
    status=$(field "$1" '{{.State.Status}}/{{.RestartCount}}')
    if [ "$status" != "$base" ]; then
      say "$1 상태 ${status:-없음}"
      return 1
    fi
    code=0
    out=$(docker exec "$1" node -e "$API_CHECK_JS" "$2" "$3" "$WOORI_API_PORT" 2>/dev/null) || code=$?
    if [ "$code" -eq 0 ]; then
      say "$1: $out"
      return 0
    fi
    if [ "$code" -eq 2 ]; then
      say "$1: $out"
      return 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      say "$1 확인 시간 초과: ${out:-응답 없음}"
      return 1
    fi
    sleep 2
  done
}

settle() { # container
  local status base
  base=running/$(field "$1" '{{.RestartCount}}')
  sleep "$WOORI_SETTLE_SECONDS"
  status=$(field "$1" '{{.State.Status}}/{{.RestartCount}}')
  [ "$status" = "$base" ] || {
    say "$1 안정화 확인 실패 (상태 ${status:-없음})"
    return 1
  }
}

# The worker start line {"service":"woori-worker","status":"polling",
# "release":…} logged since `since` (a restored container has older lines).
wait_worker() { # container release|null timeout since
  local deadline=$((SECONDS + $3)) want status base logs
  if [ "$2" = null ]; then want='"status":"polling","release":null'; else want="\"status\":\"polling\",\"release\":\"$2\""; fi
  base=running/$(field "$1" '{{.RestartCount}}')
  while :; do
    status=$(field "$1" '{{.State.Status}}/{{.RestartCount}}')
    if [ "$status" != "$base" ]; then
      say "$1 상태 ${status:-없음}"
      return 1
    fi
    # Read the logs first: grep -q would end the pipe early (pipefail).
    logs=$(docker logs --since "$4" "$1" 2>&1 || true)
    if grep -qF "$want" <<<"$logs"; then
      say "$1: 시작 로그 polling, release ${2:0:7}"
      return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      say "$1 시작 로그 확인 시간 초과"
      return 1
    fi
    sleep 2
  done
}

release_of() { # container -> its image revision label or null
  local label
  label=$(field "$1" "$LABEL")
  if [[ $label =~ $SHA_RE ]]; then printf '%s' "$label"; else printf null; fi
}

backup_image() {
  if [ -f "$WOORI_BACKUP_CONF" ]; then grep -m 1 '^WOORI_IMAGE=' "$WOORI_BACKUP_CONF" | cut -d= -f2- || true; fi
}

# WOORI_IMAGE in the backup timer's settings; other lines stay as they are.
# Each step is checked (callers run it in a condition, where errexit is off)
# and the file is replaced only by a complete copy.
set_backup_image() { # image
  local file=$WOORI_BACKUP_CONF tmp
  [ -f "$file" ] || return 0
  grep -q '^WOORI_IMAGE=' "$file" || return 0
  tmp="$file.tmp.$$"
  cp -p "$file" "$tmp" || {
    rm -f "$tmp"
    return 1
  }
  if ! sed "s|^WOORI_IMAGE=.*|WOORI_IMAGE=$1|" "$file" >"$tmp" ||
    [ "$(wc -l <"$tmp")" != "$(wc -l <"$file")" ] ||
    ! grep -qx "WOORI_IMAGE=$1" "$tmp" ||
    ! mv -f "$tmp" "$file"; then
    rm -f "$tmp"
    return 1
  fi
}

# Back to the container <name> replaced: park the new one, bring the previous
# one back under the service name, start it and check it. Safe to repeat
# after an interruption at any step.
converge_api() { # name previous failed|rolledback
  if exists "$API" && [ "$(field "$API" '{{.Config.Image}}')" = "$(image_ref "$1")" ]; then
    park "$API" "$1" "$3" || return 1
  fi
  if ! exists "$API"; then
    if [ -z "$2" ] || ! exists "$2"; then
      say "되돌릴 이전 API 컨테이너가 없습니다"
      return 1
    fi
    docker rename "$2" "$API" 2>>"$DOCKER_LOG" || return 1
  fi
  docker update --restart unless-stopped "$API" >/dev/null 2>>"$DOCKER_LOG" || return 1
  if [ "$(field "$API" '{{.State.Status}}')" != running ]; then
    docker start "$API" >/dev/null 2>>"$DOCKER_LOG" || return 1
  fi
  wait_api "$API" "$(release_of "$API")" - "$WOORI_HEALTH_TIMEOUT"
}

converge_worker() { # name previous failed|rolledback backup
  local since
  if exists "$WORKER" && [ "$(field "$WORKER" '{{.Config.Image}}')" = "$(image_ref "$1")" ]; then
    park "$WORKER" "$1" "$3" || return 1
  fi
  if ! exists "$WORKER"; then
    if [ -z "$2" ] || ! exists "$2"; then
      say "되돌릴 이전 워커 컨테이너가 없습니다"
      return 1
    fi
    docker rename "$2" "$WORKER" 2>>"$DOCKER_LOG" || return 1
  fi
  if [ -n "$4" ] && [ "$(backup_image)" = "$(image_ref "$1")" ]; then
    if set_backup_image "$4"; then say "R2 백업 이미지 복원: $4"; else say "R2 백업 설정 복원 실패: $WOORI_BACKUP_CONF 확인"; fi
  fi
  docker update --restart unless-stopped "$WORKER" >/dev/null 2>>"$DOCKER_LOG" || return 1
  since=$(now)
  if [ "$(field "$WORKER" '{{.State.Status}}')" != running ]; then
    docker start "$WORKER" >/dev/null 2>>"$DOCKER_LOG" || return 1
  else
    since=1970-01-01T00:00:00Z
  fi
  wait_worker "$WORKER" "$(release_of "$WORKER")" "$WOORI_WORKER_START_TIMEOUT" "$since"
}

# An earlier job that ended halfway (state deploying/rolling-back) is first
# brought back to the previous container. Returns 0 if nothing was pending.
recover_role() {
  read_state
  case $state_status in deploying | rolling-back) ;; *) return 0 ;; esac
  say "중단된 작업을 복구합니다 (릴리스 $state_name, 단계 ${state_phase:-?})"
  local ok=false
  if [ "$WOORI_ROLE" = api ]; then
    docker rm -f "$API-next" >/dev/null 2>&1 || true
    if converge_api "$state_name" "$state_previous" failed; then ok=true; fi
  elif converge_worker "$state_name" "$state_previous" failed "$state_backup"; then
    ok=true
  fi
  if [ "$ok" = true ]; then
    write_state "$state_name" "$state_previous" "$state_backup" rolled-back recovered
    say "result=recovered"
    return 0
  fi
  write_state "$state_name" "$state_previous" "$state_backup" rollback-failed recover
  die "복구 실패: 즉시 수동 확인 필요" 3
}

cmd_status() {
  local container=$API last='' job_state=none job_rc=''
  [ "$WOORI_ROLE" = api ] || container=$WORKER
  read_state
  printf 'role=%s\ncontainer=%s\n' "$WOORI_ROLE" "$container"
  if exists "$container"; then
    printf 'image=%s\nrelease=%s\nstate=%s\n' "$(field "$container" '{{.Config.Image}}')" \
      "$(release_of "$container")" "$(field "$container" '{{.State.Status}}')"
  else
    printf 'image=\nrelease=null\nstate=missing\n'
  fi
  printf 'last=%s\nprevious=%s\nlast_status=%s\nphase=%s\n' "$state_name" "$state_previous" "$state_status" "$state_phase"
  if [ -f "$JOBS/last" ]; then
    last=$(cat "$JOBS/last")
    job_state=$(job_state "$last")
    [ ! -f "$JOBS/$last.rc" ] || job_rc=$(cat "$JOBS/$last.rc")
  fi
  printf 'job=%s\njob_cmd=%s\njob_state=%s\njob_rc=%s\n' "$last" \
    "$(cat "$JOBS/$last.cmd" 2>/dev/null || true)" "$job_state" "$job_rc"
  [ "$WOORI_ROLE" != api ] || printf 'grants=%s\n' "$(cat "$WOORI_STATE_DIR/api.grants" 2>/dev/null || echo none)"
}

job_state() { # id -> running | finished | died
  local pid
  if [ -f "$JOBS/$1.rc" ]; then
    echo finished
    return
  fi
  pid=$(cat "$JOBS/$1.pid" 2>/dev/null || true)
  if [ -z "$pid" ]; then
    # Not started yet (a few seconds at most) or never started.
    if [ $(($(date +%s) - $(date -r "$JOBS/$1.cmd" +%s 2>/dev/null || echo 0))) -lt 30 ]; then echo running; else echo died; fi
    return
  fi
  if kill -0 "$pid" 2>/dev/null; then echo running; else
    # The result may land between the two checks.
    if [ -f "$JOBS/$1.rc" ]; then echo finished; else echo died; fi
  fi
}

cmd_job() { # id: its log and outcome, for a runner whose connection dropped
  [[ $1 =~ $JOB_RE ]] && [ -f "$JOBS/$1.cmd" ] || die "작업이 없습니다" 2
  cat "$JOBS/$1.log" 2>/dev/null || true
  printf 'job=%s\njob_state=%s\njob_rc=%s\n' "$1" "$(job_state "$1")" "$(cat "$JOBS/$1.rc" 2>/dev/null || true)"
}

cmd_has_image() {
  valid_release "$1" "$2"
  [ "$(docker image inspect -f "{{.Architecture}}|{{.Config.User}}|$LABEL" "$(image_ref "$1")" 2>/dev/null)" = "$WOORI_EXPECT_ARCH|node|$2" ]
}

tags_snapshot() {
  docker images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' 2>>"$DOCKER_LOG" |
    grep -v '^<none>:<none> ' | sort || true
}

cmd_receive() {
  local name=$1 release=$2 sum=$3 ref dir file partial bytes docker_root reason before after added removed line loaded
  valid_release "$name" "$release"
  [[ $sum =~ $SUM_RE ]] || die "sha256 형식 오류" 2
  command -v python3 >/dev/null 2>&1 || die "python3 가 없습니다 (이미지 묶음 검사에 필요)" 2
  lock
  ref=$(image_ref "$name")
  dir=$IMAGES_DIR/$name
  file=$WOORI_IMAGE_REPO-$name-$WOORI_EXPECT_ARCH.tar.gz
  mkdir -p "$dir"
  chmod 700 "$dir"
  [ "$(free_mb "$dir")" -ge "$WOORI_MIN_FREE_MB" ] ||
    die "디스크 여유가 ${WOORI_MIN_FREE_MB}MB 미만입니다 ($IMAGES_DIR). 이전 릴리스 정리는 사람이 판단합니다"
  docker_root=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)
  if [ -n "$docker_root" ] && [ -d "$docker_root" ]; then
    [ "$(free_mb "$docker_root")" -ge "$WOORI_MIN_FREE_MB" ] ||
      die "Docker 저장소 여유가 ${WOORI_MIN_FREE_MB}MB 미만입니다"
  fi
  # Everything is checked on a temporary file; only a verified archive is kept.
  partial=$(mktemp "$dir/.receive.XXXXXX")
  # At most the limit + 1 byte is read, so an endless stream stops here.
  head -c $((WOORI_MAX_ARCHIVE_MB * 1024 * 1024 + 1)) >"$partial"
  bytes=$(size_of "$partial")
  if [ "$bytes" -gt $((WOORI_MAX_ARCHIVE_MB * 1024 * 1024)) ] || [ "$bytes" -eq 0 ]; then
    rm -f "$partial"
    die "이미지 크기가 허용 범위를 벗어났습니다 (${bytes} bytes)"
  fi
  if [ "$(sha256sum "$partial" | cut -d' ' -f1)" != "$sum" ]; then
    rm -f "$partial"
    die "SHA256 불일치: 전송된 이미지를 버렸습니다"
  fi
  if [ -e "$dir/$file" ]; then
    # Kept earlier only after the same checks; never overwritten.
    rm -f "$partial"
    [ "$(sha256sum "$dir/$file" | cut -d' ' -f1)" = "$sum" ] ||
      die "$dir/$file 이 이미 다른 내용으로 있습니다 (덮어쓰지 않음)"
  elif reason=$(python3 -I -c "$ARCHIVE_CHECK_PY" "$partial" "$ref" 2>>"$DOCKER_LOG"); then
    mv "$partial" "$dir/$file"
  else
    rm -f "$partial"
    die "이미지 묶음 검사 실패 (${reason:-읽을 수 없음}): 전송된 이미지를 버렸습니다"
  fi
  printf '%s  %s\n' "$sum" "$file" >"$dir/SHA256SUMS"
  (cd "$dir" && sha256sum -c --quiet SHA256SUMS >/dev/null) || die "sha256sum -c 실패"
  say "SHA256 확인: $file ($((bytes / 1024 / 1024))MB)"

  if docker image inspect "$ref" >/dev/null 2>&1; then
    verify_image "$name" "$release"
    say "이미 로드된 이미지를 사용합니다: $ref"
    return 0
  fi
  before=$(tags_snapshot)
  loaded=true
  docker load -i "$dir/$file" >/dev/null 2>>"$DOCKER_LOG" || loaded=false
  after=$(tags_snapshot)
  added=$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep -v '^$' || true)
  removed=$(comm -23 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep -v '^$' || true)
  if [ -n "$removed" ] || { [ -n "$added" ] && [ "$added" != "$ref ${added##* }" ]; }; then
    # Undo: old tags point back to their images, tags that are new are
    # dropped (only what this load just introduced; no release image goes).
    while IFS= read -r line; do
      [ -z "$line" ] || docker tag "${line##* }" "${line%% *}" 2>>"$DOCKER_LOG" || true
    done <<<"$removed"
    while IFS= read -r line; do
      [ -z "$line" ] || grep -q "^${line%% *} " <<<"$before" ||
        docker image rm --no-prune "${line%% *}" >/dev/null 2>>"$DOCKER_LOG" || true
    done <<<"$added"
    die "docker load 가 $ref 외의 태그를 바꿨습니다: 원래대로 되돌렸습니다"
  fi
  [ "$loaded" = true ] || die "docker load 실패 (호스트 로그 $DOCKER_LOG)"
  verify_image "$name" "$release"
  say "docker load 완료: $ref"
}

cmd_check_worker() {
  need_role worker
  valid_release "$1" "$2"
  verify_image "$1" "$2"
  local out
  if out=$(docker run --rm --pull never --network none "$(image_ref "$1")" node -e "$WORKER_CHECK_JS" "$2" 2>>"$DOCKER_LOG"); then
    say "$out"
  else
    die "${out:-worker --check 실행 실패}"
  fi
}

# scripts/release-db.mjs in the release image. Settings files are copied for
# this one run (0400, the image user) and mounted read-only; node loads them,
# so `docker inspect` never shows a URL. migration.env only for apply.
run_release_db() { # name plan|apply args...
  local name=$1 tmp file code=0 network=() mounts=() files=ledger.env grants
  shift
  [ "$1" != apply ] || files="ledger.env migration.env"
  [ -z "$WOORI_DB_NETWORK" ] || network=(--network "$WOORI_DB_NETWORK")
  grants=$(cat "$WOORI_STATE_DIR/api.grants" 2>/dev/null || echo none)
  tmp=$(mktemp -d "$WOORI_STATE_DIR/run.XXXXXX")
  for file in $files; do
    [ -r "$ENV_DIR/$file" ] || continue
    cp "$ENV_DIR/$file" "$tmp/$file" && chmod 0400 "$tmp/$file" || code=1
    if [ "$(id -u)" = 0 ]; then chown "$WOORI_CONTAINER_UID:$WOORI_CONTAINER_UID" "$tmp/$file" || code=1; fi
    mounts+=(-v "$tmp/$file:/run/woori/$file:ro")
  done
  if [ "$code" -eq 0 ]; then
    docker run --rm --pull never --name "$WOORI_PREFIX-db-$name-$$" ${network[@]+"${network[@]}"} \
      ${mounts[@]+"${mounts[@]}"} -v "$CA_FILE:/run/certs/supabase-ca.crt:ro" \
      -e "WOORI_LOCK_TIMEOUT=$WOORI_LOCK_TIMEOUT" \
      --memory 512m --cpus 1 --security-opt no-new-privileges --cap-drop ALL \
      "$(image_ref "$name")" node --env-file-if-exists=/run/woori/ledger.env \
      --env-file-if-exists=/run/woori/migration.env scripts/release-db.mjs "$@" \
      --applied-grants "$grants" 2>>"$LOG_DIR/db-$name.log" || code=$?
  fi
  rm -rf "$tmp"
  return "$code"
}

cmd_db_plan() { # read-only, inline
  need_role api
  valid_release "$1" "$2"
  verify_image "$1" "$2"
  local code=0
  [ -r "$ENV_DIR/ledger.env" ] || say "ledger.env 없음: 원장을 읽지 못해 매 배포가 승인 대상입니다"
  run_release_db "$1" plan || code=$?
  [ "$code" -ne 21 ] || say "자동 적용 불가 문장이 대기 중입니다: 수동 절차로 적용한 뒤 다시 실행하세요"
  [ "$code" -ne 22 ] || say "migration 기록 문제 (호스트 로그 $LOG_DIR/db-$1.log)"
  return "$code"
}

cmd_db() {
  need_role api
  local name=$1 release=$2 token=$3 out code=0 changes hash
  lock
  verify_image "$name" "$release"
  out=$(run_release_db "$name" plan) || code=$?
  printf '%s\n' "$out"
  case $code in
  0) ;;
  21)
    say "자동 적용 불가 문장이 대기 중입니다 (수동 절차)"
    return 21
    ;;
  *)
    say "DB 계획 실패 (호스트 로그 $LOG_DIR/db-$name.log)"
    return "$code"
    ;;
  esac
  changes=$(sed -n 's/^plan_changes=//p' <<<"$out")
  hash=$(sed -n 's/^plan_hash=//p' <<<"$out")
  if [ "$changes" = false ]; then
    say "운영 DB 변경 없음: 소유자 연결을 쓰지 않습니다"
    say "result=unchanged"
    return 0
  fi
  if [ "$token" != "$hash" ]; then
    say "승인 값이 현재 DB 계획($hash)과 다릅니다. Supabase 백업 확인 후 이 계획을 승인해 다시 실행하세요"
    return 20
  fi
  [ -r "$ENV_DIR/migration.env" ] || die "$ENV_DIR/migration.env 가 없습니다 (일회성 설정)" 2
  out=$(run_release_db "$name" apply --approve "$token") || code=$?
  grep -v '^applied_grants=' <<<"$out" || true
  if [ "$code" -eq 0 ]; then
    hash=$(sed -n 's/^applied_grants=//p' <<<"$out")
    if [[ $hash =~ $SUM_RE ]]; then printf '%s\n' "$hash" >"$WOORI_STATE_DIR/api.grants"; fi
    say "운영 DB: 승인된 계획 적용 완료"
    say "result=replaced"
    return 0
  fi
  case $code in
  20) say "적용 직전 계획이 승인 값과 달라 멈췄습니다" ;;
  21) say "자동 적용 불가 문장이 대기 중입니다 (수동 절차)" ;;
  22) say "migration 기록 문제로 중단했습니다 (호스트 로그 $LOG_DIR/db-$name.log)" ;;
  *) say "DB 단계 실패 (호스트 로그 $LOG_DIR/db-$name.log)" ;;
  esac
  return "$code"
}

cmd_deploy_api() {
  need_role api
  local name=$1 release=$2 contract=$3 ref next=$API-next previous=''
  lock
  recover_role
  verify_image "$name" "$release"
  ref=$(image_ref "$name")
  if exists "$API" && [ "$(field "$API" '{{.Config.Image}}')" = "$ref" ]; then
    wait_api "$API" "$release" "$contract" "$WOORI_HEALTH_TIMEOUT" || die "이미 이 릴리스인데 확인에 실패했습니다"
    say "API가 이미 $name 입니다 (변경 없음)"
    say "result=unchanged"
    return 0
  fi
  docker network inspect "$WOORI_NETWORK" >/dev/null 2>&1 || die "Docker 네트워크 $WOORI_NETWORK 가 없습니다"
  # Holding the lock, a next container is a leftover of a killed run.
  docker rm -f "$next" >/dev/null 2>&1 || true
  run_api "$next" no "$ref" || die "사전 기동 컨테이너를 시작하지 못했습니다 (호스트 로그 $DOCKER_LOG)"
  if ! wait_api "$next" "$release" "$contract" "$WOORI_HEALTH_TIMEOUT"; then
    save_logs "$next"
    docker rm -f "$next" >/dev/null 2>&1 || true
    die "사전 기동 확인 실패: 기존 API는 그대로입니다"
  fi
  docker rm -f "$next" >/dev/null 2>&1 || true
  say "사전 기동 확인 완료, 교체합니다"

  if exists "$API"; then
    previous=$(previous_name "$API")
    write_state "$name" "$previous" '' deploying stop-old
    if ! docker stop -t 30 "$API" >/dev/null 2>>"$DOCKER_LOG" ||
      ! docker rename "$API" "$previous" 2>>"$DOCKER_LOG"; then
      docker start "$API" >/dev/null 2>>"$DOCKER_LOG" || true
      write_state "$name" "$previous" '' rolled-back stop-old
      die "이전 API를 정지·이름 변경하지 못했습니다 (이전 API 재시작)"
    fi
    say "이전 API를 $previous 로 정지 보관"
  fi
  write_state "$name" "$previous" '' deploying start-new
  if run_api "$API" unless-stopped "$ref" &&
    wait_api "$API" "$release" "$contract" "$WOORI_HEALTH_TIMEOUT" &&
    settle "$API" && wait_api "$API" "$release" "$contract" "$WOORI_HEALTH_TIMEOUT"; then
    write_state "$name" "$previous" '' deployed finished
    say "API 교체 완료: $ref"
    say "result=replaced"
    return 0
  fi
  say "새 API 확인 실패: 이전 컨테이너로 되돌립니다"
  write_state "$name" "$previous" '' rolling-back restore
  if converge_api "$name" "$previous" failed; then
    write_state "$name" "$previous" '' rolled-back finished
    die "API 교체 실패 (이전 API 복구됨)"
  fi
  write_state "$name" "$previous" '' rollback-failed restore
  die "API 교체와 복구 모두 실패: 즉시 수동 확인 필요" 3
}

cmd_rollback_api() {
  need_role api
  local name=$1
  lock
  read_state
  if [ "$state_name" = "$name" ] && { [ "$state_status" = deploying ] || [ "$state_status" = rolling-back ]; }; then
    recover_role
    return 0
  fi
  [ "$state_name" = "$name" ] && [ "$state_status" = deployed ] ||
    die "마지막으로 배포 완료된 API가 $name 이 아닙니다 (상태: ${state_name:-없음} ${state_status:-})"
  [ "$(field "$API" '{{.Config.Image}}')" = "$(image_ref "$name")" ] ||
    die "실행 중인 $API 가 $name 이 아닙니다"
  write_state "$name" "$state_previous" '' rolling-back restore
  if converge_api "$name" "$state_previous" rolledback; then
    write_state "$name" "$state_previous" '' rolled-back finished
    say "API를 $state_previous 에서 되돌렸습니다"
    say "result=rolledback"
    return 0
  fi
  write_state "$name" "$state_previous" '' rollback-failed restore
  die "API 되돌리기 실패: 즉시 수동 확인 필요" 3
}

cmd_deploy_worker() {
  need_role worker
  local name=$1 release=$2 ref previous='' others backup since
  lock
  recover_role
  verify_image "$name" "$release"
  ref=$(image_ref "$name")
  if exists "$WORKER" && [ "$(field "$WORKER" '{{.Config.Image}}')" = "$ref" ]; then
    wait_worker "$WORKER" "$release" 10 1970-01-01T00:00:00Z || die "이미 이 릴리스인데 확인에 실패했습니다"
    say "워커가 이미 $name 입니다 (변경 없음)"
    say "result=unchanged"
    return 0
  fi
  cmd_check_worker "$name" "$release"
  # Never two workers: refuse while any other container runs the worker.
  others=$(docker ps --no-trunc --format '{{.Names}}|{{.Command}}' 2>>"$DOCKER_LOG" |
    grep -F 'dist/src/worker/main.js' | cut -d'|' -f1 | grep -vx "$WORKER" || true)
  [ -z "$others" ] || die "다른 워커 컨테이너가 실행 중입니다: $(echo "$others" | tr '\n' ' ')"
  backup=$(backup_image)
  if exists "$WORKER"; then
    previous=$(previous_name "$WORKER")
    write_state "$name" "$previous" "$backup" deploying stop-old
    # SIGTERM drain: a running job goes back to the queue without an attempt.
    if ! docker stop -t 120 "$WORKER" >/dev/null 2>>"$DOCKER_LOG"; then
      docker start "$WORKER" >/dev/null 2>>"$DOCKER_LOG" || true
      write_state "$name" "$previous" "$backup" rolled-back stop-old
      die "이전 워커를 정지하지 못했습니다"
    fi
    say "이전 워커 정지 (종료 코드 $(field "$WORKER" '{{.State.ExitCode}}'))"
    if ! docker rename "$WORKER" "$previous" 2>>"$DOCKER_LOG"; then
      docker start "$WORKER" >/dev/null 2>>"$DOCKER_LOG" || true
      write_state "$name" "$previous" "$backup" rolled-back stop-old
      die "이전 워커 이름을 바꾸지 못했습니다 (이전 워커 재시작)"
    fi
    say "이전 워커를 $previous 로 정지 보관"
  fi
  write_state "$name" "$previous" "$backup" deploying start-new
  since=$(now)
  if run_worker "$WORKER" "$ref" &&
    wait_worker "$WORKER" "$release" "$WOORI_WORKER_START_TIMEOUT" "$since" &&
    settle "$WORKER"; then
    if [ -z "$backup" ]; then
      say "R2 백업 설정 없음: WOORI_IMAGE 갱신 생략"
    elif set_backup_image "$ref"; then
      say "R2 백업 이미지: $backup -> $ref"
    else
      say "R2 백업 설정 갱신 실패: $WOORI_BACKUP_CONF 는 그대로입니다 (워커는 교체됨)"
    fi
    write_state "$name" "$previous" "$backup" deployed finished
    say "워커 교체 완료: $ref"
    say "result=replaced"
    return 0
  fi
  say "새 워커 확인 실패: 이전 워커로 되돌립니다"
  write_state "$name" "$previous" "$backup" rolling-back restore
  if converge_worker "$name" "$previous" failed "$backup"; then
    write_state "$name" "$previous" "$backup" rolled-back finished
    die "워커 교체 실패 (이전 워커 복구됨)"
  fi
  write_state "$name" "$previous" "$backup" rollback-failed restore
  die "워커 교체와 복구 모두 실패: 즉시 수동 확인 필요" 3
}

cmd_rollback_worker() {
  need_role worker
  local name=$1
  lock
  read_state
  if [ "$state_name" = "$name" ] && { [ "$state_status" = deploying ] || [ "$state_status" = rolling-back ]; }; then
    recover_role
    return 0
  fi
  [ "$state_name" = "$name" ] && [ "$state_status" = deployed ] ||
    die "마지막으로 배포 완료된 워커가 $name 이 아닙니다"
  [ "$(field "$WORKER" '{{.Config.Image}}')" = "$(image_ref "$name")" ] ||
    die "실행 중인 $WORKER 가 $name 이 아닙니다"
  { [ -n "$state_previous" ] && exists "$state_previous"; } ||
    die "되돌릴 이전 워커 컨테이너가 없습니다 (현재 워커 유지)"
  write_state "$name" "$state_previous" "$state_backup" rolling-back restore
  if converge_worker "$name" "$state_previous" rolledback "$state_backup"; then
    write_state "$name" "$state_previous" "$state_backup" rolled-back finished
    say "워커를 $state_previous 에서 되돌렸습니다"
    say "result=rolledback"
    return 0
  fi
  write_state "$name" "$state_previous" "$state_backup" rollback-failed restore
  die "워커 되돌리기 실패: 즉시 수동 확인 필요" 3
}

cmd_recover() {
  lock 300
  read_state
  case $state_status in
  deploying | rolling-back) recover_role ;;
  *) say "복구할 작업이 없습니다 (상태: ${state_status:-없음})" ;;
  esac
}

# Mutating commands run detached from the SSH session; this process only
# follows the job's log and exits with its result (4 if it vanished).
# setsid (a new session, out of reach of sshd's hangup) is the tested path;
# WOORI_DETACH=systemd runs the job as a transient unit instead, which also
# survives logind's KillUserProcesses=yes (Ubuntu's default is no).
detach_mode() {
  case $WOORI_DETACH in
  auto)
    if command -v setsid >/dev/null 2>&1; then
      echo setsid
    elif command -v systemd-run >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
      echo systemd
    else echo background; fi
    ;;
  *) echo "$WOORI_DETACH" ;;
  esac
}

launch() { # command args...
  local id
  id="$(date -u +%Y%m%d%H%M%S)-$$-$1"
  : >"$JOBS/$id.log"
  printf '%s\n' "$*" >"$JOBS/$id.cmd"
  printf '%s\n' "$id" >"$JOBS/last.tmp"
  mv "$JOBS/last.tmp" "$JOBS/last"
  case $(detach_mode) in
  systemd)
    systemd-run --quiet --collect --unit "woori-deploy-$id" --property=Type=exec \
      "$BASH" "$SELF" run-job "$id" "$@" >/dev/null 2>>"$LOG_DIR/launch.log" ||
      die "작업을 시작하지 못했습니다 (systemd-run)"
    ;;
  setsid)
    setsid -f "$BASH" "$SELF" run-job "$id" "$@" </dev/null >/dev/null 2>&1 ||
      die "작업을 시작하지 못했습니다 (setsid)"
    ;;
  # Job control puts the job in its own process group, out of reach of a
  # hangup sent to the SSH session's group (setsid/systemd do more).
  *) (
    set -m
    "$BASH" "$SELF" run-job "$id" "$@" </dev/null >/dev/null 2>&1 &
  ) ;;
  esac
  say "job=$id"
  follow "$id"
}

follow() { # id
  local id=$1 log="$JOBS/$1.log" offset=0 size state
  while :; do
    size=$(size_of "$log")
    if [ "$size" -gt "$offset" ]; then
      tail -c +$((offset + 1)) "$log" 2>/dev/null | head -c $((size - offset)) 2>/dev/null || true
      offset=$size
    fi
    state=$(job_state "$id")
    if [ "$state" = finished ]; then
      size=$(size_of "$log")
      [ "$size" -le "$offset" ] || tail -c +$((offset + 1)) "$log" 2>/dev/null || true
      return "$(cat "$JOBS/$id.rc")"
    fi
    if [ "$state" = died ]; then
      say "작업 $id 가 결과 없이 끝났습니다: recover 로 상태를 맞추세요"
      return 4
    fi
    sleep 1
  done
}

# The work runs in this very process (no subshell): if the job is killed,
# nothing carries on unseen; whatever way it exits, the EXIT trap records the
# code.
JOB_ID=''
record_result() {
  local code=$?
  [ -z "$JOB_ID" ] || {
    printf '%s\n' "$code" >"$JOBS/$JOB_ID.rc.tmp"
    mv "$JOBS/$JOB_ID.rc.tmp" "$JOBS/$JOB_ID.rc"
  }
}
cmd_run_job() { # id command args... (started by launch only)
  [[ $1 =~ $JOB_RE ]] && [ -f "$JOBS/$1.cmd" ] || die "작업이 없습니다" 2
  JOB_ID=$1
  shift
  trap '' HUP INT PIPE
  trap record_result EXIT
  exec </dev/null >>"$JOBS/$JOB_ID.log" 2>&1
  printf '%s\n' "$$" >"$JOBS/$JOB_ID.pid"
  run_command "$@"
}

run_command() {
  local command=$1
  shift
  case $command in
  db) cmd_db "$@" ;;
  deploy-api) cmd_deploy_api "$@" ;;
  rollback-api) cmd_rollback_api "$@" ;;
  deploy-worker) cmd_deploy_worker "$@" ;;
  rollback-worker) cmd_rollback_worker "$@" ;;
  recover) cmd_recover ;;
  *) die "허용되지 않은 명령입니다" 2 ;;
  esac
}

# Arguments are validated before a job starts, so usage errors return at once.
dispatch() {
  local command=${1:-}
  shift || true
  case "$command:$#" in
  status:0) cmd_status ;;
  has-image:2) cmd_has_image "$@" ;;
  job:1) cmd_job "$@" ;;
  receive:3) cmd_receive "$@" ;;
  check-worker:2) cmd_check_worker "$@" ;;
  db-plan:2) cmd_db_plan "$@" ;;
  db:3)
    need_role api
    valid_release "$1" "$2"
    [ "$3" = none ] || [[ $3 =~ $SUM_RE ]] || die "승인 값 형식 오류" 2
    launch db "$@"
    ;;
  deploy-api:3)
    need_role api
    valid_release "$1" "$2"
    [ "$3" = - ] || [[ $3 =~ $VERSION_RE ]] || die "contract 형식 오류" 2
    launch deploy-api "$@"
    ;;
  deploy-worker:2)
    need_role worker
    valid_release "$1" "$2"
    launch deploy-worker "$@"
    ;;
  rollback-api:1 | rollback-worker:1)
    need_role "${command#rollback-}"
    [[ $1 =~ $NAME_RE ]] || die "릴리스 이름 형식 오류" 2
    launch "$command" "$@"
    ;;
  recover:0) launch recover ;;
  *) die "허용되지 않은 명령입니다" 2 ;;
  esac
}

if [ "${1:-}" = ssh ] && [ $# -eq 1 ]; then
  # Forced command: the client's text is split on spaces and never evaluated.
  original=${SSH_ORIGINAL_COMMAND:-}
  command_re='^[A-Za-z0-9._ -]+$'
  [ "${#original}" -le 300 ] && [[ $original =~ $command_re ]] || die "허용되지 않은 명령입니다" 2
  read -r -a words <<<"$original"
  dispatch ${words[@]+"${words[@]}"}
elif [ "${1:-}" = run-job ]; then
  shift
  cmd_run_job "$@"
else
  dispatch "$@"
fi
