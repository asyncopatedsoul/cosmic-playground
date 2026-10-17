import * as THREE from "three";
import { glow, invisible, type DragHandler, type Toy } from "../toys/toy";
import type { HoleSpec } from "./scenario";

/** How far a bead travels per scale step. */
const STEP_Y = 0.11;
/** Pixels of drag per scale step. */
const DRAG_PX = 22;

/**
 * Pattern holes (MODES.md §4.3): a toy's pattern becomes a template like
 * `<{a} {b}>`, and each hole is a bead on the toy. Drag a bead up or down to
 * move it a scale degree; its height is the pitch, its place left-to-right is
 * when. No text: the beads fill the template and set the pattern.
 */
export class Holes {
  readonly values: Record<string, number> = {};
  private beads = new Map<string, THREE.Mesh>();
  private root = new THREE.Group();

  constructor(
    readonly toy: Toy,
    private template: string,
    private specs: Record<string, HoleSpec>,
    /** Called after a bead moves, with the new pattern text (the mode applies it). */
    private onChange: (text: string) => void,
  ) {
    const keys = Object.keys(specs);
    const lo = Math.min(...keys.flatMap((k) => specs[k].values));
    keys.forEach((k, i) => {
      this.values[k] = specs[k].start;
      const x = (i - (keys.length - 1) / 2) * 0.32;
      // The bead's track: every allowed value is a faint notch.
      for (const v of specs[k].values) {
        const notch = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.008, 0.008), new THREE.MeshBasicMaterial({ color: toy.color, transparent: true, opacity: 0.3 }));
        notch.position.set(x, 0.3 + (v - lo) * STEP_Y, 0);
        this.root.add(notch);
      }
      const bead = new THREE.Mesh(new THREE.SphereGeometry(0.065, 16, 10), glow(toy.color, 1));
      const target = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), invisible());
      bead.add(target);
      target.userData = { toy, part: `hole:${k}` };
      toy.pickables.push(target);
      bead.position.x = x;
      this.root.add(bead);
      this.beads.set(k, bead);
    });
    // In front of the toy, beside its Pulse heart.
    this.root.position.set(0, 0, 0.95);
    toy.group.add(this.root);
    this.lo = lo;
    this.layout();

    // Beads are extra parts on an existing toy: route their drags here, the rest to the toy.
    const down = toy.down.bind(toy);
    const hint = toy.hint.bind(toy);
    toy.down = (part, p) => (part.startsWith("hole:") ? this.drag(part.slice(5)) : down(part, p));
    toy.hint = (part) => (part.startsWith("hole:") ? "drag note" : hint(part));
  }

  private lo: number;

  private layout() {
    for (const [k, bead] of this.beads) bead.position.y = 0.3 + (this.values[k] - this.lo) * STEP_Y;
  }

  /** The template with every hole filled. */
  text(values = this.values): string {
    return this.template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? 0));
  }

  /** Set holes directly (solutions, loading); returns the pattern text. */
  set(values: Record<string, number>) {
    for (const [k, v] of Object.entries(values)) if (this.specs[k]?.values.includes(v)) this.values[k] = v;
    this.layout();
    return this.text();
  }

  private drag(k: string): DragHandler {
    let acc = 0;
    return {
      move: (q) => {
        acc -= q.dy;
        const steps = Math.trunc(acc / DRAG_PX);
        if (!steps) return;
        acc -= steps * DRAG_PX;
        const allowed = this.specs[k].values;
        const i = allowed.indexOf(this.values[k]);
        const next = allowed[THREE.MathUtils.clamp(i + steps, 0, allowed.length - 1)];
        if (next === this.values[k]) return;
        this.values[k] = next;
        this.layout();
        this.onChange(this.text());
      },
    };
  }

  update(flash: number) {
    for (const bead of this.beads.values()) (bead.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.9 + flash * 1.5;
  }

  dispose() {
    this.toy.pickables.splice(0, this.toy.pickables.length, ...this.toy.pickables.filter((o) => !String(o.userData.part).startsWith("hole:")));
    this.root.removeFromParent();
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
