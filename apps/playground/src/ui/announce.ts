let region: HTMLElement | null = null;

/** Say something politely to screen readers ("Spire muted"); nothing is shown. */
export function announce(text: string) {
  if (!region) {
    region = document.createElement("div");
    region.className = "sr-only";
    region.setAttribute("aria-live", "polite");
    region.setAttribute("role", "status");
    document.body.append(region);
  }
  const el = region;
  // Clear first so repeating the same words is announced again.
  el.textContent = "";
  requestAnimationFrame(() => (el.textContent = text));
}
