#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/dm-online"
APP_USER="dm-online"
NODE_VERSION="22.22.2"
SERVICE_FILE="/etc/systemd/system/dm-online.service"
NGINX_FILE="/etc/nginx/conf.d/dm-online.conf"
ENV_FILE="/etc/dm-online.env"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root." >&2
  exit 1
fi

ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64 | arm64) NODE_ARCH="arm64" ;;
  *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl xz-utils nginx rsync ca-certificates

if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --home /var/lib/dm-online --shell /usr/sbin/nologin "${APP_USER}"
fi

mkdir -p /var/lib/dm-online "${APP_DIR}"
chown -R "${APP_USER}:${APP_USER}" /var/lib/dm-online

NODE_DIR="/opt/node-v${NODE_VERSION}-linux-${NODE_ARCH}"
if [[ ! -x "${NODE_DIR}/bin/node" ]]; then
  TMP_TAR="/tmp/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  curl -fsSL "https://nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o "${TMP_TAR}"
  tar -xJf "${TMP_TAR}" -C /opt
fi
ln -sf "${NODE_DIR}/bin/node" /usr/local/bin/node
ln -sf "${NODE_DIR}/bin/npm" /usr/local/bin/npm
ln -sf "${NODE_DIR}/bin/npx" /usr/local/bin/npx

node -e "require('node:sqlite'); console.log(process.version)"

cd "${APP_DIR}"
npm install
npm test

if [[ ! -f "${ENV_FILE}" ]]; then
  cat > "${ENV_FILE}" <<'ENV'
PORT=4173
HOST=127.0.0.1
DATA_DIR=/var/lib/dm-online
AI_BASE_URL=
AI_API_KEY=
AI_MODEL=gpt-4.1-mini
AI_TEMPERATURE=0.8
AI_TIMEOUT_MS=240000
AI_LOCAL_FALLBACK=true
ENV
  chmod 600 "${ENV_FILE}"
fi

cp deploy/dm-online.service "${SERVICE_FILE}"
cp deploy/nginx-dm-online.conf "${NGINX_FILE}"
rm -f /etc/nginx/sites-enabled/default

systemctl daemon-reload
systemctl enable dm-online
systemctl restart dm-online

nginx -t
systemctl reload nginx

sleep 1
curl -fsS http://127.0.0.1:4173/api/health
echo
systemctl status dm-online --no-pager -l
