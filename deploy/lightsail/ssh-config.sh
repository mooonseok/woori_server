#!/bin/bash
# Writes the SSH settings deploy-release.sh uses, from the deployment
# environment's values (.github/workflows/deploy.yml), into a private folder:
#   <dir>/key (0600), <dir>/known_hosts, <dir>/config  (prints the config path)
# Every value is checked before it reaches ssh_config: host names/IPs, port and
# user by pattern (no spaces or line breaks can add options), known_hosts as
# plain host-key lines that cover both hosts (no @cert-authority/@revoked
# markers), and the key by `ssh-keygen -y` (it must parse, without a
# passphrase). Prints no value.
#   SSH_KEY KNOWN_HOSTS API_HOST [API_PORT=22] WORKER_HOST [SSH_USER=woori-deploy]
#   bash deploy/lightsail/ssh-config.sh <dir>
# The worker is reached through the API host (ProxyJump), whose key allows a
# forward to the worker's SSH port only.
set -euo pipefail
umask 077

fail() {
  printf '[ssh-config] 실패: %s\n' "$1" >&2
  exit 2
}
dir=${1:-}
[ -n "$dir" ] || fail "사용법: ssh-config.sh <dir>"
SSH_KEY=${SSH_KEY:-}
KNOWN_HOSTS=${KNOWN_HOSTS:-}
API_HOST=${API_HOST:-}
WORKER_HOST=${WORKER_HOST:-}
API_PORT=${API_PORT:-22}
SSH_USER=${SSH_USER:-woori-deploy}
for name in SSH_KEY KNOWN_HOSTS API_HOST WORKER_HOST; do
  [ -n "${!name:-}" ] || fail "배포 설정 $name 이 없습니다"
done
host_re='^([A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|[0-9A-Fa-f:]{2,39})$'
for name in API_HOST WORKER_HOST; do
  [[ ${!name} =~ $host_re ]] || fail "$name 은 호스트 이름이나 IP 주소여야 합니다"
done
[[ $API_PORT =~ ^[0-9]{1,5}$ ]] && [ "$API_PORT" -ge 1 ] && [ "$API_PORT" -le 65535 ] ||
  fail "API_PORT 형식 오류"
[[ $SSH_USER =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail "SSH_USER 형식 오류"

mkdir -p "$dir"
chmod 700 "$dir"
key_line='^(\|1\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+|(\[[A-Za-z0-9.:-]+\]:[0-9]{1,5}|[A-Za-z0-9.:-]+)(,(\[[A-Za-z0-9.:-]+\]:[0-9]{1,5}|[A-Za-z0-9.:-]+))*) (ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|rsa-sha2-256|rsa-sha2-512|ssh-rsa) [A-Za-z0-9+/]+={0,3}( [ -~]*)?$'
: >"$dir/known_hosts"
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%$'\r'}
  case $line in '' | '#'*) continue ;; esac
  [[ $line =~ $key_line ]] || fail "DEPLOY_SSH_KNOWN_HOSTS 에 호스트 키 줄이 아닌 내용이 있습니다"
  printf '%s\n' "$line" >>"$dir/known_hosts"
done <<<"$KNOWN_HOSTS"
api_entry=$API_HOST
[ "$API_PORT" = 22 ] || api_entry="[$API_HOST]:$API_PORT"
for entry in "$api_entry" "$WORKER_HOST"; do
  ssh-keygen -F "$entry" -f "$dir/known_hosts" >/dev/null 2>&1 ||
    fail "DEPLOY_SSH_KNOWN_HOSTS 에 배포 대상 호스트의 키가 없습니다"
done

printf '%s\n' "$SSH_KEY" | tr -d '\r' >"$dir/key"
chmod 600 "$dir/key"
ssh-keygen -y -P '' -f "$dir/key" >/dev/null 2>&1 ||
  fail "DEPLOY_SSH_KEY 를 읽을 수 없습니다 (암호 없는 개인키여야 합니다)"

cat >"$dir/config" <<EOF
Host woori-api
  HostName $API_HOST
  Port $API_PORT
  User $SSH_USER
Host woori-worker
  HostName $WORKER_HOST
  User $SSH_USER
  ProxyJump woori-api
Host *
  IdentityFile $dir/key
  IdentitiesOnly yes
  UserKnownHostsFile $dir/known_hosts
  GlobalKnownHostsFile /dev/null
  StrictHostKeyChecking yes
  BatchMode yes
  ConnectTimeout 20
  ServerAliveInterval 15
  ServerAliveCountMax 8
  LogLevel ERROR
EOF
printf '%s\n' "$dir/config"
