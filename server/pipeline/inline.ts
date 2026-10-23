// Runs the whole pipeline inside the API process. Used locally (docker compose,
// npm run dev) so the full flow works without AWS. Same functions as the Lambdas.
import { finalize, markFailed } from "./finalize.js";
import { merge, notate, split, transcribe } from "./steps.js";
import type { JobInput } from "./types.js";

const LOCAL_CONCURRENCY = 4;

export async function runInline(input: JobInput): Promise<void> {
  try {
    const plan = await split(input);
    const transcribed = [];
    for (let i = 0; i < plan.chunks.length; i += LOCAL_CONCURRENCY) {
      transcribed.push(...(await Promise.all(plan.chunks.slice(i, i + LOCAL_CONCURRENCY).map(transcribe))));
    }
    const merged = await merge({ ...plan, transcribed });
    const notated = await notate(merged);
    await finalize(notated);
  } catch (err) {
    console.error(`job ${input.jobId} failed`, err);
    await markFailed({ jobId: input.jobId, error: err }).catch((e) => console.error("markFailed failed", e));
  }
}
