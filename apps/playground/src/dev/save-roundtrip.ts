import * as THREE from "three";
import { loadDoc, parseDoc, serialize, toDoc, type DocMeta } from "../persist/doc";
import { TOYS } from "../toys/registry";
import type { World } from "../world";

const SCL = `! 7-limit.scl
7-limit just scale
 7
!
 9/8
 5/4
 4/3
 3/2
 5/3
 7/4
 2/1
`;

/**
 * The S1 exit check (docs/SAVE-LOAD.md §9): a world with every toy and a
 * Scala tuning, saved, loaded, saved again, gives byte-identical JSON; plus
 * an unknown key and an unknown toy kind that must come back unchanged
 * (REVISIONS.md R3.3). Run with `cosmic.test.roundTrip()`; replaces the world.
 */
export async function roundTrip(world: World) {
  for (const t of world.toys) if (t) world.remove(t);
  world.setTempo(112);
  world.setTuningScala("7-limit", SCL);
  world.setTuning({ root: 62 });
  TOYS.forEach((e, i) => {
    const toy = world.add(e.id, new THREE.Vector3((i % 4) * 3 - 4.5, 0, Math.floor(i / 4) * 3 - 2));
    if (!toy) return;
    // Change something on each, so defaults alone can't pass.
    const [name, d] = Object.entries(toy.defs).find(([, d]) => !d.derived) ?? [];
    if (name && d) toy.setParam(name, d.range[0] + (d.range[1] - d.range[0]) * 0.3);
    toy.setPulse({ enabled: true, steps: 5 + i });
    toy.setVolume(0.5 + i * 0.05);
    if (i === 1) toy.setPattern("x . [x x] .");
  });
  const meta: DocMeta = { name: "Round trip", created: "2026-10-17T00:00:00.000Z", seed: "ROUNDTRP" };
  const fixed = { modified: "2026-10-17T00:00:00.000Z" };

  const first = await toDoc(world, meta, fixed);
  // Data from a newer build: an unknown top-level key, an unknown toy key and an unknown toy kind.
  const future = {
    ...first,
    comet: { tail: 3 },
    toys: [...first.toys.map((t, i) => (i === 0 ? { ...t, form: { kind: "spiral" } } : t)), { ...first.toys[0], id: "t_FUTURE01", kind: "warp-drive" }],
  };
  const a = serialize(future as typeof first);
  const parsed = parseDoc(a);
  if (!parsed.ok) throw new Error(parsed.error);
  const result = loadDoc(world, parsed.doc, { allowModules: true });
  const b = serialize(await toDoc(world, meta, fixed));
  const ok = a === b;
  const report = { ok, toys: first.toys.length, placeholders: result.placeholders, bytes: a.length, notes: result.notes };
  if (!ok) {
    const i = [...a].findIndex((c, k) => c !== b[k]);
    Object.assign(report, { firstDiff: i, before: a.slice(Math.max(0, i - 80), i + 80), after: b.slice(Math.max(0, i - 80), i + 80) });
  }
  console.log("save round trip", report);
  return report;
}
