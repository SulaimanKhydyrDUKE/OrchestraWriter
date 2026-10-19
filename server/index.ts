// Server entrypoint.
// Boot order: load env -> build the Hono app (auth owns the DB pool) -> listen.
// Tables are created by `node dist/db/migrate.js`, which `npm start` runs first.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { auth } from "./auth.js";
import { env } from "./config/env.js";
import { closePool, query } from "./db/client.js";
import { filesRoutes } from "./routes/files.js";
import { statusRoutes } from "./routes/status.js";

const app = new Hono();

app.use(logger());

// A separate frontend (e.g. a Vite dev server) needs CORS with credentials so the
// session cookie travels. Same-origin use, like public/, needs none of this.
if (env.corsOrigins.length > 0) {
  app.use("/api/*", cors({ origin: env.corsOrigins, credentials: true }));
}

// Liveness (App Runner polls this). Kept DB-free so a DB blip does not restart the service.
app.get("/health", (c) => c.json({ ok: true }));
// Readiness: proves the pool can reach Postgres.
app.get("/health/db", async (c) => {
  try {
    await query("SELECT 1");
    return c.json({ ok: true });
  } catch (err) {
    console.error("DB health check failed", err);
    return c.json({ ok: false }, 503);
  }
});

// What the frontend needs to know before anyone is signed in.
app.get("/api/config", (c) => c.json({ googleEnabled: Boolean(env.auth.google.clientId) }));
app.route("/api/status", statusRoutes);

// Every Better Auth endpoint lives under /api/auth/*.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.route("/api/files", filesRoutes);
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// The MVP frontend: plain files in public/, no build step.
app.use("/*", serveStatic({ root: "./public" }));

const server = serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`OrchestraWriter listening on http://localhost:${info.port} (${env.nodeEnv})`);
  console.log(`  auth base URL: ${env.auth.url}`);
  console.log(`  google sign-in: ${env.auth.google.clientId ? "enabled" : "disabled"}`);
  console.log(`  s3 bucket: ${env.s3.audioBucket ?? "(not configured)"}`);
  console.log(`  cors origins: ${env.corsOrigins.length ? env.corsOrigins.join(", ") : "(same-origin only)"}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    closePool().finally(() => process.exit(0));
  });
}
