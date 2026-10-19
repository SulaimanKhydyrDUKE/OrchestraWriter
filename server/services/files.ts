// Audio file business logic: DB rows in audio_files + objects in S3.
// Routes call these; nothing here knows about HTTP.
import { query } from "../db/client.js";
import {
  deleteAudio,
  keyBelongsTo,
  newAudioKey,
  presignDownload,
  presignUpload,
} from "../storage/audio.js";
import type { AudioFileRow } from "../types/db.js";

export type AudioFileDto = {
  id: number;
  name: string;
  key: string;
  audioLengthSeconds: number;
  createdAt: string;
};

export class ForbiddenKeyError extends Error {
  constructor() {
    super("That object key does not belong to you");
    this.name = "ForbiddenKeyError";
  }
}

function toDto(row: AudioFileRow): AudioFileDto {
  return {
    id: row.id,
    name: row.name,
    key: row.s3_key,
    audioLengthSeconds: row.audio_length_seconds,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listFiles(userId: number): Promise<AudioFileDto[]> {
  const rows = await query<AudioFileRow>(
    `SELECT id, user_id, name, s3_key, audio_length_seconds, created_at
       FROM audio_files
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC`,
    [userId],
  );
  return rows.map(toDto);
}

/** Step 1 of an upload: mint a key under the user's prefix and sign a PUT URL for it. */
export async function createUploadUrl(
  userId: number,
  filename: string,
  contentType: string,
): Promise<{ key: string; uploadUrl: string }> {
  const key = newAudioKey(userId, filename);
  const uploadUrl = await presignUpload(key, contentType);
  return { key, uploadUrl };
}

/** Step 2 of an upload: after the browser PUT succeeds, record the row. */
export async function registerFile(
  userId: number,
  input: { name: string; key: string; audioLengthSeconds: number },
): Promise<AudioFileDto> {
  if (!keyBelongsTo(input.key, userId)) throw new ForbiddenKeyError();
  const [row] = await query<AudioFileRow>(
    `INSERT INTO audio_files (user_id, name, s3_key, audio_length_seconds)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, name, s3_key, audio_length_seconds, created_at`,
    [userId, input.name, input.key, input.audioLengthSeconds],
  );
  return toDto(row!);
}

export async function getDownloadUrl(userId: number, fileId: number): Promise<string | null> {
  const [row] = await query<Pick<AudioFileRow, "s3_key">>(
    "SELECT s3_key FROM audio_files WHERE id = $1 AND user_id = $2",
    [fileId, userId],
  );
  return row ? presignDownload(row.s3_key) : null;
}

/** Removes the row, then the object. Returns false if the file was not the user's. */
export async function deleteFile(userId: number, fileId: number): Promise<boolean> {
  const [row] = await query<Pick<AudioFileRow, "s3_key">>(
    "DELETE FROM audio_files WHERE id = $1 AND user_id = $2 RETURNING s3_key",
    [fileId, userId],
  );
  if (!row) return false;
  try {
    await deleteAudio(row.s3_key);
  } catch (err) {
    // The row is gone; an orphaned object is a cleanup job, not a user-facing error.
    console.error(`Failed to delete S3 object ${row.s3_key}`, err);
  }
  return true;
}
