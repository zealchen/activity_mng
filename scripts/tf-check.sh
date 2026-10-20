#!/usr/bin/env bash
# `terraform fmt -check` over infra/ and `terraform validate` for each Terraform
# working directory. Run by CI (_checks.yml) and before any infra PR.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v terraform >/dev/null 2>&1; then
  echo "tf-check skipped - terraform not installed locally"
  exit 0
fi

echo "==> terraform fmt -check -recursive infra"
terraform fmt -check -recursive infra

for dir in infra/local infra/cloud/dev; do
  echo "==> terraform validate $dir"
  terraform -chdir="$dir" init -backend=false -input=false >/dev/null
  terraform -chdir="$dir" validate
done

echo "tf-check OK"
