import QRCode from "qrcode";
import * as Y from "yjs";
import type { Aim } from "../aim";
import type { Avatar } from "../avatar/avatar";
import { WorldBinding } from "../net/doc";
import { localPlayer, PLAYER_COLORS, Presence } from "../net/presence";
import { canHost, newCode, parseRoom, RELAY_URL, RoomSession, servedByRelay, SHARE_URL, type RoomAddress } from "../net/room";
import { save } from "../prefs";
import type { Stage } from "../render/stage";
import type { World } from "../world";
import { emit } from "../events";

const PEOPLE = `<svg viewBox="0 0 20 20"><circle cx="7" cy="7" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="14" cy="8" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M1.5 17c.5-3.5 3-5 5.5-5s5 1.5 5.5 5M12 12.4c3 0 5.6 1.3 6 4.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const MODE = { orbit: "◎", walk: "🚶", fly: "✈" } as const;

/** One connected gamepad, for Details (controllers/gamepad.ts `connected`). */
export interface PadInfo {
  id: string;
  mapping: string;
  seat: number | null;
}

/**
 * Rooms (docs/MULTIPLAYER.md §6): the people button on the HUD opens a sheet
 * to host or join, shows the code, invite and QR, the players, and for the
 * admin, the world lock and "make admin". `?room=CODE` in the URL joins.
 * The footer shows the build id and a *Details* panel testers can copy
 * (docs/PLAYTESTS.md R2; it replaces `?netdebug`, which can't reach itch's iframe).
 */
export class RoomSheet {
  session: RoomSession | null = null;
  presence: Presence | null = null;
  private binding: WorldBinding | null = null;
  private me = localPlayer();
  private button: HTMLButtonElement;
  private sheet = document.createElement("section");
  private details = false;
  private refresh = 0;
  /** Connected gamepads, listed in Details; set by main.ts. */
  pads: (() => PadInfo[]) | null = null;

  constructor(
    hud: HTMLElement,
    private world: World,
    private stage: Stage,
    private avatar: Avatar,
    private aim: Aim,
  ) {
    avatar.figure.setColor(this.me.color);
    this.button = document.createElement("button");
    this.button.className = "hud-room";
    this.button.title = "Play together";
    this.button.setAttribute("aria-label", "Play together");
    this.button.innerHTML = `${PEOPLE}<b></b>`;
    hud.insertBefore(this.button, hud.querySelector(".hud-help"));
    this.button.addEventListener("click", () => this.toggle());

    this.sheet.id = "room";
    this.sheet.hidden = true;
    this.sheet.setAttribute("aria-label", "Room");
    document.body.append(this.sheet);
    this.sheet.addEventListener("click", (e) => this.click(e));
    this.sheet.addEventListener("change", (e) => this.change(e));

    // ?room=CODE on a page served by a relay; ?join=<link or code> from the desktop app's --room option.
    const q = new URLSearchParams(location.search);
    const addr = q.get("join") ? parseRoom(q.get("join")!) : q.get("room") ? parseRoom(location.href) : null;
    if (addr) this.join(addr);
    this.render();
  }

  toggle(open = this.sheet.hidden) {
    this.sheet.hidden = !open;
    if (open) this.avatar.unlock();
    this.render();
  }

  update(dt: number) {
    this.presence?.update(dt);
    // Status and Details change without a re-render (RTT, retries); patch them in place once a second.
    this.refresh += dt;
    if (this.refresh >= 1 && !this.sheet.hidden) {
      this.refresh = 0;
      this.renderLive();
    }
  }

  join(addr: RoomAddress) {
    this.leave();
    const session = new RoomSession(addr, this.me.name);
    this.session = session;
    emit("session.join", { code: addr.code, name: this.me.name });
    this.binding = new WorldBinding(this.world, session);
    this.presence = new Presence(session, this.stage, this.avatar, this.aim, this.me);
    session.onStatus = () => this.render();
    session.onSynced = () => this.binding?.synced();
    session.onReset = () => setTimeout(() => this.join(addr), 0);
    this.binding.onChange = () => this.render();
    // Poses change 20 times a second; only re-render when who's here (or their mode) changes.
    let roster = "";
    session.awareness.on("change", () => {
      const next = JSON.stringify(this.presence?.players().map((p) => [p.id, p.state.name, p.state.color, p.state.mode]));
      if (next !== roster) {
        roster = next;
        this.render();
      }
    });
    if (servedByRelay()) history.replaceState(null, "", `?room=${addr.code}`);
    this.render();
  }

  leave() {
    if (this.session) emit("session.leave", { code: this.session.address.code });
    this.binding?.dispose();
    this.presence?.dispose();
    this.session?.leave();
    this.binding = this.presence = this.session = null;
    if (servedByRelay() && location.search.includes("room=")) history.replaceState(null, "", location.pathname);
    this.render();
  }

  private host() {
    if (!canHost()) return;
    const addr = parseRoom(newCode());
    if (addr) this.join(addr);
  }

  private click(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    if (act === "host") this.host();
    if (act === "join") {
      const input = this.sheet.querySelector<HTMLInputElement>("[name=join]")!;
      const addr = parseRoom(input.value);
      if (addr) this.join(addr);
      else {
        input.setCustomValidity(canHost() ? "Type a 6-letter code or paste a room link" : "Paste the room link (https://…/?room=CODE)");
        input.reportValidity();
      }
    }
    if (act === "leave") this.leave();
    if (act === "copy" && this.session) copy(el, this.session.address.invite);
    if (act === "copy-details") copy(el, this.detailsText());
    if (act === "details") {
      this.details = !this.details;
      this.render();
    }
    if (act === "admin" && this.session) this.session.makeAdmin(Number(el.dataset.id));
    if (act === "close") this.toggle(false);
    if (act === "color") {
      this.me = { ...this.me, color: el.dataset.color! };
      this.saveMe();
    }
  }

  private change(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.name === "lock") this.binding?.setLocked(t.checked);
    if (t.name === "name" && t.value.trim()) {
      this.me = { ...this.me, name: t.value.trim().slice(0, 24) };
      this.saveMe();
    }
  }

  private saveMe() {
    save("cosmic.player", this.me);
    this.avatar.figure.setColor(this.me.color);
    this.presence?.setMe(this.me);
    this.render();
  }

  private render() {
    const s = this.session;
    const players = this.presence?.players() ?? [];
    const locked = !!this.binding?.locked;
    this.button.classList.toggle("active", !!s && s.status === "online");
    this.button.querySelector("b")!.textContent = s && players.length ? String(players.length) : "";
    document.body.classList.toggle("world-locked", locked && !s?.isAdmin);
    if (this.sheet.hidden) return;

    const me = `
      <div class="room-me">
        <input name="name" value="${esc(this.me.name)}" aria-label="Your name" maxlength="24">
        <div class="room-colors">${PLAYER_COLORS.map((c) => `<button data-act="color" data-color="${c}" style="--player:${c}" class="${c === this.me.color ? "on" : ""}" aria-label="Colour ${c}"></button>`).join("")}</div>
      </div>`;
    if (!s) {
      this.sheet.innerHTML = `
        <header><h2>Play together</h2><button data-act="close" aria-label="Close">×</button></header>
        ${me}
        ${canHost() ? `<button class="room-primary" data-act="host">Host a room</button>` : `<p class="room-note">This window can join rooms; hosting runs from a browser tab or <code>npm run tunnel</code>.</p>`}
        <div class="room-join"><input name="join" placeholder="${canHost() ? "Code or link" : "Room link"}" aria-label="Room code or link" autocomplete="off"><button data-act="join">Join</button></div>
        ${this.footer()}`;
      return;
    }
    const a = s.address;
    const invite = SHARE_URL
      ? `<p class="room-invite">Go to <b>${esc(SHARE_URL)}</b> and enter code <b>${a.code}</b></p><button data-act="copy">Copy invite</button>`
      : a.link
        ? `<div class="room-link"><input readonly value="${esc(a.link)}" aria-label="Room link"><button data-act="copy">Copy invite</button></div>`
        : `<button data-act="copy">Copy invite</button>`;
    this.sheet.innerHTML = `
      <header><h2>Room</h2><button data-act="close" aria-label="Close">×</button></header>
      <div class="room-code" aria-label="Room code">${a.code}</div>
      ${a.link ? `<canvas class="room-qr" width="132" height="132"></canvas>` : ""}
      ${invite}
      <p class="room-status ${statusClass(s)}">${esc(statusText(s))}</p>
      ${me}
      <ul class="room-players">${players
        .map(({ id, state }) => {
          const isMe = id === s.doc.clientID;
          const admin = id === s.admin;
          const give = s.isAdmin && !isMe ? `<button data-act="admin" data-id="${id}">make admin</button>` : "";
          return `<li style="--player:${state.color}"><i></i>${esc(state.name)}${isMe ? " (you)" : ""} <span>${MODE[state.mode] ?? ""}</span>${admin ? `<em>admin</em>` : give}</li>`;
        })
        .join("")}</ul>
      ${s.isAdmin ? `<label class="room-lock"><input type="checkbox" name="lock" ${locked ? "checked" : ""}> Lock the world (guests can play toys, not change them)</label>` : locked ? `<p class="room-note">🔒 The admin locked the world: play any toy; adding, moving and retuning are off.</p>` : ""}
      <button data-act="leave">Leave room</button>
      ${this.footer()}`;
    const qr = this.sheet.querySelector<HTMLCanvasElement>(".room-qr");
    if (qr) void QRCode.toCanvas(qr, a.link, { width: 132, margin: 1 });
  }

  /** Build id, and the Details panel when it's open. */
  private footer() {
    return `
      <footer class="room-foot"><button data-act="details" aria-expanded="${this.details}">Details</button><span>build <code>${esc(__BUILD_ID__)}</code></span></footer>
      ${this.details ? `<pre class="room-details">${esc(this.detailsText())}</pre><button data-act="copy-details">Copy details</button>` : ""}`;
  }

  private renderLive() {
    const s = this.session;
    const status = this.sheet.querySelector<HTMLElement>(".room-status");
    if (s && status) {
      status.className = `room-status ${statusClass(s)}`;
      status.textContent = statusText(s);
    }
    const details = this.sheet.querySelector<HTMLElement>(".room-details");
    if (details) details.textContent = this.detailsText();
  }

  /** What a tester pastes into their report: build, relay, connection quality, pads. */
  private detailsText() {
    const s = this.session;
    const lines = [
      `build     ${__BUILD_ID__}`,
      `relay     ${s?.address.relay ?? (RELAY_URL || "this page's server")}`,
      ...(SHARE_URL ? [`page      ${SHARE_URL}`] : []),
      `origin    ${location.origin}`,
    ];
    if (s) {
      lines.push(
        `room      ${s.address.code} · ${s.status}${s.isAdmin ? " · admin" : ""}`,
        `rtt       ${s.status === "online" ? `${Math.round(s.rtt)} ms` : "–"}`,
        `reconnect ${s.reconnects}`,
        `last err  ${s.error || s.lastError || "none"}`,
        `doc       ${(Y.encodeStateAsUpdate(s.doc).byteLength / 1024).toFixed(1)} KB · ${this.presence?.players().length ?? 0} players`,
      );
    } else lines.push("room      none");
    const pads = this.pads?.() ?? [];
    lines.push(`gamepads  ${pads.length || "none"}`);
    for (const p of pads) lines.push(`  ${p.seat ? `seat ${p.seat}` : "no seat"} · ${p.mapping || "non-standard"} · ${p.id}`);
    lines.push(`browser   ${navigator.userAgent}`);
    return lines.join("\n");
  }
}

function statusText(s: RoomSession): string {
  if (s.status === "error") return s.error;
  if (s.reach === "waking") return "Waking up the room server…";
  if (s.reach === "unreachable") return "Can't reach the room server. Check your connection, or reload and try again.";
  if (s.status === "online") return s.rtt ? `Online · ${Math.round(s.rtt)} ms` : "Online";
  return s.status === "connecting" ? "Connecting…" : "Offline";
}

function statusClass(s: RoomSession): string {
  return s.reach === "unreachable" ? "error" : s.status;
}

/** Copy text, and say so on the button for a moment. */
function copy(button: HTMLElement, text: string) {
  void navigator.clipboard?.writeText(text).then(() => {
    const label = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = label), 1200);
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
