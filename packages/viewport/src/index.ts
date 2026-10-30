/**
 * Three.js viewport (Z up). Renders bodies, sketches, planes and reference meshes; picks with
 * filters; maps screen points onto sketch planes; drives standard views for the view cube.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface Frame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  normal: Vec3;
}

/** Structural copy of the kernel's BodyMesh so the viewport does not depend on the kernel. */
export interface ViewMesh {
  bodyId: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceRanges: Int32Array;
  edgeLines: Float32Array;
  edgeRanges: Int32Array;
  faceTags: string[][];
  edgeFaces: number[][];
}

export type SketchCurveView =
  | { id: string; kind: "line"; a: Vec2; b: Vec2; construction: boolean; external: boolean }
  | { id: string; kind: "circle"; center: Vec2; radius: number; construction: boolean; external: boolean }
  | { id: string; kind: "arc"; center: Vec2; radius: number; a0: number; a1: number; construction: boolean; external: boolean }
  | { id: string; kind: "spline"; pts: Vec2[]; construction: boolean; external: boolean };

export interface SketchView {
  id: string;
  frame: Frame;
  curves: SketchCurveView[];
  regions: { key: string; polygons: Vec2[][] }[];
}

export interface PlaneView {
  id: string;
  label: string;
  frame: Frame;
  size: number;
  /** Fill/border colour; defaults to a neutral blue. */
  color?: number;
}

export interface ReferenceMeshView {
  id: string;
  positions: Float32Array;
  indices: Uint32Array;
}

export type Pick =
  /** `normal` only for flat faces; `surface` is the direction out of the material at `point`, on any face. */
  | { kind: "face"; bodyId: string; face: number; tags: string[]; point: Vec3; normal: Vec3 | null; surface?: Vec3 }
  | { kind: "edge"; bodyId: string; edge: number; point: Vec3 }
  | { kind: "region"; sketchId: string; key: string; point: Vec3 }
  | { kind: "sketch_curve"; sketchId: string; curveId: string; point: Vec3 }
  | { kind: "plane"; planeId: string; point: Vec3 };

export type PickKind = Pick["kind"];

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

export interface SceneData {
  bodies: ViewMesh[];
  sketches: SketchView[];
  planes: PlaneView[];
  references: ReferenceMeshView[];
  hiddenBodies?: ReadonlySet<string>;
  /** Bodies drawn transparent (e.g. the result before a cut preview). */
  ghostBodies?: ReadonlySet<string>;
  /** Sketch being edited: drawn by the editor overlay instead. */
  editingSketch?: string | null;
}

/** Draggable arrow along an axis (push/pull, fillet radius, extrude distance). */
/** A joint drawn in the scene: a ring about a revolute joint's axis, a double arrow along a slider. */
export interface JointGlyph {
  id: string;
  type: "revolute" | "slider" | "fixed";
  origin: Vec3;
  axis: Vec3;
  /** The part the joint hangs on: the glyph moves with it. */
  parent?: string;
  active?: boolean;
}

export interface Handle {
  id: string;
  origin: Vec3;
  dir: Vec3;
  /** Current value; the arrow tip sits at origin + dir * value (plus a fixed screen offset). */
  value: number;
  onStart?: () => void;
  onDrag: (value: number) => void;
  onEnd: (value: number) => void;
  /** Smallest value allowed (e.g. 0 for radii). */
  min?: number;
  /** Arrow colour (hex); defaults to the accent blue. */
  color?: number;
  /** Draw a double arrow head (the value can go either way). Defaults to true when there is no `min`. */
  twoWay?: boolean;
}

export type DisplayMode = "shaded_edges" | "shaded" | "wireframe" | "xray" | "hidden_line";

export type StandardView = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso";

const C = {
  face: new THREE.Color(0xc4cfdc),
  faceHover: new THREE.Color(0xa9c8f5),
  faceSel: new THREE.Color(0x5b9bff),
  edge: new THREE.Color(0x26303d),
  edgeHover: new THREE.Color(0x2e7dff),
  edgeSel: new THREE.Color(0xff7a1a),
  sketch: 0x2266dd,
  sketchConstruction: 0x8aa4c8,
  sketchExternal: 0xb36bff,
  region: 0x5b9bff,
  plane: 0x7fa7e0,
};

interface BodyObj {
  mesh: ViewMesh;
  group: THREE.Group;
  faces: THREE.Mesh;
  edges: THREE.LineSegments;
  triFace: Int32Array;
  segEdge: Int32Array;
  /** What the colours were last painted for, so unchanged bodies are skipped. */
  painted?: string;
}

const VIEWS: Record<StandardView, { dir: Vec3; up: Vec3 }> = {
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] },
  left: { dir: [-1, 0, 0], up: [0, 0, 1] },
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, -1, 0] },
  iso: { dir: [0.6, -0.75, 0.55], up: [0, 0, 1] },
};

export interface ViewportEvents {
  onCameraChange?: () => void;
}

