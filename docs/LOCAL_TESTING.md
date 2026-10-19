# Test your changes locally before they reach production

Everything the site needs runs on your machine with Docker: Postgres 17 (same major version as Aurora) and S3Mock standing in for S3. You need no AWS account and nothing you do here can touch production.

## Prerequisites

- Docker Desktop (or any Docker with the `compose` plugin)
- Node 24+ if you want hot reload on your machine
- A clone of the repo. No `.env` is required for the Docker modes; if you have one, only `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are read from it, to enable the Google button locally.

## Three ways to run it

### 1. Exactly what production runs

```bash
docker compose --profile prod up --build
```

Builds the same Docker image App Runner runs, starts it the same way (`migrate` → `seed` → serve), against local Postgres and S3Mock. Open http://localhost:3000. Use this before you push: if it works here, the deploy will work. Rebuild after every change (`--build`), which takes about a minute.

### 2. Hot reload inside Docker

```bash
docker compose --profile dev up
```

Same services, but the server runs from your source tree with `tsx watch`, so saving a file restarts it in a second. First start takes a minute while it installs dependencies inside the container. Good for day-to-day work when you do not want Node installed locally.

### 3. Backing services only, server on your machine

```bash
docker compose up -d           # Postgres on localhost:5433, S3Mock on localhost:9090
```

Then put this in your `.env` (copy from `.env.example` first) and run `npm run db:migrate && npm run db:seed && npm run dev`:

```
DB_HOST=localhost
DB_PORT=5433
DB_NAME=orchestra
DB_USER=postgres
DB_PASSWORD=orchestra
DB_SSL=false
S3_AUDIO_BUCKET=orchestra-audio
S3_ENDPOINT=http://localhost:9090
AWS_ACCESS_KEY_ID=local
AWS_SECRET_ACCESS_KEY=local
```

Fastest feedback loop, and your editor's debugger attaches normally.

## Prove it works: the smoke test

```bash
scripts/smoke-test.sh                 # against http://localhost:3000
```

It creates a throwaway account, signs in, uploads a file through a presigned URL, registers it, downloads it and compares bytes, deletes it, signs out, checks a wrong password is rejected, and signs back in. About twenty checks, a few seconds. Run it before every push. The same script works against production:

```bash
scripts/smoke-test.sh https://at2rkgxrxh.us-east-1.awsapprunner.com
```

The page's **Backend check** panel at http://localhost:3000 shows the same green/red state interactively, and the upload form ticks each step of the flow.

## Where things are

| What | Where | Login |
|------|-------|-------|
| Site | http://localhost:3000 | create an account on the page |
| Postgres | `localhost:5433`, db `orchestra` | user `postgres`, password `orchestra` |
| S3Mock (S3 API) | http://localhost:9090 | none; any key and secret are accepted |

Peek at the database: `psql "postgres://postgres:orchestra@localhost:5433/orchestra"`.

List what is in the local bucket: `curl -s "http://localhost:9090/orchestra-audio?list-type=2"` (XML), or with the AWS CLI, `aws --endpoint-url http://localhost:9090 s3 ls s3://orchestra-audio/ --recursive`.

## Resetting

```bash
docker compose --profile prod --profile dev down -v
```

Stops everything and deletes the local Postgres data and S3Mock objects. Next start runs the schema and seeds from scratch, which is also the quickest way to test that a new SQL file applies cleanly on an empty database.

## Testing a database change

1. Add your SQL file under `server/db/sql/schema/` or `server/db/sql/migrations/` (rules in `server/db/sql/README.md`).
2. `docker compose --profile prod down -v && docker compose --profile prod up --build`. Watch the log for `applied  schema/00N_your_file.sql`.
3. If it fails, the container exits and prints the SQL error. Production would do the same and keep the old version running, but fix it here instead.
4. Run the smoke test, then push.

## What this does not cover

- IAM authentication to Aurora and the App Runner task role. Those are exercised only in production; the smoke test against the live URL covers them.
- Aurora's auto-pause. Local Postgres never sleeps, so the 15-second wake-up after idle only shows in production.
- Google sign-in, unless you put the client ID and secret in `.env`. The Google client already allows `http://localhost:3000/api/auth/callback/google`.
