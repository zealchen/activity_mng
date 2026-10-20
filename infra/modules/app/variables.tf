variable "name_prefix" {
  type    = string
  default = "activity-mng"
}

variable "admin_key" {
  type        = string
  sensitive   = true
  description = "Shared key the coordinator dashboard sends as x-admin-key."
}

variable "dev_mode" {
  type        = bool
  default     = false
  description = "Enables the simulated clock and the phone simulator. Never on in production."
}

variable "files_force_destroy" {
  type        = bool
  default     = false
  description = "Let destroy delete the files bucket (receipt photos) even when it is not empty."
}

variable "sender_email" {
  type = string
}

variable "manage_sender_identity" {
  type        = bool
  default     = true
  description = "Create the SES identity for sender_email. Set false when it is already verified in the account, so destroy does not remove it."
}

variable "sms_provider" {
  type        = string
  default     = "sns"
  description = "sns (LocalStack / simple) or eum (AWS End User Messaging with a registered number)."
}

variable "sms_number" {
  type        = string
  default     = "+18005550199"
  description = "The number people text back to (shown in emails)."
}

variable "sms_origination" {
  type    = string
  default = ""
}

variable "web_base_url" {
  type        = string
  description = "Public URL of the web app; used to build the personal links in texts and emails."
}

variable "api_url_template" {
  type        = string
  default     = ""
  description = "Browser-facing API URL with {id} for the API id (LocalStack needs the host-reachable form). Empty = the API's own endpoint."
}

variable "localstack_url" {
  type    = string
  default = ""
}
