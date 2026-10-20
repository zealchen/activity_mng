#!/usr/bin/env bash
# Apply infra/cloud/dev to the real AWS account. Idempotent - re-run any time.
#
# Steps:
#   1. Check toolchain (aws, terraform, jq, npm).
#   2. Verify AWS creds match aws_account_id in terraform.tfvars.
#   3. First run: create the versioned/encrypted S3 state bucket (locking is an
#      S3 lockfile, so there is no DynamoDB lock table).
#   4. Resolve the admin key: TF_VAR_admin_key, else the one the deployed Lambda
#      already uses, else a new random one.
#   5. npm ci the backend (the Lambda zip includes node_modules), terraform init,
#      plan, apply (confirmation unless --yes; --plan-only stops after plan).
#   6. Wire GitHub: create the "dev" environment and set AWS_ACCOUNT_ID,
#      AWS_DEPLOY_ROLE_ARN, ADMIN_KEY, and AUTO_PUBLISH=false if unset.
#      Skip with --no-github or when gh is absent/unauthenticated.
#
# Required env:
#   AWS_PROFILE (default: neo) or working AWS credentials
#
# Flags: --plan-only  --yes  --no-github

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf "\033[1;34m[bootstrap-cloud]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[bootstrap-cloud] WARN:\033[0m %s\n" "$*" >&2; }
fail() { printf "\033[1;31m[bootstrap-cloud] ERROR:\033[0m %s\n" "$*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"; }

PLAN_ONLY=""
ASSUME_YES=""
SKIP_GITHUB=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --plan-only) PLAN_ONLY="1"; shift ;;
    --yes)       ASSUME_YES="1"; shift ;;
    --no-github) SKIP_GITHUB="1"; shift ;;
    -h|--help)   echo "Usage: $0 [--plan-only] [--yes] [--no-github]"; exit 0 ;;
    *) fail "unknown flag: $1" ;;
  esac
done

export AWS_PROFILE="${AWS_PROFILE:-neo}"

log "Checking toolchain"
for c in aws terraform jq npm; do require_cmd "$c"; done

INFRA_DIR="infra/cloud/dev"
BACKEND_FILE="$INFRA_DIR/backend.hcl"
TFVARS_FILE="$INFRA_DIR/terraform.tfvars"
tfvar() { awk -F'[ \t]*=[ \t]*' -v k="$1" '$1 == k {gsub(/[" ]/,"",$2); print $2}' "$2"; }

STATE_BUCKET="$(tfvar bucket "$BACKEND_FILE")"
REGION="$(tfvar region "$BACKEND_FILE")"
EXPECTED_ACCOUNT="$(tfvar aws_account_id "$TFVARS_FILE")"
PROJECT="$(tfvar project "$TFVARS_FILE")"
[ -n "$STATE_BUCKET" ] && [ -n "$REGION" ] || fail "could not read bucket/region from $BACKEND_FILE"
[ -n "$EXPECTED_ACCOUNT" ] && [ -n "$PROJECT" ] || fail "could not read aws_account_id/project from $TFVARS_FILE"
export AWS_REGION="$REGION"

log "Verifying AWS credentials (profile $AWS_PROFILE) target account $EXPECTED_ACCOUNT"
ACTUAL_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
[ "$ACTUAL_ACCOUNT" = "$EXPECTED_ACCOUNT" ] \
  || fail "current AWS creds are for account $ACTUAL_ACCOUNT but $TFVARS_FILE expects $EXPECTED_ACCOUNT"

if aws s3api head-bucket --bucket "$STATE_BUCKET" >/dev/null 2>&1; then
  log "State bucket $STATE_BUCKET exists"
else
  log "Creating state bucket $STATE_BUCKET in $REGION"
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$STATE_BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$STATE_BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  aws s3api put-bucket-versioning --bucket "$STATE_BUCKET" --versioning-configuration Status=Enabled
  aws s3api put-bucket-encryption --bucket "$STATE_BUCKET" \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws s3api put-public-access-block --bucket "$STATE_BUCKET" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

if [ -z "${TF_VAR_admin_key:-}" ]; then
  TF_VAR_admin_key="$(aws lambda get-function-configuration --function-name "$PROJECT-dev-api" \
    --query 'Environment.Variables.ADMIN_KEY' --output text 2>/dev/null || true)"
  if [ -n "$TF_VAR_admin_key" ] && [ "$TF_VAR_admin_key" != "None" ]; then
    log "Reusing the admin key of the deployed API"
  else
    TF_VAR_admin_key="$(openssl rand -hex 16)"
    log "Generated a new admin key"
  fi
fi
export TF_VAR_admin_key

