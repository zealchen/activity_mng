#!/usr/bin/env bash
# Shared environment for the local scripts. Reads the LocalStack Pro token
# from ~/.genesis/config without exporting anything else from that file.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
CONFIG="${GENESIS_CONFIG:-$HOME/.genesis/config}"
if [[ -z "${LOCALSTACK_AUTH_TOKEN:-}" && -f "$CONFIG" ]]; then
  LOCALSTACK_AUTH_TOKEN="$(grep -E '^LOCALSTACK_AUTH_TOKEN=' "$CONFIG" | head -1 | cut -d= -f2- | tr -d '"'"'")"
fi
: "${LOCALSTACK_AUTH_TOKEN:?LOCALSTACK_AUTH_TOKEN not found in $CONFIG}"
export LOCALSTACK_AUTH_TOKEN
export LS="http://localhost:4666"
export ADMIN_KEY="${ADMIN_KEY:-local-admin}"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
awsl() { aws --endpoint-url "$LS" "$@"; }
