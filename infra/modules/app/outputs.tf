output "api_id" {
  value = aws_apigatewayv2_api.api.id
}

output "api_endpoint" {
  value = local.api_base
}

output "web_bucket" {
  value = aws_s3_bucket.web.bucket
}

output "table" {
  value = aws_dynamodb_table.main.name
}

output "inbound_topic_arn" {
  value = aws_sns_topic.inbound_sms.arn
}
