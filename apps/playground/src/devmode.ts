/**
 * Which developer mode this page runs in (docs/DEV-MODE.md §3.1):
 *
 *   off       production build, no flag: nothing from src/dev is loaded
 *   dev       the dev server or `npm run desktop`, or `?dev` on any build
 *   test      `?test` (CI, Playwright): dev plus always muted, no panel unless `&panel`
 *   feedback  `?feedback` on a production build: logs run, no panel (notes arrive in D2)
 */
export type DevMode = "off" | "dev" | "test" | "feedback";

export function devMode(search = location.search): DevMode {
  const q = new URLSearchParams(search);
  if (q.has("test")) return "test";
  if (q.has("dev") || import.meta.env.DEV) return "dev";
  if (q.has("feedback")) return "feedback";
  return "off";
}
