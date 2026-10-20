provider "aws" {
  region = var.aws_region

  # Fail fast if the active credentials resolve to a different account than the
  # one dev targets, instead of silently deploying into the wrong account.
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project     = var.project
      Environment = "dev"
      ManagedBy   = "terraform"
    }
  }
}
