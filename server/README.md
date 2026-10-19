# server/

The backend. TypeScript, ES modules, no framework beyond Hono.

Request path: `index.ts` builds the Hono app and mounts, in order, logging, optional CORS, health routes, `/api/status`, Better Auth at `/api/auth/*`, the file routes at `/api/files`, and finally the static frontend from `public/`.

| Folder | What lives there | Rule |
|--------|------------------|------|
| `config/` | `env.ts` reads and validates all environment variables; `aws.ts` holds shared SDK settings | nothing else reads `process.env` |
| `auth.ts` | the Better Auth instance: providers, table/column mapping, id strategy | the only file that knows auth internals |
| `db/` | the `pg` pool (`client.ts`), the schema runner (`migrate.ts`), seeds, SQL files | see `db/README.md` |
| `storage/` | S3 client and presigned-URL helpers | no HTTP, no SQL |
| `routes/` | HTTP handlers, one file per resource | validate input, call a service, shape the response; never touch db/ or storage/ directly |
| `services/` | business logic | call db/ and storage/; know nothing about HTTP |
| `types/` | row types mirroring the SQL tables | snake_case, as Postgres returns them |

Run locally with `npm run dev` (watches and restarts). `npm run typecheck` before committing; CI runs the same.
