/**
 * Three.js viewport: renders tessellated bodies (Z up), highlights and picks faces/edges.
 * Picks are reported as indices plus the face tags, so the app can turn them into selectors.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

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

export type Pick =
  | { kind: "edge"; bodyId: string; edge: number; faceTags: [string[], string[]] }
  | { kind: "face"; bodyId: string; face: number; tags: string[] };

export interface ViewportOptions {
  onPick?: (pick: Pick | null, additive: boolean) => void;
  onHover?: (pick: Pick | null) => void;
}

const COLORS = {
  face: 0xb8c4d6,
  faceHover: 0x9fc2ff,
  faceSelected: 0x4f8cff,
  edge: 0x1d2433,
  edgeHover: 0x2f7bff,
  edgeSelected: 0xff7a1a,
};

interface BodyView {
  mesh: ViewMesh;
  group: THREE.Group;
  faces: THREE.Mesh;
  edges: THREE.LineSegments;
  /** Triangle index → face index. */
  triFace: Int32Array;
  /** Line segment index → edge index. */
  segEdge: Int32Array;
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly root = new THREE.Group();
  private bodies: BodyView[] = [];
  private hover: Pick | null = null;
  private selected: Pick[] = [];
  private framed = false;
  private disposed = false;
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: ViewportOptions = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);

    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(80, -100, 70);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, -2, 3);
    this.camera.add(key);
    this.scene.add(this.camera);
    this.scene.add(this.root);

    const grid = new THREE.GridHelper(200, 20, 0x8899aa, 0xc5ced8);
    grid.rotation.x = Math.PI / 2;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(grid);
    this.scene.add(new THREE.AxesHelper(15));

    this.raycaster.params.Line = { threshold: 1 };
    this.bindPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  setMeshes(meshes: readonly ViewMesh[]): void {
    for (const b of this.bodies) {
      b.faces.geometry.dispose();
      b.edges.geometry.dispose();
      (b.faces.material as THREE.Material).dispose();
      (b.edges.material as THREE.Material).dispose();
    }
    this.root.clear();
    this.bodies = meshes.map((m) => this.buildBody(m));
    for (const b of this.bodies) this.root.add(b.group);
    this.hover = null;
    this.selected = this.selected.filter((s) => this.bodies.some((b) => b.mesh.bodyId === s.bodyId));
    this.paint();
    if (!this.framed && meshes.length) {
      this.fit();
      this.framed = true;
    }
  }

  setSelection(picks: Pick[]): void {
    this.selected = picks;
    this.paint();
  }

  /** Frames all geometry. */
  fit(): void {
    const box = new THREE.Box3().setFromObject(this.root);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const dir = new THREE.Vector3(0.6, -0.8, 0.55).normalize();
    this.camera.position.copy(center).addScaledVector(dir, size * 1.6);
    this.camera.near = size / 100;
    this.camera.far = size * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
  }

  /** PNG of the current view (for AI vision feedback and thumbnails). */
  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
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

  private buildBody(mesh: ViewMesh): BodyView {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(mesh.positions.length), 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    const triFace = new Int32Array(mesh.indices.length / 3).fill(-1);
    for (let i = 0; i < mesh.faceRanges.length; i += 3) {
      triFace.fill(mesh.faceRanges[i + 2]!, mesh.faceRanges[i]! / 3, (mesh.faceRanges[i]! + mesh.faceRanges[i + 1]!) / 3);
    }
    const faces = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        metalness: 0.05,
        roughness: 0.6,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    );

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(mesh.edgeLines, 3));
    // Edge groups come as polylines; convert to segment pairs for LineSegments.
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
    const edges = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true }));

    const group = new THREE.Group();
    group.add(faces, edges);
    return { mesh, group, faces, edges, triFace, segEdge: Int32Array.from(segEdge) };
  }

  private paint(): void {
    const color = new THREE.Color();
    for (const b of this.bodies) {
      const faceColor = (face: number) => {
        if (this.selected.some((s) => s.kind === "face" && s.bodyId === b.mesh.bodyId && s.face === face)) return COLORS.faceSelected;
        if (this.hover?.kind === "face" && this.hover.bodyId === b.mesh.bodyId && this.hover.face === face) return COLORS.faceHover;
        return COLORS.face;
      };
      const fc = b.faces.geometry.getAttribute("color") as THREE.BufferAttribute;
      const idx = b.mesh.indices;
      for (let t = 0; t < b.triFace.length; t++) {
        color.setHex(faceColor(b.triFace[t]!));
        for (let k = 0; k < 3; k++) fc.setXYZ(idx[t * 3 + k]!, color.r, color.g, color.b);
      }
      fc.needsUpdate = true;

      const edgeColor = (edge: number) => {
        if (this.selected.some((s) => s.kind === "edge" && s.bodyId === b.mesh.bodyId && s.edge === edge)) return COLORS.edgeSelected;
        if (this.hover?.kind === "edge" && this.hover.bodyId === b.mesh.bodyId && this.hover.edge === edge) return COLORS.edgeHover;
        return COLORS.edge;
      };
      const ec = b.edges.geometry.getAttribute("color") as THREE.BufferAttribute;
      const segIdx = b.edges.geometry.getIndex()!;
      for (let s = 0; s < b.segEdge.length; s++) {
        color.setHex(edgeColor(b.segEdge[s]!));
        ec.setXYZ(segIdx.getX(s * 2), color.r, color.g, color.b);
        ec.setXYZ(segIdx.getX(s * 2 + 1), color.r, color.g, color.b);
      }
      ec.needsUpdate = true;
      (b.edges.material as THREE.LineBasicMaterial).linewidth = 1;
    }
  }

  private pickAt(ev: PointerEvent): Pick | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    // Line threshold in world units ≈ 6 px at the target distance.
    const dist = this.camera.position.distanceTo(this.controls.target);
    const worldPerPx = (2 * dist * Math.tan((this.camera.fov * Math.PI) / 360)) / rect.height;
    this.raycaster.params.Line = { threshold: worldPerPx * 6 };

    const faceHits = this.raycaster.intersectObjects(this.bodies.map((b) => b.faces), false);
    const edgeHits = this.raycaster.intersectObjects(this.bodies.map((b) => b.edges), false);
    const nearestFace = faceHits[0];
    // Prefer an edge if it is not hidden behind the nearest face.
    const edgeHit = edgeHits.find((h) => !nearestFace || h.distance <= nearestFace.distance + worldPerPx * 3);
    if (edgeHit && edgeHit.index !== undefined) {
      const b = this.bodies.find((x) => x.edges === edgeHit.object)!;
      const edge = b.segEdge[Math.floor(edgeHit.index / 2)] ?? -1;
      if (edge >= 0) {
        const [fa, fb] = b.mesh.edgeFaces[edge] ?? [];
        return {
          kind: "edge",
          bodyId: b.mesh.bodyId,
          edge,
          faceTags: [b.mesh.faceTags[fa ?? -1] ?? [], b.mesh.faceTags[fb ?? -1] ?? []],
        };
      }
    }
    if (nearestFace && nearestFace.faceIndex !== undefined && nearestFace.faceIndex !== null) {
      const b = this.bodies.find((x) => x.faces === nearestFace.object)!;
      const face = b.triFace[nearestFace.faceIndex] ?? -1;
      if (face >= 0) return { kind: "face", bodyId: b.mesh.bodyId, face, tags: b.mesh.faceTags[face] ?? [] };
    }
    return null;
  }

  private bindPointer(): void {
    const el = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    el.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener("pointermove", (e) => {
      if (e.buttons) return;
      const p = this.pickAt(e);
      if (!samePick(p, this.hover)) {
        this.hover = p;
        this.paint();
        this.opts.onHover?.(p);
      }
    });
    el.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      down = null;
      this.opts.onPick?.(this.pickAt(e), e.shiftKey || e.metaKey || e.ctrlKey);
    });
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

export function samePick(a: Pick | null, b: Pick | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.bodyId !== b.bodyId) return false;
  return a.kind === "edge" ? a.edge === (b as typeof a).edge : a.face === (b as typeof a).face;
}
