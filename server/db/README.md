# server/db/

`client.ts` exports one `pg` pool and a `query()` helper. On Aurora the pool has no password: every new connection asks the AWS SDK for a 15-minute IAM token. Set `DB_PASSWORD` and `DB_SSL=false` only for a local Postgres.

`migrate.ts` (`npm run db:migrate`) applies `sql/schema/*.sql` and then `sql/migrations/*.sql` in filename order, each exactly once, each in its own transaction. Applied filenames are stored in `schema_migrations`. The production container runs it on every start, so a deploy that adds a SQL file also applies it. It retries the first connection because the cluster auto-pauses when idle.

`seed.ts` (`npm run db:seed`) runs `sql/seeds/*.sql` every time; write seeds with `ON CONFLICT DO NOTHING`.

`ping.ts` (`npm run db:ping`) is the connection smoke test: IAM token, TLS, network.

Rules for SQL files are in `sql/README.md`. Short version: new table → new numbered schema file; change to an existing table → dated file in `migrations/`; never edit a file that has already been applied.
