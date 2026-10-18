import * as THREE from "three";

/** Smallest ring radius for two or more toys (FOCUS-VIEW.md §4.1). */
export const R_MIN = 2.2;
/** Gap between neighbours on the ring, as a multiple of the largest footprint. */
const SPACING = 1.6;
/** On a portrait phone the ring's depth is squashed so it fits. */
const PORTRAIT_DEPTH = 0.7;

/**
 * How many toys fit on the ring: 8 on phones and touch screens, 12 on desktop
 * (a fine pointer and a window at least 1024 px wide; FOCUS-VIEW.md §15.1).
 */
export function ringMax(): number {
  const desktop = matchMedia("(pointer: fine)").matches && innerWidth >= 1024;
  return desktop ? 12 : 8;
}

export function ringRadius(n: number, footprint: number): number {
  return n <= 1 ? 0 : Math.max(R_MIN, (n * SPACING * footprint) / (Math.PI * 2));
}

/**
 * Positions on the ring around `centre`. Toy `i` sits `turn + 2πi/n` around,
 * measured from the camera's side, so the toy at angle 0 faces the camera
 * that looks from `azimuth`.
 */
export function ringLayout(n: number, centre: THREE.Vector3, radius: number, azimuth: number, turn: number, portrait: boolean): THREE.Vector3[] {
  const depth = portrait ? PORTRAIT_DEPTH : 1;
  // Camera-relative axes on the ground: `toward` points at the camera, `side` to its right.
  const toward = new THREE.Vector3(Math.sin(azimuth), 0, Math.cos(azimuth));
  const side = new THREE.Vector3(Math.cos(azimuth), 0, -Math.sin(azimuth));
  return Array.from({ length: n }, (_, i) => {
    const a = turn + (Math.PI * 2 * i) / n;
    return centre
      .clone()
      .addScaledVector(side, radius * Math.sin(a))
      .addScaledVector(toward, radius * depth * Math.cos(a))
      .setY(0);
  });
}

/**
 * Camera distance that frames a flat ring of `radius` (toys `height` tall) seen
 * from `elevation`: about 70% of the screen's width, and of `vFrac` of its height.
 */
export function frameDistance(radius: number, height: number, fovDeg: number, aspect: number, elevation: number, vFrac = 0.7): number {
  // A hidden or zero-size window has no aspect yet; frame as if square.
  if (!(aspect > 0) || !Number.isFinite(aspect)) aspect = 1;
  const tanV = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  const tanH = tanV * aspect;
  const wide = radius / (tanH * 0.7);
  // Seen from above at `elevation`, the ring is an ellipse `radius·sin(elevation)` tall, plus the toys.
  const tall = (radius * Math.sin(elevation) + height * Math.cos(elevation)) / (tanV * vFrac);
  return Math.max(wide, tall);
}
