import * as THREE from "three";
import type { Stage } from "../render/stage";
import type { World } from "../world";
import { AvatarFigure, EYE } from "./figure";
import type { GravityBody } from "./gravity";
import { AvatarSettings } from "./settings";

export type AvatarMode = "walk" | "fly";

const GRAVITY = 14;
const DOUBLE_TAP = 0.3;
/** Falling this far below the last body returns you to it (AVATAR.md §3). */
const FALL_LIMIT = 20;
/** Toy bases are low enough to step onto. */
const BASE_TOP = 0.12;

const Y = new THREE.Vector3(0, 1, 0);

/**
 * The avatar: a kinematic controller against the analytic gravity bodies plus
 * the camera rig for Walk and Fly (docs/AVATAR.md §3–4). Input feeds it keys
 * and look deltas; tests can call `look()` directly instead of pointer lock.
 */
export class Avatar {
  readonly settings = new AvatarSettings();
  readonly figure: AvatarFigure;
  active = false;
  mode: AvatarMode = "walk";
  /** Feet position. */
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  pitch = -0.15;
  grounded = false;
  /** The body you're bound to; Fly keeps the last one. */
  body: GravityBody;
  /** Pointer lock was refused: drag to look with a free cursor instead. */
  fallback = false;
  onChange: (() => void) | null = null;
  onEnter: (() => void) | null = null;

  private held = new Set<string>();
  private lastTap: Record<string, number> = {};
  private boost = false;
  private flyUp = Y.clone();
  private lastSafe = new THREE.Vector3();
  private transition = 0;
  private fromPos = new THREE.Vector3();
  private fromQuat = new THREE.Quaternion();
  private panClock = 0;
  private pill = document.createElement("div");
  private crosshair = document.createElement("div");
  private fade = document.createElement("div");

  constructor(
    private stage: Stage,
    private world: World,
    color: string,
  ) {
    this.body = world.bodies[0];
    this.figure = new AvatarFigure(color);
    this.figure.group.visible = false;
    stage.scene.add(this.figure.group);

    this.pill.className = "lock-pill";
    this.pill.textContent = "Click to look around";
    this.crosshair.className = "crosshair";
    this.fade.className = "avatar-fade";
    document.body.append(this.pill, this.crosshair, this.fade);

    document.addEventListener("pointerlockchange", () => this.renderChrome());
    document.addEventListener("pointerlockerror", () => {
      this.fallback = true;
      this.renderChrome();
    });
    addEventListener("keyup", (e) => {
      this.held.delete(e.code);
      if (e.code === "KeyW") this.boost = false;
    });
    addEventListener("blur", () => this.held.clear());
  }

  get size() {
    return this.settings.size;
  }

  get locked() {
    return document.pointerLockElement === this.stage.canvas;
  }

  /** Aim reach in metres (8 m walking, 16 m flying, scaled with size). */
  get reach() {
    return (this.mode === "fly" ? 16 : 8) * Math.sqrt(this.size);
  }

  /** Up for movement: the bound body's up here, or the frame frozen at take-off. */
  up(out = new THREE.Vector3()) {
    if (this.mode === "fly" && this.settings.frozenFlyFrame) return out.copy(this.flyUp);
    return this.body.up(this.pos, out);
  }

  eye(out = new THREE.Vector3()) {
    return out.copy(this.pos).addScaledVector(this.up(), EYE * this.size);
  }

  /** Where the avatar is looking. */
  direction(out = new THREE.Vector3()) {
    out.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    return out.applyQuaternion(this.frame());
  }

  /** The aim ray's visible start: the hand light (offset so it shows in first person). */
  hand(out = new THREE.Vector3()) {
    if (this.settings.thirdPerson) return this.figure.handPosition(out);
    const up = this.up();
    const dir = this.direction();
    const right = new THREE.Vector3().crossVectors(dir, up).normalize();
    return this.eye(out).addScaledVector(right, 0.22 * this.size).addScaledVector(up, -0.22 * this.size).addScaledVector(dir, 0.35 * this.size);
  }

