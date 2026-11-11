import type { FaceInfo, Topology } from "@meercad/naming";
import type {
  NCollection_List_TopoDS_Shape,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
} from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import type { OC } from "./occt.js";

/**
 * A solid plus the persistent tags of its faces. Face/edge indices are 0-based positions in the
 * shape's indexed face/edge maps, so they are stable for a given shape.
 */
export class Body implements Topology {
  readonly faces: TopoDS_Face[];
  readonly edges: TopoDS_Edge[];
  readonly edgeFaces: number[][];
  private readonly faceMap: ShapeIndex;
  private readonly edgeMap: ShapeIndex;
  private info: FaceInfo[] | null = null;
  /**
   * For a body made from an imported mesh: its triangles (corner positions in triangle order, one
   * face per triangle in the same order). Display and export use them directly instead of
   * re-meshing thousands of triangle faces, which OCCT does slowly and with a lot of memory.
   */
  sourceMesh: Float32Array | null = null;
  /** Volume and inertia need the precise integral (long curved sweeps, where the quick one is several per cent off). */
  preciseProps = false;
  /** The import feature whose file `sourceMesh` comes from (triangle i is the file's triangle i). */
  sourceFeature: string | null = null;
  /**
   * Looser display tessellation for this body (a factor like the session's `meshCoarse`): set by
   * generators of very large, detailed parts (a baseplate for a whole floor) so the view stays
   * light. Export meshes are not affected.
   */
  displayCoarse = 1;
  /**
   * Export tolerances for this body instead of the usual print quality (see exportTolerance): for
   * parts whose small rounds do not need it and that would otherwise make files of many millions
   * of triangles.
   */
  exportTolerance: { linear: number; angular: number } | null = null;
  private samples: { faces: Vec3[]; edges: Vec3[] } | null = null;

  constructor(
    private readonly oc: OC,
    readonly arena: Arena,
    readonly bodyId: string,
    readonly shape: TopoDS_Shape,
    /** Set exactly once by the creating feature via `setTags`. */
    public faceTags: string[][] = [],
  ) {
    // Only the faces and edges themselves are kept. What an explorer hands out on the way is freed
    // at once: a state keeps its shapes for as long as the design is open (Arena.trim), and a big
    // design (1100 steps) held 1.5 million of these for nothing, 350 MB of the kernel worker.
    [this.faceMap, this.faces] = indexShapes(oc, arena, shape, "TopAbs_FACE", (s) => oc.TopoDS.Face(s));
    [this.edgeMap, this.edges] = indexShapes(oc, arena, shape, "TopAbs_EDGE", (s) => oc.TopoDS.Edge(s));
    this.edgeFaces = this.edges.map(() => []);
    this.faces.forEach((face, fi) => {
      const ex = new oc.TopExp_Explorer(face, "TopAbs_EDGE");
      for (; ex.More(); ex.Next()) {
        const edge = ex.Current();
        const ei = this.edgeIndex(edge);
        edge.delete();
        const adj = this.edgeFaces[ei];
        if (adj && !adj.includes(fi)) adj.push(fi);
      }
      ex.delete();
    });
  }

  /** 0-based face index of a sub-shape of this body, or -1. */
  faceIndex(s: TopoDS_Shape): number {
    return this.faceMap.find(s);
  }

  edgeIndex(s: TopoDS_Shape): number {
    return this.edgeMap.find(s);
  }

  /** A point inside each face (triangle centroid) and on each edge (polyline midpoint). */
  get facePoints(): Vec3[] {
    return (this.samples ??= samplePoints(this.oc, this)).faces;
  }

  get edgePoints(): Vec3[] {
    return (this.samples ??= samplePoints(this.oc, this)).edges;
  }

  get faceInfo(): FaceInfo[] {
    if (!this.info) this.info = this.faces.map((f) => faceInfo(this.oc, this.arena, f));
    return this.info;
  }
}

export const HASH_BOUND = 2147483647;
type Vec3 = [number, number, number];

