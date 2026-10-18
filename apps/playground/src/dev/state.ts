import { Snap, SNAP_HEADER, SNAP_STRIDE } from "../audio/protocol";
import type { DevContext } from "./boot";

/**
 * What is true right now (docs/DEV-MODE.md §4.3, the State tab): the logs say
 * what changed, this says what is. Plain JSON, so any node can be copied.
 */
export function stateTree(ctx: DevContext): Record<string, unknown> {
  const { world, audio, room, avatar } = ctx;
  const snap = audio.snapshot;
  const toys: Record<string, unknown> = {};
  for (const t of world.toys) {
    if (!t) continue;
    const s = world.snapshot(t);
    const env = snap ? snap[SNAP_HEADER + t.slot * SNAP_STRIDE + Snap.env] : null;
    toys[t.id] = {
      kind: s.entry,
      slot: t.slot,
      pos: s.pos.map((v) => Math.round(v * 100) / 100),
      params: s.params,
      pulse: s.pulse,
      pattern: s.pattern || null,
      patternError: t.patternError || null,
      volume: t.volume,
      wild: t.wild,
      listening: world.mix.listening(t),
      env: env === null ? null : Math.round(env * 1000) / 1000,
    };
  }

  const session = room.session;
  const players = session
    ? [...session.awareness.getStates()].map(([id, s]) => ({ id, name: (s as { name?: string }).name ?? null, me: id === session.doc.clientID, admin: id === session.admin }))
    : [];

  return {
    app: {
      mode: ctx.mode,
      build: __BUILD_ID__,
      url: location.pathname + location.search,
      viewport: [innerWidth, innerHeight, devicePixelRatio],
      view: avatar.active ? avatar.mode : "orbit",
    },
    audio: {
      running: audio.ctx?.state ?? "not started",
      ready: audio.ready,
      sampleRate: audio.ctx?.sampleRate ?? null,
      beat: snap ? Math.round(snap[0] * 100) / 100 : null,
      master: world.mix.master,
      muted: world.mix.muted,
      audible: world.mix.audible,
      loudestEnv: loudest(snap),
    },
    world: {
      bpm: world.bpm,
      tuning: world.tuning,
      toys: world.count,
      canEdit: world.canEdit(),
    },
    toys,
    net: session
      ? {
          code: session.address.code,
          relay: session.address.relay,
          status: session.status,
          error: session.error || null,
          rtt: Math.round(session.rtt),
          me: session.doc.clientID,
          admin: session.admin,
          isAdmin: session.isAdmin,
          players,
        }
      : null,
  };
}

/** The loudest toy envelope in the snapshot: muted vs silent at a glance. */
export function loudest(snap: Float32Array | null): number | null {
  if (!snap) return null;
  let max = 0;
  for (let o = SNAP_HEADER; o + SNAP_STRIDE <= snap.length; o += SNAP_STRIDE) max = Math.max(max, snap[o + Snap.env]);
  return Math.round(max * 1000) / 1000;
}
