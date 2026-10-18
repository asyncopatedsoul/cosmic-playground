import { SNAP_HEADER, SNAP_STRIDE, Snap } from "../audio/protocol";
import type { Toy } from "../toys/toy";
import type { World } from "../world";
import { NotesBuffer, type TraceNote } from "./notes";

/** Bars shown at once (4/4). */
const WINDOWS = [2, 4, 8, 16];
/** A held line lasts until the lane's next note, or this many beats. */
const MAX_HOLD = 2;
/** Continuous-pitch samples kept per toy. */
const SAMPLES = 2400;

interface Sample {
  beat: number;
  hz: number;
  env: number;
}

/**
 * The Pitch Trace (FOCUS-VIEW.md §6.1): pitch in Hz over beats, one line per
 * pitch lane (§15.2), coloured by toy, scrolling right to left with "now" at
 * the right edge. Notes come from the engine's note events; sustained voices
 * also draw their snapshot `freq` as a thin line.
 */
export class PitchTrace {
  readonly el: HTMLElement;
  readonly notes = new NotesBuffer();
  ring: Toy[] = [];
  lead: Toy | null = null;
  frozen = false;
  grid = true;
  leadOnly = false;
  private bars = 4;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private samples = new Map<number, Sample[]>();
  private frozenAt = 0;
  private table: HTMLTableSectionElement;

