#!/usr/bin/env bash
# One-time AWS setup for the transcription pipeline. Idempotent: re-run any time.
#
# Creates (names derive from APP_NAME, default orchestra-writer):
#   ECR repository     orchestra-writer-worker              worker image (built by CI on arm64)
#   IAM role           orchestra-writer-worker              Lambda identity: S3 users/*, rds-db:connect as orchestra_worker, logs
#   IAM role           orchestra-writer-pipeline            Step Functions identity: invoke the six Lambdas
#   Lambda functions   orchestra-writer-{split,transcribe,merge,notate,finalize,fail}
#   State machine      orchestra-writer-transcription       from infra/transcription.asl.json
# Extends:
#   orchestra-writer-github-deploy   push worker image, update Lambda code
#   orchestra-writer-apprunner-task  start and describe executions
# Then re-runs scripts/deploy-init.sh so App Runner gets STATE_MACHINE_ARN and switches
# from the inline pipeline to Step Functions.
#
# Needs: aws CLI as admin, gh CLI signed in, the pipeline code pushed to main.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && source .env; set +a

APP_NAME=${APP_NAME:-orchestra-writer}
AWS_REGION=${AWS_REGION:-us-east-1}
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
GITHUB_REPO=${GITHUB_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}
: "${DB_HOST:?set in .env}" "${S3_AUDIO_BUCKET:?set in .env}"
DB_PORT=${DB_PORT:-5432}
DB_CLUSTER_ID=${DB_CLUSTER_ID:-${DB_HOST%%.*}}
WORKER_REPO="$APP_NAME-worker"
SM_NAME="$APP_NAME-transcription"
FUNCS="split transcribe merge notate finalize fail"

log() { printf '\n==> %s\n' "$*"; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

log "Preflight"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
DB_RESOURCE_ID=$(aws rds describe-db-clusters --db-cluster-identifier "$DB_CLUSTER_ID" --query 'DBClusters[0].DbClusterResourceId' --output text)
REGISTRY="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
echo "account $ACCOUNT_ID, cluster $DB_CLUSTER_ID ($DB_RESOURCE_ID), bucket $S3_AUDIO_BUCKET"

ROLE_CREATED=no
ensure_role() { # name trust-file
  if aws iam get-role --role-name "$1" >/dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "$1" --policy-document "file://$2"; echo "role $1 exists"
  else
    aws iam create-role --role-name "$1" --assume-role-policy-document "file://$2" >/dev/null; echo "role $1 created"; ROLE_CREATED=yes
  fi
}

# ------------------------------------------------------------------ ECR
log "ECR repository $WORKER_REPO"
if aws ecr describe-repositories --repository-names "$WORKER_REPO" >/dev/null 2>&1; then echo exists; else
  aws ecr create-repository --repository-name "$WORKER_REPO" --image-scanning-configuration scanOnPush=true >/dev/null
  # Keep the last 20 images; old worker builds otherwise pile up.
  aws ecr put-lifecycle-policy --repository-name "$WORKER_REPO" --lifecycle-policy-text \
    '{"rules":[{"rulePriority":1,"description":"keep 20","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":20},"action":{"type":"expire"}}]}' >/dev/null
  echo created
fi

# ------------------------------------------------------------------ IAM: worker
log "Worker role (what every pipeline Lambda can do)"
cat > "$TMP/lambda-trust.json" <<'JSON'
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Principal": { "Service": "lambda.amazonaws.com" }, "Action": "sts:AssumeRole" }] }
JSON
ensure_role "$APP_NAME-worker" "$TMP/lambda-trust.json"
aws iam attach-role-policy --role-name "$APP_NAME-worker" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
cat > "$TMP/worker-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ReadWriteUserObjects", "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::$S3_AUDIO_BUCKET/users/*" },
    { "Sid": "ConnectAsWorker", "Effect": "Allow", "Action": "rds-db:connect",
      "Resource": "arn:aws:rds-db:$AWS_REGION:$ACCOUNT_ID:dbuser:$DB_RESOURCE_ID/orchestra_worker" }
  ]
}
JSON
aws iam put-role-policy --role-name "$APP_NAME-worker" --policy-name pipeline --policy-document "file://$TMP/worker-policy.json"
WORKER_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$APP_NAME-worker"

