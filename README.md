# OrchestraWriter

OrchestraWriter is a tool for musicians to convert audio recordings into an orchestra score.

**Stack:** Node 24 + TypeScript, [Hono](https://hono.dev) for HTTP, [Better Auth](https://www.better-auth.com) for sign-in (email+password and Google), raw SQL on Aurora Postgres through `pg`, S3 for audio files, AWS App Runner for hosting, GitHub Actions for deploys.

## Project layout

```
server/
  index.ts          entrypoint: builds the Hono app and listens
  auth.ts           Better Auth instance (owns /api/auth/* and the auth tables)
  config/           env loading, shared AWS settings
  db/               Postgres pool, migrate/seed runners
    sql/schema/     CREATE TABLE files, numbered, applied once each in order
    sql/migrations/ changes to tables that already exist in a live DB
    sql/seeds/      lookup data (instruments); re-runnable
  storage/          S3 client and presigned-URL helpers
  routes/           HTTP handlers (routes call services, never db/ or storage/ directly)
  services/         business logic
  types/            row types mirroring the SQL tables
public/             the frontend: plain HTML/CSS/JS, no build step
scripts/            db-init.sh, s3-init.sh, deploy-init.sh, smoke-test.sh
infra/              AWS resource notes and IAM policies
docs/               API.md, LOCAL_TESTING.md, architecture.drawio
docker-compose.yml  local Postgres + S3Mock (+ the server), see docs/LOCAL_TESTING.md
.github/workflows/  CI (typecheck) and deploy (build image, push, App Runner rollout)
Dockerfile          what runs in production
```

## How it fits together

- **Database.** One Aurora PostgreSQL cluster. Nobody has a database password: the server signs a 15-minute IAM token per connection (`server/db/client.ts`). Tables are created by `server/db/migrate.ts`, which applies each file in `sql/schema/` once and records it in `schema_migrations`. The production container runs it on every start.
- **Auth.** Better Auth stores users, sessions and login methods in `users`, `sessions`, `accounts`, `verifications` (see `sql/schema/002_auth.sql`). A password is an `accounts` row with provider `credential`; a Google login is an `accounts` row with provider `google`. Sessions are HttpOnly cookies. `server/routes/session.ts` turns a cookie into `c.get("userId")` for protected routes.
- **Files.** The browser never sends audio through the server. It asks `POST /api/files/upload-url` for a presigned S3 PUT, uploads straight to S3, then calls `POST /api/files` to record the row. Playback uses a presigned GET. Keys are `users/<id>/...`, so a key alone proves ownership.
- **Hosting.** App Runner runs the Docker image and gives us an HTTPS URL. The server's AWS identity is an IAM role attached to the service, so there are no AWS keys in production either.
- **Deploys.** Push to `main`. GitHub Actions typechecks, builds the image, pushes it to ECR using a short-lived OIDC credential, and App Runner rolls it out. Pull requests only run the typecheck.

## Run locally

**Recommended: Docker, no AWS account needed.** `docker compose --profile prod up --build` runs the production image against a local Postgres and a local S3 (S3Mock). Then `scripts/smoke-test.sh` proves the whole flow. Full guide with hot-reload and reset instructions: `docs/LOCAL_TESTING.md`.

**Against the shared Aurora cluster instead.** Prerequisites: Node 24+, AWS credentials on your machine with `rds-db:connect` on the cluster and read/write on the bucket (ask the owner; see `infra/README.md`). Use `DB_NAME=dev_<yourname>` so your local migrations never touch the production database.

```bash
cp .env.example .env     # fill in DB_HOST and S3_AUDIO_BUCKET from the owner
npm install
npm run db:ping          # proves IAM auth, TLS and network all work
npm run db:migrate       # creates any tables not yet created
npm run db:seed          # instruments
npm run dev              # http://localhost:3000
```

Sign up with email and password on the page. Google sign-in appears only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set; for local use, register `http://localhost:3000/api/auth/callback/google` as a redirect URI on the same Google OAuth client.

Useful scripts: `npm run typecheck`, `npm run build`, `npm run auth:schema` (prints the SQL Better Auth expects for the field map in `server/auth.ts`; compare against `002_auth.sql` after changing either).

## Changing the database

- New table: add `sql/schema/00N_name.sql`. It runs once, in order, on the next `db:migrate` (locally) or deploy (production).
- Changing an existing table: add `sql/migrations/YYYYMMDD_description.sql` with `ALTER TABLE ...`. Same rules.
- Never edit a schema file that has already been applied somewhere; the runner will not re-run it.

## Deploying

One-time setup, run by the AWS account owner after pushing this code to `main`:

```bash
scripts/deploy-init.sh                       # creates ECR, IAM roles, secrets, the App Runner service
OPEN_DB_TO_INTERNET=yes scripts/deploy-init.sh   # if it warned about the Aurora security group (see below)
```

It prints the site URL and the Google redirect URI to register. Re-run it any time; it only creates what is missing. To enable Google sign-in in production:

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... scripts/deploy-init.sh
```

After that, every push to `main` deploys. Watch it under the repo's Actions tab; the production environment there links to the live URL.

### Database network

App Runner instances do not have fixed outbound IP addresses, so the Aurora security group cannot allowlist them. The MVP keeps the cluster publicly reachable on port 5432 and relies on two locks that are always on: TLS is required, and login needs a signed IAM token from a principal with `rds-db:connect`. The alternative is an App Runner VPC connector plus a NAT gateway, which costs more and is not set up yet.

## Architecture diagram

![Architecture](docs/architecture.png)

`docs/architecture.drawio` has two pages: the architecture above (AWS icons, including the transcription pipeline) and the full database schema with every column and foreign key. Open it at [app.diagrams.net](https://app.diagrams.net) (File, Open from, Device) or in VS Code with the "Draw.io Integration" extension. It is plain XML, so edit it in the same PR as the schema change it describes.

## Transcription pipeline

`POST /api/jobs` turns a recording into sheet music through AWS Step Functions: Split, then one Lambda per 30-second chunk in parallel, then Merge, Notate and Finalize. Code in `server/pipeline/`, state machine in `infra/transcription.asl.json`, AWS setup in `scripts/pipeline-init.sh`, worker image in `Dockerfile.worker`. Locally the same steps run inside the server, no AWS needed.

**For the model team:** replace the one function in `server/pipeline/model.ts`. Input is an audio file in S3 plus a time window; output is a MIDI file with one track per instrument. Everything else (splitting, fan-out, merging, notation, database, UI) already works around the placeholder.

## Building the frontend

The backend is done enough to build against. Start here:

- `docs/API.md` lists every endpoint with request and response shapes.
- `public/` is a working reference client in plain JavaScript, including the Backend check panel and the full upload flow with verification.
- For a separate frontend app, run the server with `CORS_ORIGINS=http://localhost:5173` (or your dev server's origin) and use `credentials: "include"` on fetch. Sessions are cookies; there is no token to manage.

Each folder has its own README: `server/`, `server/db/`, `server/routes/`, `server/services/`, `server/storage/`, `public/`, `scripts/`, `infra/`.

## Collaborators

- **Editing code and deploying:** a GitHub collaborator invite is all that is needed. Open a PR; CI typechecks it; merging to `main` deploys.
- **Running locally against the shared database:** needs an IAM user or role with the policy in `infra/README.md` (`rds-db:connect` for the cluster and S3 access to the bucket), plus `aws configure` on their machine.
- **Just using the site:** share the App Runner URL.
