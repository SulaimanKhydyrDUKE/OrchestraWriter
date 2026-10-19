# SQL layout

- `schema/`     CREATE TABLE statements. Numbered so they run in order:
                `001_...sql`, `002_...sql`. One table (or tightly related group) per file.
- `seeds/`      Dev/test data. Same numbering convention.
- `migrations/` Changes to tables that already exist in a live DB (ALTER, new indexes).
                Name as `YYYYMMDD_description.sql`.

Files are plain Postgres SQL. The runner in `server/db/migrate.ts` executes them.
