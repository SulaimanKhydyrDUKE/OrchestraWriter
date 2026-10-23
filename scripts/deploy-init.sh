#!/usr/bin/env bash
# One-time AWS setup for hosting OrchestraWriter on App Runner, deployed by GitHub Actions.
# Idempotent: re-run it any time; it creates what is missing and updates what exists.
#
# What it creates (names derive from APP_NAME, default orchestra-writer):
#   ECR repository      orchestra-writer                   images built by CI
#   IAM OIDC provider   token.actions.githubusercontent.com  lets GitHub Actions assume a role, no stored keys
#   IAM role            orchestra-writer-github-deploy     assumed by .github/workflows/deploy.yml (push to ECR)
#   IAM role            orchestra-writer-apprunner-ecr     lets App Runner pull the image
#   IAM role            orchestra-writer-apprunner-task    identity of the running server: rds-db:connect, S3, SSM
#   SSM parameters      /orchestra-writer/BETTER_AUTH_SECRET (generated), GOOGLE_CLIENT_ID/SECRET (if given)
#   App Runner service  orchestra-writer                   the website, auto-deploys when :latest changes in ECR
#   GitHub              repo variable AWS_DEPLOY_ROLE_ARN, environment "production"
#   S3                  bucket CORS updated with the site URL (via scripts/s3-init.sh)
#
# Needs: aws CLI signed in as an admin, gh CLI signed in, Docker NOT required (CI builds the image),
# and the code pushed to the main branch so the workflow can build the first image.
#
# Options (env vars):
#   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   stored in SSM and wired into the service
#   OPEN_DB_TO_INTERNET=yes                   add a 0.0.0.0/0:5432 rule to the Aurora security group
#                                             (App Runner has no fixed egress IP; see README "Database network")
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && source .env; set +a

APP_NAME=${APP_NAME:-orchestra-writer}
AWS_REGION=${AWS_REGION:-us-east-1}
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
GITHUB_REPO=${GITHUB_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}
: "${DB_HOST:?set in .env}" "${DB_NAME:?set in .env}" "${DB_USER:?set in .env}" "${S3_AUDIO_BUCKET:?set in .env}"
DB_PORT=${DB_PORT:-5432}
# "orchestra-db-1" from "orchestra-db-1.cluster-xxxx.us-east-1.rds.amazonaws.com"
DB_CLUSTER_ID=${DB_CLUSTER_ID:-${DB_HOST%%.*}}

log() { printf '\n==> %s\n' "$*"; }

log "Preflight"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
gh auth status >/dev/null
echo "account $ACCOUNT_ID, region $AWS_REGION, repo $GITHUB_REPO, cluster $DB_CLUSTER_ID"
ECR_URI="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$APP_NAME"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

DB_RESOURCE_ID=$(aws rds describe-db-clusters --db-cluster-identifier "$DB_CLUSTER_ID" \
  --query 'DBClusters[0].DbClusterResourceId' --output text)

# ------------------------------------------------------------------ ECR
log "ECR repository $APP_NAME"
if ! aws ecr describe-repositories --repository-names "$APP_NAME" >/dev/null 2>&1; then
  aws ecr create-repository --repository-name "$APP_NAME" \
    --image-scanning-configuration scanOnPush=true >/dev/null
  echo "created"
else
  echo "exists"
fi

# ------------------------------------------------------------------ IAM
ensure_role() { # name trust-policy-file
  if aws iam get-role --role-name "$1" >/dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "$1" --policy-document "file://$2"
    echo "role $1 exists (trust policy refreshed)"
  else
    aws iam create-role --role-name "$1" --assume-role-policy-document "file://$2" >/dev/null
    echo "role $1 created"
    ROLE_CREATED=yes
  fi
}
ROLE_CREATED=no

log "GitHub OIDC provider"
OIDC_ARN="arn:aws:iam::$ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then
  aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1c58a3a8518e8759bf075b76b750d4f2df264fcd >/dev/null
  echo "created"
