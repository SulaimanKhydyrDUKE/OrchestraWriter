#!/usr/bin/env bash
# Creates the audio bucket if missing, blocks all public access, and sets CORS so the
# browser can PUT/GET presigned URLs directly. Re-runnable.
#
#   ALLOWED_ORIGINS="http://localhost:3000,https://xxxx.us-east-1.awsapprunner.com" scripts/s3-init.sh
#
# Reads S3_AUDIO_BUCKET and AWS_REGION from .env. Needs AWS credentials with S3 admin rights.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && source .env; set +a

: "${S3_AUDIO_BUCKET:?set S3_AUDIO_BUCKET in .env}"
AWS_REGION=${AWS_REGION:-us-east-1}
ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-http://localhost:3000}

if aws s3api head-bucket --bucket "$S3_AUDIO_BUCKET" 2>/dev/null; then
  echo "bucket $S3_AUDIO_BUCKET exists"
else
  echo "creating bucket $S3_AUDIO_BUCKET in $AWS_REGION"
  if [ "$AWS_REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$S3_AUDIO_BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$S3_AUDIO_BUCKET" \
      --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
  fi
fi

# Nothing in this bucket is ever public. Access is only through presigned URLs.
aws s3api put-public-access-block --bucket "$S3_AUDIO_BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# CORS: the browser talks to S3 from the site's origin, so S3 must allow that origin.
ORIGINS_JSON=$(printf '%s' "$ALLOWED_ORIGINS" | tr ',' '\n' | sed 's/^ *//;s/ *$//' \
  | awk 'NF { printf "%s\"%s\"", (n++ ? "," : ""), $0 }')
aws s3api put-bucket-cors --bucket "$S3_AUDIO_BUCKET" --cors-configuration "{
  \"CORSRules\": [{
    \"AllowedOrigins\": [$ORIGINS_JSON],
    \"AllowedMethods\": [\"GET\", \"PUT\", \"HEAD\"],
    \"AllowedHeaders\": [\"*\"],
    \"ExposeHeaders\": [\"ETag\"],
    \"MaxAgeSeconds\": 3000
  }]
}"
echo "CORS origins: $ALLOWED_ORIGINS"

# Abandoned multipart uploads otherwise cost money forever.
aws s3api put-bucket-lifecycle-configuration --bucket "$S3_AUDIO_BUCKET" --lifecycle-configuration '{
  "Rules": [{
    "ID": "abort-incomplete-multipart",
    "Status": "Enabled",
    "Filter": {},
    "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
  }]
}'
echo "bucket $S3_AUDIO_BUCKET ready"