  constructor(private world: World) {
    this.el = document.createElement("section");
    this.el.className = "focus-window trace";
    this.el.hidden = true;
    this.el.setAttribute("aria-label", "Pitch Trace");
    this.el.innerHTML = `
      <div class="trace-bar">
        <b>Pitch Trace</b>
        <button data-t="grid" aria-pressed="true" title="Beat grid">┼ Grid</button>
        <button data-t="lead" aria-pressed="false" title="Grey out everything but the lead">◉ Lead only</button>
        <button data-t="bars" title="How many bars are shown">4 bars</button>
        <button data-t="freeze" aria-pressed="false" title="Freeze (Space)">❚❚</button>
      </div>
      <canvas class="trace-canvas" role="img" aria-label="Pitch over time for the toys on the ring"></canvas>
      <details class="trace-notes"><summary>Notes table</summary>
        <table><thead><tr><th>Beat</th><th>Toy</th><th>Lane</th><th>Hz</th><th>Velocity</th></tr></thead><tbody></tbody></table>
      </details>`;
    this.canvas = this.el.querySelector("canvas")!;
    this.ctx = this.canvas.getContext("2d")!;
    this.table = this.el.querySelector("tbody")!;
    this.el.querySelector(".trace-bar")!.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      const t = b.dataset.t;
      if (t === "grid") this.grid = !this.grid;
      if (t === "lead") this.leadOnly = !this.leadOnly;
      if (t === "bars") this.bars = WINDOWS[(WINDOWS.indexOf(this.bars) + 1) % WINDOWS.length];
      if (t === "freeze") this.freeze(!this.frozen);
      this.renderBar();
    });
    this.el.addEventListener("keydown", (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        this.freeze(!this.frozen);
        this.renderBar();
      }
    });
    this.el.querySelector("details")!.addEventListener("toggle", () => this.fillTable());
  }

  get open() {
    return !this.el.hidden;
  }

  toggle(open = this.el.hidden) {
    this.el.hidden = !open;
    if (open) this.renderBar();
  }

  freeze(on: boolean) {
    this.frozen = on;
    this.frozenAt = this.now();
    if (on) this.fillTable();
  }

  reset() {
    this.notes.clear();
    this.samples.clear();
    this.frozen = false;
  }

  /** The current beat, extrapolated from the last snapshot. */
  now(): number {
    const { audio } = this.world;
    const d = audio.snapshot;
    if (!d) return 0;
    return d[0] + (((performance.now() - audio.snapTime) / 1000) * d[1]) / 60;
  }

  /** Per frame: sample sustained pitch and redraw. */
  update() {
    const d = this.world.audio.snapshot;
    if (d && !this.frozen) {
      const beat = d[0];
      for (const toy of this.ring) {
        const o = SNAP_HEADER + toy.slot * SNAP_STRIDE;
        const hz = d[o + Snap.freq];
        const env = d[o + Snap.env];
        let list = this.samples.get(toy.slot);
        if (!list) this.samples.set(toy.slot, (list = []));
        if (list.length && list[list.length - 1].beat === beat) continue;
        list.push({ beat, hz, env });
        if (list.length > SAMPLES) list.splice(0, list.length - SAMPLES);
      }
    }
    if (this.open) this.draw();
  }

  private renderBar() {
    const set = (t: string, on: boolean) => this.el.querySelector(`[data-t="${t}"]`)!.setAttribute("aria-pressed", String(on));
    set("grid", this.grid);
    set("lead", this.leadOnly);
    set("freeze", this.frozen);
    this.el.querySelector(`[data-t="freeze"]`)!.textContent = this.frozen ? "▶" : "❚❚";
    this.el.querySelector(`[data-t="bars"]`)!.textContent = `${this.bars} bars`;
  }

  private draw() {
    const c = this.canvas;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(devicePixelRatio, 2);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const now = this.frozen ? this.frozenAt : this.now();
    const span = this.bars * 4;
    const from = now - span;
    const x = (beat: number) => w - ((now - beat) / span) * w;
    const slots = new Set(this.ring.map((t) => t.slot));
    const visible: TraceNote[] = [];
    for (const n of this.notes.since(from - MAX_HOLD)) if (slots.has(n.slot) && n.beat <= now) visible.push(n);

    // y: log2 Hz, ranged to what's visible with half an octave of headroom.
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of visible) {
      const p = Math.log2(n.hz);
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
    if (!Number.isFinite(lo)) {
      lo = Math.log2(110);
      hi = Math.log2(880);
    }
    lo -= 0.5;
    hi += 0.5;
    if (hi - lo < 2) {
      const mid = (hi + lo) / 2;
      lo = mid - 1;
      hi = mid + 1;
    }
    const pad = 8;
    const y = (hz: number) => h - pad - ((Math.log2(hz) - lo) / (hi - lo)) * (h - pad * 2);

    // Pitch lines: every semitone faint, the Tuning's root brighter, with Hz labels on the roots.
    const root = 440 * 2 ** ((this.world.tuning.root - 69) / 12);
    g.font = "10px system-ui, sans-serif";
    g.textBaseline = "middle";
    for (let k = Math.floor((lo - Math.log2(root)) * 12); k <= Math.ceil((hi - Math.log2(root)) * 12); k++) {
      const hz = root * 2 ** (k / 12);
      const yy = Math.round(y(hz)) + 0.5;
      const isRoot = k % 12 === 0;
      g.strokeStyle = isRoot ? "rgba(170,180,255,0.28)" : "rgba(170,180,255,0.07)";
      g.beginPath();
      g.moveTo(0, yy);
      g.lineTo(w, yy);
      g.stroke();
      if (isRoot) {
        g.fillStyle = "rgba(200,206,255,0.6)";
        g.fillText(`${Math.round(hz)} Hz`, 4, yy - 7);
      }
    }

    if (this.grid) {
      for (let b = Math.ceil(from); b <= now; b++) {
        const xx = Math.round(x(b)) + 0.5;
        const bar = b % 4 === 0;
        g.strokeStyle = bar ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)";
        g.beginPath();
        g.moveTo(xx, 0);
        g.lineTo(xx, h);
        g.stroke();
      }
      g.fillStyle = "rgba(200,206,255,0.6)";
      g.textAlign = "right";
      g.fillText(`${this.world.bpm} BPM`, w - 6, 10);
      g.textAlign = "left";
    }

    const alpha = (toy: Toy | undefined) => (!toy ? 0 : this.leadOnly && toy !== this.lead ? 0.18 : toy === this.lead ? 1 : 0.7);
    const toyAt = (slot: number) => this.ring.find((t) => t.slot === slot);

    // Sustained pitch from the snapshot: a thin line while the voice sounds.
    for (const toy of this.ring) {
      const list = this.samples.get(toy.slot);
      if (!list) continue;
      g.strokeStyle = toy.css;
      g.lineWidth = 1;
      let drawing = false;
      g.beginPath();
      for (const s of list) {
        if (s.beat < from || s.beat > now) continue;
        if (s.env < 0.03 || !(s.hz > 0)) {
          drawing = false;
          continue;
        }
        const px = x(s.beat);
        const py = y(s.hz);
        if (drawing) g.lineTo(px, py);
        else g.moveTo(px, py);
        drawing = true;
      }
      g.globalAlpha = alpha(toy) * 0.35;
      g.stroke();
    }

    // Notes: a dot at the onset and a held line to the lane's next note.
    const next = new Map<string, number>();
    for (let i = visible.length - 1; i >= 0; i--) {
      const n = visible[i];
      const key = `${n.slot}:${n.lane}`;
      const end = Math.min(next.get(key) ?? now, n.beat + MAX_HOLD, now);
      next.set(key, n.beat);
      const toy = toyAt(n.slot);
      const a = alpha(toy);
      if (!a) continue;
      const shade = lighten(toy!.color, Math.min(n.lane, 5) * 0.12);
      const yy = y(n.hz);
      g.globalAlpha = a * (0.35 + 0.65 * Math.min(1, n.vel));
      g.strokeStyle = shade;
      g.fillStyle = shade;
      g.lineWidth = toy === this.lead ? 2.5 : 1.6;
      g.setLineDash(n.lane >= 4 ? [4, 3] : []);
      g.beginPath();
      g.moveTo(x(n.beat), yy);
      g.lineTo(x(end), yy);
      g.stroke();
      g.setLineDash([]);
      g.beginPath();
      g.arc(x(n.beat), yy, toy === this.lead ? 3.5 : 2.5, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    g.lineWidth = 1;
  }

  /** The table view: the last 4 bars of notes, for screen readers (§6.1). */
  private fillTable() {
    const details = this.el.querySelector("details")!;
    if (!details.open) return;
    const now = this.frozen ? this.frozenAt : this.now();
    const rows: string[] = [];
    for (const n of this.notes.since(now - 16)) {
      const toy = this.ring.find((t) => t.slot === n.slot);
      if (!toy) continue;
      rows.push(`<tr><td>${n.beat.toFixed(2)}</td><td>${toy.entryId}</td><td>${n.lane + 1}</td><td>${n.hz.toFixed(1)}</td><td>${n.vel.toFixed(2)}</td></tr>`);
    }
    this.table.innerHTML = rows.slice(-200).join("") || `<tr><td colspan="5">No notes yet</td></tr>`;
  }
}

/** Mix a 0xRRGGBB colour toward white. */
function lighten(color: number, t: number): string {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  const m = (v: number) => Math.round(v + (255 - v) * t);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}
