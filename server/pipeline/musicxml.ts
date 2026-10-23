// Very small notes -> MusicXML writer. PLACEHOLDER quality: one voice per part,
// quantized to eighth notes at 120 bpm in 4/4, no ties across barlines.
// Good enough to prove the pipeline end to end; the notation team will replace it.
import type { Note } from "./midi.js";

const EIGHTH = 0.25;            // seconds per eighth note at 120 bpm
const SLOTS_PER_MEASURE = 8;    // 4/4 in eighths
const DURATION_TYPES: [number, string, boolean][] = [
  [8, "whole", false], [6, "half", true], [4, "half", false], [3, "quarter", true], [2, "quarter", false], [1, "eighth", false],
];
const STEPS: [string, number][] = [["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0], ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0]];
const CLEF_SPLIT = 60; // middle C

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function pitchXml(midi: number): string {
  const [step, alter] = STEPS[midi % 12]!;
  return `<pitch><step>${step}</step>${alter ? "<alter>1</alter>" : ""}<octave>${Math.floor(midi / 12) - 1}</octave></pitch>`;
}

function noteXml(midi: number | null, slots: number): string {
  const [, type, dot] = DURATION_TYPES.find(([d]) => d === slots)!;
  const body = midi === null ? "<rest/>" : pitchXml(midi);
  return `<note>${body}<duration>${slots}</duration><type>${type}</type>${dot ? "<dot/>" : ""}</note>`;
}

/** Split a run of slots into note values that exist (8, 6, 4, 3, 2, 1). */
function fill(length: number): number[] {
  const out: number[] = [];
  let left = length;
  while (left > 0) {
    const d = DURATION_TYPES.map(([x]) => x).find((x) => x <= left)!;
    out.push(d); left -= d;
  }
  return out;
}

export function notesToMusicXml(part: string, notes: Note[], title: string): string {
  // Highest pitch wins each slot; a note lasts until its end or the next onset.
  const lastEnd = Math.max(0, ...notes.map((n) => n.end));
  const totalSlots = Math.max(SLOTS_PER_MEASURE, Math.ceil(lastEnd / EIGHTH / SLOTS_PER_MEASURE) * SLOTS_PER_MEASURE);
  const onsets = new Map<number, Note>();
  for (const n of notes) {
    const slot = Math.round(n.start / EIGHTH);
    const cur = onsets.get(slot);
    if (!cur || n.pitch > cur.pitch) onsets.set(slot, n);
  }
  const avg = notes.length ? notes.reduce((a, n) => a + n.pitch, 0) / notes.length : 72;
  const clef = avg >= CLEF_SPLIT ? "<clef><sign>G</sign><line>2</line></clef>" : "<clef><sign>F</sign><line>4</line></clef>";

  const measures: string[] = [];
  for (let m = 0; m * SLOTS_PER_MEASURE < totalSlots; m++) {
    const first = m * SLOTS_PER_MEASURE;
    const end = first + SLOTS_PER_MEASURE;
    const parts: string[] = [];
    let slot = first;
    while (slot < end) {
      const n = onsets.get(slot);
      if (n) {
        let next = slot + 1;
        while (next < end && !onsets.has(next)) next++;
        const len = Math.max(1, Math.min(next - slot, Math.round((n.end - n.start) / EIGHTH) || 1, end - slot));
        const [first1, ...rest] = fill(len);
        parts.push(noteXml(n.pitch, first1!));
        for (const r of rest) parts.push(noteXml(null, r));
        slot += len;
      } else {
        let next = slot + 1;
        while (next < end && !onsets.has(next)) next++;
        for (const r of fill(next - slot)) parts.push(noteXml(null, r));
        slot = next;
      }
    }
    const attrs = m === 0
      ? `<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>${clef}</attributes>`
        + `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type><sound tempo="120"/></direction>`
      : "";
    measures.push(`<measure number="${m + 1}">${attrs}${parts.join("")}</measure>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0"><work><work-title>${xmlEscape(title)}</work-title></work>
<part-list><score-part id="P1"><part-name>${xmlEscape(part)}</part-name></score-part></part-list>
<part id="P1">${measures.join("\n")}</part></score-partwise>
`;
}
