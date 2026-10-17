import * as THREE from "three";
import type { Aim } from "../aim";
import type { Avatar } from "../avatar/avatar";
import { AvatarFigure } from "../avatar/figure";
import { load, save } from "../prefs";
import type { Stage } from "../render/stage";
import type { RoomSession } from "./room";

/** What each player shares about themselves, ~20 times a second (MULTIPLAYER.md §4.1, AVATAR.md §10 V4). */
export interface PresenceState {
  name: string;
  color: string;
  mode: "orbit" | "walk" | "fly";
  /** Avatar pose: feet position, heading, look pitch, size. */
  pose?: { p: [number, number, number]; yaw: number; pitch: number; size: number };
  /** Where the player is aiming, if anywhere. */
  aim?: [number, number, number] | null;
}

/** Colour-blind-safe player colours (Okabe–Ito plus a sky blue). */
export const PLAYER_COLORS = ["#56b4e9", "#e69f00", "#009e73", "#f0e442", "#cc79a7", "#d55e00", "#8fd3ff", "#0072b2"];
const ADJ = ["Cobalt", "Amber", "Velvet", "Lucky", "Quiet", "Bright", "Spinning", "Tiny", "Brave", "Silver"];
const NOUN = ["Comet", "Nebula", "Quasar", "Moon", "Pulsar", "Orbit", "Meteor", "Aurora", "Nova", "Star"];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

/** This device's player name and colour, generated once and remembered. */
export function localPlayer(): { name: string; color: string } {
  const p = load<{ name: string; color: string } | null>("cosmic.player", null);
  if (p?.name && p.color) return p;
  const fresh = { name: `${pick(ADJ)} ${pick(NOUN)}`, color: pick(PLAYER_COLORS) };
  save("cosmic.player", fresh);
  return fresh;
}

interface Remote {
  state: PresenceState;
  figure: AvatarFigure;
  dot: THREE.Mesh;
  tag: HTMLDivElement;
  /** Interpolated pose. */
  pos: THREE.Vector3;
  yaw: number;
  aim: THREE.Vector3 | null;
}

const SEND_MS = 50;

/**
 * Presence: publishes this player's mode, avatar pose and aim, and draws
 * everyone else's avatar, aim dot and name, smoothed between updates.
 */
export class Presence {
  private remotes = new Map<number, Remote>();
  private last = "";
  private clock = 0;
  private unsubscribe: () => void;

  constructor(
    private room: RoomSession,
    private stage: Stage,
    private avatar: Avatar,
    private aim: Aim,
    private me: { name: string; color: string },
  ) {
    const onChange = () => this.sync();
    room.awareness.on("change", onChange);
    this.unsubscribe = () => room.awareness.off("change", onChange);
    this.publish(true);
  }

  /** Everyone in the room (including you), for the room sheet. */
  players(): { id: number; state: PresenceState }[] {
    return [...this.room.awareness.getStates()].filter(([, s]) => s?.name).map(([id, s]) => ({ id, state: s as PresenceState }));
  }

  setMe(me: { name: string; color: string }) {
    this.me = me;
    this.publish(true);
  }

  private publish(force = false) {
    const a = this.avatar;
    const state: PresenceState = { name: this.me.name, color: this.me.color, mode: a.active ? a.mode : "orbit" };
    if (a.active) state.pose = { p: round(a.pos.toArray()), yaw: r3(a.yaw), pitch: r3(a.pitch), size: a.size };
    const h = this.aim.current;
    state.aim = h.kind !== "none" && h.inReach && h.point ? round(h.point.toArray()) : null;
    const key = JSON.stringify(state);
    if (!force && key === this.last) return;
    this.last = key;
    this.room.awareness.setLocalState(state);
  }

  private sync() {
    const states = this.room.awareness.getStates();
    for (const [id, r] of this.remotes) {
      if (!states.has(id)) {
        r.figure.dispose();
        r.dot.removeFromParent();
        r.tag.remove();
        this.remotes.delete(id);
      }
    }
    for (const [id, s] of states) {
      if (id === this.room.doc.clientID || !s?.name) continue;
      let r = this.remotes.get(id);
      if (!r) {
        const figure = new AvatarFigure(s.color);
        this.stage.scene.add(figure.group);
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.65, depthTest: false }));
        dot.renderOrder = 11;
        this.stage.scene.add(dot);
        const tag = document.createElement("div");
        tag.className = "player-tag";
        document.body.append(tag);
        const pos = new THREE.Vector3(...((s as PresenceState).pose?.p ?? [0, 0, 0]));
        r = { state: s as PresenceState, figure, dot, tag, pos, yaw: (s as PresenceState).pose?.yaw ?? 0, aim: null };
        this.remotes.set(id, r);
      }
      r.state = s as PresenceState;
      r.figure.setColor(r.state.color);
      (r.dot.material as THREE.MeshBasicMaterial).color.set(r.state.color);
      r.tag.textContent = r.state.name;
      r.tag.style.setProperty("--player", r.state.color);
    }
  }

  update(dt: number) {
    this.clock += dt * 1000;
    if (this.clock >= SEND_MS) {
      this.clock = 0;
      this.publish();
    }
    const k = 1 - Math.exp(-dt * 12);
    const cam = this.stage.camera;
    const rect = this.stage.canvas.getBoundingClientRect();
    for (const r of this.remotes.values()) {
      const s = r.state;
      const pose = s.mode !== "orbit" ? s.pose : undefined;
      r.figure.group.visible = !!pose;
      if (pose) {
        const target = new THREE.Vector3(...pose.p);
        // Snap after a teleport (respawn, entering avatar mode), glide otherwise.
        if (r.pos.distanceTo(target) > 6) r.pos.copy(target);
        else r.pos.lerp(target, k);
        let dy = pose.yaw - r.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        r.yaw += dy * k;
        r.figure.group.position.copy(r.pos);
        r.figure.group.rotation.set(0, r.yaw, 0);
        r.figure.group.scale.setScalar(pose.size);
      }
      if (s.aim) {
        const target = new THREE.Vector3(...s.aim);
        if (!r.aim || r.aim.distanceTo(target) > 4) r.aim = target;
        else r.aim.lerp(target, k);
        r.dot.position.copy(r.aim);
      } else r.aim = null;
      r.dot.visible = !!r.aim;

      // Name over the head in avatar mode, beside the aim dot in orbit.
      const anchor = pose ? r.pos.clone().setY(r.pos.y + 1.35 * pose.size) : r.aim;
      const p = anchor?.clone().project(cam);
      const show = !!p && p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
      r.tag.classList.toggle("on", show);
      if (show && p) r.tag.style.transform = `translate(${rect.left + ((p.x + 1) / 2) * rect.width}px, ${rect.top + ((1 - p.y) / 2) * rect.height}px) translate(-50%, -120%)`;
    }
  }

  dispose() {
    this.unsubscribe();
    for (const r of this.remotes.values()) {
      r.figure.dispose();
      r.dot.removeFromParent();
      r.tag.remove();
    }
    this.remotes.clear();
  }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const round = (v: number[]) => v.map(r3) as [number, number, number];