export interface NavBinding {
  button: "middle" | "right";
  mod?: "shift" | "ctrl" | "alt";
}
export interface Navigation {
  orbit: NavBinding[];
  pan: NavBinding[];
  zoom: NavBinding[];
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** Objects owned by tools (sketch editor, measure markers, manipulators). */
  readonly overlay = new THREE.Group();
  private persp = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 100000);
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.persp;
  readonly controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private bodiesGroup = new THREE.Group();
  private sketchGroup = new THREE.Group();
  private planeGroup = new THREE.Group();
  private refGroup = new THREE.Group();
  private bodies: BodyObj[] = [];
  private hover: Pick | null = null;
  private selected: Pick[] = [];
  private framed = false;
  private anim: { from: THREE.Vector3; to: THREE.Vector3; upFrom: THREE.Vector3; upTo: THREE.Vector3; target: THREE.Vector3; targetFrom: THREE.Vector3; t0: number; zoomTo?: number; zoomFrom?: number } | null = null;
  private resizeObserver: ResizeObserver;
  private disposed = false;
  private listeners = new Set<() => void>();
  private grid: THREE.Group;
  private displayMode: DisplayMode = "shaded_edges";
  private dark = false;
  private sceneData: SceneData | null = null;
  handles: Handle[] = [];
  private handleGroup = new THREE.Group();
  private jointGroup = new THREE.Group();
  private activeHandle: { h: Handle; value: number; pointer: number } | null = null;
  private hoverHandle: string | null = null;
  /** Reports the value being dragged and its screen position (for a value tooltip). */
  onHandleDrag: ((h: Handle | null, value: number, screen: Vec2 | null) => void) | null = null;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    this.bindPointerRoles();
    this.bindHandles();
    this.bindPartDrag();
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.touchAction = "none";

    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
    for (const cam of [this.persp, this.ortho]) cam.up.set(0, 0, 1);
    this.persp.position.set(120, -160, 110);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.2;
    this.controls.zoomToCursor = true;
    this.controls.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.addEventListener("change", () => this.emit());

    const hemi = new THREE.HemisphereLight(0xffffff, 0x7d8a99, 2.0);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(0.5, -1, 2);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-1, 0.5, -0.5);
    for (const cam of [this.persp, this.ortho]) {
      cam.add(key.clone(), fill.clone());
      this.scene.add(cam);
    }

    this.grid = new THREE.Group();
    this.grid.add(this.gridMesh);
    this.scene.add(this.grid, this.planeGroup, this.bodiesGroup, this.refGroup, this.sketchGroup, this.overlay, this.handleGroup, this.jointGroup);
    this.axes = axesHelper();
    this.scene.add(this.axes);

    // Mouse buttons are assigned per press from the navigation preset (see setNavigation).
    this.renderer.domElement.addEventListener("pointerdown", (e) => this.assignButtons(e), { capture: true });
    this.renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------------------------------------------------------------- navigation

  private axes!: THREE.Group;
  private navigation: Navigation = { orbit: [{ button: "right" }], pan: [{ button: "middle" }, { button: "right", mod: "shift" }], zoom: [] };

  /** Which mouse button (plus modifier) orbits, pans and zooms. Left always selects. */
  setNavigation(nav: Navigation, invertZoom = false): void {
    this.navigation = nav;
    this.controls.zoomSpeed = invertZoom ? -1 : 1;
  }

  private assignButtons(e: PointerEvent): void {
    const button = e.button === 1 ? "middle" : e.button === 2 ? "right" : null;
    if (!button) return;
    const mod: NavBinding["mod"] = e.shiftKey ? "shift" : e.ctrlKey || e.metaKey ? "ctrl" : e.altKey ? "alt" : undefined;
    const hit = (list: NavBinding[]) => list.some((b) => b.button === button && b.mod === mod);
    // OrbitControls swaps rotate and pan itself while ctrl/meta/shift is held; pre-swap to cancel that.
    const flipped = e.ctrlKey || e.metaKey || e.shiftKey;
    const action = hit(this.navigation.orbit)
      ? flipped ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE
      : hit(this.navigation.pan)
        ? flipped ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN
        : hit(this.navigation.zoom)
          ? THREE.MOUSE.DOLLY
          : (-1 as THREE.MOUSE);
    if (button === "middle") this.controls.mouseButtons.MIDDLE = action;
    else this.controls.mouseButtons.RIGHT = action;
  }

  // ---------------------------------------------------------------- ghost

  private ghost: THREE.Mesh | null = null;

  /**
   * A see-through stand-in for an extrusion: `triangles` (the profile, world space) swept along
   * `normal` by `distance` (negative: into the material, drawn as a cut), or each vertex along its
   * own entry in `normals` (a curved face). Instant, so a drag shows its result even while a slow
   * rebuild is still running. `null` removes it.
   */
  setGhost(g: { triangles: Float32Array; normal: Vec3; normals?: Float32Array | undefined; distance: number } | null): void {
    if (!g) {
      if (this.ghost) disposeTree(this.ghost);
      this.ghost?.removeFromParent();
      this.ghost = null;
      return;
    }
    const t = g.triangles;
    const off = new THREE.Vector3(...g.normal).normalize().multiplyScalar(g.distance);
    // Boundary edges belong to one triangle only; they become the side walls.
    const key = (i: number) => `${t[i]!.toFixed(4)},${t[i + 1]!.toFixed(4)},${t[i + 2]!.toFixed(4)}`;
    const edges = new Map<string, [number, number, number]>();
    for (let tri = 0; tri < t.length; tri += 9) {
      for (let k = 0; k < 3; k++) {
        const a = tri + k * 3;
        const b = tri + ((k + 1) % 3) * 3;
        const [ka, kb] = [key(a), key(b)];
        const [fwd, back] = [`${ka}|${kb}`, `${kb}|${ka}`];
        if (edges.has(back) || edges.has(fwd)) edges.delete(back), edges.delete(fwd);
        else edges.set(fwd, [a, b, 0]);
      }
    }
    const pos: number[] = [];
    const n = g.normals;
    const v = (i: number, o: boolean) =>
      n ? pos.push(t[i]! + (o ? n[i]! * g.distance : 0), t[i + 1]! + (o ? n[i + 1]! * g.distance : 0), t[i + 2]! + (o ? n[i + 2]! * g.distance : 0)) : pos.push(t[i]! + (o ? off.x : 0), t[i + 1]! + (o ? off.y : 0), t[i + 2]! + (o ? off.z : 0));
    for (let i = 0; i < t.length; i += 9) {
      v(i, false), v(i + 3, false), v(i + 6, false);
      v(i, true), v(i + 3, true), v(i + 6, true);
    }
    for (const [a, b] of edges.values()) {
      v(a, false), v(b, false), v(b, true);
      v(a, false), v(b, true), v(a, true);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const cut = g.distance < 0;
    const mat = new THREE.MeshBasicMaterial({ color: cut ? 0xe5484d : 0x6366f1, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false });
    if (this.ghost) disposeTree(this.ghost);
    this.ghost?.removeFromParent();
    this.ghost = new THREE.Mesh(geo, mat);
    this.ghost.renderOrder = 5;
    this.overlay.add(this.ghost);
  }

  // ---------------------------------------------------------------- pen and touch

  /** True once an Apple Pencil (or any pen) was used: from then on fingers no longer draw in sketches. */
  penSeen = false;
  /** Sketching without a Pencil: one finger draws, so it must not orbit the view. */
  private fingerDraws = false;
  setFingerDraws(on: boolean): void {
    this.fingerDraws = on;
    this.applyTouches();
  }
  private applyTouches(): void {
    // An unknown action leaves OrbitControls idle for one finger; two fingers still pan and zoom.
    this.controls.touches = { ONE: this.fingerDraws && !this.penSeen ? (-1 as THREE.TOUCH) : THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  }
  private penDown = new Set<number>();
  private penUpAt = 0;
  private touches = new Set<number>();
  private rejected = new Set<number>();
  private palmCancels = new WeakSet<Event>();

  /** A pen is touching the screen (or just lifted), so finger contacts are a resting palm. */
  get penActive(): boolean {
    return this.penDown.size > 0 || performance.now() - this.penUpAt < 400;
  }

  /**
   * Pen selects and draws like the left mouse button; fingers orbit (one) and pan/zoom (two) via
   * OrbitControls. Palm rejection: touches that land while the pen is down never reach the canvas,
   * and touches already navigating are cancelled when the pen comes down.
   */
  private bindPointerRoles(): void {
    const el = this.renderer.domElement;
    const filter = (e: PointerEvent) => {
      if (e.target !== el) return;
      if (e.pointerType === "pen") {
        if (!this.penSeen) {
          this.penSeen = true;
          this.applyTouches();
        }
        if (e.type === "pointerdown") {
          this.penDown.add(e.pointerId);
          // Cancel touches already navigating: they were the palm landing first.
          for (const id of [...this.touches]) {
            this.touches.delete(id);
            this.rejected.add(id);
            const cancel = new PointerEvent("pointercancel", { pointerId: id, pointerType: "touch", bubbles: true });
            this.palmCancels.add(cancel);
            el.dispatchEvent(cancel);
          }
        } else if (e.type === "pointerup" || e.type === "pointercancel") {
          if (this.penDown.delete(e.pointerId)) this.penUpAt = performance.now();
        }
        return;
      }
      if (e.pointerType !== "touch" || this.palmCancels.has(e)) return;
      if (e.type === "pointerdown") {
        if (this.penActive) this.rejected.add(e.pointerId);
        else this.touches.add(e.pointerId);
      }
      const rejected = this.rejected.has(e.pointerId);
      if (e.type === "pointerup" || e.type === "pointercancel") {
        this.touches.delete(e.pointerId);
        this.rejected.delete(e.pointerId);
      }
      if (rejected) e.stopPropagation();
    };
    // Capturing on the container runs before every listener on the canvas, OrbitControls included.
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const) this.container.addEventListener(type, filter, { capture: true });
  }

  // ---------------------------------------------------------------- scene

  /** How long the last setScene took (ms), for diagnostics. */
  lastSceneMs = 0;

  setScene(data: SceneData): void {
    const t0 = performance.now();
    this.sceneData = data;
    this.rebuildBodies(data);
    this.rebuildSketches(data);
    this.rebuildPlanes(data.planes);
    this.rebuildReferences(data.references);
    this.selected = this.selected.filter((s) => this.pickStillValid(s));
    if (this.hover && !this.pickStillValid(this.hover)) this.hover = null;
    this.paint();
    this.applyDisplayMode();
    if (!this.framed && (data.bodies.length || data.sketches.length)) {
      this.framed = true;
      this.fit(false);
    }
    this.lastSceneMs = performance.now() - t0;
  }

  /** Back to the starting view for the next model shown (a project is opening). */
  resetFraming(): void {
    this.framed = false;
    this.setView("iso", false);
  }

  get hovered(): Pick | null {
    return this.hover;
  }

  setHover(p: Pick | null): void {
    if (samePick(p, this.hover)) return;
    this.hover = p;
    this.paint();
  }

  /** Bodies that highlight as a whole on hover and selection (imported meshes), never face by face. */
  private wholeBodies = new Set<string>();
  setWholeBodies(ids: Set<string>): void {
    if (ids.size === this.wholeBodies.size && [...ids].every((id) => this.wholeBodies.has(id))) return;
    this.wholeBodies = ids;
    for (const b of this.bodies) b.painted = undefined;
    this.paint();
  }

  setSelection(picks: Pick[]): void {
    this.selected = picks;
    this.paint();
  }

  private pickStillValid(p: Pick): boolean {
    if (p.kind === "face" || p.kind === "edge") return this.bodies.some((b) => b.mesh.bodyId === p.bodyId);
    return true;
  }

  private rebuildBodies(data: SceneData): void {
    for (const b of this.bodies) {
      b.faces.geometry.dispose();
      b.edges.geometry.dispose();
      (b.faces.material as THREE.Material).dispose();
      (b.edges.material as THREE.Material).dispose();
    }
    this.bodiesGroup.clear();
    this.bodies = data.bodies.filter((m) => !data.hiddenBodies?.has(m.bodyId)).map((m) => this.buildBody(m, !!data.ghostBodies?.has(m.bodyId)));
    for (const b of this.bodies) this.bodiesGroup.add(b.group);
    this.applyPoses();
  }

  // ---------------------------------------------------------------- moving parts

  private poses: ReadonlyMap<string, readonly number[]> = new Map();
  /**
   * Set while parts can be dragged (moving a mechanism): `start` decides on a press on a part whether
   * it grabs that part; then `move` gets the pointer ray until `end`.
   */
  partDrag: { start(pick: Extract<Pick, { kind: "face" }>, ray: Ray): boolean; move(ray: Ray): void; end(): void } | null = null;
  private activePart: number | null = null;

  /** Shows parts moved from where they were modelled (column-major 4×4 matrices by body id). */
  setPoses(poses: ReadonlyMap<string, readonly number[]>): void {
    if (poses.size === 0 && this.poses.size === 0) return;
    this.poses = poses;
    this.applyPoses();
  }

  private applyPoses(): void {
    for (const b of this.bodies) {
      const m = this.poses.get(b.mesh.bodyId);
      b.group.matrixAutoUpdate = false;
      if (m) b.group.matrix.fromArray(m as number[]);
      else b.group.matrix.identity();
      b.group.updateMatrixWorld(true);
    }
    this.placeJoints();
    this.invalidate();
  }

  /** Shows joints as symbols (empty list hides them). */
  setJointGlyphs(glyphs: JointGlyph[]): void {
    disposeTree(this.jointGroup);
    const box = this.modelBox();
    const size = box ? Math.max(5, Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) * 0.08) : 8;
    for (const j of glyphs) {
      const g = new THREE.Group();
      g.userData = { parent: j.parent };
      const color = j.active ? 0xff7a1a : 0x4f46e5;
      const o = new THREE.Vector3(...j.origin);
      const a = new THREE.Vector3(...j.axis).normalize();
      const u = new THREE.Vector3().crossVectors(a, Math.abs(a.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
      const v = new THREE.Vector3().crossVectors(a, u);
      const at = (cu: number, cv: number, ca = 0) => o.clone().addScaledVector(u, cu).addScaledVector(v, cv).addScaledVector(a, ca);
      const line = (pts: THREE.Vector3[], width = 2.5) => g.add(Object.assign(fatLine(pts, { color, width }), { renderOrder: 60 }));
      // The axis itself, dashed through the joint.
      g.add(Object.assign(fatLine([at(0, 0, -1.6 * size), at(0, 0, 1.6 * size)], { color, width: 1.5, dashed: { dash: size * 0.2, gap: size * 0.12 } }), { renderOrder: 60 }));
      if (j.type === "revolute") {
        // Three quarters of a ring about the axis, ending in an arrow: it turns.
        const r = size * 0.8;
        const ring = Array.from({ length: 49 }, (_, k) => at(r * Math.cos((k / 48) * 1.5 * Math.PI), r * Math.sin((k / 48) * 1.5 * Math.PI)));
        line(ring);
        const end = 1.5 * Math.PI;
        const tip = at(r * Math.cos(end), r * Math.sin(end));
        const back = (s: number) => at(r * Math.cos(end - 0.35) + s * Math.cos(end - 0.35) * size * 0.18, r * Math.sin(end - 0.35) + s * Math.sin(end - 0.35) * size * 0.18);
        line([back(1), tip, back(-1)]);
      } else if (j.type === "slider") {
        // A double arrow along the axis: it slides.
        const L = size * 1.2;
        line([at(0, 0, -L), at(0, 0, L)]);
        for (const s of [1, -1]) line([at(size * 0.25, 0, s * (L - size * 0.35)), at(0, 0, s * L), at(-size * 0.25, 0, s * (L - size * 0.35))]);
      } else {
        // Fixed: a small square across the axis.
        const q = size * 0.35;
        line([at(-q, -q), at(q, -q), at(q, q), at(-q, q), at(-q, -q)]);
      }
      this.jointGroup.add(g);
    }
    this.placeJoints();
    this.invalidate();
  }

  /** Joint symbols ride along with the part they hang on. */
  private placeJoints(): void {
    for (const g of this.jointGroup.children) {
      const m = this.poses.get((g.userData as { parent?: string }).parent ?? "");
      g.matrixAutoUpdate = false;
      if (m) g.matrix.fromArray(m as number[]);
      else g.matrix.identity();
      g.updateMatrixWorld(true);
    }
  }

  /** The pointer's ray into the scene. */
  ray(clientX: number, clientY: number): Ray {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const { origin: o, direction: d } = this.raycaster.ray;
    return { origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z] };
  }

  get draggingPart(): boolean {
    return this.activePart !== null;
  }

  private bindPartDrag(): void {
    const el = this.renderer.domElement;
    el.addEventListener(
      "pointerdown",
      (e) => {
        const drag = this.partDrag;
        if (!drag || e.button !== 0 || this.activePart !== null || (e.pointerType === "touch" && !e.isPrimary)) return;
        const pick = this.pick(e.clientX, e.clientY, new Set(["face"]));
        if (pick?.kind !== "face" || !drag.start(pick, this.ray(e.clientX, e.clientY))) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        this.activePart = e.pointerId;
        el.style.cursor = "grabbing";
      },
      { capture: true },
    );
    const moveTo = perFrame((e: PointerEvent) => this.partDrag?.move(this.ray(e.clientX, e.clientY)));
    el.addEventListener(
      "pointermove",
      (e) => {
        if (e.pointerId !== this.activePart) return;
        e.stopImmediatePropagation();
        moveTo(e);
      },
      { capture: true },
    );
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.activePart) return;
      e.stopImmediatePropagation();
      moveTo.flush();
      this.activePart = null;
      el.style.cursor = "";
      this.partDrag?.end();
    };
    el.addEventListener("pointerup", end, { capture: true });
    el.addEventListener("pointercancel", end, { capture: true });
  }

  private buildBody(mesh: ViewMesh, ghost: boolean): BodyObj {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(mesh.positions.length), 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geo.computeBoundingSphere();
    const triFace = new Int32Array(mesh.indices.length / 3).fill(-1);
    for (let i = 0; i < mesh.faceRanges.length; i += 3) {
      triFace.fill(mesh.faceRanges[i + 2]!, mesh.faceRanges[i]! / 3, (mesh.faceRanges[i]! + mesh.faceRanges[i + 1]!) / 3);
    }
    const faces = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        metalness: 0.08,
        roughness: 0.55,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        transparent: ghost,
        opacity: ghost ? 0.25 : 1,
        depthWrite: !ghost,
        side: THREE.DoubleSide,
      }),
    );
    faces.userData = { body: mesh.bodyId };

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(mesh.edgeLines, 3));
    // Typed arrays sized up front: thread and fillet edges run to many thousand segments.
    let segs = 0;
    for (let i = 0; i < mesh.edgeRanges.length; i += 3) segs += Math.max(0, mesh.edgeRanges[i + 1]! - 1);
    const segIndex = new Uint32Array(segs * 2);
    const segEdge = new Int32Array(segs);
    let n = 0;
    for (let i = 0; i < mesh.edgeRanges.length; i += 3) {
      const start = mesh.edgeRanges[i]!;
      const count = mesh.edgeRanges[i + 1]!;
      for (let k = start; k < start + count - 1; k++) {
        segIndex[n * 2] = k;
        segIndex[n * 2 + 1] = k + 1;
        segEdge[n++] = mesh.edgeRanges[i + 2]!;
      }
    }
    lineGeo.setIndex(new THREE.BufferAttribute(segIndex, 1));
    lineGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(mesh.edgeLines.length), 3));
    lineGeo.computeBoundingSphere();
    const edges = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: ghost, opacity: ghost ? 0.35 : 1 }));
    edges.userData = { body: mesh.bodyId };
    const group = new THREE.Group();
    group.add(faces, edges);
    return { mesh, group, faces, edges, triFace, segEdge };
  }

  private rebuildSketches(data: SceneData): void {
    disposeTree(this.sketchGroup);
    for (const s of data.sketches) {
      if (s.id === data.editingSketch) continue;
      const g = new THREE.Group();
      g.userData = { sketch: s.id };
      g.matrixAutoUpdate = false;
      g.matrix.copy(frameMatrix(s.frame));
      for (const c of s.curves) {
        const color = c.external ? C.sketchExternal : c.construction ? C.sketchConstruction : C.sketch;
        const line = fatLine(curvePoints(c), { color, width: c.construction ? 1.5 : 2, ...(c.construction ? { dashed: { dash: 1.5, gap: 1 } } : {}) });
        line.renderOrder = 5;
        line.userData = { sketch: s.id, curve: c.id };
        g.add(line);
      }
      for (const r of s.regions) {
        const shape = new THREE.Shape(r.polygons[0]!.map(([x, y]) => new THREE.Vector2(x, y)));
        for (const h of r.polygons.slice(1)) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
        const mesh = new THREE.Mesh(
          new THREE.ShapeGeometry(shape),
          new THREE.MeshBasicMaterial({ color: C.region, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }),
        );
        mesh.renderOrder = 4;
        mesh.userData = { sketch: s.id, region: r.key };
        g.add(mesh);
      }
      this.sketchGroup.add(g);
    }
  }

  private rebuildPlanes(planes: PlaneView[]): void {
    disposeTree(this.planeGroup);
    for (const p of planes) {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      g.matrix.copy(frameMatrix(p.frame));
      const s = p.size;
      const color = p.color ?? C.plane;
      const fill = new THREE.Mesh(
        new THREE.PlaneGeometry(s, s),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.04, side: THREE.DoubleSide, depthWrite: false }),
      );
      fill.position.set(s / 2, s / 2, 0);
      fill.userData = { plane: p.id };
      const border = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(s, 0, 0), new THREE.Vector3(s, s, 0), new THREE.Vector3(0, s, 0)]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4 }),
      );
      border.userData = { plane: p.id, border: true };
      g.add(fill, border);
      g.userData = { plane: p.id };
      this.planeGroup.add(g);
    }
  }

  private rebuildReferences(refs: ReferenceMeshView[]): void {
    disposeTree(this.refGroup);
    for (const r of refs) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(r.positions, 3));
      geo.setIndex(new THREE.BufferAttribute(r.indices, 1));
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc9b38a, transparent: true, opacity: 0.6, roughness: 0.8, side: THREE.DoubleSide }));
      m.userData = { reference: r.id };
      this.refGroup.add(m);
    }
  }

  /**
   * Grid spacings (fine, minor, major) in mm for a zoom level, from world units per pixel. The app
   * sets this so the grid matches the design's unit and the sketch snapping; the default is metric.
   */
  gridSteps: (pixel: number) => { minor: number; major: number; snap: number } = (pixel) => {
    const levels = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 50000];
    const minor = levels.find((n) => n / pixel >= 12) ?? 50000;
    return { minor, major: minor * 10, snap: minor };
  };
  /** Step the grid currently offers for snapping, in mm. */
  gridSpacing = 1;

  /** Plane the grid lies in: the ground (XY) by default, the sketch plane while sketching. */
  private gridFrame: Frame | null = null;
  setGridFrame(frame: Frame | null): void {
    this.gridFrame = frame;
    // While sketching the grid is drawn over the model, like the sketch itself.
    const mat = this.gridMesh.material as THREE.ShaderMaterial;
    mat.depthTest = !frame;
    this.gridMesh.renderOrder = frame ? 0 : -1;
    this.changed = true;
  }

  /** Redraws what depends on settings outside the viewport (grid spacing, unit) on the next frame. */
  invalidate(): void {
    this.changed = true;
  }

  /**
   * Endless ground grid: one plane under the view whose shader draws minor and major lines with
   * screen-space anti-aliasing. The next finer level fades in as you zoom, and lines fade out with
   * distance, so it reaches the horizon without moiré or hard edges.
   */
  private gridMesh = (() => {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      extensions: { derivatives: true } as never,
      uniforms: {
        uMinor: { value: 1 },
        uMajor: { value: 10 },
        uCenter: { value: new THREE.Vector2() },
        uSize: { value: 1000 },
        uFade: { value: 500 },
        uColor: { value: new THREE.Color(0x98a3b5) },
        uOpacity: { value: 0.6 },
      },
      // Coordinates are in the grid's plane, so lines stay put however the plane is oriented.
      vertexShader: `
        uniform vec2 uCenter;
        uniform float uSize;
        varying vec2 vPlane;
        void main() {
          vPlane = uCenter + position.xy * uSize;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uMinor, uMajor, uFade, uOpacity;
        uniform vec2 uCenter;
        uniform vec3 uColor;
        varying vec2 vPlane;
        float lines(vec2 p, float s, float width) {
          vec2 c = p / s;
          vec2 w = fwidth(c);
          vec2 g = abs(fract(c - 0.5) - 0.5) / (w * width);
          return 1.0 - min(min(g.x, g.y), 1.0);
        }
        void main() {
          float px = length(fwidth(vPlane)) * 0.7071;
          // Both levels stay clearly visible; lines only fade where perspective crowds them (far away).
          float minorA = smoothstep(5.0, 12.0, uMinor / px) * 0.55;
          float majorA = smoothstep(4.0, 10.0, uMajor / px) * 0.95;
          float a = max(lines(vPlane, uMinor, 1.0) * minorA, lines(vPlane, uMajor, 1.25) * majorA);
          a *= 1.0 - smoothstep(uFade * 0.35, uFade, distance(vPlane, uCenter));
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a * uOpacity);
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    return mesh;
  })();

  /** Moves and sizes the grid plane with the view, and picks its spacings for the zoom. */
  private updateGrid(): void {
    const f = this.gridFrame ?? { origin: [0, 0, 0] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 1, 0] as Vec3, normal: [0, 0, 1] as Vec3 };
    const target = this.controls.target;
    // The view centre, dropped onto the grid plane, in plane coordinates.
    const d = target.clone().sub(new THREE.Vector3(...f.origin));
    const cx = d.dot(new THREE.Vector3(...f.u));
    const cy = d.dot(new THREE.Vector3(...f.v));
    const onPlane = new THREE.Vector3(...f.origin).addScaledVector(new THREE.Vector3(...f.u), cx).addScaledVector(new THREE.Vector3(...f.v), cy);
    const pixel = this.pixelSize([onPlane.x, onPlane.y, onPlane.z]);
    const steps = this.gridSteps(pixel);
    this.gridSpacing = steps.snap;
    const reach = this.camera instanceof THREE.OrthographicCamera ? pixel * Math.max(this.renderer.domElement.clientWidth, this.renderer.domElement.clientHeight) * 2 : this.camera.position.distanceTo(onPlane) * 6;
    const u = (this.gridMesh.material as THREE.ShaderMaterial).uniforms;
    u["uMinor"]!.value = steps.minor;
    u["uMajor"]!.value = steps.major;
    u["uFade"]!.value = reach;
    u["uSize"]!.value = reach * 2;
    (u["uCenter"]!.value as THREE.Vector2).set(cx, cy);
    u["uColor"]!.value = new THREE.Color(this.dark ? 0x6b7590 : 0x8a95a8);
    u["uOpacity"]!.value = this.dark ? 0.6 : 0.55;
    const m = frameMatrix(f).multiply(new THREE.Matrix4().makeTranslation(cx, cy, 0)).multiply(new THREE.Matrix4().makeScale(reach * 2, reach * 2, 1));
    this.gridMesh.matrixAutoUpdate = false;
    this.gridMesh.matrix.copy(m);
    this.gridMesh.matrixWorldNeedsUpdate = true;
  }

  /** Light/dark scene colours (grid contrast). */
  setDark(dark: boolean): void {
    if (dark === this.dark) return;
    this.dark = dark;
    this.changed = true;
  }

  get mode(): DisplayMode {
    return this.displayMode;
  }

  /** Classic CAD display modes. */
  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = mode;
    this.applyDisplayMode();
  }

  private applyDisplayMode(): void {
    const m = this.displayMode;
    for (const b of this.bodies) {
      const fm = b.faces.material as THREE.MeshStandardMaterial;
      const em = b.edges.material as THREE.LineBasicMaterial;
      b.faces.visible = m !== "wireframe";
      b.edges.visible = m !== "shaded";
      fm.transparent = m === "xray";
      fm.opacity = m === "xray" ? 0.22 : 1;
      fm.depthWrite = m !== "xray";
      // Hidden-line: flat white faces that only occlude, plus visible edges.
      fm.emissive.setHex(m === "hidden_line" ? 0xffffff : 0x000000);
      fm.emissiveIntensity = m === "hidden_line" ? 1 : 0;
      fm.needsUpdate = true;
      em.depthTest = !(m === "wireframe" || m === "xray");
      em.needsUpdate = true;
    }
  }

  setPlanesVisible(v: boolean): void {
    this.planeGroup.visible = v;
  }
  private planeEmphasis = false;
  /** Stronger plane fills and borders, for when the user has to pick one. */
  setPlaneEmphasis(on: boolean): void {
    if (on === this.planeEmphasis) return;
    this.planeEmphasis = on;
    this.paint();
  }
  setSketchesVisible(v: boolean): void {
    this.sketchGroup.visible = v;
  }
  setGridVisible(v: boolean): void {
    this.grid.visible = v;
  }

  // ---------------------------------------------------------------- highlight

  /** Base colours of parts ("#rrggbb" by body id); others use the default part colour. */
  private bodyColors = new Map<string, THREE.Color>();
  setBodyColors(colors: ReadonlyMap<string, string>): void {
    const next = new Map([...colors].map(([id, hex]) => [id, new THREE.Color(hex)]));
    const same = next.size === this.bodyColors.size && [...next].every(([id, c]) => this.bodyColors.get(id)?.equals(c));
    if (same) return;
    this.bodyColors = next;
    for (const b of this.bodies) b.painted = undefined;
    this.paint();
    this.invalidate();
  }

  private paint(): void {
    // Selection as lookups (a whole selected mesh is thousands of faces; scanning the list per face
    // would be quadratic), then only bodies whose highlight changed are recoloured.
    const selFaces = new Map<string, Set<number>>();
    const selEdges = new Map<string, Set<number>>();
    for (const p of this.selected) {
      if (p.kind === "face") (selFaces.get(p.bodyId) ?? selFaces.set(p.bodyId, new Set()).get(p.bodyId)!).add(p.face);
      else if (p.kind === "edge") (selEdges.get(p.bodyId) ?? selEdges.set(p.bodyId, new Set()).get(p.bodyId)!).add(p.edge);
    }
    const h = this.hover && (this.hover.kind === "face" || this.hover.kind === "edge") ? this.hover : null;
    for (const b of this.bodies) {
      const id = b.mesh.bodyId;
      const whole = this.wholeBodies.has(id);
      const sf = selFaces.get(id) ?? new Set<number>();
      const se = selEdges.get(id) ?? new Set<number>();
      const hovered = h && h.bodyId === id ? h : null;
      const key = whole
        ? `whole|${sf.size || se.size ? 1 : 0}|${hovered ? 1 : 0}`
        : `${[...sf].join(",")}|${[...se].join(",")}|${hovered ? `${hovered.kind}${hovered.kind === "face" ? hovered.face : hovered.edge}` : ""}`;
      if (b.painted === key) continue;
      b.painted = key;
      const fc = b.faces.geometry.getAttribute("color") as THREE.BufferAttribute;
      const idx = b.mesh.indices;
      const base = this.bodyColors.get(id) ?? C.face;
      const wholeColor = sf.size || se.size ? C.faceSel : hovered ? C.faceHover : base;
      const faceColor = (f: number) => (whole ? wholeColor : sf.has(f) ? C.faceSel : hovered?.kind === "face" && hovered.face === f ? C.faceHover : base);
      for (let t = 0; t < b.triFace.length; t++) {
        const c = faceColor(b.triFace[t]!);
        for (let k = 0; k < 3; k++) fc.setXYZ(idx[t * 3 + k]!, c.r, c.g, c.b);
      }
      fc.needsUpdate = true;
      const ec = b.edges.geometry.getAttribute("color") as THREE.BufferAttribute;
      const segIdx = b.edges.geometry.getIndex()!;
      for (let sg = 0; sg < b.segEdge.length; sg++) {
        const e = b.segEdge[sg]!;
        const c = se.has(e) ? C.edgeSel : hovered?.kind === "edge" && hovered.edge === e ? C.edgeHover : C.edge;
        ec.setXYZ(segIdx.getX(sg * 2), c.r, c.g, c.b);
        ec.setXYZ(segIdx.getX(sg * 2 + 1), c.r, c.g, c.b);
      }
      ec.needsUpdate = true;
    }
    this.sketchGroup.traverse((o) => {
      const { region, curve, sketch } = o.userData as { region?: string; curve?: string; sketch?: string };
      if (region !== undefined && o instanceof THREE.Mesh) {
        const sel = this.selected.some((s) => s.kind === "region" && s.sketchId === sketch && s.key === region);
        const hov = this.hover?.kind === "region" && this.hover.sketchId === sketch && this.hover.key === region;
        (o.material as THREE.MeshBasicMaterial).opacity = sel ? 0.45 : hov ? 0.25 : 0.08;
      }
      if (curve !== undefined && o instanceof THREE.Line) {
        const sel = this.selected.some((s) => s.kind === "sketch_curve" && s.sketchId === sketch && s.curveId === curve);
        const hov = this.hover?.kind === "sketch_curve" && this.hover.sketchId === sketch && this.hover.curveId === curve;
        const mat = o.material as THREE.LineBasicMaterial;
        if (mat.userData["base"] === undefined) mat.userData["base"] = mat.color.getHex();
        mat.color.setHex(sel ? C.edgeSel.getHex() : hov ? C.edgeHover.getHex() : (mat.userData["base"] as number));
      }
    });
    const strong = this.planeEmphasis;
    this.planeGroup.traverse((o) => {
      const { plane, border } = o.userData as { plane?: string; border?: boolean };
      if (plane === undefined || !(o instanceof THREE.Mesh || o instanceof THREE.Line)) return;
      const sel = this.selected.some((s) => s.kind === "plane" && s.planeId === plane);
      const hov = this.hover?.kind === "plane" && this.hover.planeId === plane;
      const mat = o.material as THREE.Material;
      if (border) mat.opacity = sel || hov ? 1 : strong ? 0.85 : 0.4;
      else mat.opacity = sel ? 0.38 : hov ? (strong ? 0.4 : 0.18) : strong ? 0.13 : 0.04;
    });
  }

  // ---------------------------------------------------------------- handles

  setHandles(handles: Handle[]): void {
    // While dragging, the grabbed handle keeps its own callbacks and position until release.
    if (this.activeHandle) handles = [this.activeHandle.h, ...handles.filter((h) => h.id !== this.activeHandle!.h.id)];
    this.handles = handles;
    this.drawHandles();
  }

  private handleBase(h: Handle): number {
    return this.pixelSize(h.origin) * 46;
  }

  private handleTip(h: Handle, value = h.value): THREE.Vector3 {
    const d = new THREE.Vector3(...h.dir).normalize();
    return new THREE.Vector3(...h.origin).addScaledVector(d, value + this.handleBase(h));
  }

  private drawHandles(): void {
    disposeTree(this.handleGroup);
    const onTop = <M extends THREE.Material>(m: M, opacity = 1) => {
      m.depthTest = false;
      m.depthWrite = false;
      m.transparent = true;
      m.opacity = opacity;
      return m;
    };
    for (const h0 of this.handles) {
      const h = this.activeHandle?.h.id === h0.id ? { ...h0, value: this.activeHandle.value } : h0;
      const px = this.pixelSize(h.origin);
      const d = new THREE.Vector3(...h.dir).normalize();
      const o = new THREE.Vector3(...h.origin);
      const tip = this.handleTip(h);
      const hot = this.activeHandle?.h.id === h.id || this.hoverHandle === h.id;
      const color = hot ? 0xff7a1a : (h.color ?? 0x4f46e5);
      const along = tip.clone().sub(o);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), along.lengthSq() ? along.clone().normalize() : d);
      const parts: THREE.Object3D[] = [];
      // A slim track from the grabbed spot to the knob, with a soft white edge so it reads on any surface.
      for (const [r, col, opacity, order] of [
        [2.4, 0xffffff, 0.7, 50],
        [1, color, 0.9, 51],
      ] as const) {
        const track = new THREE.Mesh(new THREE.CylinderGeometry(px * r, px * r, Math.max(along.length(), px), 12), onTop(new THREE.MeshBasicMaterial({ color: col }), opacity));
        track.position.copy(o).addScaledVector(along, 0.5);
        track.quaternion.copy(q);
        track.renderOrder = order;
        const dot = new THREE.Mesh(new THREE.SphereGeometry(px * (r === 1 ? 3 : 4.6), 16, 12), onTop(new THREE.MeshBasicMaterial({ color: col }), r === 1 ? 1 : 0.9));
        dot.position.copy(o);
        dot.renderOrder = order;
        parts.push(track, dot);
      }
      // The knob: a round, screen-facing button with chevrons along the drag direction.
      const pointing = h.value < 0 ? d.clone().negate() : d;
      const tex = handleKnob(color, h.twoWay ?? h.min === undefined);
      if (tex) {
        const knob = new THREE.Sprite(onTop(new THREE.SpriteMaterial({ map: tex })));
        const a = this.worldToScreen([tip.x, tip.y, tip.z]);
        const ahead = tip.clone().addScaledVector(pointing, px * 20);
        const b = this.worldToScreen([ahead.x, ahead.y, ahead.z]);
        if (a && b && Math.hypot(b[0] - a[0], b[1] - a[1]) > 2) knob.material.rotation = Math.atan2(a[1] - b[1], b[0] - a[0]);
        knob.position.copy(tip);
        knob.scale.setScalar(px * (hot ? 36 : 32));
        knob.renderOrder = 53;
        parts.push(knob);
      }
      this.handleGroup.add(...parts);
    }
  }

  private hitHandle(clientX: number, clientY: number, radius = 18): Handle | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    let best: Handle | null = null;
    let bd = radius;
    for (const h of this.handles) {
      const tip = this.handleTip(h);
      const a = this.worldToScreen(h.origin);
      const b = this.worldToScreen([tip.x, tip.y, tip.z]);
      if (!a || !b) continue;
      // Distance to the arrow segment, favouring the tip.
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0.35, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
      const dist = Math.hypot(a[0] + dx * t - px, a[1] + dy * t - py) - (t > 0.9 ? 6 : 0);
      if (dist < bd) {
        bd = dist;
        best = h;
      }
    }
    return best;
  }

  /** Axis parameter closest to the pointer ray. */
  private axisParam(h: Handle, clientX: number, clientY: number): number | null {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const ray = this.raycaster.ray;
    const d = new THREE.Vector3(...h.dir).normalize();
    const w0 = ray.origin.clone().sub(new THREE.Vector3(...h.origin));
    const b = d.dot(ray.direction);
    const denom = 1 - b * b;
    if (denom < 1e-6) return null;
    return (w0.dot(d) - b * w0.dot(ray.direction)) / denom;
  }

  /** Step drag handles snap to, from world units per screen pixel; unset: a round step for the zoom. */
  handleStep: ((pixel: number) => number) | null = null;

  private snapStep(at: Vec3): number {
    if (this.handleStep) return this.handleStep(this.pixelSize(at));
    const px = this.pixelSize(at) * 6;
    for (const s of [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100]) if (s >= px) return s;
    return 100;
  }

  private bindHandles(): void {
    const el = this.renderer.domElement;
    let grab = 0;
    el.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0 || (e.pointerType === "touch" && this.penSeen)) return;
        const h = this.hitHandle(e.clientX, e.clientY, e.pointerType === "touch" ? 30 : 18);
        if (!h) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        const t = this.axisParam(h, e.clientX, e.clientY);
        // Offset between where the arrow was grabbed and its value, so it does not jump.
        grab = (t ?? 0) - (h.value + this.handleBase(h));
        this.activeHandle = { h, value: h.value, pointer: e.pointerId };
        h.onStart?.();
      },
      { capture: true },
    );
    el.addEventListener(
      "pointermove",
      (e) => {
        const a = this.activeHandle;
        if (!a) {
          // Fingers do not hover; a finger orbiting across an arrow must not be swallowed.
          if (e.pointerType === "touch") return;
          const hit = this.hitHandle(e.clientX, e.clientY)?.id ?? null;
          if (hit !== this.hoverHandle) {
            this.hoverHandle = hit;
            el.style.cursor = hit ? "grab" : "";
            this.drawHandles();
          }
          if (hit) e.stopImmediatePropagation();
          return;
        }
        if (e.pointerId !== a.pointer) return;
        e.stopImmediatePropagation();
        dragTo(e);
      },
      { capture: true },
    );
    const dragTo = perFrame((e: PointerEvent) => {
        const a = this.activeHandle;
        if (!a) return;
        const t = this.axisParam(a.h, e.clientX, e.clientY);
        if (t === null) return;
        const raw = t - grab - this.handleBase(a.h);
        const step = this.snapStep(a.h.origin);
        let v = Math.round(raw / step) * step;
        if (a.h.min !== undefined) v = Math.max(a.h.min, v);
        v = Math.round(v * 1000) / 1000;
        if (v !== a.value) {
          a.value = v;
          a.h.onDrag(v);
          this.drawHandles();
        }
        const tip = this.handleTip(a.h, v);
        this.onHandleDrag?.(a.h, v, this.worldToScreen([tip.x, tip.y, tip.z]));
    });
    const end = (e: PointerEvent) => {
      const a = this.activeHandle;
      if (!a || e.pointerId !== a.pointer) return;
      e.stopImmediatePropagation();
      dragTo.flush();
      this.activeHandle = null;
      el.style.cursor = "";
      this.onHandleDrag?.(null, a.value, null);
      a.h.onEnd(a.value);
      this.drawHandles();
      if (this.pendingInset !== null) {
        const px = this.pendingInset;
        this.pendingInset = null;
        this.setBottomInset(px);
      }
    };
    el.addEventListener("pointerup", end, { capture: true });
    el.addEventListener("pointercancel", end, { capture: true });
  }

  /** Screen position (canvas CSS px) of a handle's arrow tip, for value labels. */
  handleTipScreen(id: string): Vec2 | null {
    const h = this.activeHandle?.h.id === id ? { ...this.activeHandle.h, value: this.activeHandle.value } : this.handles.find((x) => x.id === id);
    if (!h) return null;
    const tip = this.handleTip(h);
    return this.worldToScreen([tip.x, tip.y, tip.z]);
  }

  get draggingHandle(): boolean {
    return !!this.activeHandle;
  }

  // ---------------------------------------------------------------- picking

  private ndc(clientX: number, clientY: number): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  /** World units per screen pixel at a point (or at the orbit target). */
  pixelSize(at?: Vec3): number {
    const h = this.renderer.domElement.clientHeight || 1;
    if (this.camera instanceof THREE.OrthographicCamera) return (this.camera.top - this.camera.bottom) / this.camera.zoom / h;
    const p = at ? new THREE.Vector3(...at) : this.controls.target;
    const d = this.camera.position.distanceTo(p);
    return (2 * d * Math.tan((this.persp.fov * Math.PI) / 360)) / h;
  }

  private planar = new WeakMap<BodyObj, Map<number, boolean>>();
  /** Whether a face is flat: every vertex normal of its triangles points the same way. */
  private isPlanar(b: BodyObj, face: number): boolean {
    let cache = this.planar.get(b);
    if (!cache) this.planar.set(b, (cache = new Map()));
    const known = cache.get(face);
    if (known !== undefined) return known;
    const { faceRanges: fr, indices, normals } = b.mesh;
    let ref: [number, number, number] | null = null;
    let flat = true;
    for (let g = 0; g < fr.length && flat; g += 3) {
      if (fr[g + 2] !== face) continue;
      for (let t = fr[g]!; t < fr[g]! + fr[g + 1]!; t++) {
        const i = indices[t]! * 3;
        const n: [number, number, number] = [normals[i]!, normals[i + 1]!, normals[i + 2]!];
        if (!ref) ref = n;
        else if (n[0] * ref[0] + n[1] * ref[1] + n[2] * ref[2] < 0.9995) {
          flat = false;
          break;
        }
      }
    }
    cache.set(face, flat);
    return flat;
  }

  pick(clientX: number, clientY: number, kinds: ReadonlySet<PickKind>): Pick | null {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const px = this.pixelSize();
    this.raycaster.params.Line = { threshold: px * 6 };
    const ray = this.raycaster;
    const v3 = (p: THREE.Vector3): Vec3 => [p.x, p.y, p.z];

    const faceHit = ray.intersectObjects(this.bodies.map((b) => b.faces), false)[0];
    const occlusion = faceHit ? faceHit.distance + px * 4 : Infinity;

    if (kinds.has("sketch_curve") && this.sketchGroup.visible) {
      const hit = ray.intersectObject(this.sketchGroup, true).find((h) => h.object instanceof THREE.Line && (h.object.userData as { curve?: string }).curve !== undefined);
      if (hit) {
        const { sketch, curve } = hit.object.userData as { sketch: string; curve: string };
        return { kind: "sketch_curve", sketchId: sketch, curveId: curve, point: v3(hit.point) };
      }
    }
    if (kinds.has("edge")) {
      const hit = ray.intersectObjects(this.bodies.map((b) => b.edges), false).find((h) => h.distance <= occlusion);
      if (hit && hit.index !== undefined) {
        const b = this.bodies.find((x) => x.edges === hit.object)!;
        const edge = b.segEdge[Math.floor(hit.index / 2)] ?? -1;
        if (edge >= 0) return { kind: "edge", bodyId: b.mesh.bodyId, edge, point: v3(hit.point) };
      }
    }
    if (kinds.has("region") && this.sketchGroup.visible) {
      const hit = ray.intersectObject(this.sketchGroup, true).find((h) => (h.object.userData as { region?: string }).region !== undefined && h.distance <= occlusion);
      if (hit) {
        const { sketch, region } = hit.object.userData as { sketch: string; region: string };
        return { kind: "region", sketchId: sketch, key: region, point: v3(hit.point) };
      }
    }
    if (kinds.has("face") && faceHit && faceHit.faceIndex !== undefined && faceHit.faceIndex !== null) {
      const b = this.bodies.find((x) => x.faces === faceHit.object)!;
      const face = b.triFace[faceHit.faceIndex] ?? -1;
      if (face >= 0) {
        // Only flat faces have one normal (push/pull and sketching need it); curved ones get none.
        // The interpolated vertex normal follows a curved face; the triangle's own normal is exact on a flat one.
        const fn = faceHit.face?.normal;
        const hn = faceHit.normal ?? fn;
        const n: Vec3 | null = this.isPlanar(b, face) && fn ? [fn.x, fn.y, fn.z] : null;
        return { kind: "face", bodyId: b.mesh.bodyId, face, tags: b.mesh.faceTags[face] ?? [], point: v3(faceHit.point), normal: n, surface: n ?? (hn ? [hn.x, hn.y, hn.z] : undefined) };
      }
    }
    if (kinds.has("plane") && this.planeGroup.visible) {
      const hit = ray.intersectObject(this.planeGroup, true).find((h) => h.object instanceof THREE.Mesh && h.distance <= occlusion);
      if (hit) return { kind: "plane", planeId: (hit.object.userData as { plane: string }).plane, point: v3(hit.point) };
    }
    return null;
  }

  /**
   * Box selection in screen space (client px). `enclosed` keeps only entities fully inside,
   * otherwise anything touching the box is taken.
   */
  boxSelect(x0: number, y0: number, x1: number, y1: number, enclosed: boolean, kinds: ReadonlySet<"face" | "edge">): Pick[] {
    const r = this.renderer.domElement.getBoundingClientRect();
    const [ax, bx] = [Math.min(x0, x1) - r.left, Math.max(x0, x1) - r.left];
    const [ay, by] = [Math.min(y0, y1) - r.top, Math.max(y0, y1) - r.top];
    const v = new THREE.Vector3();
    const inside = (x: number, y: number, z: number) => {
      v.set(x, y, z).project(this.camera);
      if (v.z > 1) return false;
      const sx = ((v.x + 1) / 2) * r.width;
      const sy = ((1 - v.y) / 2) * r.height;
      return sx >= ax && sx <= bx && sy >= ay && sy <= by;
    };
    const test = (pts: number[]) => {
      let any = false;
      let all = true;
      for (let i = 0; i < pts.length; i += 3) {
        const ok = inside(pts[i]!, pts[i + 1]!, pts[i + 2]!);
        any ||= ok;
        all &&= ok;
        if (!enclosed && any) return true;
        if (enclosed && !all) return false;
      }
      return enclosed ? all && pts.length > 0 : any;
    };
    const out: Pick[] = [];
    for (const b of this.bodies) {
      const m = b.mesh;
      if (kinds.has("face")) {
        for (let g = 0; g < m.faceRanges.length; g += 3) {
          const [start, count, face] = [m.faceRanges[g]!, m.faceRanges[g + 1]!, m.faceRanges[g + 2]!];
          if (face < 0) continue;
          const pts: number[] = [];
          for (let k = start; k < start + count; k++) {
            const i = m.indices[k]! * 3;
            pts.push(m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!);
          }
          if (test(pts)) out.push({ kind: "face", bodyId: m.bodyId, face, tags: m.faceTags[face] ?? [], point: [pts[0]!, pts[1]!, pts[2]!], normal: null });
        }
      }
      if (kinds.has("edge")) {
        for (let g = 0; g < m.edgeRanges.length; g += 3) {
          const [start, count, edge] = [m.edgeRanges[g]!, m.edgeRanges[g + 1]!, m.edgeRanges[g + 2]!];
          if (edge < 0) continue;
          const pts = Array.from(m.edgeLines.subarray(start * 3, (start + count) * 3));
          if (test(pts)) out.push({ kind: "edge", bodyId: m.bodyId, edge, point: [pts[0]!, pts[1]!, pts[2]!] });
        }
      }
    }
    return out;
  }

  /** Intersects the pointer ray with a sketch plane; returns sketch coordinates. */
  rayToPlane(clientX: number, clientY: number, f: Frame): Vec2 | null {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const n = new THREE.Vector3(...f.normal);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(...f.origin));
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return null;
    const d = hit.sub(new THREE.Vector3(...f.origin));
    return [d.dot(new THREE.Vector3(...f.u)), d.dot(new THREE.Vector3(...f.v))];
  }

  /** Screen position (CSS px relative to the canvas) of a world point; null when behind the camera. */
  worldToScreen(p: Vec3): Vec2 | null {
    const v = new THREE.Vector3(...p).project(this.camera);
    if (v.z > 1) return null;
    const el = this.renderer.domElement;
    return [((v.x + 1) / 2) * el.clientWidth, ((1 - v.y) / 2) * el.clientHeight];
  }

  // ---------------------------------------------------------------- camera

  get projection(): "perspective" | "orthographic" {
    return this.camera === this.ortho ? "orthographic" : "perspective";
  }

  setProjection(p: "perspective" | "orthographic"): void {
    const next = p === "orthographic" ? this.ortho : this.persp;
    if (next === this.camera) return;
    const target = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(target);
    next.position.copy(this.camera.position);
    next.up.copy(this.camera.up);
    if (next === this.ortho) {
      const h = 2 * dist * Math.tan((this.persp.fov * Math.PI) / 360);
      this.ortho.zoom = 1;
      this.setOrthoSize(h);
    } else {
      const h = (this.ortho.top - this.ortho.bottom) / this.ortho.zoom;
      const d = h / (2 * Math.tan((this.persp.fov * Math.PI) / 360));
      next.position.copy(target).add(this.camera.position.clone().sub(target).normalize().multiplyScalar(d));
    }
    this.camera = next;
    this.controls.object = next;
    this.controls.update();
    this.resize();
    this.emit();
  }

  private setOrthoSize(h: number): void {
    const el = this.renderer.domElement;
    const aspect = (el.clientWidth || 1) / (el.clientHeight || 1);
    this.ortho.top = h / 2;
    this.ortho.bottom = -h / 2;
    this.ortho.left = (-h / 2) * aspect;
    this.ortho.right = (h / 2) * aspect;
    this.ortho.updateProjectionMatrix();
  }

  /** Camera orientation for the view cube: world → camera rotation. */
  get cameraQuaternion(): THREE.Quaternion {
    return this.camera.quaternion;
  }

  setView(view: StandardView, animate = true): void {
    const v = VIEWS[view];
    this.lookFrom(new THREE.Vector3(...v.dir), new THREE.Vector3(...v.up), animate);
  }

  /** Looks at a plane head-on (sketch mode). */
  alignToFrame(f: Frame, animate = true): void {
    this.lookFrom(new THREE.Vector3(...f.normal), new THREE.Vector3(...f.v), animate, new THREE.Vector3(...f.origin));
  }

  lookFrom(dir: THREE.Vector3, up: THREE.Vector3, animate: boolean, center?: THREE.Vector3): void {
    const box = new THREE.Box3().setFromObject(this.bodiesGroup);
    const sk = new THREE.Box3().setFromObject(this.sketchGroup);
    if (!sk.isEmpty()) box.union(sk);
    const target = center && box.isEmpty() ? center : box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const size = box.isEmpty() ? 100 : Math.max(box.getSize(new THREE.Vector3()).length(), 10);
    // Fit the narrower of the two view angles, so tall (phone) windows frame the model too.
    const half = Math.tan((this.persp.fov * Math.PI) / 360) * Math.min(1, this.persp.aspect);
    const dist = this.camera === this.ortho ? size * 4 : (size * 1.4) / half / 2;
    const to = target.clone().add(dir.clone().normalize().multiplyScalar(dist));
    const zoomTo = this.camera === this.ortho ? this.orthoZoomFor(size * 1.3) : undefined;
    if (!animate) {
      this.camera.position.copy(to);
      this.camera.up.copy(up);
      this.controls.target.copy(target);
      if (zoomTo) {
        this.ortho.zoom = zoomTo;
        this.ortho.updateProjectionMatrix();
      }
      this.controls.update();
      this.emit();
      return;
    }
    this.anim = {
      from: this.camera.position.clone(),
      to,
      upFrom: this.camera.up.clone(),
      upTo: up.clone(),
      targetFrom: this.controls.target.clone(),
      target,
      t0: performance.now(),
      ...(zoomTo ? { zoomTo, zoomFrom: this.ortho.zoom } : {}),
    };
  }

  private orthoZoomFor(size: number): number {
    return Math.min(this.ortho.top - this.ortho.bottom, this.ortho.right - this.ortho.left) / size;
  }

  /** Orbits the camera around the target (radians), e.g. when dragging the view cube. */
  orbit(dAzimuth: number, dPolar: number): void {
    this.anim = null;
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const up = this.camera.up.clone().normalize();
    // Azimuth around the world Z axis, polar around the camera's right vector.
    offset.applyAxisAngle(new THREE.Vector3(0, 0, 1), dAzimuth);
    up.applyAxisAngle(new THREE.Vector3(0, 0, 1), dAzimuth);
    const right = new THREE.Vector3().crossVectors(up, offset).normalize();
    offset.applyAxisAngle(right, dPolar);
    up.applyAxisAngle(right, dPolar);
    this.camera.position.copy(target).add(offset);
    this.camera.up.copy(up);
    this.camera.lookAt(target);
    this.controls.update();
    this.emit();
  }

  /** Turns to face a surface head-on, centred on the touched point and keeping the distance. */
  lookAtFace(point: Vec3, normal: Vec3): void {
    const d = new THREE.Vector3(...normal).normalize();
    const up = Math.abs(d.z) > 0.99 ? new THREE.Vector3(0, d.z > 0 ? 1 : -1, 0) : new THREE.Vector3(0, 0, 1);
    const target = new THREE.Vector3(...point);
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.anim = {
      from: this.camera.position.clone(),
      to: target.clone().addScaledVector(d, dist),
      upFrom: this.camera.up.clone(),
      upTo: up,
      targetFrom: this.controls.target.clone(),
      target,
      t0: performance.now(),
    };
  }

  /** Looks along -dir (camera placed at +dir), choosing a sensible up vector. */
  viewFrom(dir: Vec3, animate = true): void {
    const d = new THREE.Vector3(...dir).normalize();
    const up = Math.abs(d.z) > 0.99 ? new THREE.Vector3(0, d.z > 0 ? 1 : -1, 0) : new THREE.Vector3(0, 0, 1);
    this.lookFrom(d, up, animate);
  }

  fit(animate = true): void {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.lookFrom(dir.lengthSq() ? dir : new THREE.Vector3(...VIEWS.iso.dir), this.camera.up.clone(), animate);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Overlays (handles, labels, view cube) follow the camera once per frame, however many
   *  pointer events moved it in between. */
  private emit(): void {
    this.changed = true;
  }
  private changed = true;

  /** Bounding box of the shown parts in their current poses (or of `bodies` only). */
  modelBox(bodies?: readonly string[]): { min: Vec3; max: Vec3 } | null {
    const box = new THREE.Box3();
    for (const b of this.bodies) if (!bodies || bodies.includes(b.mesh.bodyId)) box.expandByObject(b.group);
    return box.isEmpty() ? null : { min: box.min.toArray() as Vec3, max: box.max.toArray() as Vec3 };
  }

  /**
   * A picture for assistants and exports: the model framed from a standard view or any direction,
   * optionally zoomed onto some parts (`focus`, `isolate` hides the rest), cut open by a plane
   * (`section`: the cut shows red) and with parts or faces highlighted. Helpers (grid, planes,
   * handles) are left out. `box` fixes the framing (frames of a motion).
   */
  render(o: {
    width: number;
    height: number;
    view?: StandardView;
    direction?: Vec3;
    focus?: readonly string[];
    isolate?: boolean;
    section?: { normal: Vec3; offset: number };
    bodyColors?: ReadonlyMap<string, string>;
    faces?: Pick[];
    box?: { min: Vec3; max: Vec3 };
  }): string {
    const helpers = [this.grid, this.planeGroup, this.handleGroup, this.overlay, this.axes, this.sketchGroup, this.refGroup];
    const shown = helpers.map((h) => h.visible);
    helpers.forEach((h) => (h.visible = false));
    const hidden = o.isolate && o.focus ? this.bodies.filter((b) => !o.focus!.includes(b.mesh.bodyId)) : [];
    for (const b of hidden) b.group.visible = false;
    const savedColors = this.bodyColors;
    const savedSel = this.selected;
    if (o.bodyColors) this.setBodyColors(new Map([...[...savedColors].map(([id, c]): [string, string] => [id, `#${c.getHexString()}`]), ...o.bodyColors]));
    if (o.faces) this.setSelection(o.faces);
    // The cut: clip everything, and show the inside (back faces) in red where the plane opens it.
    const caps: THREE.Mesh[] = [];
    const plane = o.section ? new THREE.Plane(new THREE.Vector3(...o.section.normal).normalize(), -o.section.offset) : null;
    if (plane) {
      this.renderer.localClippingEnabled = true;
      for (const b of this.bodies) {
        (b.faces.material as THREE.Material).clippingPlanes = [plane];
        (b.edges.material as THREE.Material).clippingPlanes = [plane];
        const cap = new THREE.Mesh(b.faces.geometry, new THREE.MeshBasicMaterial({ color: 0xd94a4a, side: THREE.BackSide, clippingPlanes: [plane] }));
        b.group.add(cap);
        caps.push(cap);
      }
    }
    const prev = this.renderer.getSize(new THREE.Vector2());
    this.persp.clearViewOffset();
    this.renderer.setSize(o.width, o.height, false);
    const aspect = o.width / o.height;
    const saved = { aspect: this.persp.aspect, fov: this.persp.fov, pos: this.persp.position.clone(), quat: this.persp.quaternion.clone(), up: this.persp.up.clone() };
    this.persp.aspect = aspect;
    this.persp.fov = fovFor(aspect);
    this.persp.updateProjectionMatrix();
    const b = o.box ?? this.modelBox(o.focus) ?? { min: [-50, -50, -50] as Vec3, max: [50, 50, 50] as Vec3 };
    const sphere = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)).getBoundingSphere(new THREE.Sphere());
    const std = VIEWS[o.view ?? "iso"];
    const dir = new THREE.Vector3(...(o.direction ?? std.dir)).normalize();
    // Up: Z, unless looking along it.
    const up = o.direction ? (Math.abs(dir.z) > 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)) : new THREE.Vector3(...std.up);
    const fov = THREE.MathUtils.degToRad(this.persp.fov) / 2;
    const dist = (Math.max(sphere.radius, 1e-3) / Math.sin(Math.min(fov, Math.atan(Math.tan(fov) * aspect)))) * 1.04;
    this.persp.position.copy(sphere.center).addScaledVector(dir, dist);
    this.persp.up.copy(up);
    this.persp.lookAt(sphere.center);
    this.persp.updateMatrixWorld();
    this.renderer.render(this.scene, this.persp);
    const url = this.renderer.domElement.toDataURL("image/png");
    // Put everything back.
    this.persp.position.copy(saved.pos);
    this.persp.quaternion.copy(saved.quat);
    this.persp.up.copy(saved.up);
    this.persp.aspect = saved.aspect;
    this.persp.fov = saved.fov;
    this.persp.updateProjectionMatrix();
    this.persp.updateMatrixWorld();
    this.renderer.setSize(prev.x, prev.y, false);
    this.applyInset();
    for (const cap of caps) {
      cap.removeFromParent();
      (cap.material as THREE.Material).dispose();
    }
    if (plane) {
      for (const body of this.bodies) {
        (body.faces.material as THREE.Material).clippingPlanes = null;
        (body.edges.material as THREE.Material).clippingPlanes = null;
      }
      this.renderer.localClippingEnabled = false;
    }
    if (o.faces) this.setSelection(savedSel);
    if (o.bodyColors) {
      this.bodyColors = savedColors;
      for (const body of this.bodies) body.painted = undefined;
      this.paint();
    }
    for (const h of hidden) h.group.visible = true;
    helpers.forEach((h, i) => (h.visible = shown[i]!));
    this.invalidate();
    return url;
  }

  snapshot(width = 480, height = 360, clean = false): string {
    // Thumbnails leave out helpers so only the model is pictured.
    const helpers = [this.grid, this.planeGroup, this.handleGroup, this.overlay, this.axes];
    const shown = helpers.map((h) => h.visible);
    if (clean) helpers.forEach((h) => (h.visible = false));
    const prev = this.renderer.getSize(new THREE.Vector2());
    // Pictures are of the whole model, without the room kept free for a sheet.
    this.persp.clearViewOffset();
    this.ortho.clearViewOffset();
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    const saved = { aspect: this.persp.aspect, fov: this.persp.fov, l: this.ortho.left, r: this.ortho.right };
    this.persp.aspect = aspect;
    this.persp.fov = fovFor(aspect);
    this.persp.updateProjectionMatrix();
    this.ortho.left = this.ortho.bottom * aspect;
    this.ortho.right = this.ortho.top * aspect;
    this.ortho.updateProjectionMatrix();
    // Clean shots frame the model tightly with the perspective camera.
    const box = new THREE.Box3().setFromObject(this.bodiesGroup);
    const cam = clean && !box.isEmpty() ? this.persp : this.camera;
    const pose = { pos: this.persp.position.clone(), quat: this.persp.quaternion.clone() };
    if (cam === this.persp && clean) {
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      // Always from the standard iso corner, whatever view the user was in (a top view pictures a square).
      const dir = new THREE.Vector3(...VIEWS.iso.dir).normalize();
      const fov = THREE.MathUtils.degToRad(this.persp.fov) / 2;
      const dist = sphere.radius / Math.sin(Math.min(fov, Math.atan(Math.tan(fov) * aspect))) * 1.02;
      this.persp.position.copy(sphere.center).addScaledVector(dir, dist);
      this.persp.up.set(...VIEWS.iso.up);
      this.persp.lookAt(sphere.center);
      this.persp.updateMatrixWorld();
    }
    this.renderer.render(this.scene, cam);
    const url = this.renderer.domElement.toDataURL("image/png");
    this.persp.position.copy(pose.pos);
    this.persp.quaternion.copy(pose.quat);
    this.persp.updateMatrixWorld();
    this.renderer.setSize(prev.x, prev.y, false);
    this.persp.aspect = saved.aspect;
    this.persp.fov = saved.fov;
    this.persp.updateProjectionMatrix();
    this.ortho.left = saved.l;
    this.ortho.right = saved.r;
    this.ortho.updateProjectionMatrix();
    this.applyInset();
    if (clean) helpers.forEach((h, i) => (h.visible = shown[i]!));
    return url;
  }

  private frame(): void {
    if (this.anim) {
      const t = Math.min(1, (performance.now() - this.anim.t0) / 350);
      const e = 1 - (1 - t) ** 3;
      this.camera.position.lerpVectors(this.anim.from, this.anim.to, e);
      this.camera.up.lerpVectors(this.anim.upFrom, this.anim.upTo, e).normalize();
      this.controls.target.lerpVectors(this.anim.targetFrom, this.anim.target, e);
      if (this.anim.zoomTo && this.anim.zoomFrom) {
        this.ortho.zoom = this.anim.zoomFrom + (this.anim.zoomTo - this.anim.zoomFrom) * e;
        this.ortho.updateProjectionMatrix();
      }
      if (t >= 1) this.anim = null;
      this.emit();
    }
    this.controls.update();
    if (this.changed) {
      this.changed = false;
      this.updateGrid();
      if (this.handles.length) this.drawHandles();
      for (const fn of this.listeners) fn();
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** Height in px of a panel covering the bottom of the view (phone sheets): the picture centres in the space above it. */
  private bottomInset = 0;
  /** Inset asked for while an arrow is being dragged: the picture must not move under the finger. */
  private pendingInset: number | null = null;
  setBottomInset(px: number): void {
    if (this.activeHandle) {
      this.pendingInset = px;
      return;
    }
    if (Math.abs(px - this.bottomInset) < 1) return;
    this.bottomInset = px;
    this.applyInset();
    this.emit();
  }
  private applyInset(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const shift = Math.round(this.bottomInset / 2);
    for (const cam of [this.persp, this.ortho]) {
      if (shift) cam.setViewOffset(w, h, 0, shift, w, h);
      else cam.clearViewOffset();
    }
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.persp.aspect = w / h;
    this.persp.fov = fovFor(w / h);
    this.persp.updateProjectionMatrix();
    const oh = this.ortho.top - this.ortho.bottom || 200;
    this.setOrthoSize(oh);
    this.applyInset();
    this.emit();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.renderer.setAnimationLoop(null);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  get data(): SceneData | null {
    return this.sceneData;
  }
}

// ---------------------------------------------------------------- helpers

/**
 * Wraps a pointermove handler so it runs at most once per frame, with the latest event. iPad
 * Safari delivers Apple Pencil moves at up to 240 Hz instead of once per frame; handling every one
 * builds a backlog that keeps the view updating long after the pen lifted. Call `flush()` before
 * handling pointerdown/up so they see the final position.
 */
export function perFrame<E>(fn: (e: E) => void): ((e: E) => void) & { flush(): void; cancel(): void } {
  let pending: E | null = null;
  let raf = 0;
  const run = () => {
    raf = 0;
    const e = pending;
    pending = null;
    if (e) fn(e);
  };
  const wrapped = (e: E) => {
    pending = e;
    if (!raf) raf = requestAnimationFrame(run);
  };
  return Object.assign(wrapped, {
    flush: () => {
      if (raf) cancelAnimationFrame(raf);
      run();
    },
    cancel: () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      pending = null;
    },
  });
}

export function frameMatrix(f: Frame): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.u), new THREE.Vector3(...f.v), new THREE.Vector3(...f.normal));
  m.setPosition(...f.origin);
  return m;
}