else
  echo "exists"
fi

log "Deploy role (assumed by GitHub Actions)"
DEPLOY_ROLE="$APP_NAME-github-deploy"
# GitHub's OIDC subject now carries numeric ids: repo:<owner>@<ownerId>/<repo>@<repoId>:...
# so a renamed or re-created repo cannot inherit the trust. Allow that form, and the
# older id-less form, for any workflow in this repository. The role itself can only
# push images and read App Runner status, so branch-level scoping buys little here.
GH_OWNER_ID=$(gh api "repos/$GITHUB_REPO" --jq '.owner.id')
GH_REPO_ID=$(gh api "repos/$GITHUB_REPO" --jq '.id')
GITHUB_REPO_WITH_IDS="${GITHUB_REPO%%/*}@$GH_OWNER_ID/${GITHUB_REPO##*/}@$GH_REPO_ID"
cat > "$TMP/deploy-trust.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "$OIDC_ARN" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": [
        "repo:$GITHUB_REPO_WITH_IDS:*",
        "repo:$GITHUB_REPO:*"
      ] }
    }
  }]
}
JSON
ensure_role "$DEPLOY_ROLE" "$TMP/deploy-trust.json"
cat > "$TMP/deploy-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    { "Effect": "Allow",
      "Action": ["ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload",
                 "ecr:PutImage", "ecr:UploadLayerPart", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
                 "ecr:DescribeImages"],
      "Resource": "arn:aws:ecr:$AWS_REGION:$ACCOUNT_ID:repository/$APP_NAME" },
    { "Effect": "Allow", "Action": "apprunner:ListServices", "Resource": "*" },
    { "Effect": "Allow", "Action": ["apprunner:DescribeService", "apprunner:ListOperations"],
      "Resource": "arn:aws:apprunner:$AWS_REGION:$ACCOUNT_ID:service/$APP_NAME/*" }
  ]
}
JSON
aws iam put-role-policy --role-name "$DEPLOY_ROLE" --policy-name deploy --policy-document "file://$TMP/deploy-policy.json"
DEPLOY_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$DEPLOY_ROLE"

log "App Runner ECR access role"
ECR_ROLE="$APP_NAME-apprunner-ecr"
cat > "$TMP/ecr-trust.json" <<'JSON'
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow",
  "Principal": { "Service": "build.apprunner.amazonaws.com" }, "Action": "sts:AssumeRole" }] }
JSON
ensure_role "$ECR_ROLE" "$TMP/ecr-trust.json"
aws iam attach-role-policy --role-name "$ECR_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess
ECR_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$ECR_ROLE"

log "App Runner task role (what the running server can do)"
TASK_ROLE="$APP_NAME-apprunner-task"
cat > "$TMP/task-trust.json" <<'JSON'
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow",
  "Principal": { "Service": "tasks.apprunner.amazonaws.com" }, "Action": "sts:AssumeRole" }] }
JSON
ensure_role "$TASK_ROLE" "$TMP/task-trust.json"
cat > "$TMP/task-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ConnectToAurora", "Effect": "Allow", "Action": "rds-db:connect",
      "Resource": "arn:aws:rds-db:$AWS_REGION:$ACCOUNT_ID:dbuser:$DB_RESOURCE_ID/$DB_USER" },
    { "Sid": "ListBucket", "Effect": "Allow", "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::$S3_AUDIO_BUCKET" },
    { "Sid": "Objects", "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::$S3_AUDIO_BUCKET/*" },
    { "Sid": "ReadSecrets", "Effect": "Allow", "Action": ["ssm:GetParameters", "ssm:GetParameter"],
      "Resource": "arn:aws:ssm:$AWS_REGION:$ACCOUNT_ID:parameter/$APP_NAME/*" },
    { "Sid": "DecryptSecrets", "Effect": "Allow", "Action": "kms:Decrypt", "Resource": "*",
      "Condition": { "StringEquals": { "kms:ViaService": "ssm.$AWS_REGION.amazonaws.com" } } }
  ]
}
JSON
aws iam put-role-policy --role-name "$TASK_ROLE" --policy-name runtime --policy-document "file://$TMP/task-policy.json"
TASK_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$TASK_ROLE"

