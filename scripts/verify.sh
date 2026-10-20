#!/usr/bin/env bash
# Full verification on a clean LocalStack: unit tests, deploy, end-to-end flow,
# then a clean re-seed so the stack is ready for a manual walkthrough.
source "$(dirname "$0")/env.sh"
cd "$ROOT"
echo "==> Unit tests"
(cd backend && npm test --silent)
echo "==> Fresh deploy (no seed data)"
SEED=0 scripts/up.sh --reset
API="$(cd infra/local && terraform output -raw api_endpoint)"
echo "==> End-to-end flow"
API="$API" LS="$LS" ADMIN_KEY="$ADMIN_KEY" node --test --test-concurrency=1 e2e/flow.test.mjs
echo "==> Clean stack with the GSC 2026 data"
scripts/up.sh --reset