export function curvePoints(c: SketchCurveView): Vec2[] {
  if (c.kind === "line") return [c.a, c.b];
  if (c.kind === "spline") return c.pts;
  const [a0, sweep] = c.kind === "circle" ? [0, 2 * Math.PI] : [c.a0, (((c.a1 - c.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI];
  const n = Math.max(8, Math.ceil(sweep / (Math.PI / 48)));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push([c.center[0] + c.radius * Math.cos(a), c.center[1] + c.radius * Math.sin(a)]);
  }
  return pts;
}

const knobs = new Map<string, THREE.Texture>();
/**
 * Texture of a handle knob: a filled disc with a white rim and soft shadow, and white chevrons
 * pointing right (rotated to the drag direction when drawn); both ways when `twoWay`. Cached.
 */
function handleKnob(color: number, twoWay: boolean): THREE.Texture | null {
  const key = `${color}:${twoWay}`;
  const hit = knobs.get(key);
  if (hit) return hit;
  const S = 128;
  const canvas = typeof document === "undefined" ? null : document.createElement("canvas");
  const g = canvas?.getContext("2d");
  if (!canvas || !g) return null;
  canvas.width = canvas.height = S;
  const c = S / 2;
  g.shadowColor = "rgba(15, 23, 42, 0.35)";
  g.shadowBlur = 10;
  g.shadowOffsetY = 3;
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.arc(c, c, 50, 0, Math.PI * 2);
  g.fill();
  g.shadowColor = "transparent";
  g.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  g.beginPath();
  g.arc(c, c, 44, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "#ffffff";
  g.lineWidth = 8;
  g.lineCap = "round";
  g.lineJoin = "round";
  const chevron = (x: number, dir: 1 | -1, h: number) => {
    g.beginPath();
    g.moveTo(x - (h / 2) * dir, c - h);
    g.lineTo(x + (h / 2) * dir, c);
    g.lineTo(x - (h / 2) * dir, c + h);
    g.stroke();
  };
  if (twoWay) {
    chevron(c + 19, 1, 12);
    chevron(c - 19, -1, 12);
  } else chevron(c + 4, 1, 15);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  knobs.set(key, tex);
  return tex;
}

function disposeTree(g: THREE.Object3D): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
  g.clear();
}

function axesHelper(): THREE.Group {
  const g = new THREE.Group();
  const mk = (to: Vec3, color: number) => {
    // Hidden by parts in front of them, so they do not show through the model like scratches.
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...to)]), new THREE.LineBasicMaterial({ color }));
    line.renderOrder = 10;
    g.add(line);
  };
  mk([12, 0, 0], 0xe5484d);
  mk([0, 12, 0], 0x30a46c);
  mk([0, 0, 12], 0x3e63dd);
  return g;
}

