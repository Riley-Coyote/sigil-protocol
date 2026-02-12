#!/usr/bin/env bash
set -euo pipefail

# Generic zero-friction deploy helper for a single-node SIGIL host.
# Required env vars:
#   DEPLOY_HOST          e.g. sigilprotocol.xyz
#   DEPLOY_PATH          e.g. /srv/sigil-site
# Optional env vars:
#   DEPLOY_USER          default: $USER
#   DEPLOY_PORT          default: 22
#   DEPLOY_SERVICE       systemd service name (default: sigil-site)
#   DEPLOY_USE_PM2       if set to 1, restart with pm2 instead of systemd
#   DEPLOY_HEALTH_URL    default: http://127.0.0.1:3141/api/health

if [[ -z "${DEPLOY_HOST:-}" ]]; then
  echo "DEPLOY_HOST is required" >&2
  exit 1
fi
if [[ -z "${DEPLOY_PATH:-}" ]]; then
  echo "DEPLOY_PATH is required" >&2
  exit 1
fi

DEPLOY_USER="${DEPLOY_USER:-$USER}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"
DEPLOY_SERVICE="${DEPLOY_SERVICE:-sigil-site}"
DEPLOY_HEALTH_URL="${DEPLOY_HEALTH_URL:-http://127.0.0.1:3141/api/health}"
REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"

rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'output/' \
  --exclude 'api/db/*.db' \
  --exclude 'api/db/*.db-shm' \
  --exclude 'api/db/*.db-wal' \
  -e "ssh -p ${DEPLOY_PORT}" \
  ./ "${REMOTE}:${DEPLOY_PATH}/"

ssh -p "${DEPLOY_PORT}" "${REMOTE}" "bash -s" <<REMOTE_SH
set -euo pipefail
cd "${DEPLOY_PATH}"
npm ci --omit=dev

if [[ "${DEPLOY_USE_PM2:-0}" == "1" ]]; then
  pm2 restart sigil-site || pm2 start api/server.mjs --name sigil-site
else
  sudo systemctl daemon-reload || true
  sudo systemctl restart "${DEPLOY_SERVICE}"
fi

curl -fsS "${DEPLOY_HEALTH_URL}" >/dev/null
REMOTE_SH

echo "Deploy completed and health check passed."
