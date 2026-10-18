import * as THREE from "three";
import { Fields } from "./audio/fields";
import { AudioHost } from "./audio/host";
import { Aim } from "./aim";
import { Avatar } from "./avatar/avatar";
import { FakeGamepadSource } from "./controllers/fake-gamepad";
import { Gamepads } from "./controllers/gamepad";
import { MergedSource, NavigatorGamepads, type GamepadSource } from "./controllers/source";
import { FocusView } from "./focus/focus";
import { Input } from "./input";
import type { ToyConfig } from "./audio/config";
import { AimPreview } from "./render/aim-preview";
import { PlacementGhost } from "./render/ghost";
import { SeatCursors } from "./render/seat-cursors";
import { Stage } from "./render/stage";
import { Seats } from "./seats/seats";
import { configEntry, registerToy } from "./toys/registry";
import { Chest } from "./ui/chest";
import { Constellations } from "./ui/constellations";
import { library } from "./persist/library";
import { Variants } from "./ui/variants";
import { FocusBar } from "./ui/focus-bar";
import { Hotbar } from "./ui/hotbar";
import { Hud } from "./ui/hud";
import { ListenSheet } from "./ui/listen";
import { ModeSwitch } from "./ui/modes";
import { PlacePicker } from "./ui/place-picker";
import { PuzzleShelf } from "./ui/puzzles";
import { RoomSheet } from "./ui/room";
import { PulseEditor } from "./ui/pulse-editor";
import { SoundBadge } from "./ui/sound-badge";
import { World } from "./world";
import "./style.css";

const stage = new Stage(document.getElementById("stage") as HTMLCanvasElement);
const audio = new AudioHost();
const fields = new Fields();
const world = new World(stage, audio, fields);
const editor = new PulseEditor(world);
const chest = new Chest(world, stage, audio);
const hud = new Hud(world, audio);
const listen = new ListenSheet(world, document.getElementById("hud")!);
hud.onListen = () => listen.toggle();
const badge = new SoundBadge(world);
badge.onLongPress = (toy) => editor.open(toy);
const aim = new Aim(stage, world);
const preview = new AimPreview(stage);
const avatar = new Avatar(stage, world, "#8fd3ff");
const modes = new ModeSwitch(document.getElementById("hud")!, avatar, preview);
const hotbar = new Hotbar();
avatar.onEnter = () => chest.toggle(false);
const ghost = new PlacementGhost(stage.scene);
const room = new RoomSheet(document.getElementById("hud")!, world, stage, avatar, aim);
const seats = new Seats();
const focus = new FocusView(world, avatar, editor);
const focusBar = new FocusBar(world, focus);
const selected = () => world.toys.filter((t): t is NonNullable<typeof t> => !!t && world.selection.has(t.id));
listen.onFocusSelected = () => focus.enter(selected());
// The toy panel's focus glyph: that toy, plus the selection if it's in it.
editor.onFocusView = (toy) => focus.enter(world.selection.has(toy.id) ? [toy, ...selected().filter((t) => t !== toy)] : [toy]);
const input = new Input({ stage, world, editor, chest, audio, aim, preview, avatar, hotbar, ghost, modes, listen, badge, seats, focus, focusBar });

const params = new URLSearchParams(location.search);

// Gamepad seats (docs/PLAYTESTS.md §3). In dev, scripted pads join the real ones (`cosmic.pads`).
const fakePads = import.meta.env.DEV || params.has("dev") || params.has("test") ? new FakeGamepadSource() : null;
const padSource: GamepadSource = fakePads ? new MergedSource([new NavigatorGamepads(), fakePads]) : new NavigatorGamepads();
const picker = new PlacePicker(world);
const cursors = new SeatCursors(stage, seats);
const gamepads = new Gamepads({ stage, world, editor, aim, audio, seats, picker, cursors }, padSource);
room.pads = () => gamepads.connected;

