#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/dm-online.env}"
SERVICE_NAME="${SERVICE_NAME:-dm-online}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4173/api/health}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root." >&2
  exit 1
fi

required_vars=(AI_BASE_URL AI_API_KEY AI_MODEL)
for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    echo "${var_name} is required." >&2
    exit 1
  fi
done

tmp_file="$(mktemp)"
if [[ -f "${ENV_FILE}" ]]; then
  cp "${ENV_FILE}" "${tmp_file}"
fi

set_kv() {
  local key="$1"
  local value="$2"
  local escaped
  escaped="$(printf '%s' "${value}" | sed -e 's/[\/&]/\\&/g')"
  if grep -q "^${key}=" "${tmp_file}"; then
    sed -i "s/^${key}=.*/${key}=${escaped}/" "${tmp_file}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${tmp_file}"
  fi
}

set_kv PORT "${PORT:-4173}"
set_kv HOST "${HOST:-127.0.0.1}"
set_kv DATA_DIR "${DATA_DIR:-/var/lib/dm-online}"
set_kv AI_BASE_URL "${AI_BASE_URL}"
set_kv AI_API_KEY "${AI_API_KEY}"
set_kv AI_MODEL "${AI_MODEL}"
set_kv AI_TEMPERATURE "${AI_TEMPERATURE:-0.8}"
set_kv AI_TIMEOUT_MS "${AI_TIMEOUT_MS:-120000}"
set_kv AI_LOCAL_FALLBACK "${AI_LOCAL_FALLBACK:-false}"

install -m 600 -o root -g root "${tmp_file}" "${ENV_FILE}"
rm -f "${tmp_file}"

systemctl restart "${SERVICE_NAME}"
sleep 1
systemctl is-active --quiet "${SERVICE_NAME}"

health="$(curl -fsS "${HEALTH_URL}")"
case "${health}" in
  *'"aiConfigured":true'*)
    echo "AI configuration applied and ${SERVICE_NAME} is healthy."
    ;;
  *)
    echo "Service is reachable, but health check did not report aiConfigured=true:" >&2
    echo "${health}" >&2
    exit 1
    ;;
esac
