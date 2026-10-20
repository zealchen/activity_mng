# Non-secret dev config, committed so CI applies the same stack. The admin key is
# NOT here: TF_VAR_admin_key locally, the ADMIN_KEY secret of the GitHub "dev"
# environment in CI.
project        = "activity-mng"
aws_region     = "us-east-1"
aws_account_id = "905418107398"

# Verified in SES (us-east-1). A verified domain address delivers better than gmail.
sender_email = "neochen428@gmail.com"

# GitHub repo Actions deploy from - scopes the OIDC deploy-role trust.
github_owner = "zealchen"
github_repo  = "activity_mng"

# This project is the first to use GitHub OIDC in the account, so it creates the
# account-wide provider. Another project in the same account leaves this false.
manage_oidc_provider = true
