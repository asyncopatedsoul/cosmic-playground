import * as THREE from "three";

/**
 * Gravity bodies (docs/AVATAR.md §4). "Up" is the gradient of each body's
 * signed distance field. V1 only has the ground plane; planetoids and prisms
 * (V2) plug into the same interface.
 */
export interface GravityBody {
  id: string;
  kind: "plane" | "planetoid" | "prism";
  pos: THREE.Vector3;
  /** plane: walkable `radius`; planetoid: `radius`; prism: half-extents + corner radius. */
  shape: Record<string, number>;
  /** How far from the surface the body captures a walker. */
  reach: number;
  color: string;
  /** Hum tied to size. Built but inactive (AVATAR.md §13.4): see BODY_SOUND. */
  sound?: BodySound;
  /** Signed distance from the surface (negative inside). */
  sdf(p: THREE.Vector3): number;
  /** Unit "up" at `p` (the SDF's gradient). */
  up(p: THREE.Vector3, out?: THREE.Vector3): THREE.Vector3;
  /** Nearest ray hit on the walkable surface, or null. */
  raycast(ray: THREE.Ray): { point: THREE.Vector3; normal: THREE.Vector3; distance: number } | null;
  /** Whether the point (projected onto the surface) is on walkable ground. */
  covers(p: THREE.Vector3): boolean;
}

/**
 * A body's hum, using the same pieces as a toy Voice: a frequency from size
 * (bigger is lower) and a level. Off until bodies become player-accessible.
 */
export interface BodySound {
  enabled: boolean;
  freq: number;
  gain: number;
}

/** Gravity bodies stay silent and the hum is not exposed to players yet. */
export const BODY_SOUND = false;

/** The hum a body of this size would make: an octave lower per doubling of size. */
export function bodyHum(size: number): BodySound {
  const freq = THREE.MathUtils.clamp(110 * (2 / Math.max(0.25, size)), 27.5, 440);
  return { enabled: BODY_SOUND, freq, gain: 0.08 };
}

const Y = new THREE.Vector3(0, 1, 0);

/** The ground: a horizontal disc at y = 0. */
export function planeBody(radius = 16): GravityBody {
  const plane = new THREE.Plane(Y.clone(), 0);
  return {
    id: "ground",
    kind: "plane",
    pos: new THREE.Vector3(),
    shape: { radius },
    reach: Infinity,
    color: "#2a2f66",
    sound: bodyHum(radius),
    sdf: (p) => p.y,
    up: (_p, out = new THREE.Vector3()) => out.copy(Y),
    raycast(ray) {
      const point = ray.intersectPlane(plane, new THREE.Vector3());
      if (!point || Math.hypot(point.x, point.z) > radius) return null;
      return { point, normal: Y.clone(), distance: ray.origin.distanceTo(point) };
    },
    covers: (p) => Math.hypot(p.x, p.z) <= radius,
  };
}
