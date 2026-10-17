import * as THREE from "three";
import { Fields } from "./audio/fields";
import { AudioHost } from "./audio/host";
import { Aim } from "./aim";
import { Avatar } from "./avatar/avatar";
import { FakeGamepadSource } from "./controllers/fake-gamepad";
import { Gamepads } from "./controllers/gamepad";
import { MergedSource, NavigatorGamepads, type GamepadSource } from "./controllers/source";
import { Input } from "./input";
import type { ToyConfig } from "./audio/config";
import { AimPreview } from "./render/aim-preview";
import { PlacementGhost } from "./render/ghost";
import { SeatCursors } from "./render/seat-cursors";
import { Stage } from "./render/stage";
import { Seats } from "./seats/seats";
import { configEntry, registerToy } from "./toys/registry";
import { Chest } from "./ui/chest";
import { Hotbar } from "./ui/hotbar";
import { Hud } from "./ui/hud";
import { ListenSheet } from "./ui/listen";
import { ModeSwitch } from "./ui/modes";
import { PlacePicker } from "./ui/place-picker";
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
const input = new Input({ stage, world, editor, chest, audio, aim, preview, avatar, hotbar, ghost, modes, listen, badge, seats });

// Gamepad seats (docs/PLAYTESTS.md §3). In dev, scripted pads join the real ones (`cosmic.pads`).
const params = new URLSearchParams(location.search);
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
  editor.update();
  stage.render();
});

if (fakePads) {
  const cosmic = { world, audio, stage, fields, aim, avatar, hotbar, room, seats, gamepads, pads: fakePads, test: {} as Record<string, unknown> };
  Object.assign(window, { cosmic });
  // The L1 exit check (docs/PLAYTESTS.md): `cosmic.test.seats()`, or open with ?scenario=seats.
  const seatsScenario = () => import("./dev/seats-scenario").then((m) => m.runSeatsScenario({ aim, world, stage, seats, gamepads, pads: fakePads, input }));
  cosmic.test.seats = seatsScenario;
  if (params.get("scenario") === "seats") seatsScenario();
}
