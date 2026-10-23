// Transcription jobs: create, start the pipeline, read status, sign sheet downloads.
import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { awsConfig } from "../config/aws.js";
import { env } from "../config/env.js";
import { query } from "../db/client.js";
import { markFailed } from "../pipeline/finalize.js";
import { runInline } from "../pipeline/inline.js";
import type { JobInput } from "../pipeline/types.js";
import { presignDownload } from "../storage/audio.js";

const sfn = new SFNClient({ region: awsConfig.region });

export class NotFoundError extends Error {
  constructor(what: string) { super(`${what} not found`); this.name = "NotFoundError"; }
}

type JobRow = {
  id: number; audio_file_id: number | null; audio_name: string | null; status: string;
  execution_arn: string | null; chunk_count: number | null; set_id: number | null; error: string | null;
  created_at: Date; started_at: Date | null; finished_at: Date | null;
};

export type SheetDto = { id: number; name: string; instrument: string };
export type JobDto = {
  id: number; audioFileId: number | null; audioName: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  chunkCount: number | null; setId: number | null; error: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  sheets?: SheetDto[];
};

const SELECT_JOB = `
  SELECT j.id, j.audio_file_id, a.name AS audio_name, j.status, j.execution_arn, j.chunk_count,
         j.set_id, j.error, j.created_at, j.started_at, j.finished_at
    FROM app.transcription_jobs j
    LEFT JOIN app.audio_files a ON a.id = j.audio_file_id`;

function toDto(r: JobRow): JobDto {
  return {
    id: r.id, audioFileId: r.audio_file_id, audioName: r.audio_name, status: r.status as JobDto["status"],
    chunkCount: r.chunk_count, setId: r.set_id, error: r.error,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

/** Create a job for one of the user's recordings and start the pipeline. */
export async function createJob(userId: number, audioFileId: number): Promise<JobDto> {
  const [audio] = await query<{ id: number; name: string; s3_key: string; audio_length_seconds: number }>(
    "SELECT id, name, s3_key, audio_length_seconds FROM app.audio_files WHERE id = $1 AND user_id = $2",
    [audioFileId, userId]);
  if (!audio) throw new NotFoundError("Recording");

  const [job] = await query<{ id: number }>(
    "INSERT INTO app.transcription_jobs (user_id, audio_file_id) VALUES ($1, $2) RETURNING id", [userId, audioFileId]);
  const input: JobInput = {
    jobId: job!.id, userId, audioFileId,
    audioKey: audio.s3_key, audioName: audio.name, durationSeconds: audio.audio_length_seconds,
  };

  if (env.pipeline.mode === "stepfunctions") {
    if (!env.pipeline.stateMachineArn) throw new Error("STATE_MACHINE_ARN is not set");
    try {
      const out = await sfn.send(new StartExecutionCommand({
        stateMachineArn: env.pipeline.stateMachineArn,
        name: `job-${input.jobId}-${Date.now()}`,
        input: JSON.stringify(input),
      }));
      await query("UPDATE app.transcription_jobs SET status = 'running', started_at = now(), execution_arn = $2 WHERE id = $1",
        [input.jobId, out.executionArn]);
    } catch (err) {
      await markFailed({ jobId: input.jobId, error: err });
      throw err;
    }
  } else {
    await query("UPDATE app.transcription_jobs SET status = 'running', started_at = now() WHERE id = $1", [input.jobId]);
    void runInline(input); // fire and forget; the job row records the outcome
  }
  return getJob(userId, input.jobId);
}

export async function listJobs(userId: number): Promise<JobDto[]> {
  const rows = await query<JobRow>(`${SELECT_JOB} WHERE j.user_id = $1 ORDER BY j.created_at DESC, j.id DESC LIMIT 50`, [userId]);
  return rows.map(toDto);
}

/** One job, with its sheets once it has succeeded. */
export async function getJob(userId: number, jobId: number): Promise<JobDto> {
  const [row] = await query<JobRow>(`${SELECT_JOB} WHERE j.id = $1 AND j.user_id = $2`, [jobId, userId]);
  if (!row) throw new NotFoundError("Job");
  await reconcile(row);
  const dto = toDto(row);
  if (row.set_id) {
    dto.sheets = await query<SheetDto>(
      `SELECT s.id, s.name, i.name AS instrument FROM app.sheets s JOIN app.instruments i ON i.id = s.instrument_id
        WHERE s.set_id = $1 ORDER BY s.id`, [row.set_id]);
  }
  return dto;
}

/**
 * Safety net: if an execution died in a way the state machine's Catch could not
 * record (aborted by hand, Step Functions-level timeout), mark the job failed.
 */
async function reconcile(row: JobRow): Promise<void> {
  if (row.status !== "running" || !row.execution_arn || env.pipeline.mode !== "stepfunctions") return;
  try {
    const ex = await sfn.send(new DescribeExecutionCommand({ executionArn: row.execution_arn }));
    if (ex.status && ex.status !== "RUNNING" && ex.status !== "SUCCEEDED" && ex.status !== "PENDING_REDRIVE") {
      await markFailed({ jobId: row.id, error: { Error: `Execution ${ex.status}`, Cause: ex.cause ?? ex.error } });
      row.status = "failed";
      row.error = `Execution ${ex.status}`;
    }
  } catch (err) {
    console.warn(`could not describe execution for job ${row.id}`, err);
  }
}

export async function getSheetDownloadUrl(userId: number, sheetId: number): Promise<string> {
  const [row] = await query<{ s3_key: string }>(
    `SELECT s.s3_key FROM app.sheets s JOIN app.orchestral_sets o ON o.id = s.set_id
      WHERE s.id = $1 AND o.user_id = $2`, [sheetId, userId]);
  if (!row) throw new NotFoundError("Sheet");
  return presignDownload(row.s3_key);
}