# ------------------------------------------------------------------ IAM: state machine
log "State machine role"
cat > "$TMP/sfn-trust.json" <<'JSON'
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Principal": { "Service": "states.amazonaws.com" }, "Action": "sts:AssumeRole" }] }
JSON
ensure_role "$APP_NAME-pipeline" "$TMP/sfn-trust.json"
cat > "$TMP/sfn-policy.json" <<JSON
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": "lambda:InvokeFunction",
  "Resource": ["arn:aws:lambda:$AWS_REGION:$ACCOUNT_ID:function:$APP_NAME-*", "arn:aws:lambda:$AWS_REGION:$ACCOUNT_ID:function:$APP_NAME-*:*"] }] }
JSON
aws iam put-role-policy --role-name "$APP_NAME-pipeline" --policy-name invoke --policy-document "file://$TMP/sfn-policy.json"
SFN_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$APP_NAME-pipeline"

# ------------------------------------------------------------------ IAM: extend CI and API roles
log "Let CI ship the worker and the API start jobs"
cat > "$TMP/ci-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": ["ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload", "ecr:PutImage",
                 "ecr:UploadLayerPart", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:DescribeImages", "ecr:DescribeRepositories"],
      "Resource": "arn:aws:ecr:$AWS_REGION:$ACCOUNT_ID:repository/$WORKER_REPO" },
    { "Effect": "Allow", "Action": ["lambda:UpdateFunctionCode", "lambda:GetFunction", "lambda:GetFunctionConfiguration"],
      "Resource": "arn:aws:lambda:$AWS_REGION:$ACCOUNT_ID:function:$APP_NAME-*" }
  ]
}
JSON
aws iam put-role-policy --role-name "$APP_NAME-github-deploy" --policy-name pipeline --policy-document "file://$TMP/ci-policy.json"
cat > "$TMP/api-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "states:StartExecution", "Resource": "arn:aws:states:$AWS_REGION:$ACCOUNT_ID:stateMachine:$SM_NAME" },
    { "Effect": "Allow", "Action": "states:DescribeExecution", "Resource": "arn:aws:states:$AWS_REGION:$ACCOUNT_ID:execution:$SM_NAME:*" }
  ]
}
JSON
aws iam put-role-policy --role-name "$APP_NAME-apprunner-task" --policy-name pipeline --policy-document "file://$TMP/api-policy.json"
echo "deploy role and App Runner task role extended"

# ------------------------------------------------------------------ Worker image
log "Worker image $REGISTRY/$WORKER_REPO:latest"
if aws ecr describe-images --repository-name "$WORKER_REPO" --image-ids imageTag=latest >/dev/null 2>&1; then echo exists; else
  echo "waiting 15s for IAM, then asking GitHub Actions to build it"; sleep 15
  gh workflow run deploy.yml --repo "$GITHUB_REPO" --ref main
  for i in $(seq 1 80); do
    sleep 15
    aws ecr describe-images --repository-name "$WORKER_REPO" --image-ids imageTag=latest >/dev/null 2>&1 && { echo " image pushed"; break; }
    [ "$i" -eq 80 ] && { echo "ERROR: no worker image after 20 min. Check: gh run list --repo $GITHUB_REPO"; exit 1; }
    printf '.'
  done
fi
IMAGE_URI="$REGISTRY/$WORKER_REPO:latest"

