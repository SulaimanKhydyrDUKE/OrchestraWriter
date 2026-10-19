// GET /api/status: public backend health summary, plus who is signed in (if anyone).
import { Hono } from "hono";
import { auth } from "../auth.js";
import { env } from "../config/env.js";
import { checkDatabase, checkStorage } from "../services/status.js";

export const statusRoutes = new Hono();

statusRoutes.get("/", async (c) => {
  const [database, storage, session] = await Promise.all([
    checkDatabase(),
    checkStorage(),
    // A session lookup needs the database; if that is down we still want to
    // report the other checks instead of failing the whole response.
    auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null),
  ]);
  const user = session?.user ?? null;
  return c.json({
    ok: database.ok && storage.ok,
    server: { env: env.nodeEnv, time: new Date().toISOString(), baseUrl: env.auth.url },
    database,
    storage,
    auth: {
      googleEnabled: Boolean(env.auth.google.clientId),
      signedIn: Boolean(user),
      user: user ? { id: user.id, name: user.name, email: user.email } : null,
    },
  });
});
