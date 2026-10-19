# scripts/

All re-runnable. All read `.env`.

| Script | Needs | Does |
|--------|-------|------|
| `db-init.sh` | DB access | `npm run db:migrate` then `npm run db:seed` |
| `s3-init.sh` | S3 admin | creates the bucket if missing, blocks public access, sets CORS for `ALLOWED_ORIGINS`, abandons stale multipart uploads |
| `smoke-test.sh [url]` | curl + node | end-to-end check of auth, upload, download, delete against a running server; default http://localhost:3000. Run before pushing and after deploys. |
| `deploy-init.sh` | AWS admin + `gh` signed in + code pushed to `main` | creates ECR, the three IAM roles, the GitHub OIDC trust, secrets in SSM, triggers the first image build, creates the App Runner service, updates bucket CORS with the live URL. Prints the site URL and the Google redirect URI. Pass `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` to enable Google sign-in. |

What each AWS resource is for is in `infra/README.md`.
