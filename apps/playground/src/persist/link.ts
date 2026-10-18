import { parseDoc, serialize, type ParseResult, type WorldDoc } from "./doc";

/** Worlds that compress under this go in a link (SAVE-LOAD.md §5). */
export const LINK_LIMIT = 6 * 1024;
const PREFIX = "#w=";

/**
 * A share link for a small world: `#w=` + base64url(deflate-raw(JSON)).
 * Thumbnails are left out; worlds with custom sound modules are too big by design.
 * Returns null when the world doesn't fit.
 */
export async function worldLink(doc: WorldDoc, base = location.href): Promise<string | null> {
  const { thumbnail: _t, ...rest } = doc;
  const packed = await deflate(new TextEncoder().encode(serialize(rest as WorldDoc)));
  if (packed.length > LINK_LIMIT) return null;
  const url = new URL(base);
  url.hash = PREFIX.slice(1) + toBase64Url(packed);
  return url.toString();
}

/** The world in the page's hash, if any. */
export async function readLink(hash = location.hash): Promise<ParseResult | null> {
  if (!hash.startsWith(PREFIX)) return null;
  try {
    const bytes = await inflate(fromBase64Url(hash.slice(PREFIX.length)));
    return parseDoc(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, error: "That world link is broken (part of it may be missing)." };
  }
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  // Cap what a link can expand to, so a crafted hash can't eat memory.
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > 2 * 1024 * 1024) throw new Error("too big");
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const s = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
