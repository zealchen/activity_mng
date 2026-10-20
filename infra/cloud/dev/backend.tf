terraform {
  # Configured at init time via:
  #   terraform -chdir=infra/cloud/dev init -backend-config=backend.hcl
  backend "s3" {}
}
