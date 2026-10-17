// Mirrors crates/hypertoy-core/src/tuning.rs (`Scale::cents`, `nearest_degree`). Change both together.

/** Scale tones in cents by preset id (engine `Scale::from_id`). */
export const SCALE_CENTS: Record<number, number[]> = {
  0: [0, 200, 400, 700, 900],
  1: [0, 300, 500, 700, 1000],
  2: [0, 203.91, 386.31, 701.96, 884.36],
  3: [0, 200, 400, 500, 700, 900, 1100],
  4: [0, 200, 300, 500, 700, 900, 1000],
  5: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100],
};

export const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

/** Where a frequency sits in the world's scale. */
export interface Placed {
  /** Nearest scale degree (signed; wraps periods). */
  degree: number;
  /** Degree within the table (pitch class of the scale). */
  pc: number;
  octave: number;
  /** Signed distance from that degree, in cents. */
  cents: number;
}

export function place(hz: number, rootMidi: number, scale: number): Placed | null {
  if (!(hz > 0) || !Number.isFinite(hz)) return null;
  const tones = SCALE_CENTS[scale] ?? SCALE_CENTS[0];
  const n = tones.length;
  const cents = 1200 * Math.log2(hz / midiToHz(rootMidi));
  const k = Math.floor(cents / 1200);
  const within = cents - k * 1200;
  let best = 0;
  let bestD = Infinity;
  [...tones, 1200].forEach((s, i) => {
    const d = Math.abs(within - s);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  const degree = k * n + best;
  const pc = ((degree % n) + n) % n;
  return { degree, pc, octave: Math.floor(degree / n), cents: within - [...tones, 1200][best] };
}

/** Number of tones in a preset scale. */
export const scaleSize = (scale: number) => (SCALE_CENTS[scale] ?? SCALE_CENTS[0]).length;
