# Activity Manager - everything one deployment needs. The same module runs on
# LocalStack (infra/local) and on AWS (infra/cloud/dev). Production would add a
# CloudFront front door and a real SMS origination number.

terraform {
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.80" }
    archive = { source = "hashicorp/archive", version = "~> 2.6" }
  }
}

locals {
  p        = var.name_prefix
  api_base = var.api_url_template != "" ? replace(var.api_url_template, "{id}", aws_apigatewayv2_api.api.id) : aws_apigatewayv2_api.api.api_endpoint
  web_root = "${path.module}/../../../web"
  mime = {
    html = "text/html; charset=utf-8"
    js   = "application/javascript; charset=utf-8"
    css  = "text/css; charset=utf-8"
    svg  = "image/svg+xml"
    png  = "image/png"
    ico  = "image/x-icon"
    json = "application/json"
  }
  lambda_env = {
    TABLE_NAME        = aws_dynamodb_table.main.name
    FILES_BUCKET      = aws_s3_bucket.files.bucket
    SENDER_EMAIL      = var.sender_email
    SMS_PROVIDER      = var.sms_provider
    SMS_NUMBER        = var.sms_number
    SMS_ORIGINATION   = var.sms_origination
    INBOUND_TOPIC_ARN = aws_sns_topic.inbound_sms.arn
    WEB_BASE_URL      = var.web_base_url
    ADMIN_KEY         = var.admin_key
    DEV_MODE          = tostring(var.dev_mode)
  }
}

# ---------------------------------------------------------------- data
resource "aws_dynamodb_table" "main" {
  name         = "${local.p}-data"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"
  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  point_in_time_recovery { enabled = true }
}

resource "aws_s3_bucket" "files" {
  bucket        = "${local.p}-files"
  force_destroy = var.dev_mode || var.files_force_destroy
}

resource "aws_s3_bucket_public_access_block" "files" {
  bucket                  = aws_s3_bucket.files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---------------------------------------------------------------- lambda
data "archive_file" "backend" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend"
  output_path = "${path.module}/../../../.build/backend.zip"
  excludes    = ["test", "test/engine.test.mjs"]
}

resource "aws_iam_role" "lambda" {
  name = "${local.p}-lambda"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "lambda" {
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "*" },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"], Resource = aws_dynamodb_table.main.arn },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.files.arn}/*" },
      { Effect = "Allow", Action = ["ses:SendEmail"], Resource = "*" },
      { Effect = "Allow", Action = ["sns:Publish"], Resource = "*" },
      { Effect = "Allow", Action = ["sms-voice:SendTextMessage"], Resource = "*" },
    ]
  })
}

resource "aws_lambda_function" "fn" {
  for_each         = { api = "src/api.handler", inbound = "src/inbound.handler" }
  function_name    = "${local.p}-${each.key}"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  handler          = each.value
  filename         = data.archive_file.backend.output_path
  source_code_hash = data.archive_file.backend.output_base64sha256
  timeout          = 60
  memory_size      = 512
  environment { variables = local.lambda_env }
}

# ---------------------------------------------------------------- HTTP API
resource "aws_apigatewayv2_api" "api" {
  name          = "${local.p}-api"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["content-type", "x-admin-key"]
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.fn["api"].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "api" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_stage" "api" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "api" {
  statement_id  = "apigw"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn["api"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

# ---------------------------------------------------------------- inbound SMS
# In AWS, point the phone number's two-way SMS destination at this topic.
resource "aws_sns_topic" "inbound_sms" {
  name = "${local.p}-inbound-sms"
}

resource "aws_sns_topic_subscription" "inbound_sms" {
  topic_arn = aws_sns_topic.inbound_sms.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.fn["inbound"].arn
}

resource "aws_lambda_permission" "inbound" {
  statement_id  = "sns"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn["inbound"].function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.inbound_sms.arn
}

# ---------------------------------------------------------------- email
resource "aws_ses_email_identity" "sender" {
  count = var.manage_sender_identity ? 1 : 0
  email = var.sender_email
}

moved {
  from = aws_ses_email_identity.sender
  to   = aws_ses_email_identity.sender[0]
}

# ---------------------------------------------------------------- web
resource "aws_s3_bucket" "web" {
  bucket        = "${local.p}-web"
  force_destroy = true
}

resource "aws_s3_bucket_website_configuration" "web" {
  bucket = aws_s3_bucket.web.id
  index_document { suffix = "index.html" }
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "web" {
  bucket     = aws_s3_bucket.web.id
  depends_on = [aws_s3_bucket_public_access_block.web]
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = "*", Action = "s3:GetObject", Resource = "${aws_s3_bucket.web.arn}/*" }]
  })
}

resource "aws_s3_object" "web" {
  for_each     = fileset(local.web_root, "**/*.{html,js,css,svg,png,ico}")
  bucket       = aws_s3_bucket.web.id
  key          = each.value
  source       = "${local.web_root}/${each.value}"
  etag         = filemd5("${local.web_root}/${each.value}")
  content_type = lookup(local.mime, reverse(split(".", each.value))[0], "application/octet-stream")
}

resource "aws_s3_object" "config" {
  bucket        = aws_s3_bucket.web.id
  key           = "config.js"
  content_type  = local.mime.js
  cache_control = "no-store"
  content       = "window.APP_CONFIG = ${jsonencode({ apiBase = local.api_base, devMode = var.dev_mode, localstack = var.localstack_url })};\n"
}
