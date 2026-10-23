// The pipeline steps that only touch S3. Each is a plain async function of the
// state described in types.ts, so the same code runs in Lambda and inline locally.
import { getObjectBytes, putObjectBytes } from "../storage/objects.js";
import { midiToNotes, notesToMidi, type Note } from "./midi.js";
import { notesToMusicXml } from "./musicxml.js";
import { transcribeChunk } from "./model.js";
import {
  jobPrefix, type Chunk, type ChunkResult, type JobInput, type MergedState,
  type NotatedState, type SplitState, type TranscribedState,
} from "./types.js";

export const CHUNK_SECONDS = 30;
export const OVERLAP_SECONDS = 2;

/** Plan the work: time windows only. Workers read their own window from the original file. */
export async function split(input: JobInput): Promise<SplitState> {
  const duration = Math.max(1, input.durationSeconds);
  const chunks: Chunk[] = [];
  for (let start = 0, i = 0; start < duration; start += CHUNK_SECONDS, i++) {
    chunks.push({
      jobId: input.jobId,
      index: i,
      audioKey: input.audioKey,
      startSeconds: Math.max(0, start - (i ? OVERLAP_SECONDS : 0)),
      endSeconds: Math.min(duration, start + CHUNK_SECONDS),
      outputKey: `${jobPrefix(input.userId, input.jobId)}/midi/chunk-${String(i).padStart(4, "0")}.mid`,
    });
  }
  return { ...input, chunks, overlapSeconds: OVERLAP_SECONDS };
}

/** One worker per chunk. Calls the model, stores its MIDI. */
export async function transcribe(chunk: Chunk): Promise<ChunkResult> {
  const midi = await transcribeChunk(chunk);
  await putObjectBytes(chunk.outputKey, midi, "audio/midi");
  return { index: chunk.index, outputKey: chunk.outputKey };
}

/**
 * Stitch chunk MIDIs onto one timeline. Each chunk owns the notes that start at or
 * after its nominal start (startSeconds + overlap, except chunk 0), which drops the
 * duplicates produced in the overlap regions.
 */
export async function merge(state: TranscribedState): Promise<MergedState> {
  const all: Note[] = [];
  const byIndex = new Map(state.transcribed.map((r) => [r.index, r]));
  for (const chunk of state.chunks) {
    const result = byIndex.get(chunk.index);
    if (!result) throw new Error(`chunk ${chunk.index} produced no output`);
    const owned = chunk.index === 0 ? chunk.startSeconds : chunk.startSeconds + state.overlapSeconds;
    for (const n of midiToNotes(await getObjectBytes(result.outputKey))) {
      const start = n.start + chunk.startSeconds;
      if (start < owned || start >= chunk.endSeconds) continue;
      all.push({ ...n, start, end: n.end + chunk.startSeconds });
    }
  }
  const mergedKey = `${jobPrefix(state.userId, state.jobId)}/merged.mid`;
  await putObjectBytes(mergedKey, notesToMidi(all), "audio/midi");
  const parts = [...new Set(all.map((n) => n.part))].sort();
  return { ...state, mergedKey, parts };
}

/** One MusicXML file per part. */
export async function notate(state: MergedState): Promise<NotatedState> {
  const notes = midiToNotes(await getObjectBytes(state.mergedKey));
  const sheets: { part: string; key: string }[] = [];
  for (const part of state.parts) {
    const slug = part.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "part";
    const key = `${jobPrefix(state.userId, state.jobId)}/sheets/${slug}.musicxml`;
    const xml = notesToMusicXml(part, notes.filter((n) => n.part === part), `${state.audioName} (${part})`);
    await putObjectBytes(key, xml, "application/vnd.recordare.musicxml+xml");
    sheets.push({ part, key });
  }
  return { ...state, sheets };
}
