/**
 * Values drawn into the picture itself: text (on a chip or plain with a halo) on a quad in the scene,
 * either lying in a plane (a dimension's value on its line) or facing the screen at a point (a drag
 * arrow's value). Text on the page over the canvas reaches the screen on its own path and can show a
 * frame before or after the picture while the view turns; drawn with the picture it never trails.
 */
import * as THREE from "three";
import { biasTowardCamera, hiddenCopy } from "./depthBias.js";

export type V3 = readonly [number, number, number];
/** A box's corners: top left, top right, bottom right, bottom left. */
export type Quad = readonly [V3, V3, V3, V3];

export interface TextLook {
  text: string;
  /** A CSS font ("600 12.5px monospace"). */
  font: string;
  color: string;
  /** A glow round the letters, so they read over lines and the grid. */
  halo?: string;
  /** A chip behind the text. */
  chip?: { fill: string; border: string; radius: number; dashed?: boolean };
}

export interface SceneTextSpec {
  look: TextLook;
  /** The box the look is drawn into, in CSS pixels. */
  size: readonly [number, number];
  /** Lying in a plane: the box's corners in the world. */
  corners?: Quad;
  /** Facing the screen: centred `offset` CSS pixels (right, down) from `at`. */
  at?: V3;
  offset?: readonly [number, number];
  /**
   * Hidden by parts in front of it like the part it lies on, and drawn only faintly there; otherwise
   * over everything.
   */
  hides?: boolean;
}

/** Room round the box for the halo and the chip's border (CSS pixels each side). */
export const MARGIN_PX = 4;

/**
 * Texture pixels per screen pixel. A value is laid as big on the screen as on the page (a slanted
 * plane gets a larger box), so one texel a pixel is sharpest; more would be blurred down by mip maps.
 */
const OVERSAMPLE = 1;
const MAX_SCALE = 4;
/** Drawn over everything else, as the values on the page were (dimension lines 30, arrows up to 61). */
const RENDER_ORDER = 1000;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

/** The corners grown by `margin` CSS pixels each side, the box being `size` CSS pixels. */
export function grownQuad(corners: Quad, size: readonly [number, number], margin: number): Quad {
  const [tl, tr, , bl] = corners;
  const right = sub(tr, tl).map((v) => v / size[0]) as unknown as V3;
  const down = sub(bl, tl).map((v) => v / size[1]) as unknown as V3;
  const x0 = add(add(tl, right, -margin), down, -margin);
  const w = size[0] + 2 * margin;
  const h = size[1] + 2 * margin;

  return [x0, add(x0, right, w), add(add(x0, right, w), down, h), add(x0, down, h)];
}

/**
 * The corners of a box `size` CSS pixels facing the screen, centred `offset` pixels from `at`: `right`
 * and `up` are the camera's unit axes, `pixel` world units per screen pixel at `at`'s depth.
 */
export function screenQuad(
  at: V3,
  offset: readonly [number, number],
  size: readonly [number, number],
  right: V3,
  up: V3,
  pixel: number,
): Quad {
  const centre = add(add(at, right, offset[0] * pixel), up, -offset[1] * pixel);
  const [w, h] = [(size[0] / 2) * pixel, (size[1] / 2) * pixel];
  const top = add(centre, up, h);
  const bottom = add(centre, up, -h);

  return [add(top, right, -w), add(top, right, w), add(bottom, right, w), add(bottom, right, -w)];
}

/** A look as a key: the texture is drawn again only when it changes. */
const keyOf = (look: TextLook, size: readonly [number, number], scale: number) =>
  JSON.stringify([look, size, scale]);

/** Draws a look into a canvas `scale` texture pixels per CSS pixel, with `MARGIN_PX` round it. */
export function drawLook(
  canvas: HTMLCanvasElement,
  look: TextLook,
  size: readonly [number, number],
  scale: number,
): void {
  const [w, h] = [size[0] + 2 * MARGIN_PX, size[1] + 2 * MARGIN_PX];
  canvas.width = Math.max(1, Math.ceil(w * scale));
  canvas.height = Math.max(1, Math.ceil(h * scale));

  const g = canvas.getContext("2d");
  if (!g) return;

  g.setTransform(scale, 0, 0, scale, 0, 0);
  g.clearRect(0, 0, w, h);

  if (look.chip) {
    const { fill, border, radius, dashed } = look.chip;
    g.beginPath();
    g.roundRect(MARGIN_PX + 0.5, MARGIN_PX + 0.5, size[0] - 1, size[1] - 1, Math.min(radius, size[1] / 2));
    g.fillStyle = fill;
    g.fill();
    g.setLineDash(dashed ? [3, 2] : []);
    g.lineWidth = 1;
    g.strokeStyle = border;
    g.stroke();
    g.setLineDash([]);
  }

  g.font = look.font;
  g.textAlign = "center";
  g.textBaseline = "middle";

  const [x, y] = [w / 2, h / 2 + 0.5];

  if (look.halo) {
    g.lineJoin = "round";
    g.strokeStyle = look.halo;
    g.shadowColor = look.halo;
    g.shadowBlur = 3 * scale;
    g.lineWidth = 3;
    g.strokeText(look.text, x, y);
    g.shadowBlur = 0;
  }

  g.fillStyle = look.color;
  g.fillText(look.text, x, y);
}

