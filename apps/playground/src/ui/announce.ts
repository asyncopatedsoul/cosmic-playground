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

let toasts: HTMLElement | null = null;

/** A short visible note at the top of the screen ("Player 2 joined"), also announced. */
export function toast(text: string, color?: string) {
  if (!toasts) {
    toasts = document.createElement("div");
    toasts.className = "toasts";
    toasts.setAttribute("aria-hidden", "true");
    document.body.append(toasts);
  }
  const el = document.createElement("div");
  el.className = "toast";
  if (color) el.style.setProperty("--seat", color);
  el.textContent = text;
  toasts.append(el);
  setTimeout(() => el.classList.add("gone"), 2400);
  setTimeout(() => el.remove(), 3000);
  announce(text);
}