  enter() {
    if (this.active) return;
    const target = this.stage.orbitTarget;
    target.y = 0;
    if (!this.body.covers(target)) target.set(0, 0, 0);
    this.pos.copy(target);
    this.lastSafe.copy(target);
    this.vel.set(0, 0, 0);
    this.yaw = this.stage.orbitHeading;
    this.pitch = -0.15;
    this.mode = "walk";
    this.active = true;
    this.stage.rig = "avatar";
    this.fromPos.copy(this.stage.camera.position);
    this.fromQuat.copy(this.stage.camera.quaternion);
    this.transition = this.stage.reducedMotion ? 1 : 0;
    this.renderChrome();
    this.onEnter?.();
    this.onChange?.();
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    if (this.locked) document.exitPointerLock();
    this.stage.rig = "orbit";
    this.stage.camera.up.copy(Y);
    this.stage.setOrbit(this.pos.clone().setY(0.5), this.yaw);
    this.figure.group.visible = false;
    this.renderChrome();
    this.onChange?.();
  }

  setMode(mode: AvatarMode) {
    if (mode === this.mode) return;
    if (mode === "fly") this.body.up(this.pos, this.flyUp);
    this.mode = mode;
    this.vel.set(0, 0, 0);
    this.onChange?.();
  }

  setThirdPerson(on: boolean) {
    this.settings.set({ thirdPerson: on });
    this.onChange?.();
  }

