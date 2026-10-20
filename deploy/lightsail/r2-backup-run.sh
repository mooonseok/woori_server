#!/usr/bin/env bash
# Daily R2 backup on the Lightsail worker host (template; see SETUP.md
# "백업과 복원 훈련"). Installed as /usr/local/lib/woori/r2-backup-run.sh and
# started only by woori-r2-backup.service. Copies production -> backup bucket
# with the release image; never prunes (pruning stays a manual decision).
#   /etc/woori/r2-backup.conf  WOORI_IMAGE=woori-server:<tag> (not secret)
#   /etc/woori/r2-backup.env   root 0600: R2_ACCOUNT_ID, R2_BUCKET,
#                              R2_BACKUP_BUCKET, R2_BACKUP_ACCESS_KEY_ID,
#                              R2_BACKUP_SECRET_ACCESS_KEY (no quotes/export)
#   /etc/woori/r2-backup.ping  optional, root 0600: one Healthchecks-style
#                              check URL; /start and /<exit code> are appended
# Run it by hand only through `systemctl start woori-r2-backup.service`, so the
# lock below also covers manual runs.
# Exit code is the backup's: 0 ok, 1 failed/partial/aborted, 2 settings,
# 3 ok but the manifest nears its size limit (set a retention period); 124
# timeout and 125 docker errors come from timeout/docker. Non-zero = alert.
set -uo pipefail
: "${WOORI_IMAGE:?WOORI_IMAGE is not set (/etc/woori/r2-backup.conf)}"
env_file=/etc/woori/r2-backup.env
ping_file=/etc/woori/r2-backup.ping

ping() {
  [ -r "$ping_file" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "$(head -n 1 "$ping_file")$1" || true
}

# Two runs never overlap (root-only lock path).
exec 9>/run/woori-r2-backup.lock
if ! flock -n 9; then
  echo '{"status":"skipped","reason":"already-running"}'
  exit 0
fi

ping /start
# Holding the lock, any container left by a killed earlier run is stale.
docker rm -f woori-r2-backup >/dev/null 2>&1 || true
# Stopping the service signals the docker client, which forwards it to the
# container (sig-proxy); `timeout` then ends the backup.
docker run --rm --pull never --name woori-r2-backup \
  --env-file "$env_file" \
  --memory 512m --cpus 1 \
  --security-opt no-new-privileges --cap-drop ALL \
  "$WOORI_IMAGE" timeout 150m node scripts/r2-backup.mjs --apply
code=$?
ping "/$code"
exit "$code"
