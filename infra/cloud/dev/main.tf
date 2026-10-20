# Dev: the whole app as Lambda + API Gateway + DynamoDB + S3 + SES - no VPC, no
# containers, nothing billed while idle.

locals {
  name_prefix = "${var.project}-dev"
  # S3 static website endpoint (HTTP only) - the personal links in emails point here.
  web_url = "http://${local.name_prefix}-web.s3-website-${var.aws_region}.amazonaws.com"
}

module "app" {
  source                 = "../../modules/app"
  name_prefix            = local.name_prefix
  admin_key              = var.admin_key
  dev_mode               = false
  sender_email           = var.sender_email
  manage_sender_identity = false
  files_force_destroy    = true
  web_base_url           = local.web_url
}
