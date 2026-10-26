/**
 * Three.js viewport (Z up). Renders bodies, sketches, planes and reference meshes; picks with
 * filters; maps screen points onto sketch planes; drives standard views for the view cube.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

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
  | { id: string; kind: "arc"; center: Vec2; radius: number; a0: number; a1: number; construction: boolean; external: boolean };

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
}

export interface ReferenceMeshView {
  id: string;
  positions: Float32Array;
  indices: Uint32Array;
}

export type Pick =
  | { kind: "face"; bodyId: string; face: number; tags: string[]; point: Vec3; normal: Vec3 | null }
  | { kind: "edge"; bodyId: string; edge: number; point: Vec3 }
  | { kind: "region"; sketchId: string; key: string; point: Vec3 }
  | { kind: "sketch_curve"; sketchId: string; curveId: string; point: Vec3 }
  | { kind: "plane"; planeId: string; point: Vec3 };

export type PickKind = Pick["kind"];

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
}

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

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** Objects owned by tools (sketch editor, measure markers, manipulators). */
  readonly overlay = new THREE.Group();
  private persp = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
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
  private grid: THREE.GridHelper;
  private sceneData: SceneData | null = null;
  handles: Handle[] = [];
  private handleGroup = new THREE.Group();
  private activeHandle: { h: Handle; value: number } | null = null;
  private hoverHandle: string | null = null;
  /** Reports the value being dragged and its screen position (for a value tooltip). */
  onHandleDrag: ((h: Handle | null, value: number, screen: Vec2 | null) => void) | null = null;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    this.bindHandles();
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

    this.grid = new THREE.GridHelper(400, 40, 0x9aa7b6, 0xd3dae2);
    this.grid.rotation.x = Math.PI / 2;
    const gm = this.grid.material as THREE.Material;
    gm.transparent = true;
    gm.opacity = 0.35;
    gm.depthWrite = false;
    this.scene.add(this.grid, this.planeGroup, this.bodiesGroup, this.refGroup, this.sketchGroup, this.overlay, this.handleGroup);
    this.scene.add(axesHelper());

    // Shift+right-drag pans (for trackpads without a middle button).
    this.renderer.domElement.addEventListener("pointerdown", (e) => {
      this.controls.mouseButtons.RIGHT = e.shiftKey ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    }, { capture: true });
    this.renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------------------------------------------------------------- scene

  setScene(data: SceneData): void {
    this.sceneData = data;
    this.rebuildBodies(data);
    this.rebuildSketches(data);
    this.rebuildPlanes(data.planes);
    this.rebuildReferences(data.references);
    this.selected = this.selected.filter((s) => this.pickStillValid(s));
    if (this.hover && !this.pickStillValid(this.hover)) this.hover = null;
    this.paint();
    if (!this.framed && (data.bodies.length || data.sketches.length)) {
      this.framed = true;
      this.fit(false);
    }
  }

  get hovered(): Pick | null {
    return this.hover;
  }

  setHover(p: Pick | null): void {
    if (samePick(p, this.hover)) return;
    this.hover = p;
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
    const segIndex: number[] = [];
    const segEdge: number[] = [];
    for (let i = 0; i < mesh.edgeRanges.length; i += 3) {
      const start = mesh.edgeRanges[i]!;
      const count = mesh.edgeRanges[i + 1]!;
      for (let k = start; k < start + count - 1; k++) {
        segIndex.push(k, k + 1);
        segEdge.push(mesh.edgeRanges[i + 2]!);
      }
    }
    lineGeo.setIndex(segIndex);
    lineGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(mesh.edgeLines.length), 3));
    lineGeo.computeBoundingSphere();
    const edges = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: ghost, opacity: ghost ? 0.35 : 1 }));
    edges.userData = { body: mesh.bodyId };
    const group = new THREE.Group();
    group.add(faces, edges);
    return { mesh, group, faces, edges, triFace, segEdge: Int32Array.from(segEdge) };
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
        const pts = curvePoints(c);
        const geo = new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => new THREE.Vector3(x, y, 0)));
        const color = c.external ? C.sketchExternal : c.construction ? C.sketchConstruction : C.sketch;
        const mat = c.construction ? new THREE.LineDashedMaterial({ color, dashSize: 1.5, gapSize: 1, depthTest: false }) : new THREE.LineBasicMaterial({ color, depthTest: false });
        const line = new THREE.Line(geo, mat);
        if (c.construction) line.computeLineDistances();
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
      const fill = new THREE.Mesh(
        new THREE.PlaneGeometry(s, s),
        new THREE.MeshBasicMaterial({ color: C.plane, transparent: true, opacity: 0.04, side: THREE.DoubleSide, depthWrite: false }),
      );
      fill.position.set(s / 2, s / 2, 0);
      fill.userData = { plane: p.id };
      const border = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(s, 0, 0), new THREE.Vector3(s, s, 0), new THREE.Vector3(0, s, 0)]),
        new THREE.LineBasicMaterial({ color: C.plane, transparent: true, opacity: 0.4 }),
      );
      border.userData = { plane: p.id };
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

  setPlanesVisible(v: boolean): void {
    this.planeGroup.visible = v;
  }
  setSketchesVisible(v: boolean): void {
    this.sketchGroup.visible = v;
  }
  setGridVisible(v: boolean): void {
    this.grid.visible = v;
  }

  // ---------------------------------------------------------------- highlight

  private paint(): void {
    for (const b of this.bodies) {
      const isSel = (k: "face" | "edge", i: number) => this.selected.some((s) => s.kind === k && s.bodyId === b.mesh.bodyId && (k === "face" ? (s as { face: number }).face : (s as { edge: number }).edge) === i);
      const h = this.hover;
      const isHover = (k: "face" | "edge", i: number) =>
        !!h && h.kind === k && (h.kind === "face" || h.kind === "edge") && h.bodyId === b.mesh.bodyId && (h.kind === "face" ? h.face : h.edge) === i;
      const fc = b.faces.geometry.getAttribute("color") as THREE.BufferAttribute;
      const idx = b.mesh.indices;
      const colors = new Map<number, THREE.Color>();
      const faceColor = (f: number) => {
        let c = colors.get(f);
        if (!c) {
          c = isSel("face", f) ? C.faceSel : isHover("face", f) ? C.faceHover : C.face;
          colors.set(f, c);
        }
        return c;
      };
      for (let t = 0; t < b.triFace.length; t++) {
        const c = faceColor(b.triFace[t]!);
        for (let k = 0; k < 3; k++) fc.setXYZ(idx[t * 3 + k]!, c.r, c.g, c.b);
      }
      fc.needsUpdate = true;
      const ec = b.edges.geometry.getAttribute("color") as THREE.BufferAttribute;
      const segIdx = b.edges.geometry.getIndex()!;
      for (let s = 0; s < b.segEdge.length; s++) {
        const e = b.segEdge[s]!;
        const c = isSel("edge", e) ? C.edgeSel : isHover("edge", e) ? C.edgeHover : C.edge;
        ec.setXYZ(segIdx.getX(s * 2), c.r, c.g, c.b);
        ec.setXYZ(segIdx.getX(s * 2 + 1), c.r, c.g, c.b);
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
    this.planeGroup.traverse((o) => {
      const { plane } = o.userData as { plane?: string };
      if (plane === undefined || !(o instanceof THREE.Mesh)) return;
      const sel = this.selected.some((s) => s.kind === "plane" && s.planeId === plane);
      const hov = this.hover?.kind === "plane" && this.hover.planeId === plane;
      (o.material as THREE.MeshBasicMaterial).opacity = sel ? 0.3 : hov ? 0.18 : 0.04;
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
    return this.pixelSize(h.origin) * 28;
  }

  private handleTip(h: Handle, value = h.value): THREE.Vector3 {
    const d = new THREE.Vector3(...h.dir).normalize();
    return new THREE.Vector3(...h.origin).addScaledVector(d, value + this.handleBase(h));
  }

  private drawHandles(): void {
    disposeTree(this.handleGroup);
    for (const h0 of this.handles) {
      const h = this.activeHandle?.h.id === h0.id ? { ...h0, value: this.activeHandle.value } : h0;
      const px = this.pixelSize(h.origin);
      const d = new THREE.Vector3(...h.dir).normalize();
      const o = new THREE.Vector3(...h.origin);
      const tip = this.handleTip(h);
      const hot = this.activeHandle?.h.id === h.id || this.hoverHandle === h.id;
      const color = hot ? 0xff7a1a : 0x2f6fed;
      const shaft = new THREE.Line(new THREE.BufferGeometry().setFromPoints([o, tip]), new THREE.LineBasicMaterial({ color, depthTest: false }));
      shaft.renderOrder = 50;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(px * 5.5, px * 16, 20), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      cone.position.copy(tip);
      const up = new THREE.Vector3(0, 1, 0);
      cone.quaternion.setFromUnitVectors(up, h.value < 0 ? d.clone().negate() : d);
      cone.renderOrder = 51;
      const base = new THREE.Mesh(new THREE.SphereGeometry(px * 3.5, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      base.position.copy(o);
      base.renderOrder = 51;
      this.handleGroup.add(shaft, cone, base);
    }
  }

  private hitHandle(clientX: number, clientY: number): Handle | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    let best: Handle | null = null;
    let bd = 16;
    for (const h of this.handles) {
      const tip = this.handleTip(h);
      const s = this.worldToScreen([tip.x, tip.y, tip.z]);
      if (!s) continue;
      const dist = Math.hypot(s[0] + r.left - clientX, s[1] + r.top - clientY);
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

  private snapStep(at: Vec3): number {
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
        if (e.button !== 0) return;
        const h = this.hitHandle(e.clientX, e.clientY);
        if (!h) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        const t = this.axisParam(h, e.clientX, e.clientY);
        // Offset between where the arrow was grabbed and its value, so it does not jump.
        grab = (t ?? 0) - (h.value + this.handleBase(h));
        this.activeHandle = { h, value: h.value };
        h.onStart?.();
      },
      { capture: true },
    );
    el.addEventListener(
      "pointermove",
      (e) => {
        const a = this.activeHandle;
        if (!a) {
          const hit = this.hitHandle(e.clientX, e.clientY)?.id ?? null;
          if (hit !== this.hoverHandle) {
            this.hoverHandle = hit;
            el.style.cursor = hit ? "grab" : "";
            this.drawHandles();
          }
          if (hit) e.stopImmediatePropagation();
          return;
        }
        e.stopImmediatePropagation();
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
      },
      { capture: true },
    );
    const end = (e: PointerEvent) => {
      const a = this.activeHandle;
      if (!a) return;
      e.stopImmediatePropagation();
      this.activeHandle = null;
      el.style.cursor = "";
      this.onHandleDrag?.(null, a.value, null);
      a.h.onEnd(a.value);
      this.drawHandles();
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
        const n = faceHit.face?.normal;
        return { kind: "face", bodyId: b.mesh.bodyId, face, tags: b.mesh.faceTags[face] ?? [], point: v3(faceHit.point), normal: n ? [n.x, n.y, n.z] : null };
      }
    }
    if (kinds.has("plane") && this.planeGroup.visible) {
      const hit = ray.intersectObject(this.planeGroup, true).find((h) => h.object instanceof THREE.Mesh && h.distance <= occlusion);
      if (hit) return { kind: "plane", planeId: (hit.object.userData as { plane: string }).plane, point: v3(hit.point) };
    }
    return null;
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
    const dist = this.camera === this.ortho ? size * 4 : size * 1.4 / Math.tan((this.persp.fov * Math.PI) / 360) / 2;
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
    return (this.ortho.top - this.ortho.bottom) / size;
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

  private emit(): void {
    if (this.handles.length) this.drawHandles();
    for (const fn of this.listeners) fn();
  }

  snapshot(width = 480, height = 360): string {
    const prev = this.renderer.getSize(new THREE.Vector2());
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    const saved = { aspect: this.persp.aspect, l: this.ortho.left, r: this.ortho.right };
    this.persp.aspect = aspect;
    this.persp.updateProjectionMatrix();
    this.ortho.left = this.ortho.bottom * aspect;
    this.ortho.right = this.ortho.top * aspect;
    this.ortho.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL("image/png");
    this.renderer.setSize(prev.x, prev.y, false);
    this.persp.aspect = saved.aspect;
    this.persp.updateProjectionMatrix();
    this.ortho.left = saved.l;
    this.ortho.right = saved.r;
    this.ortho.updateProjectionMatrix();
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
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    const oh = this.ortho.top - this.ortho.bottom || 200;
    this.setOrthoSize(oh);
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

export function frameMatrix(f: Frame): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.u), new THREE.Vector3(...f.v), new THREE.Vector3(...f.normal));
  m.setPosition(...f.origin);
  return m;
}

export function curvePoints(c: SketchCurveView): Vec2[] {
  if (c.kind === "line") return [c.a, c.b];
  const [a0, sweep] = c.kind === "circle" ? [0, 2 * Math.PI] : [c.a0, (((c.a1 - c.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI];
  const n = Math.max(8, Math.ceil(sweep / (Math.PI / 48)));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push([c.center[0] + c.radius * Math.cos(a), c.center[1] + c.radius * Math.sin(a)]);
  }
  return pts;
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
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...to)]), new THREE.LineBasicMaterial({ color, depthTest: false }));
    line.renderOrder = 10;
    g.add(line);
  };
  mk([12, 0, 0], 0xe5484d);
  mk([0, 12, 0], 0x30a46c);
  mk([0, 0, 12], 0x3e63dd);
  return g;
}

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
