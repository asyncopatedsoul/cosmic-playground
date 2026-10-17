import * as Y from "yjs";
import type { PulseState, Toy } from "../toys/toy";
import type { ToyEdit, ToySnapshot, World } from "../world";
import type { RoomSession } from "./room";

/** Origin of transactions this binding makes, so its own changes aren't applied back. */
const LOCAL = Symbol("local");
/** Drags write to the doc at most this often (MULTIPLAYER.md §4.2). */
const FLUSH_MS = 33;

/**
 * Binds the World to the room's Y.Doc (docs/MULTIPLAYER.md §4):
 *
 *   world : Y.Map { init, bpm, root, scale, wild, locked }
 *   toys  : Y.Map<toyId, Y.Map { entry, pos, params: Y.Map, pulse, pattern, volume }>
 *
 * Local edits go into the doc (throttled); remote changes are applied to the
 * World with `world.applying` set. The first admin to sync an empty room seeds
 * it from their world; everyone else's world is replaced by the room's.
 * Mute, solo and focus are each player's own and never written (AUDIO-MIX.md §5).
 * Not shared yet: custom tunings (tables, Scala), zap recipes, Forge-only toys.
 */
export class WorldBinding {
  readonly meta: Y.Map<unknown>;
  readonly toys: Y.Map<Y.Map<unknown>>;
  /** Called when the lock or roles change, for the UI. */
  onChange: (() => void) | null = null;

  private dirty = new Map<string, Set<ToyEdit>>();
  private timer = 0;
  private started = false;
  private listener: World["listeners"][number];

  constructor(
    private world: World,
    private room: RoomSession,
  ) {
    this.meta = room.doc.getMap("world");
    this.toys = room.doc.getMap("toys");

    this.listener = {
      add: (toy) => this.write(() => this.toys.set(toy.id, toyMap(world.snapshot(toy)))),
      remove: (toy) => this.write(() => this.toys.delete(toy.id)),
      edit: (toy, what) => this.queue(toy, what),
      world: () => this.write(() => this.writeWorld()),
      poke: (toy, strength) => room.emit({ t: "poke", id: toy.id, strength }),
    };

    this.toys.observeDeep((events, tx) => {
      if (tx.origin === LOCAL || !this.started) return;
      const ids = new Set<string>();
      for (const e of events) {
        if (e.target === this.toys) for (const k of (e as Y.YMapEvent<unknown>).keysChanged) ids.add(k);
        else ids.add(String(e.path[0]));
      }
      this.apply(() => ids.forEach((id) => this.reconcile(id)));
    });
    this.meta.observe((_e, tx) => {
      if (tx.origin === LOCAL) return;
      if (!this.started && this.meta.get("init")) {
        this.start();
        return;
      }
      if (this.started) this.apply(() => this.readWorld());
      this.onChange?.();
    });
    room.onEvent = (e) => {
      const ev = e as { t: string; id: string; strength: number };
      const toy = ev.t === "poke" ? world.byId(ev.id) : null;
      if (toy) this.apply(() => toy.poke(Number(ev.strength) || 0.8));
    };
    world.canEdit = () => !this.locked || room.isAdmin;
  }

  get locked() {
    return this.meta.get("locked") === true;
  }

  /** Admins lock or unlock the world for guests. */
  setLocked(on: boolean) {
    if (!this.room.isAdmin) return;
    this.write(() => this.meta.set("locked", on));
    this.onChange?.();
  }

  /** Call once the room has synced: seed an empty room (admin), or take the room's world. */
  synced() {
    if (this.started) return;
    if (this.meta.get("init")) this.start();
    else if (this.room.isAdmin) {
      this.write(() => {
        this.meta.set("init", true);
        this.writeWorld();
        for (const toy of this.world.toys) if (toy) this.toys.set(toy.id, toyMap(this.world.snapshot(toy)));
      });
      this.started = true;
      this.world.listeners.push(this.listener);
    }
    // A guest in a room nobody has seeded yet waits for `init` (meta observer).
  }

  private start() {
    this.started = true;
    this.apply(() => {
      this.readWorld();
      for (const toy of this.world.toys) if (toy && !this.toys.has(toy.id)) this.world.remove(toy);
      for (const id of this.toys.keys()) this.reconcile(id);
    });
    this.world.listeners.push(this.listener);
    this.onChange?.();
  }

