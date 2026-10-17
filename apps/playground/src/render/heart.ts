import * as THREE from "three";
import type { GoalKind } from "../modes/scenario";

/** What one shell is told each frame. */
export interface ShellState {
  closeness: number;
  locked: boolean;
  /** Not yet evaluated (waiting on another goal): drawn as a faint silhouette. */
  dormant: boolean;
  /** Cents out of tune: the surface beats at this rate (MODES.md §5.2). */
  cents: number;
  /** World positions of the toys feeding the shell (threads), and how bright they are now. */
  feeds: { pos: THREE.Vector3; flash: number }[];
  /** A hint: this shell's thread pulses toward its toy. */
  hint: boolean;
}

export interface ShellSpec {
  kind: GoalKind;
  color: number;
  optional: boolean;
  /** Ticks, petals or facets to draw. */
  count: number;
  /** Ticks spin once per this many beats (rhythm and ratio shells). */
  period?: number;
}

interface Shell {
  spec: ShellSpec;
  group: THREE.Group;
  /** Meshes whose opacity follows the fill. */
  parts: THREE.Mesh[];
  /** Inner fill (pitch shells). */
  fill?: THREE.Mesh;
  /** Two arcs (interval shells). */
  arcs?: [THREE.Mesh, THREE.Mesh];
  threads: THREE.Line[];
  shown: number;
  radius: number;
}

const DIM = 0.12;

/**
 * The Heart (MODES.md §5): a seed in the middle of the world with one shell per
 * goal. Shape = kind of goal, colour = the toy feeding it, fill = closeness,
 * wobble = how far out of tune. It blooms when every shell holds.
 */
export class Heart {
  readonly group = new THREE.Group();
  private core: THREE.Mesh;
  private light: THREE.PointLight;
  private shells: Shell[] = [];
  private bloom = 0;
  private blooming = false;

