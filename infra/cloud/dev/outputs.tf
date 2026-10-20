output "web_url" {
  description = "Coordinator dashboard."
  value       = "${local.web_url}/index.html"
}

output "api_base_url" {
  description = "Public HTTPS URL of the API. The deploy smoke test hits /health on it."
  value       = module.app.api_endpoint
}

output "table" {
  description = "DynamoDB table holding every event, person and message."
  value       = module.app.table
}

output "github_oidc_role_arn" {
  description = "IAM role ARN GitHub Actions assumes via OIDC. Set as the AWS_DEPLOY_ROLE_ARN secret of the dev environment."
  value       = aws_iam_role.gha_deploy.arn
}

output "aws_account_id" {
  description = "Target AWS account id."
  value       = var.aws_account_id
}