function samplePoints(oc: OC, body: Body): { faces: Vec3[]; edges: Vec3[] } {
  const faceByHash = new Map<number, number>();
  body.faces.forEach((f, i) => faceByHash.set(oc.ReplicadShapeHasher.HashCode(f, HASH_BOUND), i));
  const edgeByHash = new Map<number, number>();
  body.edges.forEach((e, i) => edgeByHash.set(oc.ReplicadShapeHasher.HashCode(e, HASH_BOUND), i));
  const m = oc.ReplicadMeshExtractor.extract(body.shape, 0.1, 0.5, true);
  const em = oc.ReplicadEdgeMeshExtractor.extract(body.shape, 0.1, 0.5);
  try {
    const buf = oc.wasmMemory.buffer;
    const pos = new Float32Array(buf, m.getVerticesPtr() >>> 0, m.getVerticesSize());
    const tri = new Uint32Array(buf, m.getTrianglesPtr() >>> 0, m.getTrianglesSize());
    const groups = new Int32Array(buf, m.getFaceGroupsPtr() >>> 0, m.getFaceGroupsSize());
    const faces: Vec3[] = body.faces.map(() => [0, 0, 0]);
    for (let g = 0; g < groups.length; g += 3) {
      const fi = faceByHash.get(groups[g + 2]!);
      if (fi === undefined || groups[g + 1]! < 3) continue;
      // Centroid of the largest triangle: robust inside point even for thin faces.
      let best = -1;
      let bestArea = -1;
      for (let t = groups[g]!; t < groups[g]! + groups[g + 1]!; t += 3) {
        const [a, b, c] = [tri[t]! * 3, tri[t + 1]! * 3, tri[t + 2]! * 3];
        const u = [pos[b]! - pos[a]!, pos[b + 1]! - pos[a + 1]!, pos[b + 2]! - pos[a + 2]!];
        const v = [pos[c]! - pos[a]!, pos[c + 1]! - pos[a + 1]!, pos[c + 2]! - pos[a + 2]!];
        const area = Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
        if (area > bestArea) {
          bestArea = area;
          best = t;
        }
      }
      const [a, b, c] = [tri[best]! * 3, tri[best + 1]! * 3, tri[best + 2]! * 3];
      faces[fi] = [0, 1, 2].map((k) => (pos[a + k]! + pos[b + k]! + pos[c + k]!) / 3) as Vec3;
    }
    const lines = new Float32Array(buf, em.getLinesPtr() >>> 0, em.getLinesSize());
    const eg = new Int32Array(buf, em.getEdgeGroupsPtr() >>> 0, em.getEdgeGroupsSize());
    const edges: Vec3[] = body.edges.map(() => [0, 0, 0]);
    for (let g = 0; g < eg.length; g += 3) {
      const ei = edgeByHash.get(eg[g + 2]!);
      if (ei === undefined || eg[g + 1]! < 1) continue;
      const count = eg[g + 1]!;
      if (count % 2 === 0) {
        const a = (eg[g]! + count / 2 - 1) * 3;
        const b = (eg[g]! + count / 2) * 3;
        edges[ei] = [0, 1, 2].map((k) => (lines[a + k]! + lines[b + k]!) / 2) as Vec3;
      } else {
        const a = (eg[g]! + (count - 1) / 2) * 3;
        edges[ei] = [lines[a]!, lines[a + 1]!, lines[a + 2]!];
      }
    }
    return { faces, edges };
  } finally {
    m.delete();
    em.delete();
  }
}

/** Index of distinct shapes with `IsSame` semantics (same TShape and location, any orientation). */
class ShapeIndex {
  private buckets = new Map<number, { shape: TopoDS_Shape; index: number }[]>();
  private count = 0;

  constructor(private readonly oc: OC) {}

  /** Adds the shape if new; returns its 0-based index. */
  add(s: TopoDS_Shape): number {
    const h = this.oc.ReplicadShapeHasher.HashCode(s, HASH_BOUND);
    let bucket = this.buckets.get(h);
    if (!bucket) this.buckets.set(h, (bucket = []));
    const hit = bucket.find((b) => b.shape.IsSame(s));
    if (hit) return hit.index;
    bucket.push({ shape: s, index: this.count });
    return this.count++;
  }

  find(s: TopoDS_Shape): number {
    const bucket = this.buckets.get(this.oc.ReplicadShapeHasher.HashCode(s, HASH_BOUND));
    return bucket?.find((b) => b.shape.IsSame(s))?.index ?? -1;
  }
}

/** Index of the distinct sub-shapes of a type, plus those shapes in index order. */
/** The distinct faces or edges of a shape in the order an explorer meets them, as `cast` makes them, and their index. */
function indexShapes<T extends TopoDS_Shape>(oc: OC, arena: Arena, shape: TopoDS_Shape, type: "TopAbs_FACE" | "TopAbs_EDGE", cast: (s: TopoDS_Shape) => T): [ShapeIndex, T[]] {
  const index = new ShapeIndex(oc);
  const unique: T[] = [];
  const ex = new oc.TopExp_Explorer(shape, type);
  for (; ex.More(); ex.Next()) {
    const s = ex.Current();
    if (index.find(s) === -1) {
      const typed = arena.track(cast(s));
      index.add(typed);
      unique.push(typed);
    }
    s.delete();
  }
  ex.delete();
  return [index, unique];
}

function faceInfo(oc: OC, arena: Arena, face: TopoDS_Face): FaceInfo {
  const props = arena.track(new oc.GProp_GProps());
  oc.BRepGProp.SurfaceProperties(face, props, false, false);
  const surf = arena.track(new oc.BRepAdaptor_Surface(face, true));
  if (surf.GetType() !== "GeomAbs_Plane") return { planar: false, normal: null, area: props.Mass() };
  const d = arena.track(arena.track(arena.track(surf.Plane()).Axis()).Direction());
  const s = face.Orientation() === "TopAbs_REVERSED" ? -1 : 1;
  return { planar: true, normal: [s * d.X(), s * d.Y(), s * d.Z()], area: props.Mass() };
}

/** Drains an OCCT list into an array (the list is consumed). */
export function listToArray(arena: Arena, list: NCollection_List_TopoDS_Shape): TopoDS_Shape[] {
  const out: TopoDS_Shape[] = [];
  while (!list.IsEmpty()) {
    out.push(arena.track(list.First()));
    list.RemoveFirst();
  }
  list.delete();
  return out;
}
