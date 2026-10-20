#!/usr/bin/env bash
# One command: start LocalStack, deploy everything, load the GSC 2026 data.
#   scripts/up.sh            first run / after code changes (idempotent)
#   scripts/up.sh --reset    wipe LocalStack and start from scratch
source "$(dirname "$0")/env.sh"
cd "$ROOT"

if [[ "${1:-}" == "--reset" ]]; then
  docker compose down -v >/dev/null 2>&1 || true
  rm -rf infra/local/terraform.tfstate* .build
fi

echo "==> Starting LocalStack Pro on :4666"
docker compose up -d
for i in $(seq 1 60); do
  if curl -fs "$LS/_localstack/health" | grep -q '"dynamodb"'; then break; fi
  sleep 2
done
curl -fs "$LS/_localstack/health" >/dev/null || { echo "LocalStack did not start"; docker compose logs --tail 50; exit 1; }

echo "==> Installing backend dependencies"
(cd backend && npm install --omit=dev --no-audit --no-fund --silent)

echo "==> Deploying (terraform)"
cd infra/local
terraform init -input=false -upgrade >/dev/null
terraform apply -input=false -auto-approve -var "admin_key=$ADMIN_KEY" >/tmp/activity-mng-apply.log 2>&1 || { tail -40 /tmp/activity-mng-apply.log; exit 1; }
API="$(terraform output -raw api_endpoint)"
WEB="$(terraform output -raw web_url)"
cd "$ROOT"

echo "==> Waiting for the API"
for i in $(seq 1 30); do curl -fs "$API/health" >/dev/null && break; sleep 2; done
curl -fs "$API/health" >/dev/null || { echo "API not answering at $API"; exit 1; }

if [[ "${SEED:-1}" == "1" ]]; then
  echo "==> Loading playbook, people and the GSC 2026 event"
  API="$API" ADMIN_KEY="$ADMIN_KEY" node scripts/seed.mjs
fi

cat <<EOF

Ready.
  Dashboard : $WEB/index.html      (admin key: $ADMIN_KEY)
  API       : $API
  Emails    : $LS/_aws/ses          (every email LocalStack "sent")
  Texts     : $LS/_aws/sns/sms-messages
EOF
