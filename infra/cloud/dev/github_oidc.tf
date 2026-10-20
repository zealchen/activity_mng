# GitHub Actions OIDC trust + deploy role for dev.
#
# publish.yml (_deploy.yml) assumes this role to run terraform plan/apply, which
# owns everything: the Lambda code (zipped from backend/), the web files in S3 and
# this role itself. pr.yml assumes it for a read-only plan.
#
# An account holds only ONE `token.actions.githubusercontent.com` provider. The
# first project in an account creates it (manage_oidc_provider = true); every
# other project references it.

variable "github_owner" {
  description = "GitHub org or user that owns the repo Actions runs from."
  type        = string
}

variable "github_repo" {
  description = "GitHub repo name (without owner)."
  type        = string
}

variable "manage_oidc_provider" {
  description = "Create the account-wide GitHub OIDC provider (first project in the account only)."
  type        = bool
  default     = false
}

resource "aws_iam_openid_connect_provider" "github" {
  count           = var.manage_oidc_provider ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.manage_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  oidc_provider_arn = var.manage_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
  arn_prefix        = "arn:aws:%s:${var.aws_region}:${var.aws_account_id}"
}

data "aws_iam_policy_document" "github_oidc_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Every job that assumes the role runs in the "dev" GitHub Environment, so
    # that is the only subject allowed. Listed twice: an org may enable the
    # id-qualified subject form (repo:OWNER@<id>/REPO@<id>:...).
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_owner}/${var.github_repo}:environment:dev",
        "repo:${var.github_owner}@*/${var.github_repo}@*:environment:dev",
      ]
    }
  }
}

resource "aws_iam_role" "gha_deploy" {
  name               = "${local.name_prefix}-gha-deploy"
  description        = "Assumed by GitHub Actions to deploy ${local.name_prefix}."
  assume_role_policy = data.aws_iam_policy_document.github_oidc_assume.json
}

# Deploy permissions, scoped to this project's names wherever the service allows.
data "aws_iam_policy_document" "gha_deploy" {
  # State bucket (activity-mng-dev-tfstate) and the app's own buckets.
  statement {
    sid       = "S3"
    effect    = "Allow"
    actions   = ["s3:*"]
    resources = ["arn:aws:s3:::${local.name_prefix}-*", "arn:aws:s3:::${local.name_prefix}-*/*"]
  }

  statement {
    sid       = "Lambda"
    effect    = "Allow"
    actions   = ["lambda:*"]
    resources = ["${format(local.arn_prefix, "lambda")}:function:${local.name_prefix}-*"]
  }

  statement {
    sid       = "DynamoDB"
    effect    = "Allow"
    actions   = ["dynamodb:*"]
    resources = ["${format(local.arn_prefix, "dynamodb")}:table/${local.name_prefix}-*"]
  }

  statement {
    sid       = "SNS"
    effect    = "Allow"
    actions   = ["sns:*"]
    resources = ["${format(local.arn_prefix, "sns")}:${local.name_prefix}-*"]
  }

  # HTTP API ids are random, so API Gateway cannot be scoped by name.
  statement {
    sid       = "ApiGateway"
    effect    = "Allow"
    actions   = ["apigateway:*"]
    resources = ["arn:aws:apigateway:${var.aws_region}::/*"]
  }

  # The Lambda role, this deploy role, and the OIDC provider.
  statement {
    sid     = "IAM"
    effect  = "Allow"
    actions = ["iam:*"]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/${local.name_prefix}-*",
      "arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com",
    ]
  }

  statement {
    sid       = "Identity"
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "gha_deploy" {
  name   = "${local.name_prefix}-gha-deploy"
  role   = aws_iam_role.gha_deploy.id
  policy = data.aws_iam_policy_document.gha_deploy.json
}
