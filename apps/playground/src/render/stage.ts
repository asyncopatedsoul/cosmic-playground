import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

/** The three.js scene, orbit camera and picking helpers. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  /** Drawing-buffer size in CSS pixels, for fat-line materials. */
  readonly resolution = new THREE.Vector2(1, 1);
  readonly reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private azimuth = 0;
  private elevation = 0.6;
  private distance = 9.5;
  private target = new THREE.Vector3(0, 0.5, 0);

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene.background = new THREE.Color(0x04050d);
    this.scene.fog = new THREE.Fog(0x04050d, 20, 70);

    this.scene.add(new THREE.HemisphereLight(0x8ea2ff, 0x140a1c, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(4, 9, 6);
    this.scene.add(key);
    this.addStars();
    this.addGround();

    // Bloom is the first thing to drop on phones: audio comes first.
    if (!matchMedia("(pointer: coarse)").matches) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.5, 0.2);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }

    this.resize();
    addEventListener("resize", () => this.resize());
  }

  private addStars() {
    const n = 1800;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = 45 + Math.random() * 40;
      const s = Math.sqrt(1 - u * u);
      pos.set([r * s * Math.cos(a), Math.abs(r * u) * 0.9 - 6, r * s * Math.sin(a)], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xaab4ff, size: 0.18, sizeAttenuation: true, fog: false });
    this.scene.add(new THREE.Points(geo, mat));
  }

  private addGround() {
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(16, 96),
      new THREE.MeshStandardMaterial({ color: 0x080a1a, roughness: 0.95, metalness: 0.0 }),
    );
    disc.rotation.x = -Math.PI / 2;
    this.scene.add(disc);
    const grid = new THREE.PolarGridHelper(15, 12, 8, 96, 0x2a2f66, 0x161a3d);
    grid.position.y = 0.005;
    const m = grid.material as THREE.Material;
    m.transparent = true;
    m.opacity = 0.5;
    this.scene.add(grid);
  }

  resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    this.bloom?.resolution.set(w / 2, h / 2);
    this.resolution.set(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.placeCamera();
  }

  orbit(dAzimuth: number, dElevation: number) {
    this.azimuth += dAzimuth;
    this.elevation = THREE.MathUtils.clamp(this.elevation + dElevation, 0.15, 1.35);
    this.placeCamera();
  }

  zoom(factor: number) {
    this.distance = THREE.MathUtils.clamp(this.distance * factor, 5, 26);
    this.placeCamera();
  }

  private placeCamera() {
    // Portrait screens need to stand further back to fit the same world.
    const d = this.distance / Math.min(1, this.camera.aspect) ** 0.75;
    const c = this.camera;
    c.position.set(
      this.target.x + d * Math.cos(this.elevation) * Math.sin(this.azimuth),
      this.target.y + d * Math.sin(this.elevation),
      this.target.z + d * Math.cos(this.elevation) * Math.cos(this.azimuth),
    );
    c.lookAt(this.target);
  }

  private setRay(x: number, y: number) {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  ray(x: number, y: number): THREE.Ray {
    this.setRay(x, y);
    return this.raycaster.ray.clone();
  }

  pick(x: number, y: number, objects: THREE.Object3D[]): THREE.Intersection | null {
    this.setRay(x, y);
    return this.raycaster.intersectObjects(objects, false)[0] ?? null;
  }

  /** Where a screen point lands on a horizontal plane at height `y`. */
  planePoint(x: number, y: number, height = 0): THREE.Vector3 | null {
    this.setRay(x, y);
    this.ground.constant = -height;
    return this.raycaster.ray.intersectPlane(this.ground, new THREE.Vector3());
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
