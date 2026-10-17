import * as THREE from "three";
import type { Aim } from "../aim";
import type { Gamepads } from "../controllers/gamepad";
import { nextFrame, type FakeGamepadSource } from "../controllers/fake-gamepad";
import type { Input } from "../input";
import type { Stage } from "../render/stage";
import type { SeatState, Seats } from "../seats/seats";
import type { Toy } from "../toys/toy";
import type { World } from "../world";

/**
 * The L1 exit check (docs/PLAYTESTS.md §3): two fake gamepads drive two seats
 * on this client next to the mouse.
 *
 *   - each seat has its own put-away undo
 *   - seat 2 can't grab, drag or put away a toy seat 3 holds
 *   - the mouse (seat 1) still grabs, puts away and undoes as before, and
 *     can't grab a toy a gamepad seat holds
 *
 * Run it with `cosmic.test.seats()` in dev, or open the page with
 * `?scenario=seats`. It clears the world first.
 */
export interface ScenarioDeps {
  aim: Aim;
  world: World;
  stage: Stage;
  seats: Seats;
  gamepads: Gamepads;
  pads: FakeGamepadSource;
  input: Input;
}

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export async function runSeatsScenario(d: ScenarioDeps): Promise<{ pass: boolean; checks: Check[] }> {
  const { aim, world, stage, seats, pads } = d;
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, detail });
  const canvas = stage.canvas;

  for (const t of world.toys) if (t) world.remove(t);
  stage.setOrbit(new THREE.Vector3(0, 0.5, 0), 0);
  const spire = world.add("spire", new THREE.Vector3(-2, 0, 0.5))!;
  const kettle = world.add("kettle", new THREE.Vector3(2, 0, 0.5))!;
  await frames(2);

  // ---- join -----------------------------------------------------------------
  const p2 = pads.connect();
  await pads.tap(p2, "A");
  const p3 = pads.connect();
  await pads.tap(p3, "B");
  const s2 = seats.byDevice(pads.key(p2));
  const s3 = seats.byDevice(pads.key(p3));
  check("two pads join as seats 2 and 3", s2?.number === 2 && s3?.number === 3, `got ${s2?.number}, ${s3?.number}`);
  if (!s2 || !s3) return report(checks, pads, [p2, p3]);
  const colors = new Set([seats.mouse.color, s2.color, s3.color].map((c) => c.toLowerCase()));
  check("each seat has its own colour", colors.size === 3, [...colors].join(" "));
  check("the joining press doesn't act", s2.actions === 0 && s3.actions === 0);

  // ---- soft lock --------------------------------------------------------------
  await steer(pads, p3, s3, baseOf(aim, stage, spire));
  pads.press(p3, "A");
  await until(() => s3.holding === spire, 1);
  check("seat 3 grabs the Spire by holding A", s3.holding === spire);
  const before = spire.group.position.clone();
  pads.stick(p3, "left", 0.7, 0);
  await seconds(0.3);
  pads.stick(p3, "left", 0, 0);
  check("the left stick slides the held toy", spire.group.position.distanceTo(before) > 0.2, `moved ${spire.group.position.distanceTo(before).toFixed(2)}`);

  await steer(pads, p2, s2, baseOf(aim, stage, spire));
  pads.press(p2, "A");
  await seconds(0.45);
  check("seat 2 can't grab the toy seat 3 holds", s2.holding === null && s3.holding === spire);
  pads.release(p2, "A");
  pads.press(p2, "B");
  await seconds(1.2);
  pads.release(p2, "B");
  await frames(1);
  check("seat 2 can't put away the toy seat 3 holds", world.toys.includes(spire) && s2.putAway.length === 0);
  pads.release(p3, "A");
  await frames(2);
  check("releasing A lets go", s3.holding === null);

  // ---- mouse unchanged, and it respects the lock -----------------------------
  const kBase = baseOf(aim, stage, kettle);
  await steer(pads, p2, s2, kBase);
  pads.press(p2, "A");
  await until(() => s2.holding === kettle, 1);
  const kBefore = kettle.group.position.clone();
  mouseDrag(canvas, kBase, { x: kBase.x + 80, y: kBase.y });
  await frames(2);
  check("the mouse can't grab a toy seat 2 holds", kettle.group.position.distanceTo(kBefore) < 1e-6 && s2.holding === kettle);
  pads.release(p2, "A");
  await frames(2);

  const sBase = baseOf(aim, stage, spire);
  const sBefore = spire.group.position.clone();
  mouseDrag(canvas, sBase, { x: sBase.x + 80, y: sBase.y });
  await frames(2);
  check("the mouse still drags a toy by its base", spire.group.position.distanceTo(sBefore) > 0.2 && seats.mouse.holding === null);

  // ---- per-seat put-away undo --------------------------------------------------
  await steer(pads, p2, s2, baseOf(aim, stage, spire));
  await holdButton(pads, p2, "B", 1.2);
  await steer(pads, p3, s3, baseOf(aim, stage, kettle));
  await holdButton(pads, p3, "B", 1.2);
  check("hold B puts a toy away onto that seat's stack", !world.toys.includes(spire) && !world.toys.includes(kettle) && s2.putAway.length === 1 && s3.putAway.length === 1);
  await pads.tap(p2, "View");
  await frames(1);
  const spire2 = world.byId(spire.id);
  check("seat 2's View brings back only seat 2's toy", !!spire2 && !world.byId(kettle.id) && s3.putAway.length === 1);
  await pads.tap(p3, "View");
  await frames(1);
  const kettle2 = world.byId(kettle.id);
  check("seat 3's View brings back seat 3's toy", !!kettle2 && s2.putAway.length === 0 && s3.putAway.length === 0);

  const mouseStack = seats.mouse.putAway.length;
  if (spire2) {
    const at = baseOf(aim, stage, spire2);
    canvas.dispatchEvent(pointer("pointermove", at));
    await frames(2);
    dispatchEvent(new KeyboardEvent("keydown", { code: "Delete", key: "Delete" }));
    await frames(1);
    check("the mouse's Delete uses seat 1's stack", !world.byId(spire.id) && seats.mouse.putAway.length === mouseStack + 1 && s2.putAway.length === 0);
    dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", key: "z", ctrlKey: true }));
    await frames(1);
    check("Ctrl+Z brings it back", !!world.byId(spire.id) && seats.mouse.putAway.length === mouseStack);
    canvas.dispatchEvent(new PointerEvent("pointerleave"));
  }

  // ---- leaving ----------------------------------------------------------------
  await holdButton(pads, p3, "Menu", 2.2);
  check("holding Menu leaves", !seats.list.includes(s3));
  pads.disconnect(p2);
  await frames(2);
  check("a disconnected seat waits", seats.list.includes(s2));
  d.gamepads.update(31);
  check("…and leaves after 30 s", !seats.list.includes(s2));
  check("toys stay when their players leave", world.count === 2);

  return report(checks, pads, [p3]);
}

