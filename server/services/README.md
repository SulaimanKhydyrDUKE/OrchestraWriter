# server/services/

Business logic. Functions here take plain values (a user id, a filename), talk to `db/` and `storage/`, and return plain objects or throw typed errors. They know nothing about HTTP, which is what makes them testable from a script.

- `files.ts`: list, presign upload, register row, presign download, delete. Enforces that a key belongs to the user before storing it.
- `status.ts`: the database and S3 checks behind `/api/status`.

Convention: DTOs returned to routes use camelCase (`audioLengthSeconds`); rows coming from Postgres use snake_case (`audio_length_seconds`, typed in `types/db.ts`). The service does the translation so the frontend never sees column names.
