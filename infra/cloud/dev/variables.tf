variable "project" {
  description = "Project slug used as the resource name prefix (\"<project>-dev-*\")."
  type        = string
  default     = "activity-mng"
}

variable "aws_region" {
  description = "AWS region for dev."
  type        = string
}

variable "aws_account_id" {
  description = "Target dev AWS account ID."
  type        = string
}

variable "admin_key" {
  description = "Shared key the coordinator types into the dashboard. Pass via TF_VAR_admin_key (GitHub secret ADMIN_KEY in CI)."
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.admin_key) >= 16
    error_message = "Use an admin key of at least 16 characters."
  }
}

variable "sender_email" {
  description = "From address of every email. Must already be verified in SES in this account and region."
  type        = string
}
