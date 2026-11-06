/**
 * Physically based looks of parts and the rendered view: a studio light (a room environment
 * generated in code, so no picture files), a sun that casts soft shadows onto a ground under the
 * model, tone mapping, a backdrop, and sphere swatches of materials for pickers.
 *
 * Kept cheap for tablets: the environment is made once, the shadow is only redrawn when the model
 * moves or changes, and light passing through (transmission) is only drawn in the rendered view.
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/** The finish of a part (all 0…1), as materials give it. */
export interface BodyLook {
  roughness: number;
  metalness: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  sheen?: number;
  transmission?: number;
}

/** Parts without a material: a soft plastic sheen, as meerCAD has always drawn them. */
export const PLAIN_LOOK: BodyLook = { roughness: 0.55, metalness: 0.08 };
/** Scans and pictures already hold their light: no shine on top. */
export const TEXTURED_LOOK: BodyLook = { roughness: 1, metalness: 0 };

/** The environment is Y-up; the model is Z-up. */
const ENV_ROTATION = new THREE.Euler(Math.PI / 2, 0, 0);

const envCache = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();
/** The studio light as a prefiltered environment map, made once per renderer. */
export function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  let tex = envCache.get(renderer);
  if (!tex) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    tex = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    envCache.set(renderer, tex);
  }
  return tex;
}

/**
 * Puts a look on a part's material. `env`: reflections of the studio (metals need them to look
 * like metal); `rendered`: the full look, with light passing through see-through materials.
 */
export function applyLook(mat: THREE.MeshPhysicalMaterial, look: BodyLook, env: THREE.Texture | null, rendered: boolean): void {
  const before = programKey(mat);
  mat.roughness = look.roughness;
  mat.metalness = look.metalness;
  mat.clearcoat = look.clearcoat ?? 0;
  mat.clearcoatRoughness = look.clearcoatRoughness ?? 0;
  mat.sheen = look.sheen ?? 0;
  mat.sheenRoughness = 0.6;
  mat.sheenColor.setRGB(1, 1, 1);
  mat.transmission = rendered ? (look.transmission ?? 0) : 0;
  mat.thickness = mat.transmission ? 2 : 0;
  mat.ior = 1.5;
  mat.envMap = env;
  mat.envMapRotation.copy(ENV_ROTATION);
  // In the working view the lamps light the model; reflections only add what makes metal metal.
  mat.envMapIntensity = rendered ? 1 : 0.25 + 0.75 * look.metalness;
  if (programKey(mat) !== before) mat.needsUpdate = true;
}

/** What makes three.js compile another shader for a material. */
const programKey = (m: THREE.MeshPhysicalMaterial) => `${!!m.envMap}|${m.clearcoat > 0}|${m.sheen > 0}|${m.transmission > 0}`;

