// /api/jobs: transcription jobs for the signed-in user.
// /api/sheets/:id/download-url: presigned link to a finished MusicXML part.
import { Hono } from "hono";
import * as jobs from "../services/jobs.js";
import { StorageNotConfiguredError } from "../storage/audio.js";
import { requireUser, type AuthEnv } from "./session.js";

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function withErrors(app: Hono<AuthEnv>): Hono<AuthEnv> {
  app.use("*", requireUser);
  app.onError((err, c) => {
    if (err instanceof jobs.NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof StorageNotConfiguredError) return c.json({ error: "File storage is not configured on this server" }, 503);
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });
  return app;
}

export const jobsRoutes = withErrors(new Hono<AuthEnv>());

jobsRoutes.get("/", async (c) => c.json({ jobs: await jobs.listJobs(c.get("userId")) }));

jobsRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { audioFileId?: unknown };
  const audioFileId = Number(body.audioFileId);
  if (!Number.isInteger(audioFileId) || audioFileId <= 0) return c.json({ error: "audioFileId is required" }, 400);
  return c.json({ job: await jobs.createJob(c.get("userId"), audioFileId) }, 201);
});

jobsRoutes.get("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid id" }, 400);
  return c.json({ job: await jobs.getJob(c.get("userId"), id) });
});

export const sheetsRoutes = withErrors(new Hono<AuthEnv>());

sheetsRoutes.get("/:id/download-url", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid id" }, 400);
  return c.json({ url: await jobs.getSheetDownloadUrl(c.get("userId"), id) });
});