// Start with a string to pluck and an orrery already turning, so the first
// touch makes sound and the world is playing on its own right away.
const portrait = innerHeight > innerWidth;
world.add("spire", portrait ? new THREE.Vector3(-0.4, 0, 2.2) : new THREE.Vector3(-2.4, 0, 0.8));
world.add("orrery", portrait ? new THREE.Vector3(0.2, 0, -1.6) : new THREE.Vector3(2.3, 0, -0.6));
chest.toggle(true);

// Puzzles (docs/MODES.md): the shelf on the HUD, or open one directly with ?puzzle=first-light.
const devBuild = import.meta.env.DEV || params.has("dev") || params.has("test");
const puzzles = new PuzzleShelf(document.getElementById("hud")!, world, devBuild);
puzzles.onChange = (mode) => {
  chest.render();
  if (mode) chest.toggle(false);
};
if (params.get("puzzle")) puzzles.open(params.get("puzzle")!);

// Save and open worlds (docs/SAVE-LOAD.md): autosave, named saves, files and links.
const constellations = new Constellations(document.getElementById("hud")!, {
  world,
  audio,
  avatarActive: () => avatar.active,
  room: () => ({ inRoom: !!room.session, admin: !!room.session?.isAdmin }),
  beforeLoad: () => {
    if (puzzles.mode) puzzles.leave();
  },
  afterLoad: (doc) => {
    chest.render();
    if (doc) variants.offer(doc.templates);
  },
  importToy: (text) => variants.importText(text),
  saving: () => !puzzles.mode,
});

// Toy variants (docs/SAVE-LOAD.md §6): "Keep this one", the chest fan, toy files and copy/paste.
const variants = new Variants({
  world,
  target: () => editor.toy ?? input.targetToy(),
  aimPoint: () => {
    const h = aim.current;
    return h.kind !== "none" && h.point && h.point.length() < 12 ? h.point.clone().setY(0) : null;
  },
});
chest.variants = variants;
editor.onKeep = (toy) => void variants.keep(toy);
// Keeping a variant links the toy to it, which changes what a save holds.
library.listeners.push(() => constellations.markChanged());
// The library loads before the autosave is offered, so a continued world finds its variants.
void library.load().then(() => constellations.start());

// Toys sent from the Toy Forge (forge.html, same origin) join the chest and the world.
new BroadcastChannel("hypertoys-forge").onmessage = (ev: MessageEvent<{ t: "toy"; config: ToyConfig }>) => {
  if (ev.data?.t !== "toy") return;
  registerToy(configEntry(ev.data.config));
  chest.render();
  world.add(ev.data.config.id);
};

const wake = document.getElementById("wake")!;
audio.onReady = () => wake.classList.add("gone");

const clock = new THREE.Clock();
stage.renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  input.update(dt);
  gamepads.update(dt);
  room.update(dt);
  world.update(dt, clock.elapsedTime);
  focus.update(dt);
  editor.update();
  stage.render();
});

if (fakePads) {
  const cosmic = { world, audio, puzzles, constellations, stage, fields, aim, avatar, hotbar, room, seats, gamepads, focus, pads: fakePads, test: {} as Record<string, unknown> };
  Object.assign(window, { cosmic });
  // The L1 exit check (docs/PLAYTESTS.md): `cosmic.test.seats()`, or open with ?scenario=seats.
  const seatsScenario = () => import("./dev/seats-scenario").then((m) => m.runSeatsScenario({ aim, world, stage, seats, gamepads, pads: fakePads, input }));
  cosmic.test.seats = seatsScenario;
  if (params.get("scenario") === "seats") seatsScenario();
  // `cosmic.test.solve()` applies the open puzzle's first listed solution (docs/MODES.md §10).
  cosmic.test.solve = (which = 0) => puzzles.mode?.solve(which);
  // The S1 exit check (docs/SAVE-LOAD.md §9): save → load → save gives the same JSON.
  cosmic.test.roundTrip = () => import("./dev/save-roundtrip").then((m) => m.roundTrip(world));
}