# ------------------------------------------------------------------ Secrets
log "Secrets in SSM Parameter Store"
param_arn() { echo "arn:aws:ssm:$AWS_REGION:$ACCOUNT_ID:parameter/$APP_NAME/$1"; }
if ! aws ssm get-parameter --name "/$APP_NAME/BETTER_AUTH_SECRET" >/dev/null 2>&1; then
  aws ssm put-parameter --name "/$APP_NAME/BETTER_AUTH_SECRET" --type SecureString \
    --value "$(openssl rand -base64 32)" >/dev/null
  echo "BETTER_AUTH_SECRET generated"
else
  echo "BETTER_AUTH_SECRET exists"
fi
SECRETS_JSON="\"BETTER_AUTH_SECRET\": \"$(param_arn BETTER_AUTH_SECRET)\""
GOOGLE_ENABLED=no
if [[ -n "${GOOGLE_CLIENT_ID:-}" && -n "${GOOGLE_CLIENT_SECRET:-}" ]]; then
  aws ssm put-parameter --name "/$APP_NAME/GOOGLE_CLIENT_ID" --type SecureString --value "$GOOGLE_CLIENT_ID" --overwrite >/dev/null
  aws ssm put-parameter --name "/$APP_NAME/GOOGLE_CLIENT_SECRET" --type SecureString --value "$GOOGLE_CLIENT_SECRET" --overwrite >/dev/null
  echo "Google client stored"
  GOOGLE_ENABLED=yes
elif aws ssm get-parameter --name "/$APP_NAME/GOOGLE_CLIENT_ID" >/dev/null 2>&1; then
  echo "Google client already stored"
  GOOGLE_ENABLED=yes
else
  echo "Google sign-in not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and re-run to enable)"
fi
if [ "$GOOGLE_ENABLED" = yes ]; then
  SECRETS_JSON="$SECRETS_JSON, \"GOOGLE_CLIENT_ID\": \"$(param_arn GOOGLE_CLIENT_ID)\", \"GOOGLE_CLIENT_SECRET\": \"$(param_arn GOOGLE_CLIENT_SECRET)\""
fi

# ------------------------------------------------------------------ Database network
log "Aurora network check"
# App Runner has no fixed egress IP, so the database must accept connections from
# anywhere (TLS + IAM token are still required to log in). Test reachability directly
# rather than trusting the PubliclyAccessible flag, which this cluster reports oddly.
SG_IDS=$(aws rds describe-db-clusters --db-cluster-identifier "$DB_CLUSTER_ID" \
  --query 'DBClusters[0].VpcSecurityGroups[].VpcSecurityGroupId' --output text)
REACHABLE=no
if nc -z -w 5 "$DB_HOST" "$DB_PORT" 2>/dev/null; then REACHABLE=yes; fi
echo "port $DB_PORT reachable from this machine: $REACHABLE; security groups: ${SG_IDS:-none}"
if [ -z "$SG_IDS" ]; then
  if [ "$REACHABLE" = yes ]; then
    echo "no security groups to manage; the endpoint answers from the internet, so App Runner can connect"
  else
    echo "WARNING: endpoint not reachable from here and no security groups to adjust. Check the cluster's network settings."
  fi
