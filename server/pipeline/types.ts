// Shapes passed between pipeline steps. In production these are the JSON states
// Step Functions hands from one Lambda to the next (infra/transcription.asl.json).
// Locally, server/pipeline/inline.ts passes the same objects between the same functions.

/** What the API sends when it starts a job. */
export type JobInput = {
  jobId: number;
  userId: number;
  audioFileId: number;
  audioKey: string;          // S3 key of the uploaded recording
  audioName: string;
  durationSeconds: number;
};

/**
 * One unit of work for the model. THIS IS THE CONTRACT the model team implements:
 * read seconds [startSeconds, endSeconds) of audioKey, write a MIDI file to outputKey.
 * Note times in the MIDI are relative to startSeconds. One MIDI track per instrument,
 * named with the instrument (track name meta event), e.g. "violin", "cello", "piano".
 */
export type Chunk = {
  jobId: number;
  index: number;
  audioKey: string;
  startSeconds: number;
  endSeconds: number;
  outputKey: string;
};

/** After split: the plan. */
export type SplitState = JobInput & { chunks: Chunk[]; overlapSeconds: number };

/** What each transcribe worker returns (Map collects these into an array). */
export type ChunkResult = { index: number; outputKey: string };

/** After the Map state. */
export type TranscribedState = SplitState & { transcribed: ChunkResult[] };

/** After merge. */
export type MergedState = TranscribedState & { mergedKey: string; parts: string[] };

/** After notate: one MusicXML file per instrument part. */
export type NotatedState = MergedState & { sheets: { part: string; key: string }[] };

/** Prefix all of a job's files under the owner's folder, like uploads. */
export function jobPrefix(userId: number, jobId: number): string {
  return `users/${userId}/jobs/${jobId}`;
}
