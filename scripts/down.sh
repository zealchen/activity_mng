#!/usr/bin/env bash
# Stop LocalStack and forget all local data.
source "$(dirname "$0")/env.sh"
cd "$ROOT"
docker compose down -v
rm -rf infra/local/terraform.tfstate* .build
echo "Stopped. Run scripts/up.sh to start again."
