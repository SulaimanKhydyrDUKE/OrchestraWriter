# HTTP API

Base URL: the site origin (`http://localhost:3000` in development, the App Runner URL in production). All bodies are JSON. Sessions are HttpOnly cookies set by the server, so a same-origin frontend sends nothing special. A frontend on another origin needs the server started with `CORS_ORIGINS=<its origin>` and must call `fetch` with `credentials: "include"`.

Errors from our routes look like `{ "error": "message" }`. Errors from Better Auth look like `{ "code": "SOME_CODE", "message": "..." }`. Protected routes return `401 { "error": "Not signed in" }` without a valid session.

## Health and status

| Method | Path | Auth | Returns |
|--------|------|------|---------|
| GET | `/health` | no | `{ ok: true }` (liveness, no DB) |
| GET | `/health/db` | no | `{ ok: true }` or 503 |
| GET | `/api/config` | no | `{ googleEnabled: boolean }` |
| GET | `/api/status` | optional | database, storage and auth checks; see below |

`GET /api/status` response:

```json
{
  "ok": true,
  "server":   { "env": "production", "time": "2026-10-19T06:20:42.189Z", "baseUrl": "https://..." },
  "database": { "ok": true, "latencyMs": 12, "instruments": 31, "detail": "PostgreSQL 17.9, 31 instruments seeded, host orchestra-db-1" },
  "storage":  { "ok": true, "latencyMs": 80, "bucket": "orchestra-writer-s3", "detail": "bucket orchestra-writer-s3 reachable in us-east-1" },
  "auth":     { "googleEnabled": false, "signedIn": true, "user": { "id": "1", "name": "Ada", "email": "ada@example.com" } }
}
```

## Auth (Better Auth, under `/api/auth`)

These are Better Auth's standard endpoints. Full list: https://www.better-auth.com/docs/concepts/api

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/api/auth/sign-up/email` | `{ name, email, password }` (password ≥ 8 chars) | `{ token, user }` and sets the session cookie |
| POST | `/api/auth/sign-in/email` | `{ email, password }` | `{ token, user }` and sets the cookie; 401 `INVALID_EMAIL_OR_PASSWORD` |
| POST | `/api/auth/sign-in/social` | `{ provider: "google", callbackURL: "/" }` | `{ url }`; navigate the browser to `url` |
| GET | `/api/auth/get-session` | | `{ session, user }` or `null` |
| POST | `/api/auth/sign-out` | `{}` | `{ success: true }` and clears the cookie |

`user` fields: `id` (string, numeric), `name`, `email`, `emailVerified`, `image`, `createdAt`, `updatedAt`.

Browser requests must send an `Origin` header matching the site or one of `CORS_ORIGINS` (browsers do this automatically). That is Better Auth's CSRF check.

## Files (`/api/files`, all require a session)

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET | `/api/files` | | `{ files: File[] }`, newest first |
| POST | `/api/files/upload-url` | `{ filename, contentType }` (`audio/*`) | `{ key, uploadUrl }` |
| POST | `/api/files` | `{ name, key, audioLengthSeconds }` | 201 `{ file: File }`; 403 if `key` is not under your prefix |
| GET | `/api/files/:id/download-url` | | `{ url }` (valid 15 min); 404 if not yours |
| DELETE | `/api/files/:id` | | 204; 404 if not yours |

`File`: `{ id: number, name: string, key: string, audioLengthSeconds: number, createdAt: string }`

### Upload flow

1. `POST /api/files/upload-url` with the file's name and MIME type. The server mints a key `users/<userId>/<uuid>-<name>` and signs a PUT URL for it.
2. `PUT <uploadUrl>` with the raw file as the body and the **same** `Content-Type` header. This goes straight to S3, not through the server.
3. `POST /api/files` with the `key` from step 1, a display `name`, and the duration in whole seconds (read it in the browser with an `Audio` element).
4. To play: `GET /api/files/:id/download-url`, then set the returned `url` as an `<audio>` source.

`public/app.js` is a complete reference client for all of this in plain JavaScript.

## Transcription jobs (`/api/jobs`, all require a session)

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/api/jobs` | `{ audioFileId }` | 201 `{ job: Job }`, status `running`; 404 if the recording is not yours |
| GET | `/api/jobs` | | `{ jobs: Job[] }`, newest first, at most 50 |
| GET | `/api/jobs/:id` | | `{ job: Job }`, including `sheets` once `status` is `succeeded` |
| GET | `/api/sheets/:id/download-url` | | `{ url }`, presigned MusicXML download, valid 15 min |

`Job`: `{ id, audioFileId, audioName, status: "queued" | "running" | "succeeded" | "failed", chunkCount, setId, error, createdAt, startedAt, finishedAt, sheets?: { id, name, instrument }[] }`

Poll `GET /api/jobs/:id` every few seconds until `status` is `succeeded` or `failed`. `public/app.js` does exactly that.

What happens behind it: the API inserts a job row and starts one AWS Step Functions execution (locally, it runs the same steps inside the server). Split plans 30-second windows, one Lambda per window transcribes it in parallel, Merge stitches the windows, Notate writes one MusicXML file per instrument, Finalize records the sheets. The transcription model is a placeholder until the model team replaces `server/pipeline/model.ts`; see the contract at the top of that file.
