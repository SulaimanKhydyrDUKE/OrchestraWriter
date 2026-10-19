# server/routes/

HTTP handlers. One file per resource, each exporting a `Hono` sub-app that `index.ts` mounts.

- `session.ts`: `requireUser` middleware. Turns the session cookie into `c.get("user")` and `c.get("userId")`, or answers 401.
- `files.ts`: `/api/files`, the signed-in user's recordings. Mounts `requireUser` on every route.
- `status.ts`: `/api/status`, public backend self-check.

A route validates the body by hand (the shapes are small), calls one function in `services/`, and returns JSON. Errors thrown by services are mapped to status codes in the sub-app's `onError`. Routes never import from `db/` or `storage/`.

Adding a resource: create `thing.ts` with `export const thingRoutes = new Hono<AuthEnv>()`, add `app.route("/api/thing", thingRoutes)` in `index.ts`, document it in `docs/API.md`.
