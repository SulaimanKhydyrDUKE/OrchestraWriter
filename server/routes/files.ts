// /api/files: the signed-in user's audio recordings.
// Upload is two requests: POST /upload-url (get a presigned S3 PUT), then
// POST / with the key once the browser has PUT the bytes to S3 directly.
import { Hono } from "hono";
import * as files from "../services/files.js";
import { StorageNotConfiguredError } from "../storage/audio.js";
import { requireUser, type AuthEnv } from "./session.js";

export const filesRoutes = new Hono<AuthEnv>();

filesRoutes.use("*", requireUser);

filesRoutes.onError((err, c) => {
  if (err instanceof StorageNotConfiguredError) {
    return c.json({ error: "File storage is not configured on this server" }, 503);
  }
  if (err instanceof files.ForbiddenKeyError) {
    return c.json({ error: err.message }, 403);
  }
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

async function jsonBody(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

filesRoutes.get("/", async (c) => {
  return c.json({ files: await files.listFiles(c.get("userId")) });
});

filesRoutes.post("/upload-url", async (c) => {
  const body = await jsonBody(c);
  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  const contentType = typeof body.contentType === "string" ? body.contentType.trim() : "";
  if (!filename || !contentType) {
    return c.json({ error: "filename and contentType are required" }, 400);
  }
  if (!/^(audio\/|video\/|application\/octet-stream$)/.test(contentType)) {
    return c.json({ error: "Only audio uploads are accepted" }, 400);
  }
  return c.json(await files.createUploadUrl(c.get("userId"), filename, contentType));
});

filesRoutes.post("/", async (c) => {
  const body = await jsonBody(c);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const key = typeof body.key === "string" ? body.key : "";
  const audioLengthSeconds = Number(body.audioLengthSeconds);
  if (!name || name.length > 100) return c.json({ error: "name must be 1-100 characters" }, 400);
  if (!key) return c.json({ error: "key is required" }, 400);
  if (!Number.isInteger(audioLengthSeconds) || audioLengthSeconds <= 0) {
    return c.json({ error: "audioLengthSeconds must be a positive integer" }, 400);
  }
  const file = await files.registerFile(c.get("userId"), { name, key, audioLengthSeconds });
  return c.json({ file }, 201);
});

filesRoutes.get("/:id/download-url", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid id" }, 400);
  const url = await files.getDownloadUrl(c.get("userId"), id);
  return url ? c.json({ url }) : c.json({ error: "Not found" }, 404);
});

filesRoutes.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid id" }, 400);
  const deleted = await files.deleteFile(c.get("userId"), id);
  return deleted ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
});
