#!/usr/bin/env bash
# Tear down the entire infra/cloud/dev stack: Lambdas, API Gateway, DynamoDB
# table (every event, person and message), both S3 buckets (website + receipt
# photos), SNS topic, IAM roles, the GitHub OIDC deploy role, and the Lambda log
# groups (which Lambda creates itself, outside terraform).
#
# Irreversible - there is no backup. Confirms once unless --yes.
#
# Flags:
#   --yes     skip the confirmation prompt
#   --purge   also delete the terraform state bucket (nothing of dev is left)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf "\033[1;34m[teardown-dev]\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m[teardown-dev] ERROR:\033[0m %s\n" "$*" >&2; exit 1; }

ASSUME_YES=""
PURGE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes)   ASSUME_YES="1"; shift ;;
    --purge) PURGE="1"; shift ;;
    -h|--help) echo "Usage: $0 [--yes] [--purge]"; exit 0 ;;
    *) fail "unknown flag: $1" ;;
  esac
done

export AWS_PROFILE="${AWS_PROFILE:-neo}"
for c in aws terraform jq; do command -v "$c" >/dev/null 2>&1 || fail "missing required command: $c"; done

INFRA_DIR="infra/cloud/dev"
tfvar() { awk -F'[ \t]*=[ \t]*' -v k="$1" '$1 == k {gsub(/[" ]/,"",$2); print $2}' "$2"; }
STATE_BUCKET="$(tfvar bucket "$INFRA_DIR/backend.hcl")"
EXPECTED_ACCOUNT="$(tfvar aws_account_id "$INFRA_DIR/terraform.tfvars")"
PREFIX="$(tfvar project "$INFRA_DIR/terraform.tfvars")-dev"
export AWS_REGION="$(tfvar region "$INFRA_DIR/backend.hcl")"

ACTUAL_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
[ "$ACTUAL_ACCOUNT" = "$EXPECTED_ACCOUNT" ] \
  || fail "current AWS creds are for account $ACTUAL_ACCOUNT but dev lives in $EXPECTED_ACCOUNT"

aws s3api head-bucket --bucket "$STATE_BUCKET" >/dev/null 2>&1 \
  || { log "State bucket $STATE_BUCKET not found - dev was never bootstrapped, nothing to tear down"; exit 0; }

log "This will DESTROY dev ($PREFIX-*) in account $EXPECTED_ACCOUNT, data and receipt photos included."
[ -n "$PURGE" ] && log "--purge: the state bucket $STATE_BUCKET is deleted too."
if [ -z "$ASSUME_YES" ]; then
  read -r -p "Type 'destroy' to proceed: " confirm
  [ "$confirm" = "destroy" ] || fail "aborted by user"
fi

log "Running terraform destroy"
terraform -chdir="$INFRA_DIR" init -input=false -reconfigure -backend-config=backend.hcl >/dev/null
# destroy still validates variables; the admin key's value is irrelevant here.
TF_VAR_admin_key="${TF_VAR_admin_key:-teardown-placeholder-key}" \
  terraform -chdir="$INFRA_DIR" destroy -input=false -auto-approve -var-file=terraform.tfvars

for g in $(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/$PREFIX-" --query 'logGroups[].logGroupName' --output text); do
  aws logs delete-log-group --log-group-name "$g" && log "Deleted log group $g"
done

if [ -n "$PURGE" ]; then
  log "Deleting state bucket $STATE_BUCKET (all versions)"
  VERSIONS="$(aws s3api list-object-versions --bucket "$STATE_BUCKET" --output json \
    --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}}')"
  if [ "$(jq '.Objects | length' <<<"$VERSIONS")" -gt 0 ]; then
    aws s3api delete-objects --bucket "$STATE_BUCKET" --delete "$VERSIONS" >/dev/null
  fi
  aws s3api delete-bucket --bucket "$STATE_BUCKET"
  rm -rf "$INFRA_DIR/.terraform"
else
  log "Kept the state bucket $STATE_BUCKET - harmless, and reused if dev is rebuilt (--purge removes it)."
fi
log "Done. The GitHub \"dev\" environment secrets still point at the deleted role; scripts/bootstrap-cloud.sh rewires them."