log "Installing backend dependencies (packaged into the Lambda zip)"
(cd backend && npm ci --omit=dev --no-audit --no-fund --silent)

log "Running terraform init"
terraform -chdir="$INFRA_DIR" init -input=false -reconfigure -backend-config=backend.hcl >/dev/null

log "Running terraform plan"
terraform -chdir="$INFRA_DIR" plan -input=false -var-file=terraform.tfvars -out=tfplan

if [ -n "$PLAN_ONLY" ]; then
  rm -f "$INFRA_DIR/tfplan"
  log "--plan-only: skipping apply"
  exit 0
fi

if [ -z "$ASSUME_YES" ]; then
  read -r -p "Apply the plan above to AWS account $EXPECTED_ACCOUNT? [type 'apply' to proceed] " confirm
  [ "$confirm" = "apply" ] || { rm -f "$INFRA_DIR/tfplan"; fail "aborted by user"; }
fi

log "Running terraform apply"
terraform -chdir="$INFRA_DIR" apply -input=false tfplan
rm -f "$INFRA_DIR/tfplan"

API_URL="$(terraform -chdir="$INFRA_DIR" output -raw api_base_url)"
WEB_URL="$(terraform -chdir="$INFRA_DIR" output -raw web_url)"
OIDC_ROLE_ARN="$(terraform -chdir="$INFRA_DIR" output -raw github_oidc_role_arn)"

log "Smoke test $API_URL/health"
for i in 1 2 3 4 5; do curl -fsS -m 10 "$API_URL/health" >/dev/null && break; sleep 5; done
curl -fsS -m 10 "$API_URL/health" >/dev/null || warn "API /health did not answer yet"

# --- GitHub wiring --------------------------------------------------------
REPO_SLUG="$(tfvar github_owner "$TFVARS_FILE")/$(tfvar github_repo "$TFVARS_FILE")"
print_github_manual() {
  cat <<MANUAL
Wire these yourself once gh is ready (repo $REPO_SLUG):
  gh api --method PUT repos/$REPO_SLUG/environments/dev
  gh variable set AWS_ACCOUNT_ID      --repo $REPO_SLUG --env dev --body $EXPECTED_ACCOUNT
  gh secret   set AWS_DEPLOY_ROLE_ARN --repo $REPO_SLUG --env dev --body $OIDC_ROLE_ARN
  gh secret   set ADMIN_KEY           --repo $REPO_SLUG --env dev   # paste the admin key
  gh variable set AUTO_PUBLISH        --repo $REPO_SLUG --body false
MANUAL
}

if [ -n "$SKIP_GITHUB" ]; then
  log "--no-github: skipping GitHub wiring"; print_github_manual
elif ! command -v gh >/dev/null 2>&1; then
  warn "gh CLI not found - skipping GitHub wiring."; print_github_manual
elif ! gh auth status >/dev/null 2>&1; then
  warn "gh is not authenticated (run 'gh auth login') - skipping GitHub wiring."; print_github_manual
else
  log "Wiring GitHub secrets/variables on $REPO_SLUG (environment: dev)"
  gh api --method PUT "repos/$REPO_SLUG/environments/dev" >/dev/null
  gh variable set AWS_ACCOUNT_ID      --repo "$REPO_SLUG" --env dev --body "$EXPECTED_ACCOUNT"
  gh secret   set AWS_DEPLOY_ROLE_ARN --repo "$REPO_SLUG" --env dev --body "$OIDC_ROLE_ARN"
  gh secret   set ADMIN_KEY           --repo "$REPO_SLUG" --env dev --body "$TF_VAR_admin_key"
  # Never clobber a deliberate AUTO_PUBLISH=true.
  if gh variable list --repo "$REPO_SLUG" 2>/dev/null | grep -q '^AUTO_PUBLISH'; then
    log "AUTO_PUBLISH already set - leaving as-is"
  else
    gh variable set AUTO_PUBLISH --repo "$REPO_SLUG" --body false
  fi
fi

cat <<NEXT_STEPS

──────────────────────────────────────────────────────────────────
Dev is up.
  Dashboard : $WEB_URL
  API       : $API_URL
  Admin key : $TF_VAR_admin_key   (also the ADMIN_KEY secret of the GitHub "dev" environment)

Next:
  1. Load the playbook and people (sends nothing):
       API=$API_URL ADMIN_KEY=<admin key> node scripts/seed.mjs
  2. Later deploys: Actions -> Publish (dev). To deploy on every merge to main:
       gh variable set AUTO_PUBLISH --repo $REPO_SLUG --body true
  3. Tear down: scripts/teardown-dev.sh
──────────────────────────────────────────────────────────────────
NEXT_STEPS
log "Done."
