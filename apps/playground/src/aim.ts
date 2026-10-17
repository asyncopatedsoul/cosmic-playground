import * as THREE from "three";
import type { GravityBody } from "./avatar/gravity";
import type { Stage } from "./render/stage";
import type { Toy } from "./toys/toy";
import type { World } from "./world";

/** What a ray is pointing at (docs/AVATAR.md §5). */
export interface AimHit {
  kind: "part" | "surface" | "none";
  toy?: Toy;
  part?: string;
  /** The picked mesh and its raw intersection, for toy handlers. */
  object?: THREE.Object3D;
  intersection: THREE.Intersection | null;
  body?: GravityBody;
  point?: THREE.Vector3;
  normal?: THREE.Vector3;
  /** Distance from the reach origin (the avatar's eye, or the camera in Orbit). */
  distance: number;
  inReach: boolean;
  ray: THREE.Ray;
}

/** Parts win ties against surfaces within this distance, so a toy on a surface is always targetable. */
const TIE = 0.05;

/**
 * One ray for every creator action. Input asks Aim instead of picking itself:
 * from the pointer in Orbit, from the crosshair in avatar mode.
 */
export class Aim {
  /** Max distance for actions; out-of-reach hits are still reported for the preview. */
  reach = Infinity;
  /** Where reach is measured from; null = the ray's origin. */
  reachOrigin: THREE.Vector3 | null = null;
  /** Toys to look through (e.g. the one being carried). */
  ignore: Toy | null = null;
  /** Updated each frame for the preview and the placement ghost. */
  current: AimHit;

  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  constructor(
    private stage: Stage,
    private world: World,
  ) {
    this.current = this.none(new THREE.Ray());
  }

  fromScreen(x: number, y: number): AimHit {
    const r = this.stage.canvas.getBoundingClientRect();
    this.ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.stage.camera);
    return this.fromRay(this.raycaster.ray);
  }

  /**
   * Aim from a screen point for a seat that isn't the pointer (a gamepad
   * cursor): no side effects on `current` or `ignore`, and no reach limit,
   * since gamepad seats always play in Orbit view.
   */
  probe(x: number, y: number, ignore: Toy | null = null): AimHit {
    return this.probing(ignore, () => this.fromScreen(x, y));
  }

  /** `probe`, but only walkable surfaces (sliding a toy along the ground). */
  probeSurface(x: number, y: number, ignore: Toy | null = null): AimHit {
    return this.probing(ignore, () => this.surfaceFromScreen(x, y));
  }

  private probing(ignore: Toy | null, f: () => AimHit): AimHit {
    const { ignore: prevIgnore, reach, reachOrigin } = this;
    this.ignore = ignore;
    this.reach = Infinity;
    this.reachOrigin = null;
    try {
      return f();
    } finally {
      this.ignore = prevIgnore;
      this.reach = reach;
      this.reachOrigin = reachOrigin;
    }
  }

  fromCrosshair(): AimHit {
    const r = this.stage.canvas.getBoundingClientRect();
    return this.fromScreen(r.left + r.width / 2, r.top + r.height / 2);
  }

  /** The nearest walkable surface only (dragging a toy along the ground). */
  surfaceFromScreen(x: number, y: number): AimHit {
    const hit = this.fromScreen(x, y);
    if (hit.kind !== "part") return hit;
    return this.surface(hit.ray) ?? this.none(hit.ray);
  }

  fromRay(ray: THREE.Ray): AimHit {
    const r = ray.clone();
    this.raycaster.ray.copy(r);
    const objects = this.world.pickables().filter((o) => o.userData.toy !== this.ignore);
    const part = this.raycaster.intersectObjects(objects, false)[0] ?? null;
    const surf = this.nearestSurface(r);
    if (part && (!surf || part.distance <= surf.t + TIE)) {
      const normal = part.face ? part.face.normal.clone().transformDirection(part.object.matrixWorld) : r.direction.clone().negate();
      return this.finish({
        kind: "part",
        toy: part.object.userData.toy,
        part: part.object.userData.part,
        object: part.object,
        intersection: part,
        point: part.point.clone(),
        normal,
        distance: 0,
        inReach: true,
        ray: r,
      });
    }
    return surf ? surf.hit : this.none(r);
  }

  private surface(ray: THREE.Ray): AimHit | null {
    return this.nearestSurface(ray)?.hit ?? null;
  }

  /** The nearest body surface along the ray, with its distance along the ray (`t`). */
  private nearestSurface(ray: THREE.Ray): { hit: AimHit; t: number } | null {
    let best: { body: GravityBody; point: THREE.Vector3; normal: THREE.Vector3; distance: number } | null = null;
    for (const body of this.world.bodies) {
      const h = body.raycast(ray);
      if (h && (!best || h.distance < best.distance)) best = { body, ...h };
    }
    if (!best) return null;
    const { body, point, normal, distance } = best;
    return { t: distance, hit: this.finish({ kind: "surface", body, point, normal, distance, inReach: true, intersection: null, ray }) };
  }

  private finish(hit: AimHit): AimHit {
    hit.distance = hit.point!.distanceTo(this.reachOrigin ?? hit.ray.origin);
    hit.inReach = hit.distance <= this.reach;
    return hit;
  }

  /** Aiming at nothing (no cursor over the canvas). */
  nothing(): AimHit {
    return this.none(new THREE.Ray());
  }

  private none(ray: THREE.Ray): AimHit {
    return { kind: "none", distance: Infinity, inReach: false, intersection: null, ray };
  }
}