/** A vertical gradient as the backdrop of the rendered view. */
function backdrop(dark: boolean): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  if (dark) {
    grad.addColorStop(0, "#3a404b");
    grad.addColorStop(1, "#16191e");
  } else {
    grad.addColorStop(0, "#fbfcfd");
    grad.addColorStop(1, "#d5dbe3");
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The rendered view's stage: environment light, a sun with soft shadows, a ground that only shows
 * the shadow, tone mapping and a backdrop. `enable` and `disable` switch it; `fit` places sun and
 * ground under the model (after it changed or moved).
 */
export class RenderedStage {
  readonly sun = new THREE.DirectionalLight(0xffffff, 1.6);
  private ground: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
  private backdrops = new Map<boolean, THREE.CanvasTexture>();
  private saved: { background: THREE.Scene["background"]; environment: THREE.Texture | null; toneMapping: THREE.ToneMapping; lights: number[] } | null = null;
  active = false;
  dark = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
    /** The working view's lamps, dimmed while the studio light is on. */
    private readonly lamps: THREE.Light[],
  ) {
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.radius = 10;
    this.sun.shadow.blurSamples = 16;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ color: 0x0d1424, opacity: 0.32, depthWrite: false }));
    this.ground.receiveShadow = true;
    this.ground.renderOrder = -2;
    this.ground.userData["stage"] = true;
    this.sun.userData["stage"] = true;
  }

  enable(): void {
    if (this.active) return;
    this.active = true;
    this.saved = { background: this.scene.background, environment: this.scene.environment, toneMapping: this.renderer.toneMapping, lights: this.lamps.map((l) => l.intensity) };
    this.scene.environment = studioEnvironment(this.renderer);
    this.scene.environmentRotation.copy(ENV_ROTATION);
    this.scene.background = this.backdropFor(this.dark);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    // The studio and the sun light the model now; the lamps that follow the camera only fill in.
    this.lamps.forEach((l) => (l.intensity *= l instanceof THREE.HemisphereLight ? 0 : 0.25));
    this.scene.add(this.sun, this.sun.target, this.ground);
  }

  disable(): void {
    if (!this.active || !this.saved) return;
    this.active = false;
    this.scene.background = this.saved.background;
    this.scene.environment = this.saved.environment;
    this.renderer.toneMapping = this.saved.toneMapping;
    this.renderer.shadowMap.enabled = false;
    this.lamps.forEach((l, i) => (l.intensity = this.saved!.lights[i]!));
    this.scene.remove(this.sun, this.sun.target, this.ground);
    this.saved = null;
  }

  setDark(dark: boolean): void {
    this.dark = dark;
    if (this.active) this.scene.background = this.backdropFor(dark);
  }

  /** Shows the backdrop or leaves the background clear (transparent pictures). */
  setBackdrop(on: boolean): void {
    if (this.active) this.scene.background = on ? this.backdropFor(this.dark) : null;
  }

  private backdropFor(dark: boolean): THREE.CanvasTexture {
    let t = this.backdrops.get(dark);
    if (!t) this.backdrops.set(dark, (t = backdrop(dark)));
    return t;
  }

  /** Sun and ground for a model in `box` (world space); redraws the shadow. */
  fit(box: THREE.Box3): void {
    if (box.isEmpty()) box = new THREE.Box3(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 50));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 1);
    // From above, a little from the front left: the shadow falls behind, as in a photo studio.
    const dir = new THREE.Vector3(-0.35, -0.5, 1).normalize();
    this.sun.position.copy(sphere.center).addScaledVector(dir, r * 4);
    this.sun.target.position.copy(sphere.center);
    this.sun.target.updateMatrixWorld();
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -r * 2.2;
    cam.right = cam.top = r * 2.2;
    cam.near = r * 0.5;
    cam.far = r * 8;
    cam.updateProjectionMatrix();
    // Softness grows with the model, so a small part and a big one look alike.
    this.sun.shadow.radius = 10;
    this.ground.position.set(sphere.center.x, sphere.center.y, box.min.z - r * 0.002);
    this.ground.scale.set(r * 30, r * 30, 1);
    this.ground.updateMatrixWorld();
    this.renderer.shadowMap.needsUpdate = true;
  }

  /** A sharper shadow for pictures: a bigger map for one render, then back. */
  withShadowSize<T>(size: number, fn: () => T): T {
    const before = this.sun.shadow.mapSize.x;
    const resize = (s: number) => {
      this.sun.shadow.mapSize.set(s, s);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      this.renderer.shadowMap.needsUpdate = true;
    };
    if (size === before) return fn();
    resize(size);
    try {
      return fn();
    } finally {
      resize(before);
    }
  }

  dispose(): void {
    this.disable();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    for (const t of this.backdrops.values()) t.dispose();
    this.sun.shadow.map?.dispose();
  }
}

/** A material swatch to picture: its finish and colour. */
export interface SwatchSpec {
  look: BodyLook;
  /** "#rrggbb" */
  color: string;
}

/**
 * Sphere swatches (PNG data URLs, `size` px square, transparent around) drawn with the given
 * renderer in a small studio of their own. The renderer's size is put back afterwards.
 */
export function drawSwatches(renderer: THREE.WebGLRenderer, specs: readonly SwatchSpec[], size: number): string[] {
  if (!specs.length) return [];
  const scene = new THREE.Scene();
  scene.environment = studioEnvironment(renderer);
  scene.environmentRotation.copy(ENV_ROTATION);
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(-1, -1.2, 2);
  scene.add(key);
  const geo = new THREE.SphereGeometry(1, 64, 40);
  const mat = new THREE.MeshPhysicalMaterial();
  const ball = new THREE.Mesh(geo, mat);
  scene.add(ball);
  // A darker ground colour behind see-through materials, so they read as clear, not white.
  const backing = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshBasicMaterial({ color: 0x5b6573 }));
  backing.position.set(0, 3, 0);
  backing.rotation.x = Math.PI / 2;
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  cam.up.set(0, 0, 1);
  cam.position.set(0, -4.2, 1.4);
  cam.lookAt(0, 0, 0);
  const prev = { size: renderer.getSize(new THREE.Vector2()), ratio: renderer.getPixelRatio(), tone: renderer.toneMapping, shadows: renderer.shadowMap.enabled, clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha() };
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = false;
  renderer.setClearColor(0x000000, 0);
  const out: string[] = [];
  try {
    for (const s of specs) {
      applyLook(mat, s.look, scene.environment, true);
      mat.color.set(s.color);
      if ((s.look.transmission ?? 0) > 0) scene.add(backing);
      else scene.remove(backing);
      renderer.render(scene, cam);
      out.push(renderer.domElement.toDataURL("image/png"));
    }
  } finally {
    renderer.setPixelRatio(prev.ratio);
    renderer.setSize(prev.size.x, prev.size.y, false);
    renderer.toneMapping = prev.tone;
    renderer.shadowMap.enabled = prev.shadows;
    renderer.setClearColor(prev.clear, prev.alpha);
    geo.dispose();
    mat.dispose();
    (backing.material as THREE.Material).dispose();
    backing.geometry.dispose();
  }
  return out;
}
