import * as THREE from "three";

/**
 * The placement ghost (docs/AVATAR.md §6): a translucent stand-in for the
 * hotbar toy where right-click would put it; red (and hatched by its ring
 * turning dashed) when it can't go there.
 */
export class PlacementGhost {
  readonly group = new THREE.Group();
  private mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.28, depthWrite: false });
  private ringMat = new THREE.LineDashedMaterial({ transparent: true, opacity: 0.9, dashSize: 1, gapSize: 0 });
  private ring: THREE.LineLoop;

  constructor(scene: THREE.Scene) {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.64, 0.12, 40), this.mat);
    base.position.y = 0.06;
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 1.1, 16), this.mat);
    column.position.y = 0.67;
    const pts = Array.from({ length: 64 }, (_, i) => {
      const a = (i / 64) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * 0.64, 0.02, Math.sin(a) * 0.64);
    });
    this.ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), this.ringMat);
    this.ring.computeLineDistances();
    this.group.add(base, column, this.ring);
    this.group.visible = false;
    scene.add(this.group);
  }

  show(at: THREE.Vector3, normal: THREE.Vector3, color: string, ok: boolean) {
    this.group.visible = true;
    this.group.position.copy(at);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    const c = ok ? color : "#ff6b6b";
    this.mat.color.set(c);
    this.ringMat.color.set(c);
    this.ringMat.dashSize = ok ? 1 : 0.1;
    this.ringMat.gapSize = ok ? 0 : 0.07;
  }

  hide() {
    this.group.visible = false;
  }
}
