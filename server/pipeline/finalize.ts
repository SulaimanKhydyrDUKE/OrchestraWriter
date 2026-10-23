// The only pipeline steps that touch the database. In AWS they log in as the
// orchestra_worker Postgres role, which can see app tables and nothing in auth.
import { pool } from "../db/client.js";
import type { NotatedState } from "./types.js";

/** Record the score: one orchestral_sets row, one sheets row per part, job succeeded. Idempotent. */
export async function finalize(state: NotatedState): Promise<{ jobId: number; setId: number; sheets: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await client.query<{ status: string; set_id: number | null }>(
      "SELECT status, set_id FROM app.transcription_jobs WHERE id = $1 FOR UPDATE", [state.jobId]);
    const row = job.rows[0];
    if (!row) throw new Error(`job ${state.jobId} not found`);
    if (row.status === "succeeded" && row.set_id) {
      await client.query("COMMIT");
      return { jobId: state.jobId, setId: row.set_id, sheets: state.sheets.length };
    }
    const set = await client.query<{ id: number }>(
      `INSERT INTO app.orchestral_sets (user_id, audio_file_id, name) VALUES ($1, $2, $3) RETURNING id`,
      [state.userId, state.audioFileId, `${state.audioName} · score`.slice(0, 100)]);
    const setId = set.rows[0]!.id;
    for (const sheet of state.sheets) {
      // Match the part name to a known instrument; unknown names fall back to piano.
      await client.query(
        `INSERT INTO app.sheets (set_id, instrument_id, name, s3_key)
         VALUES ($1, COALESCE((SELECT id FROM app.instruments WHERE name = lower($2)),
                              (SELECT id FROM app.instruments WHERE name = 'piano')), $3, $4)`,
        [setId, sheet.part, sheet.part.slice(0, 100), sheet.key]);
    }
    await client.query(
      `UPDATE app.transcription_jobs SET status = 'succeeded', set_id = $2, chunk_count = $3, finished_at = now(), error = NULL
       WHERE id = $1`, [state.jobId, setId, state.chunks.length]);
    await client.query("COMMIT");
    return { jobId: state.jobId, setId, sheets: state.sheets.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Called by the state machine's Catch, or by the inline runner, when any step fails. */
export async function markFailed(input: { jobId: number; error?: unknown }): Promise<{ jobId: number }> {
  const text = describeError(input.error).slice(0, 2000);
  await pool.query(
    `UPDATE app.transcription_jobs SET status = 'failed', error = $2, finished_at = now()
     WHERE id = $1 AND status <> 'succeeded'`, [input.jobId, text]);
  return { jobId: input.jobId };
}

function describeError(e: unknown): string {
  if (!e) return "unknown error";
  if (e instanceof Error) return e.message;
  if (typeof e === "object") {
    // Step Functions Catch shape: { Error, Cause } where Cause is often JSON from Lambda.
    const o = e as { Error?: string; Cause?: string };
    try {
      const cause = o.Cause ? JSON.parse(o.Cause) as { errorMessage?: string } : undefined;
      return [o.Error, cause?.errorMessage ?? o.Cause].filter(Boolean).join(": ");
    } catch {
      return [o.Error, o.Cause].filter(Boolean).join(": ");
    }
  }
  return String(e);
}
