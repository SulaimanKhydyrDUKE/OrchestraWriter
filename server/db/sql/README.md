# SQL layout

- `schema/`     CREATE TABLE statements. Numbered so they run in order:
                `001_...sql`, `002_...sql`. One table (or tightly related group) per file.
- `seeds/`      Dev/test data. Same numbering convention.
- `migrations/` Changes to tables that already exist in a live DB (ALTER, new indexes).
                Name as `YYYYMMDD_description.sql`.

Files are plain Postgres SQL. The runner in `server/db/migrate.ts` executes them.

## Schemas

Since `migrations/20261022_01_auth_app_schemas.sql` the tables live in two schemas:

- `auth`: `users`, `sessions`, `accounts`, `verifications`. Owned by Better Auth; only the API touches them.
- `app`: everything else, including `transcription_jobs`.

Every connection uses `search_path = app, auth, public`, so code writes plain `users` or `audio_files`.
Name the schema explicitly in new SQL files (`CREATE TABLE app.something`) so there is no doubt where a table lands.

The pipeline workers log in as `orchestra_worker`, which has privileges on selected `app` tables and none on `auth`.
When you add an `app` table the workers need, add the matching `GRANT ... TO orchestra_worker` in the same file.
