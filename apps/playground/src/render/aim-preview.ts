import * as THREE from "three";
import type { AimHit } from "../aim";
import { load, save } from "../prefs";
import type { Stage } from "./stage";

const OK = 0x8fd3ff;
const FAR = 0xff6b6b;

/**
 * The ray and target preview (`B`, docs/AVATAR.md §6): the aim ray, the hit
 * point with a ring on the surface, the targeted part outlined through
 * occluders, and a tiny label naming what a click will do.
 */
export class AimPreview {
  enabled = load("cosmic.rayPreview", false);
  /** Gravity debug (`Shift+B`): the bound body's up at the avatar. */
  gravity = false;

  private group = new THREE.Group();
  private line: THREE.Line;
  private lineMat = new THREE.LineDashedMaterial({ color: OK, transparent: true, depthTest: false, dashSize: 1e3, gapSize: 0 });
  private dot: THREE.Mesh;
  private ring: THREE.Mesh;
  private tick: THREE.Line;
  private outline: THREE.Mesh;
  private outlineMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.28, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  private upArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1.2, 0x7cf7a0);
  private label = document.createElement("div");

  constructor(private stage: Stage) {
    const pts = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
    this.line = new THREE.Line(pts, this.lineMat);
    this.line.frustumCulled = false;
    const flat = (color: number, opacity = 0.9) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, side: THREE.DoubleSide });
    this.dot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), flat(0xffffff, 1));
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.09, 0.12, 32), flat(OK, 0.85));
    this.tick = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 0.25)]), new THREE.LineBasicMaterial({ color: OK, depthTest: false, transparent: true }));
    this.outline = new THREE.Mesh(new THREE.BufferGeometry(), this.outlineMat);
    this.outline.matrixAutoUpdate = false;
    for (const o of [this.line, this.dot, this.ring, this.tick, this.outline, this.upArrow]) {
      o.renderOrder = 10;
      this.group.add(o);
    }
    this.group.visible = false;
    this.upArrow.visible = false;
    stage.scene.add(this.group);
    this.label.className = "aim-label";
    document.body.append(this.label);
  }

  toggle(on = !this.enabled) {
    this.enabled = on;
    save("cosmic.rayPreview", on);
  }

  /**
   * Draw `hit`. `from` is the ray's visible start (the avatar's hand light);
   * null in Orbit, where the ray starts at the cursor and is drawn faint.
   */
  update(hit: AimHit, from: THREE.Vector3 | null, action: string, up?: { at: THREE.Vector3; dir: THREE.Vector3 }) {
    this.upArrow.visible = this.gravity && !!up;
    if (up && this.gravity) {
      this.upArrow.position.copy(up.at);
      this.upArrow.setDirection(up.dir);
    }
    const show = this.enabled && hit.kind !== "none";
    this.group.visible = show || this.upArrow.visible;
    for (const o of [this.line, this.dot, this.ring, this.tick, this.outline]) o.visible = show;
    this.label.classList.toggle("on", show && !!action);
    if (!show) return;

    const p = hit.point!;
    const n = hit.normal!;
    const color = hit.inReach ? OK : FAR;
    const start = from ?? hit.ray.origin.clone().addScaledVector(hit.ray.direction, this.stage.camera.near + 0.05);
    const pos = this.line.geometry.getAttribute("position") as THREE.BufferAttribute;
    pos.setXYZ(0, start.x, start.y, start.z);
    pos.setXYZ(1, p.x, p.y, p.z);
    pos.needsUpdate = true;
    this.line.computeLineDistances();
    this.lineMat.color.setHex(color);
    this.lineMat.opacity = from ? 0.8 : 0.25;
    // Out of reach: red *and* dashed, so the state doesn't rely on colour alone.
    this.lineMat.dashSize = hit.inReach ? 1e3 : 0.12;
    this.lineMat.gapSize = hit.inReach ? 0 : 0.08;

    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this.dot.position.copy(p);
    this.ring.position.copy(p).addScaledVector(n, 0.004);
    this.ring.quaternion.copy(q);
    (this.ring.material as THREE.MeshBasicMaterial).color.setHex(color);
    this.tick.position.copy(p);
    this.tick.quaternion.copy(q);
    (this.tick.material as THREE.LineBasicMaterial).color.setHex(color);

    const target = hit.kind === "part" && hit.object instanceof THREE.Mesh ? hit.object : null;
    this.outline.visible = !!target;
    if (target && hit.toy) {
      this.outline.geometry = target.geometry;
      this.outline.matrix.copy(target.matrixWorld).multiply(new THREE.Matrix4().makeScale(1.08, 1.08, 1.08));
      this.outlineMat.color.setHex(hit.toy.color);
    }

    const s = p.clone().project(this.stage.camera);
    const r = this.stage.canvas.getBoundingClientRect();
    this.label.textContent = action;
    this.label.style.transform = `translate(${r.left + ((s.x + 1) / 2) * r.width + 14}px, ${r.top + ((1 - s.y) / 2) * r.height - 26}px)`;
  }
}