else
  OPEN=0
  for SG in $SG_IDS; do
    N=$(aws ec2 describe-security-group-rules --filters "Name=group-id,Values=$SG" \
      --query "length(SecurityGroupRules[?IsEgress==\`false\` && FromPort<=\`$DB_PORT\` && ToPort>=\`$DB_PORT\` && CidrIpv4=='0.0.0.0/0'])" --output text)
    OPEN=$((OPEN + N))
  done
  if [ "$OPEN" -gt 0 ]; then
    echo "port $DB_PORT already open to 0.0.0.0/0"
  elif [ "${OPEN_DB_TO_INTERNET:-no}" = yes ]; then
    FIRST_SG=${SG_IDS%% *}
    aws ec2 authorize-security-group-ingress --group-id "$FIRST_SG" --ip-permissions \
      "IpProtocol=tcp,FromPort=$DB_PORT,ToPort=$DB_PORT,IpRanges=[{CidrIp=0.0.0.0/0,Description='App Runner (no fixed egress IP)'}]" >/dev/null
    echo "opened port $DB_PORT on $FIRST_SG to 0.0.0.0/0"
  else
    echo "WARNING: no inbound rule for 0.0.0.0/0:$DB_PORT, so App Runner will not reach Aurora."
    echo "         Re-run with OPEN_DB_TO_INTERNET=yes to add the rule."
  fi
fi

# ------------------------------------------------------------------ GitHub
log "GitHub repository settings"
gh variable set AWS_DEPLOY_ROLE_ARN --repo "$GITHUB_REPO" --body "$DEPLOY_ROLE_ARN"
gh api -X PUT "repos/$GITHUB_REPO/environments/production" >/dev/null
echo "variable AWS_DEPLOY_ROLE_ARN=$DEPLOY_ROLE_ARN, environment production"

# ------------------------------------------------------------------ First image
log "Container image $ECR_URI:latest"
if aws ecr describe-images --repository-name "$APP_NAME" --image-ids imageTag=latest >/dev/null 2>&1; then
  echo "exists"
else
  if [ "$ROLE_CREATED" = yes ]; then echo "waiting 20s for IAM to propagate"; sleep 20; fi
  echo "triggering the GitHub workflow to build and push it"
  gh workflow run deploy.yml --repo "$GITHUB_REPO" --ref main
  for i in $(seq 1 60); do
    sleep 15
    if aws ecr describe-images --repository-name "$APP_NAME" --image-ids imageTag=latest >/dev/null 2>&1; then
      echo "image pushed"; break
    fi
    [ "$i" -eq 60 ] && { echo "ERROR: image did not appear in 15 min. Check: gh run list --repo $GITHUB_REPO"; exit 1; }
    printf '.'
  done
fi

# ------------------------------------------------------------------ App Runner
service_arn() {
  aws apprunner list-services --query "ServiceSummaryList[?ServiceName=='$APP_NAME'].ServiceArn" --output text
}
wait_for_service() { # arn
  for i in $(seq 1 80); do
    # A dropped Wi-Fi packet must not abort the whole script: treat it as "unknown, keep waiting".
    STATUS=$(aws apprunner describe-service --service-arn "$1" --query Service.Status --output text 2>/dev/null || echo UNKNOWN)
    case "$STATUS" in
      RUNNING)
        # RUNNING also follows a failed deployment that rolled back; check the last operation.
        LAST=$(aws apprunner list-operations --service-arn "$1" --max-results 1 --query 'OperationSummaryList[0].Status' --output text 2>/dev/null || echo UNKNOWN)
        case "$LAST" in
          ROLLBACK_*|FAILED) echo " $STATUS, but the last operation ended $LAST (rolled back)."
            echo "See: aws logs tail /aws/apprunner/$APP_NAME/$(basename "$1")/application --since 30m"; return 1 ;;
        esac
        echo " $STATUS"; return 0 ;;
      CREATE_FAILED|DELETE_FAILED) echo " $STATUS"; echo "See the App Runner console event log."; return 1 ;;
      *) printf '.' ; sleep 15 ;;
    esac
  done
  echo "timed out waiting for App Runner"; return 1
}
source_config() { # better-auth-url
cat <<JSON
{
  "ImageRepository": {
    "ImageIdentifier": "$ECR_URI:latest",
    "ImageRepositoryType": "ECR",
    "ImageConfiguration": {
      "Port": "3000",
      "RuntimeEnvironmentVariables": {
        "NODE_ENV": "production",
        "PORT": "3000",
        "AWS_REGION": "$AWS_REGION",
        "DB_HOST": "$DB_HOST",
        "DB_PORT": "$DB_PORT",
        "DB_NAME": "$DB_NAME",
        "DB_USER": "$DB_USER",
        "S3_AUDIO_BUCKET": "$S3_AUDIO_BUCKET",
        "BETTER_AUTH_URL": "$1"$PIPELINE_ENV
      },
      "RuntimeEnvironmentSecrets": { $SECRETS_JSON }
    }
  },
  "AutoDeploymentsEnabled": true,
  "AuthenticationConfiguration": { "AccessRoleArn": "$ECR_ROLE_ARN" }
}
JSON
}
# If scripts/pipeline-init.sh created the state machine, the API runs jobs on it;
# otherwise the API runs the pipeline in-process (PIPELINE_MODE defaults to inline).
SM_ARN=$(aws stepfunctions list-state-machines --query "stateMachines[?name=='$APP_NAME-transcription'].stateMachineArn" --output text 2>/dev/null || true)
PIPELINE_ENV=""
[ -n "$SM_ARN" ] && PIPELINE_ENV=",
        \"STATE_MACHINE_ARN\": \"$SM_ARN\""
