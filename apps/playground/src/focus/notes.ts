import { NOTE_STRIDE } from "../audio/protocol";

/** A note joins a lane whose running pitch is within this many cents (FOCUS-VIEW.md §15.2). */
export const LANE_CENTS = 35;
/** A lane silent this many beats is retired, so its shade can be reused. */
const LANE_IDLE_BEATS = 8;
/** Notes kept for the Trace (§6.1). */
const CAPACITY = 4096;

export interface TraceNote {
  slot: number;
  beat: number;
  hz: number;
  vel: number;
  /** The pitch lane within its toy: the Trace's "emitter". */
  lane: number;
}

interface Lane {
  /** log2 Hz of the lane's latest note. */
  pitch: number;
  last: number;
  index: number;
}

/**
 * The Trace's note buffer. Voices can be stolen (a patch toy's allocator index
 * moves between notes), so emitters are grouped by pitch instead: each toy
 * keeps lanes, and a note joins the nearest lane within ±35 cents of its
 * running pitch, or opens a new one. One lane is one line on the Trace.
 */
export class NotesBuffer {
  readonly notes: TraceNote[] = [];
  private lanes = new Map<number, Lane[]>();
  private head = 0;

  /** Notes as the host forwards them: `[slot, beat, hz, vel]` per note. */
  push(raw: Float32Array) {
    for (let o = 0; o + NOTE_STRIDE <= raw.length; o += NOTE_STRIDE) {
      const slot = raw[o];
      const beat = raw[o + 1];
      const hz = raw[o + 2];
      if (!(hz > 0)) continue;
      const note: TraceNote = { slot, beat, hz, vel: raw[o + 3], lane: this.lane(slot, beat, Math.log2(hz)) };
      if (this.notes.length < CAPACITY) this.notes.push(note);
      else {
        this.notes[this.head] = note;
        this.head = (this.head + 1) % CAPACITY;
      }
    }
  }

  /** Notes oldest first, from `fromBeat` on. */
  *since(fromBeat: number): Iterable<TraceNote> {
    const n = this.notes.length;
    for (let i = 0; i < n; i++) {
      const note = this.notes[(this.head + i) % n];
      if (note.beat >= fromBeat) yield note;
    }
  }

  /** How many lanes a toy has open now (for the inspector and tests). */
  laneCount(slot: number): number {
    return this.lanes.get(slot)?.length ?? 0;
  }

  /** Forget a toy (it left the ring or the world). */
  forget(slot: number) {
    this.lanes.delete(slot);
  }

  clear() {
    this.notes.length = 0;
    this.head = 0;
    this.lanes.clear();
  }

  private lane(slot: number, beat: number, pitch: number): number {
    let lanes = this.lanes.get(slot);
    if (!lanes) this.lanes.set(slot, (lanes = []));
    // Retire lanes that have gone quiet.
    for (let i = lanes.length - 1; i >= 0; i--) if (beat - lanes[i].last > LANE_IDLE_BEATS) lanes.splice(i, 1);
    let best: Lane | null = null;
    let bestCents = LANE_CENTS;
    for (const l of lanes) {
      const cents = Math.abs(pitch - l.pitch) * 1200;
      if (cents <= bestCents) {
        best = l;
        bestCents = cents;
      }
    }
    if (!best) {
      // Reuse the lowest free index, so shades stay stable.
      let index = 0;
      while (lanes.some((l) => l.index === index)) index++;
      best = { pitch, last: beat, index };
      lanes.push(best);
    }
    best.pitch = pitch;
    best.last = beat;
    return best.index;
  }
}