/** A point on the toy's base (not its heart or body), in client pixels: searched round the rim. */
function baseOf(aim: Aim, stage: Stage, toy: Toy): { x: number; y: number } {
  const p = toy.group.position;
  const r = stage.canvas.getBoundingClientRect();
  const toCam = Math.atan2(stage.camera.position.x - p.x, stage.camera.position.z - p.z);
  let fallback: { x: number; y: number } | null = null;
  for (const da of [0.6, -0.6, 1.0, -1.0, 0.3, -0.3, 0]) {
    const a = toCam + da;
    const v = new THREE.Vector3(p.x + Math.sin(a) * 0.48, 0.1, p.z + Math.cos(a) * 0.48).project(stage.camera);
    const at = { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    fallback ??= at;
    const h = aim.probe(at.x, at.y);
    if (h.toy === toy && h.part === "base") return at;
  }
  return fallback!;
}

/** Push the left stick toward a point until the seat's cursor is on it. */
async function steer(pads: FakeGamepadSource, n: number, seat: SeatState, to: { x: number; y: number }) {
  const end = performance.now() + 4000;
  while (performance.now() < end) {
    const dx = to.x - seat.x;
    const dy = to.y - seat.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 3) break;
    // Close in gently: the curve makes small deflections slow.
    const push = Math.min(1, 0.3 + dist / 150);
    pads.stick(n, "left", (dx / dist) * push, (dy / dist) * push);
    await nextFrame();
  }
  pads.stick(n, "left", 0, 0);
  await nextFrame();
}

async function holdButton(pads: FakeGamepadSource, n: number, b: "B" | "Menu", s: number) {
  pads.press(n, b);
  await seconds(s);
  pads.release(n, b);
  await frames(2);
}

function pointer(type: string, at: { x: number; y: number }, buttons = 0) {
  return new PointerEvent(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: at.x, clientY: at.y, button: 0, buttons, bubbles: true });
}

function mouseDrag(canvas: HTMLCanvasElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  canvas.dispatchEvent(pointer("pointerdown", from, 1));
  for (let i = 1; i <= 4; i++) canvas.dispatchEvent(pointer("pointermove", { x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4 }, 1));
  canvas.dispatchEvent(pointer("pointerup", to));
}

async function frames(n: number) {
  for (let i = 0; i < n; i++) await nextFrame();
}

async function seconds(s: number) {
  const end = performance.now() + s * 1000;
  while (performance.now() < end) await nextFrame();
}

async function until(f: () => boolean, s: number) {
  const end = performance.now() + s * 1000;
  while (!f() && performance.now() < end) await nextFrame();
}

function report(checks: Check[], pads: FakeGamepadSource, unplug: number[]) {
  for (const n of unplug) {
    try {
      pads.disconnect(n);
    } catch {
      // Already gone.
    }
  }
  const pass = checks.every((c) => c.pass);
  console.table(checks);
  console.log(`seats scenario: ${pass ? "PASS" : "FAIL"} (${checks.filter((c) => c.pass).length}/${checks.length})`);
  const el = document.createElement("pre");
  el.className = "scenario-report";
  el.dataset.pass = String(pass);
  el.textContent = [`seats scenario: ${pass ? "PASS" : "FAIL"}`, ...checks.map((c) => `${c.pass ? "✓" : "✗"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`)].join("\n");
  el.addEventListener("click", () => el.remove());
  document.body.append(el);
  return { pass, checks };
}