echo "pipeline: ${SM_ARN:-inline (no state machine yet)}"
INSTANCE_CONFIG="{\"Cpu\":\"0.25 vCPU\",\"Memory\":\"0.5 GB\",\"InstanceRoleArn\":\"$TASK_ROLE_ARN\"}"
HEALTH_CONFIG='{"Protocol":"HTTP","Path":"/health","Interval":10,"Timeout":5,"HealthyThreshold":1,"UnhealthyThreshold":5}'

log "App Runner service $APP_NAME"
ARN=$(service_arn)
if [ -z "$ARN" ]; then
  if [ "$ROLE_CREATED" = yes ]; then echo "waiting 20s for IAM to propagate"; sleep 20; fi
  source_config "https://pending" > "$TMP/source.json"
  ARN=$(aws apprunner create-service --service-name "$APP_NAME" \
    --source-configuration "file://$TMP/source.json" \
    --instance-configuration "$INSTANCE_CONFIG" \
    --health-check-configuration "$HEALTH_CONFIG" \
    --query Service.ServiceArn --output text)
  echo "created $ARN"
  printf 'waiting for first deployment'
  wait_for_service "$ARN"
else
  echo "exists $ARN"
  printf 'waiting for any in-progress operation'
  wait_for_service "$ARN"
fi
URL="https://$(aws apprunner describe-service --service-arn "$ARN" --query Service.ServiceUrl --output text)"
echo "service URL: $URL"

# Second pass: now that the URL is known, set BETTER_AUTH_URL (and refresh everything else).
source_config "$URL" > "$TMP/source.json"
aws apprunner update-service --service-arn "$ARN" \
  --source-configuration "file://$TMP/source.json" \
  --instance-configuration "$INSTANCE_CONFIG" \
  --health-check-configuration "$HEALTH_CONFIG" >/dev/null
printf 'applying configuration'
wait_for_service "$ARN"

# ------------------------------------------------------------------ S3 CORS
log "S3 bucket CORS"
ALLOWED_ORIGINS="http://localhost:3000,$URL" scripts/s3-init.sh

# ------------------------------------------------------------------ Done
log "Done"
cat <<TXT
Site:                 $URL
Health:               $URL/health   and   $URL/health/db
Deploy:               push to main -> GitHub Actions builds the image -> App Runner rolls it out
Logs:                 aws logs tail /aws/apprunner/$APP_NAME/$(basename "$ARN")/application --follow
Google sign-in:       $([ "$GOOGLE_ENABLED" = yes ] && echo enabled || echo "disabled")
  redirect URI to register in Google Cloud Console:
  $URL/api/auth/callback/google
  then: GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... scripts/deploy-init.sh
TXT
