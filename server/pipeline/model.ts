// ============================================================================
//  MODEL SLOT. This is the one function the model team replaces.
//
//  Input:  a Chunk (see types.ts): the S3 key of the full recording and the
//          window [startSeconds, endSeconds) this worker is responsible for.
//  Output: a MIDI file (bytes). Note times relative to startSeconds. One track
//          per instrument, track name = instrument name ("violin", "cello", ...),
//          matching names in app.instruments where possible.
//
//  The real model can live anywhere: in this file (Node), in a separate Lambda
//  in Python (point the Map state's Resource at it in infra/transcription.asl.json),
//  or behind SageMaker if it needs a GPU. Only the contract above has to hold.
//
//  The placeholder below ignores the audio and emits a fixed two-part pattern,
//  so everything around it (split, fan-out, merge, notation, DB, UI) can be built
//  and tested before the model exists.
// ============================================================================
import { notesToMidi, type Note } from "./midi.js";
import type { Chunk } from "./types.js";

const ARPEGGIO = [60, 64, 67, 72];   // C E G C, piano, every half second
const MELODY = [76, 74, 72, 74, 76, 76, 76, 74]; // violin, one note per second

export async function transcribeChunk(chunk: Chunk): Promise<Uint8Array> {
  const length = chunk.endSeconds - chunk.startSeconds;
  const notes: Note[] = [];
  for (let t = 0; t < length; t += 0.5) {
    const absolute = Math.round((chunk.startSeconds + t) * 2);
    notes.push({ part: "piano", pitch: ARPEGGIO[absolute % ARPEGGIO.length]!, start: t, end: t + 0.45, velocity: 70 });
  }
  for (let t = Math.ceil(chunk.startSeconds) - chunk.startSeconds; t < length; t += 1) {
    const absolute = Math.round(chunk.startSeconds + t);
    notes.push({ part: "violin", pitch: MELODY[absolute % MELODY.length]!, start: t, end: t + 0.95, velocity: 80 });
  }
  return notesToMidi(notes);
}