/** Vertical field of view in landscape; portrait windows keep it as the horizontal one instead. */
const BASE_FOV = 40;
/** The vertical field of view for an aspect ratio: turning a phone keeps the model the same width. */
const fovFor = (aspect: number) => (aspect >= 1 ? BASE_FOV : (2 * Math.atan(Math.tan((BASE_FOV * Math.PI) / 360) / aspect) * 180) / Math.PI);

export function samePick(a: Pick | null, b: Pick | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "face":
      return a.bodyId === (b as typeof a).bodyId && a.face === (b as typeof a).face;
    case "edge":
      return a.bodyId === (b as typeof a).bodyId && a.edge === (b as typeof a).edge;
    case "region":
      return a.sketchId === (b as typeof a).sketchId && a.key === (b as typeof a).key;
    case "sketch_curve":
      return a.sketchId === (b as typeof a).sketchId && a.curveId === (b as typeof a).curveId;
    case "plane":
      return a.planeId === (b as typeof a).planeId;
  }
}

export { THREE };

/** Sketch lines are drawn this wide (screen pixels); plain WebGL lines are one pixel on Apple devices. */
export const SKETCH_LINE_WIDTH = 2.5;

/**
 * A line of a given width in screen pixels through the points (sketch curves, previews, guides).
 * `loop` closes it; `dashed` draws dashes in sketch units.
 */
export function fatLine(points: readonly (readonly [number, number] | THREE.Vector3)[], o: { color: number; width?: number; loop?: boolean; dashed?: { dash: number; gap: number }; depthTest?: boolean }): Line2 {
  const flat: number[] = [];
  const push = (p: readonly [number, number] | THREE.Vector3) => (p instanceof THREE.Vector3 ? flat.push(p.x, p.y, p.z) : flat.push(p[0], p[1], 0));
  points.forEach(push);
  if (o.loop && points.length) push(points[0]!);
  const geo = new LineGeometry();
  geo.setPositions(flat);
  const mat = new LineMaterial({ color: o.color, linewidth: o.width ?? SKETCH_LINE_WIDTH, depthTest: o.depthTest ?? false, dashed: !!o.dashed, dashSize: o.dashed?.dash ?? 1, gapSize: o.dashed?.gap ?? 1, transparent: true });
  const line = new Line2(geo, mat);
  if (o.dashed) line.computeLineDistances();
  return line;
}
