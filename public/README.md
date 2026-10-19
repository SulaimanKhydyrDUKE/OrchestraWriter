# public/

The MVP frontend: one HTML page, one stylesheet, one script, no build step. The server serves this folder at `/`.

It exists to prove the backend end to end, and to be a reference client while a real frontend is built:

- **Backend check** panel at the top calls `GET /api/status` and shows database, S3 and auth state with green/red dots. Visible signed out or in.
- **Sign in / Create account** tabs call Better Auth's email endpoints. The Google button appears only when the server reports it enabled.
- **Upload** walks the five-step flow and ticks each step: duration read, presigned URL, PUT to S3, row stored, then a HEAD through a fresh download URL to prove the object is really there. The list shows each row's id and S3 key.

Every call the page makes is documented in `docs/API.md`. When you build the real frontend, keep this page: it is the fastest way to tell whether a problem is in the backend or in your UI.

Building a separate frontend (Vite, Next, anything): start the server with `CORS_ORIGINS=http://localhost:5173`, use `fetch(..., { credentials: "include" })`, and the session cookie works across origins in development.
