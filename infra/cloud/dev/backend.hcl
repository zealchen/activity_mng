# Created by scripts/bootstrap-cloud.sh. Locking uses an S3 lockfile, so there
# is no DynamoDB lock table.
bucket       = "activity-mng-dev-tfstate"
key          = "cloud/dev/terraform.tfstate"
region       = "us-east-1"
encrypt      = true
use_lockfile = true
