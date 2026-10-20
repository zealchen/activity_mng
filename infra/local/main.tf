# LocalStack environment. Deploy with scripts/deploy-local.sh.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.80" }
    archive = { source = "hashicorp/archive", version = "~> 2.6" }
  }
}

variable "localstack_endpoint" {
  type    = string
  default = "http://localhost:4666"
}

variable "admin_key" {
  type      = string
  default   = "local-admin"
  sensitive = true
}

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true
  endpoints {
    apigatewayv2   = var.localstack_endpoint
    cloudwatch     = var.localstack_endpoint
    cloudwatchlogs = var.localstack_endpoint
    dynamodb       = var.localstack_endpoint
    eventbridge    = var.localstack_endpoint
    iam            = var.localstack_endpoint
    lambda         = var.localstack_endpoint
    s3             = var.localstack_endpoint
    ses            = var.localstack_endpoint
    sns            = var.localstack_endpoint
    sts            = var.localstack_endpoint
  }
}

module "app" {
  source           = "../modules/app"
  name_prefix      = "activity-mng"
  admin_key        = var.admin_key
  dev_mode         = true
  sender_email     = "neo@example.com"
  sms_provider     = "sns"
  sms_number       = "+18005550199"
  web_base_url     = "http://activity-mng-web.s3-website.localhost.localstack.cloud:4666"
  api_url_template = "http://{id}.execute-api.localhost.localstack.cloud:4666"
  localstack_url   = var.localstack_endpoint
}

output "api_endpoint" { value = module.app.api_endpoint }
output "web_url" { value = "http://activity-mng-web.s3-website.localhost.localstack.cloud:4666" }
output "inbound_topic_arn" { value = module.app.inbound_topic_arn }
