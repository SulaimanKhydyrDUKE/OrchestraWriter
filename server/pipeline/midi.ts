// Minimal MIDI <-> note-list conversion. Times are in seconds; one track per instrument.
import midiFile from "midi-file";
import type { MidiData, MidiEvent } from "midi-file";

const { parseMidi, writeMidi } = midiFile;

export type Note = { part: string; pitch: number; start: number; end: number; velocity: number };

const TICKS_PER_BEAT = 480;
const MICROS_PER_BEAT = 500_000; // 120 bpm
const ticksPerSecond = (microsPerBeat: number, tpb: number) => (tpb * 1_000_000) / microsPerBeat;

/** Encode notes as a format-1 MIDI file, one track per part, at 120 bpm. */
export function notesToMidi(notes: Note[]): Uint8Array {
  const parts = [...new Set(notes.map((n) => n.part))].sort();
  const tps = ticksPerSecond(MICROS_PER_BEAT, TICKS_PER_BEAT);
  const tracks: MidiEvent[][] = parts.map((part, i) => {
    const channel = i >= 9 ? i + 1 : i; // skip channel 9 (drums)
    const timed: { tick: number; on: boolean; pitch: number; velocity: number }[] = [];
    for (const n of notes.filter((x) => x.part === part)) {
      timed.push({ tick: Math.round(n.start * tps), on: true, pitch: n.pitch, velocity: n.velocity });
      timed.push({ tick: Math.max(Math.round(n.end * tps), Math.round(n.start * tps) + 1), on: false, pitch: n.pitch, velocity: 0 });
    }
    // note-offs before note-ons at the same tick, so repeated notes don't swallow each other
    timed.sort((a, b) => a.tick - b.tick || Number(a.on) - Number(b.on));
    const events: MidiEvent[] = [{ deltaTime: 0, meta: true, type: "trackName", text: part }];
    if (i === 0) events.push({ deltaTime: 0, meta: true, type: "setTempo", microsecondsPerBeat: MICROS_PER_BEAT });
    let last = 0;
    for (const e of timed) {
      const deltaTime = e.tick - last;
      last = e.tick;
      events.push({ deltaTime, channel, type: e.on ? "noteOn" : "noteOff", noteNumber: e.pitch, velocity: e.velocity });
    }
    events.push({ deltaTime: 0, meta: true, type: "endOfTrack" });
    return events;
  });
  const data: MidiData = { header: { format: 1, numTracks: tracks.length, ticksPerBeat: TICKS_PER_BEAT }, tracks };
  return Uint8Array.from(writeMidi(data));
}

/** Decode a MIDI file into notes. Uses the first tempo event (120 bpm if none). */
export function midiToNotes(bytes: Uint8Array): Note[] {
  const midi = parseMidi(bytes);
  const tpb = midi.header.ticksPerBeat ?? TICKS_PER_BEAT;
  let micros = MICROS_PER_BEAT;
  for (const track of midi.tracks) {
    const tempo = track.find((e) => e.type === "setTempo");
    if (tempo && "microsecondsPerBeat" in tempo) { micros = tempo.microsecondsPerBeat; break; }
  }
  const tps = ticksPerSecond(micros, tpb);
  const notes: Note[] = [];
  midi.tracks.forEach((track, i) => {
    let tick = 0;
    let part = `part ${i + 1}`;
    const open = new Map<number, { start: number; velocity: number }>();
    for (const e of track) {
      tick += e.deltaTime;
      if (e.type === "trackName" || e.type === "instrumentName") part = e.text.trim() || part;
      const isOn = e.type === "noteOn" && e.velocity > 0;
      const isOff = e.type === "noteOff" || (e.type === "noteOn" && e.velocity === 0);
      if (isOn) open.set(e.noteNumber, { start: tick / tps, velocity: e.velocity });
      else if (isOff) {
        const o = open.get(e.noteNumber);
        if (o) { notes.push({ part, pitch: e.noteNumber, start: o.start, end: tick / tps, velocity: o.velocity }); open.delete(e.noteNumber); }
      }
    }
  });
  return notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}
