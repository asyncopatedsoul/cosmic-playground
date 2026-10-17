import * as THREE from "three";

/** Height of a size-1 (child-sized) avatar, in metres. */
export const HEIGHT = 1.2;
export const EYE = 1.1;

/**
 * The avatar's look (docs/AVATAR.md §3): a small glowing capsule with a visor
 * and a "hand" light that is the aim ray's origin. Faces -Z. Used for your own
 * avatar in third person and for other players in a room.
 */
export class AvatarFigure {
  readonly group = new THREE.Group();
  private bodyMat: THREE.MeshStandardMaterial;
  private handMat: THREE.MeshBasicMaterial;
  private hand: THREE.Mesh;

  constructor(color: string) {
    this.bodyMat = new THREE.MeshStandardMaterial({ color: 0x15132b, emissive: color, emissiveIntensity: 0.5, roughness: 0.4, metalness: 0.15 });
    const r = 0.22;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(r, HEIGHT - 2 * r, 6, 18), this.bodyMat);
    body.position.y = HEIGHT / 2;
    const visor = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 20, 10, 0, Math.PI * 2, Math.PI * 0.32, Math.PI * 0.3),
      new THREE.MeshStandardMaterial({ color: 0x0a0c18, emissive: 0x9fd8ff, emissiveIntensity: 0.9, roughness: 0.2 }),
    );
    visor.scale.set(1.2, 1, 1);
    visor.rotation.x = Math.PI / 2;
    visor.position.set(0, EYE - 0.02, -0.12);
    this.handMat = new THREE.MeshBasicMaterial({ color });
    this.hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), this.handMat);
    this.hand.position.set(0.27, 0.62, -0.16);
    this.group.add(body, visor, this.hand);
    this.setColor(color);
  }

  setColor(color: string) {
    this.bodyMat.color.set(color).multiplyScalar(0.25);
    this.bodyMat.emissive.set(color);
    this.handMat.color.set(color);
  }

  /** The hand light in world space. */
  handPosition(out = new THREE.Vector3()) {
    this.group.updateMatrixWorld();
    return this.hand.getWorldPosition(out);
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