  /** Leave the room: the world stays as it is, now local again. */
  dispose() {
    clearTimeout(this.timer);
    const i = this.world.listeners.indexOf(this.listener);
    if (i >= 0) this.world.listeners.splice(i, 1);
    this.world.canEdit = () => true;
  }

  private apply(fn: () => void) {
    const was = this.world.applying;
    this.world.applying = true;
    try {
      fn();
    } finally {
      this.world.applying = was;
    }
  }

  private write(fn: () => void) {
    this.room.doc.transact(fn, LOCAL);
  }

  private queue(toy: Toy, what: ToyEdit) {
    let set = this.dirty.get(toy.id);
    if (!set) this.dirty.set(toy.id, (set = new Set()));
    set.add(what);
    if (!this.timer) this.timer = window.setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush() {
    this.timer = 0;
    const dirty = this.dirty;
    this.dirty = new Map();
    this.write(() => {
      for (const [id, whats] of dirty) {
        const toy = this.world.byId(id);
        const m = this.toys.get(id);
        if (!toy || !m) continue;
        const s = this.world.snapshot(toy);
        if (whats.has("pos")) m.set("pos", s.pos);
        if (whats.has("pulse")) m.set("pulse", s.pulse);
        if (whats.has("pattern")) m.set("pattern", s.pattern);
        if (whats.has("volume")) m.set("volume", s.volume);
        if (whats.has("params")) {
          const params = m.get("params") as Y.Map<number>;
          for (const [k, v] of Object.entries(s.params)) if (params.get(k) !== v) params.set(k, v);
        }
      }
    });
  }

  /** Make toy `id` match the doc: add, remove or update it. */
  private reconcile(id: string) {
    const m = this.toys.get(id);
    const toy = this.world.byId(id);
    if (!m) {
      if (toy) this.world.remove(toy);
      return;
    }
    const s = readToy(id, m);
    if (!toy) {
      if (!this.world.restore(s)) console.warn(`room: can't place toy ${s.entry} (unknown here, or the world is full)`);
      return;
    }
    const p = toy.group.position;
    this.world.applyState(toy, {
      pos: p.x !== s.pos[0] || p.y !== s.pos[1] || p.z !== s.pos[2] ? s.pos : undefined,
      params: s.params,
      pulse: JSON.stringify(s.pulse) !== JSON.stringify(toy.pulse) ? s.pulse : undefined,
      pattern: s.pattern,
      volume: s.volume,
    });
  }

  private writeWorld() {
    const { bpm, tuning } = this.world;
    this.meta.set("bpm", bpm);
    this.meta.set("root", tuning.root);
    // Custom tables aren't shared yet; guests hear the nearest preset.
    this.meta.set("scale", tuning.scale);
    this.meta.set("wild", tuning.wild);
  }

  private readWorld() {
    const bpm = this.meta.get("bpm");
    if (typeof bpm === "number" && bpm !== this.world.bpm) this.world.setTempo(bpm);
    const root = this.meta.get("root");
    const scale = this.meta.get("scale");
    const wild = this.meta.get("wild");
    const t = this.world.tuning;
    if (typeof scale === "number" && (root !== t.root || scale !== t.scale || wild !== t.wild)) {
      this.world.setTuning({ root: Number(root), scale, wild: !!wild });
    }
  }
}

function toyMap(s: ToySnapshot): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("entry", s.entry);
  m.set("pos", s.pos);
  m.set("params", new Y.Map(Object.entries(s.params)));
  m.set("pulse", s.pulse);
  m.set("pattern", s.pattern);
  m.set("volume", s.volume);
  return m;
}

function readToy(id: string, m: Y.Map<unknown>): ToySnapshot {
  const params = m.get("params") as Y.Map<number> | undefined;
  return {
    id,
    entry: String(m.get("entry")),
    pos: (m.get("pos") as [number, number, number]) ?? [0, 0, 0],
    params: params ? Object.fromEntries(params.entries()) : {},
    pulse: m.get("pulse") as PulseState,
    pattern: String(m.get("pattern") ?? ""),
    volume: typeof m.get("volume") === "number" ? (m.get("volume") as number) : undefined,
  };
}