  constructor(
    private scene: THREE.Scene,
    pos: THREE.Vector3,
    radius: number,
    specs: ShellSpec[],
    private reducedMotion: () => boolean,
  ) {
    this.group.position.copy(pos);
    this.group.position.y += radius + 0.25;
    this.core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.16, 2),
      new THREE.MeshStandardMaterial({ color: 0x1a1030, emissive: 0xffd9a0, emissiveIntensity: 0.25, roughness: 0.4 }),
    );
    this.group.add(this.core);
    this.light = new THREE.PointLight(0xffd9a0, 0, 6);
    this.group.add(this.light);

    const main = specs.filter((s) => !s.optional).length;
    let i = 0;
    let extra = 0;
    for (const spec of specs) {
      // Required shells nest outward; optional ones sit just outside them.
      const r = spec.optional ? radius * (1.08 + 0.1 * extra++) : 0.3 + ((radius - 0.3) * (i++ + 1)) / Math.max(1, main);
      this.shells.push(this.build(spec, r));
    }
    scene.add(this.group);
  }

  private mat(color: number, opacity = DIM) {
    return new THREE.MeshStandardMaterial({
      color: 0x0d0a1c,
      emissive: color,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  private build(spec: ShellSpec, r: number): Shell {
    const group = new THREE.Group();
    const parts: THREE.Mesh[] = [];
    const shell: Shell = { spec, group, parts, threads: [], shown: 0, radius: r };
    const c = spec.color;
    switch (spec.kind) {
      case "pitch": {
        const outline = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), new THREE.MeshBasicMaterial({ color: c, wireframe: true, transparent: true, opacity: 0.18 }));
        group.add(outline);
        shell.fill = new THREE.Mesh(new THREE.SphereGeometry(r * 0.96, 32, 20), this.mat(c, 0.5));
        group.add(shell.fill);
        break;
      }
      case "interval": {
        const a = new THREE.Mesh(new THREE.TorusGeometry(r, 0.03, 8, 48, Math.PI), this.mat(c));
        const b = new THREE.Mesh(new THREE.TorusGeometry(r, 0.03, 8, 48, Math.PI), this.mat(c));
        group.add(a, b);
        parts.push(a, b);
        shell.arcs = [a, b];
        break;
      }
      case "chord":
      case "chordTones": {
        // One facet per chord tone (or per chord), set around the shell like a cut gem.
        const n = Math.max(3, spec.count);
        for (let k = 0; k < n; k++) {
          const f = new THREE.Mesh(new THREE.CircleGeometry(r * 0.42, 3), this.mat(c));
          const a = (k / n) * Math.PI * 2;
          f.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
          f.lookAt(0, 0, 0);
          group.add(f);
          parts.push(f);
        }
        break;
      }
      case "ratio":
      case "rhythm": {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.012, 6, 64), this.mat(c));
        ring.rotation.x = Math.PI / 2;
        group.add(ring);
        parts.push(ring);
        const n = Math.max(1, spec.count);
        const spinner = new THREE.Group();
        spinner.name = "spinner";
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2;
          const tick =
            spec.kind === "rhythm"
              ? new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 6).scale(1, 0.4, 2.2), this.mat(c))
              : new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.14, 0.03), this.mat(c));
          tick.position.set(Math.sin(a) * r, 0, -Math.cos(a) * r);
          tick.rotation.y = -a;
          spinner.add(tick);
          parts.push(tick);
        }
        group.add(spinner);
        break;
      }
      case "smooth": {
        const seam = new THREE.Mesh(new THREE.TorusGeometry(r, 0.02, 8, 64), this.mat(c));
        seam.rotation.x = Math.PI / 2;
        group.add(seam);
        parts.push(seam);
        break;
      }
    }
    // Tilt each shell a little so nested ones read as separate layers.
    group.rotation.z = (this.shells.length % 2 ? 1 : -1) * 0.25 * this.shells.length;
    this.group.add(group);
    return shell;
  }

  /** Every required shell held: open up, become a star you can stand on. */
  startBloom() {
    this.blooming = true;
  }

  update(dt: number, t: number, beat: number, states: ShellState[]) {
    const calm = this.reducedMotion();
    if (this.blooming) this.bloom = Math.min(1, this.bloom + dt / 4);
    const coreMat = this.core.material as THREE.MeshStandardMaterial;
    const progress = states.length ? states.filter((s, i) => s.locked && !this.shells[i].spec.optional).length / Math.max(1, this.shells.filter((s) => !s.spec.optional).length) : 0;
    coreMat.emissiveIntensity = 0.25 + progress * 0.9 + this.bloom * 2.5;
    this.core.scale.setScalar(1 + progress * 0.6 + this.bloom * 1.8);
    this.light.intensity = progress * 0.6 + this.bloom * 3;
    if (!calm) this.core.rotation.y = t * (0.2 + this.bloom);

    this.shells.forEach((sh, i) => {
      const s = states[i];
      if (!s) return;
      // Ease the shown fill toward closeness; snap up on lock ("click").
      const target = s.locked ? 1 : s.dormant ? 0 : s.closeness;
      sh.shown += (target - sh.shown) * Math.min(1, dt * (s.locked ? 10 : 2.5));
      const f = sh.shown;
      const throb = s.locked && !calm ? Math.max(0, ...s.feeds.map((x) => x.flash)) : 0;
      const opacity = sh.spec.optional && !s.locked && f < 0.05 ? 0.05 : DIM + f * (s.locked ? 0.8 : 0.55);
      for (const p of sh.parts) {
        const m = p.material as THREE.MeshStandardMaterial;
        m.opacity = opacity;
        m.emissiveIntensity = 0.5 + f * 0.8 + throb * 1.5 + this.bloom * 0.6;
      }
      if (sh.fill) {
        const m = sh.fill.material as THREE.MeshStandardMaterial;
        sh.fill.scale.setScalar(Math.max(0.02, f));
        m.opacity = 0.25 + f * 0.6;
        m.emissiveIntensity = 0.6 + throb * 1.5 + this.bloom;
      }
      if (sh.arcs) {
        // The two arcs swing apart when out of tune and meet into a ring when in.
        const gap = (1 - f) * Math.PI * 0.5;
        sh.arcs[0].rotation.z = gap;
        sh.arcs[1].rotation.z = Math.PI - gap;
      }
      // Facets light one by one as tones arrive.
      if (sh.spec.kind === "chord" || sh.spec.kind === "chordTones") {
        const lit = Math.round(f * sh.parts.length);
        sh.parts.forEach((p, k) => ((p.material as THREE.MeshStandardMaterial).opacity = k < lit ? opacity : DIM * 0.7));
      }
      const spinner = sh.group.getObjectByName("spinner");
      if (spinner && sh.spec.period && !calm) spinner.rotation.y = -((beat / sh.spec.period) % 1) * Math.PI * 2 * (s.locked ? 1 : f);
      // Wobble: the surface beats at the detune rate and calms when in tune.
      const wob = s.locked || s.dormant || calm ? 0 : (1 - f) * 0.07 * Math.min(1, f * 4);
      const hz = Math.min(6, Math.max(0.5, Math.abs(s.cents) / 10));
      sh.group.scale.setScalar(1 + wob * Math.sin(t * Math.PI * 2 * hz) + this.bloom * 0.15);
      if (!calm && this.bloom) sh.group.rotation.y += dt * 0.3 * this.bloom * (i % 2 ? 1 : -1);
      this.threads(sh, s, t);
    });
  }

  private threads(sh: Shell, s: ShellState, t: number) {
    while (sh.threads.length < s.feeds.length) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: sh.spec.color, transparent: true, opacity: 0.2 }),
      );
      this.scene.add(line);
      sh.threads.push(line);
    }
    sh.threads.forEach((line, k) => {
      const feed = s.feeds[k];
      line.visible = !!feed && !s.dormant && !(sh.spec.optional && sh.shown < 0.05);
      if (!feed) return;
      const from = this.group.position;
      const to = feed.pos.clone().setY(feed.pos.y + 0.4);
      const dir = to.clone().sub(from).normalize();
      const start = from.clone().addScaledVector(dir, sh.radius);
      const pos = line.geometry.getAttribute("position") as THREE.BufferAttribute;
      pos.setXYZ(0, start.x, start.y, start.z);
      pos.setXYZ(1, to.x, to.y, to.z);
      pos.needsUpdate = true;
      line.geometry.computeBoundingSphere();
      const pulse = s.hint ? 0.5 + 0.5 * Math.sin(t * 6) : 0;
      (line.material as THREE.LineBasicMaterial).opacity = 0.12 + feed.flash * 0.5 + sh.shown * 0.2 + pulse * 0.6;
    });
  }

  dispose() {
    this.group.removeFromParent();
    const all: THREE.Object3D[] = [this.group, ...this.shells.flatMap((s) => s.threads)];
    for (const root of all) {
      root.removeFromParent();
      root.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
  }
}
