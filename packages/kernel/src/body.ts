import type { FaceInfo, Topology } from "@opencad/naming";
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
  readonly faces: TopoDS_Face[] = [];
  readonly edges: TopoDS_Edge[] = [];
  readonly edgeFaces: number[][];
  private readonly faceMap: ShapeIndex;
  private readonly edgeMap: ShapeIndex;
  private info: FaceInfo[] | null = null;

  constructor(
    private readonly oc: OC,
    readonly arena: Arena,
    readonly bodyId: string,
    readonly shape: TopoDS_Shape,
    /** Set exactly once by the creating feature via `setTags`. */
    public faceTags: string[][] = [],
  ) {
    let unique: TopoDS_Shape[];
    [this.faceMap, unique] = indexShapes(oc, arena, shape, "TopAbs_FACE");
    for (const s of unique) this.faces.push(arena.track(oc.TopoDS.Face(s)));
    [this.edgeMap, unique] = indexShapes(oc, arena, shape, "TopAbs_EDGE");
    for (const s of unique) this.edges.push(arena.track(oc.TopoDS.Edge(s)));
    this.edgeFaces = this.edges.map(() => []);
    this.faces.forEach((face, fi) => {
      const ex = arena.track(new oc.TopExp_Explorer(face, "TopAbs_EDGE"));
      for (; ex.More(); ex.Next()) {
        const ei = this.edgeIndex(arena.track(ex.Current()));
        const adj = this.edgeFaces[ei];
        if (adj && !adj.includes(fi)) adj.push(fi);
      }
    });
  }

  /** 0-based face index of a sub-shape of this body, or -1. */
  faceIndex(s: TopoDS_Shape): number {
    return this.faceMap.find(s);
  }

  edgeIndex(s: TopoDS_Shape): number {
    return this.edgeMap.find(s);
  }

  get faceInfo(): FaceInfo[] {
    if (!this.info) this.info = this.faces.map((f) => faceInfo(this.oc, this.arena, f));
    return this.info;
  }
}

const HASH_BOUND = 2147483647;

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
function indexShapes(oc: OC, arena: Arena, shape: TopoDS_Shape, type: "TopAbs_FACE" | "TopAbs_EDGE"): [ShapeIndex, TopoDS_Shape[]] {
  const index = new ShapeIndex(oc);
  const unique: TopoDS_Shape[] = [];
  const ex = arena.track(new oc.TopExp_Explorer(shape, type));
  for (; ex.More(); ex.Next()) {
    const s = arena.track(ex.Current());
    if (index.add(s) === unique.length) unique.push(s);
  }
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
