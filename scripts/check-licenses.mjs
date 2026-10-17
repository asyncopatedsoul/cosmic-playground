// License gate for the Rust crates: every dependency that can end up in a
// build of the embeddable crates (the workspace's default members, crates/*)
// must be under a permissive license (the same allow-list as deny.toml).
// The desktop app is MPL-2.0 like the playground, so it isn't gated here.
// Uses `cargo metadata`, so it needs nothing installed beyond Rust.
//
//   node scripts/check-licenses.mjs        exits 1 and lists offenders
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const env = { ...process.env, [pathKey]: `${join(homedir(), ".cargo", "bin")}${delimiter}${process.env[pathKey]}` };

// The allow-list lives in deny.toml; read it from there so the two never drift.
const deny = readFileSync(join(root, "deny.toml"), "utf8");
const allowBlock = deny.match(/allow\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
const allowed = new Set([...allowBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]));

const meta = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], { cwd: root, env, maxBuffer: 1 << 28 }).toString(),
);

/** Evaluate an SPDX expression: true if some way of satisfying it uses only allowed licenses. */
function ok(expr) {
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const primary = () => {
    if (tokens[i] === "(") {
      i++;
      const v = or();
      i++; // ")"
      return v;
    }
    let id = tokens[i++];
    if (tokens[i] === "WITH") {
      id += ` WITH ${tokens[i + 1]}`;
      i += 2;
    }
    // Legacy "/" separated lists mean OR.
    return id.split("/").some((x) => allowed.has(x));
  };
  const and = () => {
    let v = primary();
    while (tokens[i] === "AND") {
      i++;
      v = primary() && v;
    }
    return v;
  };
  const or = () => {
    let v = and();
    while (tokens[i] === "OR") {
      i++;
      v = and() || v;
    }
    return v;
  };
  return or();
}

// Normal and build dependencies of workspace members (dev-dependencies never ship).
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const shipped = new Set();
const walk = (id) => {
  if (shipped.has(id)) return;
  shipped.add(id);
  for (const d of nodes.get(id).deps) {
    if (d.dep_kinds.some((k) => k.kind !== "dev")) walk(d.pkg);
  }
};
const roots = meta.workspace_default_members ?? meta.workspace_members.filter((id) => /[\/]crates[\/]/.test(id));
roots.forEach(walk);

const bad = meta.packages
  .filter((p) => shipped.has(p.id))
  .filter((p) => !p.license || !ok(p.license))
  .map((p) => `  ${p.name} ${p.version}: ${p.license ?? `no SPDX license (license_file: ${p.license_file})`}`);

if (bad.length) {
  console.error(`Not on the allow-list in deny.toml:\n${bad.join("\n")}`);
  process.exit(1);
}
console.log(`licenses ok: ${shipped.size} crates, all within ${[...allowed].join(", ")}`);