interface Entry {
  spec: SceneTextSpec;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  key: string;
}

/** The values drawn in the scene, by id. */
export class SceneTexts {
  readonly group = new THREE.Group();
  private entries = new Map<string, Entry>();

  constructor(
    private pixelRatio: () => number,
    private anisotropy: () => number,
  ) {
    this.group.name = "scene-texts";
    // Web fonts may arrive after a value is first drawn: draw again with them.
    document.fonts?.addEventListener?.("loadingdone", () => this.redraw());
  }

  /** Shows a value (or updates it), or removes it with null. */
  set(id: string, spec: SceneTextSpec | null): void {
    const entry = this.entries.get(id);

    if (!spec) {
      if (entry) this.remove(id, entry);

      return;
    }

    const e = entry ?? this.add(id, spec);
    e.spec = spec;
    this.paint(e);
    if (spec.corners) this.lay(e, grownQuad(spec.corners, spec.size, MARGIN_PX));
  }

  /** The ids shown. */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Turns the values facing the screen to the camera; call before each picture. */
  update(camera: THREE.Camera, viewHeight: number): void {
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const forward = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2).normalize().negate();
    const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);

    for (const e of this.entries.values()) {
      const { at, offset, size } = e.spec;
      if (!at || e.spec.corners) continue;

      const pixel = pixelAt(camera, viewHeight, new THREE.Vector3(...at).sub(eye).dot(forward));
      e.mesh.visible = pixel > 0;
      if (pixel <= 0) continue;

      const grown: [number, number] = [size[0] + 2 * MARGIN_PX, size[1] + 2 * MARGIN_PX];
      this.lay(e, screenQuad(at, offset ?? [0, 0], grown, right.toArray(), up.toArray(), pixel));
    }
  }

  dispose(): void {
    for (const [id, e] of this.entries) this.remove(id, e);
  }

  private add(id: string, spec: SceneTextSpec): Entry {
    const canvas = document.createElement("canvas");
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.anisotropy();
    texture.minFilter = THREE.LinearMipmapLinearFilter;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 2));
    geometry.setIndex([0, 3, 1, 1, 3, 2]);

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = RENDER_ORDER;
    mesh.frustumCulled = false;
    mesh.name = id;
    this.group.add(mesh);

    if (spec.hides) {
      // A faint copy over everything where it is hidden, the text itself depth tested.
      const ghost = new THREE.Mesh(geometry, hiddenCopy(material));
      ghost.renderOrder = RENDER_ORDER - 1;
      ghost.frustumCulled = false;
      mesh.add(ghost);
      biasTowardCamera(material);
    }

    const entry: Entry = { spec, mesh, canvas, texture, key: "" };
    this.entries.set(id, entry);

    return entry;
  }

  private paint(e: Entry): void {
    const scale = Math.min(MAX_SCALE, Math.max(1, this.pixelRatio()) * OVERSAMPLE);
    const key = keyOf(e.spec.look, e.spec.size, scale);
    if (key === e.key) return;

    e.key = key;

    const [w, h] = [e.canvas.width, e.canvas.height];
    drawLook(e.canvas, e.spec.look, e.spec.size, scale);

    // A canvas of another size needs a new texture on the GPU.
    if (w !== e.canvas.width || h !== e.canvas.height) {
      e.texture.dispose();

      const texture = new THREE.CanvasTexture(e.canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = this.anisotropy();
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      e.texture = texture;

      for (const m of [e.mesh, ...e.mesh.children] as THREE.Mesh<
        THREE.BufferGeometry,
        THREE.MeshBasicMaterial
      >[]) {
        m.material.map = texture;
        m.material.needsUpdate = true;
      }
    } else {
      e.texture.needsUpdate = true;
    }
  }

  private lay(e: Entry, quad: Quad): void {
    const position = e.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    quad.forEach((p, i) => position.setXYZ(i, p[0], p[1], p[2]));
    position.needsUpdate = true;
    e.mesh.visible = true;
  }

  private redraw(): void {
    for (const e of this.entries.values()) {
      e.key = "";
      this.paint(e);
    }
  }

  private remove(id: string, e: Entry): void {
    e.mesh.removeFromParent();
    e.mesh.geometry.dispose();
    e.mesh.material.dispose();

    for (const ghost of e.mesh.children as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[]) {
      ghost.material.dispose();
    }

    e.texture.dispose();
    this.entries.delete(id);
  }
}

/** World units per screen pixel at `depth` in front of the camera (0 behind it). */
export function pixelAt(camera: THREE.Camera, viewHeight: number, depth: number): number {
  if (camera instanceof THREE.OrthographicCamera) {
    return (camera.top - camera.bottom) / camera.zoom / Math.max(viewHeight, 1);
  }

  if (camera instanceof THREE.PerspectiveCamera) {
    if (depth <= 0) return 0;

    return (2 * depth * Math.tan((camera.fov * Math.PI) / 360)) / camera.zoom / Math.max(viewHeight, 1);
  }

  return 0;
}