# ------------------------------------------------------------------ Lambdas
log "Lambda functions"
[ "$ROLE_CREATED" = yes ] && { echo "waiting 15s for the new roles to propagate"; sleep 15; }
ENV_JSON="{\"Variables\":{\"DB_HOST\":\"$DB_HOST\",\"DB_PORT\":\"$DB_PORT\",\"DB_NAME\":\"${DB_NAME:-postgres}\",\"DB_USER\":\"orchestra_worker\",\"S3_AUDIO_BUCKET\":\"$S3_AUDIO_BUCKET\"}}"
settings() { # function -> "memoryMB timeoutSec"
  case "$1" in
    split) echo "512 30" ;; transcribe) echo "2048 900" ;; merge) echo "1024 300" ;;
    notate) echo "1024 300" ;; finalize) echo "512 120" ;; fail) echo "256 60" ;;
  esac
}
for f in $FUNCS; do
  name="$APP_NAME-$f"; read -r mem timeout <<<"$(settings "$f")"
  handler="pipeline/lambda.$f"
  if aws lambda get-function --function-name "$name" >/dev/null 2>&1; then
    aws lambda wait function-updated-v2 --function-name "$name"
    aws lambda update-function-configuration --function-name "$name" --role "$WORKER_ROLE_ARN" \
      --memory-size "$mem" --timeout "$timeout" --environment "$ENV_JSON" \
      --image-config "{\"Command\":[\"$handler\"]}" >/dev/null
    echo "$name updated"
  else
    for attempt in 1 2 3 4; do
      if aws lambda create-function --function-name "$name" --package-type Image --code "ImageUri=$IMAGE_URI" \
          --role "$WORKER_ROLE_ARN" --architectures arm64 --memory-size "$mem" --timeout "$timeout" \
          --environment "$ENV_JSON" --image-config "{\"Command\":[\"$handler\"]}" >/dev/null 2>"$TMP/err"; then
        echo "$name created"; break
      fi
      grep -q "cannot be assumed" "$TMP/err" && [ "$attempt" -lt 4 ] && { echo "role not ready, retrying"; sleep 10; continue; }
      cat "$TMP/err"; exit 1
    done
  fi
done
for f in $FUNCS; do aws lambda wait function-active-v2 --function-name "$APP_NAME-$f"; done
echo "all functions active"

# ------------------------------------------------------------------ State machine
log "State machine $SM_NAME"
fn_arn() { echo "arn:aws:lambda:$AWS_REGION:$ACCOUNT_ID:function:$APP_NAME-$1"; }
sed -e "s|\${SplitArn}|$(fn_arn split)|" -e "s|\${TranscribeArn}|$(fn_arn transcribe)|" \
    -e "s|\${MergeArn}|$(fn_arn merge)|" -e "s|\${NotateArn}|$(fn_arn notate)|" \
    -e "s|\${FinalizeArn}|$(fn_arn finalize)|" -e "s|\${FailArn}|$(fn_arn fail)|" \
    infra/transcription.asl.json > "$TMP/asl.json"
SM_ARN=$(aws stepfunctions list-state-machines --query "stateMachines[?name=='$SM_NAME'].stateMachineArn" --output text)
if [ -n "$SM_ARN" ]; then
  aws stepfunctions update-state-machine --state-machine-arn "$SM_ARN" --definition "file://$TMP/asl.json" --role-arn "$SFN_ROLE_ARN" >/dev/null
  echo "updated $SM_ARN"
else
  SM_ARN=$(aws stepfunctions create-state-machine --name "$SM_NAME" --definition "file://$TMP/asl.json" \
    --role-arn "$SFN_ROLE_ARN" --type STANDARD --query stateMachineArn --output text)
  echo "created $SM_ARN"
fi

# ------------------------------------------------------------------ App Runner
log "Point App Runner at the state machine (scripts/deploy-init.sh)"
scripts/deploy-init.sh

log "Pipeline ready"
echo "State machine: https://$AWS_REGION.console.aws.amazon.com/states/home?region=$AWS_REGION#/statemachines/view/$SM_ARN"
echo "Test it:       scripts/smoke-test.sh https://\$(aws apprunner list-services --query 'ServiceSummaryList[0].ServiceUrl' --output text)"