  lock() {
    if (this.fallback || this.locked) return;
    try {
      const p = this.stage.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {
        this.fallback = true;
        this.renderChrome();
      });
    } catch {
      this.fallback = true;
    }
    this.renderChrome();
  }

  unlock() {
    if (this.locked) document.exitPointerLock();
  }

  look(dx: number, dy: number) {
    this.yaw -= dx * 0.0025;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0025, -1.45, 1.45);
  }

  /** Movement keys (by `KeyboardEvent.code`). Returns true when the key was used. */
  keyDown(e: KeyboardEvent): boolean {
    const code = e.code;
    const moveKeys = ["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"];
    if (!moveKeys.includes(code)) return false;
    if (e.repeat) return true;
    this.held.add(code);
    const now = performance.now() / 1000;
    const double = now - (this.lastTap[code] ?? -1) < DOUBLE_TAP;
    this.lastTap[code] = double ? -1 : now;
    if (code === "KeyW" && double) this.boost = true;
    if (code === "Space") {
      if (double) this.setMode(this.mode === "walk" ? "fly" : "walk");
      else if (this.mode === "walk" && this.grounded) this.jump();
    }
    return true;
  }

  private jump() {
    const up = this.up();
    this.vel.addScaledVector(up, Math.sqrt(2 * GRAVITY * 1.1 * this.size));
    this.grounded = false;
  }

  private frame() {
    return new THREE.Quaternion().setFromUnitVectors(Y, this.up());
  }

  /** Height of walkable ground under `p` along up: the body surface, or a toy base to step onto. */
  private groundAt(p: THREE.Vector3): number | null {
    if (!this.body.covers(p)) return null;
    let h = 0;
    for (const toy of this.world.toys) {
      if (!toy) continue;
      const q = toy.group.position;
      if (Math.hypot(p.x - q.x, p.z - q.z) < 0.62) h = Math.max(h, q.y + BASE_TOP);
    }
    return h;
  }

  update(dt: number) {
    if (!this.active) return;
    const s = this.size;
    const up = this.up();
    const q = this.frame();
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).applyQuaternion(q);
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const k = (c: string) => (this.held.has(c) ? 1 : 0);
    const wish = new THREE.Vector3()
      .addScaledVector(fwd, k("KeyW") - k("KeyS"))
      .addScaledVector(right, k("KeyD") - k("KeyA"));
    if (wish.lengthSq() > 1) wish.normalize();
    const shift = k("ShiftLeft") || k("ShiftRight");
    const boost = this.boost && this.held.has("KeyW") ? 1.8 : 1;

    if (this.mode === "fly") {
      const speed = 7 * s * boost;
      const target = wish.multiplyScalar(speed).addScaledVector(up, (k("Space") - shift) * speed * 0.7);
      this.vel.lerp(target, 1 - Math.exp(-dt * 10));
      this.pos.addScaledVector(this.vel, dt);
      const g = this.groundAt(this.pos);
      if (g !== null && this.pos.y <= g) {
        // Flying into the ground lands you, as in Minecraft creative.
        this.pos.y = g;
        this.setMode("walk");
        this.grounded = true;
      }
    } else {
      const speed = 3.2 * s * boost * (shift ? 0.4 : 1);
      const vUp = this.vel.dot(up);
      const flat = wish.multiplyScalar(speed);
      const along = this.vel.clone().addScaledVector(up, -vUp);
      along.lerp(flat, 1 - Math.exp(-dt * (this.grounded ? 14 : 3)));
      const next = this.pos.clone().addScaledVector(along, dt);
      // Sneak never walks off an edge.
      if (shift && this.grounded && this.groundAt(next) === null) along.set(0, 0, 0);
      this.vel.copy(along).addScaledVector(up, vUp - GRAVITY * dt);
      const prevY = this.pos.y;
      this.pos.addScaledVector(this.vel, dt);
      const g = this.groundAt(this.pos);
      this.grounded = false;
      if (g !== null && this.vel.dot(up) <= 0 && this.pos.y <= g && prevY >= g - 0.35 * s) {
        this.pos.y = g;
        this.vel.addScaledVector(up, -this.vel.dot(up));
        this.grounded = true;
        this.lastSafe.copy(this.pos);
      }
      if (this.pos.y < -FALL_LIMIT) this.respawn();
    }
    if (this.settings.solidToys) this.collideToys();
    this.place(dt);
    this.panClock += dt;
    if (this.panClock > 0.05) {
      // The listener is the avatar's head (AVATAR.md §9): pans follow as you turn.
      this.panClock = 0;
      for (const toy of this.world.toys) toy?.sendPan();
    }
  }

  private respawn() {
    this.fade.classList.add("on");
    setTimeout(() => this.fade.classList.remove("on"), 350);
    this.pos.copy(this.lastSafe);
    this.vel.set(0, 0, 0);
  }

  /** Solid toys: push the avatar out of each toy's bounding cylinder (off by default). */
  private collideToys() {
    const box = new THREE.Box3();
    const r0 = 0.22 * this.size;
    for (const toy of this.world.toys) {
      if (!toy) continue;
      box.setFromObject(toy.group);
      if (this.pos.y > box.max.y) continue;
      const c = toy.group.position;
      const r = Math.max(box.max.x - c.x, c.x - box.min.x, box.max.z - c.z, c.z - box.min.z) + r0;
      const dx = this.pos.x - c.x;
      const dz = this.pos.z - c.z;
      const d = Math.hypot(dx, dz);
      if (d < r && d > 1e-4) {
        this.pos.x = c.x + (dx / d) * r;
        this.pos.z = c.z + (dz / d) * r;
      }
    }
  }

  /** Put the figure and the camera where the avatar is. */
  private place(dt: number) {
    const s = this.size;
    const up = this.up();
    const g = this.figure.group;
    g.position.copy(this.pos);
    g.quaternion.copy(this.frame()).multiply(new THREE.Quaternion().setFromAxisAngle(Y, this.yaw));
    g.scale.setScalar(s);
    g.visible = this.settings.thirdPerson;

    const cam = this.stage.camera;
    const eye = this.eye();
    const dir = this.direction();
    const pos = eye.clone();
    if (this.settings.thirdPerson) {
      // Over the right shoulder, so the avatar never covers the crosshair.
      const k = Math.max(0.35, s);
      const right = new THREE.Vector3().crossVectors(dir, up).normalize();
      pos.addScaledVector(dir, -3.5 * k).addScaledVector(up, 0.4 * k).addScaledVector(right, 0.75 * k);
      // Keep the chase camera above the ground it would otherwise dip under.
      if (this.body.covers(pos) && this.body.sdf(pos) < 0.15) pos.addScaledVector(up, 0.15 - this.body.sdf(pos));
    }
    cam.up.copy(up);
    cam.position.copy(pos);
    cam.lookAt(pos.clone().add(dir));
    if (this.transition < 1) {
      this.transition = Math.min(1, this.transition + dt / 0.6);
      const t = THREE.MathUtils.smoothstep(this.transition, 0, 1);
      cam.position.lerpVectors(this.fromPos, pos, t);
      cam.quaternion.slerpQuaternions(this.fromQuat, cam.quaternion.clone(), t);
    }
  }

  /** The "Click to look around" pill and the crosshair. */
  renderChrome() {
    const on = this.active;
    this.pill.classList.toggle("on", on && !this.locked && !this.fallback);
    this.crosshair.classList.toggle("on", on && this.locked);
    document.body.classList.toggle("avatar-mode", on);
    document.body.classList.toggle("avatar-free", on && this.fallback && !this.locked);
  }
}
