# AWS resources

Everything is in `us-east-1`. Created by `scripts/deploy-init.sh` unless noted.

| Resource | Name | Purpose |
|----------|------|---------|
| Aurora PostgreSQL cluster | `orchestra-db-1` (pre-existing) | application tables; IAM auth, TLS required |
| S3 bucket | `orchestra-writer-s3` (pre-existing) | audio recordings; private, presigned URLs only, CORS for the site origin |
| ECR repository | `orchestra-writer` | container images built by GitHub Actions |
| App Runner service | `orchestra-writer` | runs the image on port 3000; auto-deploys when `:latest` changes |
| IAM OIDC provider | `token.actions.githubusercontent.com` | lets GitHub Actions assume a role with no stored keys |
| IAM role | `orchestra-writer-github-deploy` | assumed by the workflow: push to ECR, read App Runner status |
| IAM role | `orchestra-writer-apprunner-ecr` | lets App Runner pull from ECR (AWS managed policy) |
| IAM role | `orchestra-writer-apprunner-task` | the running server: `rds-db:connect`, bucket read/write, read SSM secrets |
| SSM parameters | `/orchestra-writer/BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | injected into the service as env vars |
| GitHub repo variable | `AWS_DEPLOY_ROLE_ARN` | read by `.github/workflows/deploy.yml` |

## Policy for a collaborator running locally

Attach to an IAM user (then `aws configure` with its access key) or a role they can assume. Replace `ACCOUNT_ID` and `CLUSTER_RESOURCE_ID` (`aws rds describe-db-clusters --db-cluster-identifier orchestra-db-1 --query 'DBClusters[0].DbClusterResourceId'`).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "rds-db:connect",
      "Resource": "arn:aws:rds-db:us-east-1:ACCOUNT_ID:dbuser:CLUSTER_RESOURCE_ID/postgres" },
    { "Effect": "Allow", "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::orchestra-writer-s3" },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::orchestra-writer-s3/*" }
  ]
}
```

This grants a login to the database, not table permissions; those come from the Postgres role. Today everyone connects as `postgres`. A follow-up is a dedicated `app` role with `GRANT rds_iam TO app` and only the privileges the server needs.

## Known gaps

- The cluster is Serverless v2 with min 0 ACU and a 300s auto-pause. The first request after 5 idle minutes waits ~15s while it resumes (the pool allows 30s). Raise min capacity to 0.5 ACU to remove the pause if that delay bothers users; it costs roughly an always-on small instance.

- Aurora is reachable from the internet on 5432 (TLS and IAM token still required). A VPC connector + NAT gateway would close it.
- Backup retention was 1 day and deletion protection off at setup time. Raise to 7+ days and enable protection.
- No custom domain; the App Runner URL is the site URL. Changing it means re-registering the Google redirect URI and re-running `deploy-init.sh`.
