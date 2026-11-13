/**
 * Turns an imported triangle mesh into a solid with real faces: the surfaces `fitMesh` recognised
 * become planar, cylindrical, conical and spherical faces bounded by lines, circle arcs and
 * B-splines; triangles that no surface claimed stay flat facets. Neighbouring faces share their
 * edges, the faces are sewn and fixed into a solid, and the result is checked against the mesh.
 */
import { FeatureError } from "@meercad/model";
import type { Geom_Surface, TopoDS_Edge, TopoDS_Face, TopoDS_Shape, TopoDS_Vertex, TopoDS_Wire, gp_Dir, gp_Pnt } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import { basis, demoteRegions, fitCircle, fitMesh, primitiveNormal, unit, type FitOptions, type MeshFit, type Primitive, type Region, type Vec3 } from "./meshfit.js";
import { occtErrorMessage, type OC } from "./occt.js";

/** More flat facets than this and the result would be as slow to display as the mesh was. */
export const MAX_FACETS = 1500;

export interface ConvertResult {
  shape: TopoDS_Shape;
  fit: MeshFit;
  /** Region index of a face of `shape`, or -1. */
  regionOf: (face: TopoDS_Face) => number;
  /** Faces per kind, for reporting. */
  counts: Record<Primitive["kind"] | "facet", number>;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const COS_1DEG = Math.cos(Math.PI / 180);

export function convertMesh(oc: OC, arena: Arena, corners: ArrayLike<number>, opts: FitOptions = {}): ConvertResult {
  let fit = fitMesh(corners, opts);
  const tooMany = () => {
    // Every face costs OCCT's mesher dearly: more than this and the result is as slow as the mesh was.
    if (fit.regions.length <= MAX_FACETS) return;
    const facets = fit.regions.filter((r) => !r.primitive).length;
    const pct = Math.round((fit.regions.filter((r) => !r.primitive || r.triangles.length <= 2).reduce((s, r) => s + r.area, 0) / fit.regions.reduce((s, r) => s + r.area, 0)) * 100);
    throw new FeatureError(`the part is mostly freeform: ${fit.regions.length} faces, ${pct}% of the surface matches no plane, cylinder, cone or sphere (${facets} loose triangles)`, "a larger tolerance may help; freeform parts stay meshes");
  };
  tooMany();
  // Surfaces OCCT cannot make a valid face from (a sphere patch over a pole, a twisted boundary)
  // fall back to their triangles, and the solid is built again.
  for (let round = 0; ; round++) {
    const b = new Builder(oc, arena, fit);
    const faces: TopoDS_Face[] = [];
    // Full bands first: the faces next to them reuse their circle edges.
    for (const r of [...fit.regions].sort((x, y) => Number(b.isBand(y)) - Number(b.isBand(x)))) {
      const face = b.face(r);
      if (face) faces.push(face);
    }
    const built = b.solid(faces);
    if (built.ok) {
      const counts: ConvertResult["counts"] = { plane: 0, cylinder: 0, cone: 0, sphere: 0, facet: 0 };
      for (const r of fit.regions) counts[r.primitive?.kind ?? "facet"]++;
      const f = fit;
      return { shape: built.shape, fit: f, regionOf: (face) => b.regionOf(face), counts };
    }
    // OCCT finds a face invalid only for meshes no test reproduces (seen on real scans): the
    // primitives on those faces are turned back into facets and the solid built again.
    /* v8 ignore start */
    const bad = new Set<number>();
    for (const face of built.invalidFaces) {
      const ri = b.regionOf(face);
      if (ri >= 0 && fit.regions[ri]!.primitive) bad.add(ri);
    }
    if (!bad.size || round >= 3) throw new FeatureError("the converted solid is not valid", "a larger tolerance may help");
    fit = demoteRegions(fit, bad);
    tooMany();
    /* v8 ignore stop */
  }
}

class Builder {
  private readonly vertices = new Map<number, TopoDS_Vertex>();
  private readonly edges = new Map<number, TopoDS_Edge[]>();
  private readonly tol: number;

  constructor(
    private readonly oc: OC,
    private readonly arena: Arena,
    private readonly fit: MeshFit,
  ) {
    this.tol = fit.tolerance;
  }

  private p(i: number): Vec3 {
    const q = this.fit.positions;
    return [q[i * 3]!, q[i * 3 + 1]!, q[i * 3 + 2]!];
  }
  private pnt(v: Vec3): gp_Pnt {
    return this.arena.track(new this.oc.gp_Pnt(v[0], v[1], v[2]));
  }
  private dir(v: Vec3): gp_Dir {
    return this.arena.track(new this.oc.gp_Dir(v[0], v[1], v[2]));
  }
  private vertex(i: number): TopoDS_Vertex {
    let v = this.vertices.get(i);
    if (!v) {
      v = this.arena.track(this.arena.track(new this.oc.BRepBuilderAPI_MakeVertex(this.pnt(this.p(i)))).Vertex());
      this.vertices.set(i, v);
    }
    return v;
  }
  private line(a: number, b: number): TopoDS_Edge {
    return this.arena.track(this.arena.track(new this.oc.BRepBuilderAPI_MakeEdge(this.vertex(a), this.vertex(b))).Edge());
  }

  // ------------------------------------------------------------ edges

  /** The edge(s) of a segment, built once and shared by the two faces on either side. */
  private segmentEdges(si: number): TopoDS_Edge[] {
    const cached = this.edges.get(si);
    if (cached) return cached;
    const seg = this.fit.segments[si]!;
    const vs = seg.vertices;
    const a = this.fit.regions[seg.a]?.primitive ?? null;
    const b = seg.b >= 0 ? (this.fit.regions[seg.b]?.primitive ?? null) : null;
    let out: TopoDS_Edge[] | null = null;
    if (vs.length === 2 || (a?.kind === "plane" && b?.kind === "plane")) out = [this.line(vs[0]!, vs[vs.length - 1]!)];
    else {
      const axis = circleAxis(a, b, this.tol);
      if (axis) out = this.arc(vs, seg.closed, axis);
      if (!out && a && b) out = this.spline(vs, seg.closed);
      // Next to a flat facet the boundary is the facet's own straight edges.
      if (!out) out = vs.slice(1).map((v, i) => this.line(vs[i]!, v));
    }
    this.edges.set(si, out);
    return out;
  }

  /** A circle (closed) or arc through the segment's vertices around a known axis direction; null if they don't lie on one. */
  private arc(vs: number[], closed: boolean, axis: Vec3): TopoDS_Edge[] | null {
    const pts = (closed ? vs.slice(0, -1) : vs).map((v) => this.p(v));
    const [e1, e2] = basis(axis);
    const circle = fitCircle(pts.map((q): [number, number] => [dot(q, e1), dot(q, e2)]));
    if (!circle) return null;
    let depth = 0;
    for (const q of pts) depth += dot(q, axis);
    depth /= pts.length;
    const center = add(add(scale(e1, circle.cx), scale(e2, circle.cy)), scale(axis, depth));
    if (pts.some((q) => Math.abs(len(sub(sub(q, center), scale(axis, dot(sub(q, center), axis)))) - circle.r) > this.tol * 2 || Math.abs(dot(sub(q, center), axis)) > this.tol * 2)) return null;
    const start = this.p(vs[0]!);
    const xdir = unit(sub(sub(start, center), scale(axis, dot(sub(start, center), axis))));
    const ang = (q: Vec3) => {
      const d = sub(q, center);
      return Math.atan2(dot(d, cross(axis, xdir)), dot(d, xdir));
    };
    // The arc from the first to the last vertex must pass the middle one: otherwise run it the other way.
    let n: Vec3 = axis;
    if (!closed) {
      const mid = ang(this.p(vs[Math.floor(vs.length / 2)]!));
      const end = ang(this.p(vs[vs.length - 1]!));
      const norm = (x: number) => (x < 0 ? x + 2 * Math.PI : x);
      if (norm(mid) > norm(end)) n = scale(axis, -1);
    }
    const circ = this.arena.track(new this.oc.gp_Circ(this.arena.track(new this.oc.gp_Ax2(this.pnt(center), this.dir(n), this.dir(xdir))), circle.r));
    try {
      const mk = closed
        ? this.arena.track(new this.oc.BRepBuilderAPI_MakeEdge(circ))
        : this.arena.track(new this.oc.BRepBuilderAPI_MakeEdge(circ, this.vertex(vs[0]!), this.vertex(vs[vs.length - 1]!)));
      if (!mk.IsDone()) return null;
      return [this.arena.track(mk.Edge())];
      /* v8 ignore start -- OCCT refuses an edge here only for degenerate input no test reproduces: the caller falls back to straight edges */
    } catch {
      return null;
    }
    /* v8 ignore stop */
  }

  private spline(vs: number[], closed: boolean): TopoDS_Edge[] | null {
    const pts = vs.map((v) => this.p(v));
    // Drop repeated points: the interpolation needs distinct ones.
    const distinct = pts.filter((q, i) => i === 0 || len(sub(q, pts[i - 1]!)) > this.tol * 0.1);
    if (distinct.length < 3) return null;
    try {
      const arr = this.arena.track(new this.oc.NCollection_Array1_gp_Pnt(1, distinct.length));
      distinct.forEach((q, i) => arr.SetValue(i + 1, this.pnt(q)));
      const mk = this.arena.track(new this.oc.GeomAPI_PointsToBSpline(arr, 3, 8, "GeomAbs_C2", this.tol * 0.1));
      if (!mk.IsDone()) return null;
      const curve = this.arena.track(mk.Curve());
      const me = closed
        ? this.arena.track(new this.oc.BRepBuilderAPI_MakeEdge(curve))
        : this.arena.track(new this.oc.BRepBuilderAPI_MakeEdge(curve, this.vertex(vs[0]!), this.vertex(vs[vs.length - 1]!)));
      if (!me.IsDone()) return null;
      return [this.arena.track(me.Edge())];
      /* v8 ignore start -- OCCT refuses an edge here only for degenerate input no test reproduces: the caller falls back to straight edges */
    } catch {
      return null;
    }
    /* v8 ignore stop */
  }

  // ------------------------------------------------------------ faces

  isBand(r: Region): boolean {
    return !!r.primitive && r.primitive.kind !== "plane" && !!this.bandRange(r.primitive, r);
  }

  /** The band's own circle edges stand in for the region's two closed segments (oriented along them). */
  private adoptBandCircles(face: TopoDS_Face, prim: Extract<Primitive, { kind: "cylinder" | "cone" }>, r: Region): void {
    const { oc, arena } = this;
    const base = prim.kind === "cylinder" ? prim.origin : prim.apex;
    const circles: { edge: TopoDS_Edge; level: number }[] = [];
    for (const ex = arena.track(new oc.TopExp_Explorer(face, "TopAbs_EDGE")); ex.More(); ex.Next()) {
      const edge = arena.track(oc.TopoDS.Edge(arena.track(ex.Current())));
      const c = arena.track(new oc.BRepAdaptor_Curve(edge));
      if (c.GetType() !== "GeomAbs_Circle") continue;
      const q = arena.track(c.Value(c.FirstParameter()));
      circles.push({ edge: arena.track(oc.TopoDS.Edge(arena.track(edge.Oriented("TopAbs_FORWARD")))), level: dot(sub([q.X(), q.Y(), q.Z()], base), prim.axis) });
    }
    for (const loop of r.loops) {
      const si = loop[0]!.segment;
      const vs = this.fit.segments[si]!.vertices;
      const level = dot(sub(this.p(vs[0]!), base), prim.axis);
      const hit = circles.reduce((best, c) => (Math.abs(c.level - level) < Math.abs(best.level - level) ? c : best));
      // A circle edge runs counter-clockwise about the axis; the segment's vertex order may not.
      const [e1, e2] = basis(prim.axis);
      let area = 0;
      for (let i = 0; i + 1 < vs.length; i++) {
        const a = sub(this.p(vs[i]!), base);
        const b = sub(this.p(vs[i + 1]!), base);
        area += dot(a, e1) * dot(b, e2) - dot(b, e1) * dot(a, e2);
      }
      this.edges.set(si, [area >= 0 ? hit.edge : arena.track(oc.TopoDS.Edge(arena.track(hit.edge.Reversed())))]);
    }
  }

  private wire(loop: Region["loops"][number]): TopoDS_Wire | null {
    const mw = this.arena.track(new this.oc.BRepBuilderAPI_MakeWire());
    for (const ref of loop) {
      let edges = this.segmentEdges(ref.segment);
      if (!ref.forward) edges = [...edges].reverse();
      for (const e of edges) mw.Add(ref.forward ? e : this.arena.track(this.oc.TopoDS.Edge(this.arena.track(e.Reversed()))));
    }
    if (!mw.IsDone()) return null;
    return this.arena.track(mw.Wire());
  }

  face(r: Region): TopoDS_Face | null {
    const { oc, arena } = this;
    const prim = r.primitive;
    const wires = r.loops.map((loop) => ({ loop, wire: this.wire(loop) }));
    if (wires.some((w) => !w.wire)) throw new FeatureError(`could not close the boundary of a ${prim?.kind ?? "facet"} face`, "the mesh may have overlapping or flipped triangles");
    const loops = wires as { loop: Region["loops"][number]; wire: TopoDS_Wire }[];
    if (!prim || prim.kind === "plane") {
      const normal = prim ? prim.normal : this.triangleNormal(r);
      const origin = prim ? prim.origin : this.p(this.fit.triangles[r.triangles[0]! * 3]!);
      if (!normal) return null;
      const pln = arena.track(new oc.gp_Pln(arena.track(new oc.gp_Ax3(this.pnt(origin), this.dir(normal)))));
      // The outer loop encloses the largest area; the others are holes.
      const areas = loops.map((w) => Math.abs(this.loopArea(w.loop, normal)));
      const outer = areas.indexOf(Math.max(...areas));
      const mf = arena.track(new oc.BRepBuilderAPI_MakeFace(pln, loops[outer]!.wire, true));
      loops.forEach((w, i) => i !== outer && mf.Add(w.wire));
      if (!mf.IsDone()) throw new FeatureError("could not build a flat face from the mesh");
      return arena.track(mf.Face());
    }
    if (prim.kind === "sphere") {
      const cap = this.sphereCap(prim, r);
      if (cap) return cap;
    }
    const surface = this.surface(prim, r);
    if (!loops.length) {
      const mf = arena.track(new oc.BRepBuilderAPI_MakeFace(surface, 1e-7));
      return mf.IsDone() ? arena.track(mf.Face()) : null;
    }
    // A hole wall or shaft, bounded by two circles square to the axis: OCCT's own full band has a
    // clean seam and whole circle edges (which fillets and threads need); sewing merges its circles
    // with the neighbouring faces' hole edges.
    const band = this.bandRange(prim, r);
    if (band) {
      const mf = arena.track(new oc.BRepBuilderAPI_MakeFace(surface, 0, 2 * Math.PI, band[0], band[1], 1e-7));
      if (mf.IsDone() && prim.kind !== "sphere") {
        const face = arena.track(mf.Face());
        this.adoptBandCircles(face, prim, r);
        return face;
      }
    }
    const mf = arena.track(new oc.BRepBuilderAPI_MakeFace(surface, loops[0]!.wire, false));
    for (const w of loops.slice(1)) mf.Add(w.wire);
    if (!mf.IsDone()) throw new FeatureError(`could not build a ${prim.kind} face from the mesh`);
    return arena.track(mf.Face());
  }

  /**
   * A sphere region bounded by one circle (a ball cut by a plane, or grown into another ball): the
   * sphere placed with its pole square to the circle, and the face cut from it along the circle's
   * latitude. Built from a loop instead, such a face had no area and the solid came out wrong.
   */
  private sphereCap(prim: Extract<Primitive, { kind: "sphere" }>, r: Region): TopoDS_Face | null {
    const { oc, arena } = this;
    if (r.loops.length !== 1 || r.loops[0]!.length !== 1) return null;
    const seg = this.fit.segments[r.loops[0]![0]!.segment]!;
    if (!seg.closed) return null;
    // A closed segment ends on its first vertex again.
    const pts = seg.vertices.slice(0, -1).map((v) => this.p(v));
    let c: Vec3 = [0, 0, 0];
    for (const q of pts) c = add(c, scale(q, 1 / pts.length));
    const d = sub(c, prim.center);
    const dist = len(d);
    if (dist <= this.tol) return null;
    const axis = scale(d, 1 / dist);
    if (pts.some((q) => Math.abs(dot(sub(q, prim.center), axis) - dist) > this.tol * 2)) return null;
    const lat = Math.asin(Math.min(1, dist / prim.radius));
    // The small cap beyond the circle, or the rest of the ball: whichever has the mesh's area.
    const small = 2 * Math.PI * prim.radius * (prim.radius - dist);
    const large = 2 * Math.PI * prim.radius * (prim.radius + dist);
    const [v0, v1] = Math.abs(small - r.area) < Math.abs(large - r.area) ? [lat, Math.PI / 2] : [-Math.PI / 2, lat];
    const ax3 = arena.track(new oc.gp_Ax3(this.pnt(prim.center), this.dir(axis), this.dir(basis(axis)[0])));
    const surface = arena.track(new oc.Geom_SphericalSurface(ax3, prim.radius));
    const mf = arena.track(new oc.BRepBuilderAPI_MakeFace(surface, 0, 2 * Math.PI, v0, v1, 1e-7));
    return mf.IsDone() ? arena.track(mf.Face()) : null;
  }

  /** V range of a cylinder or cone region bounded by exactly two closed circles square to its axis, else null. */
  private bandRange(prim: Exclude<Primitive, { kind: "plane" }>, r: Region): [number, number] | null {
    if (prim.kind === "sphere" || r.loops.length !== 2) return null;
    const base = prim.kind === "cylinder" ? prim.origin : prim.apex;
    const levels: number[] = [];
    for (const loop of r.loops) {
      if (loop.length !== 1) return null;
      const seg = this.fit.segments[loop[0]!.segment]!;
      if (!seg.closed) return null;
      const ts = seg.vertices.map((v) => dot(sub(this.p(v), base), prim.axis));
      const t = ts.reduce((x, y) => x + y, 0) / ts.length;
      if (ts.some((x) => Math.abs(x - t) > this.tol)) return null;
      levels.push(t);
    }
    const [lo, hi] = [Math.min(...levels), Math.max(...levels)];
    if (hi - lo <= this.tol) return null;
    // Geom_ConicalSurface's v runs along the generatrix, a cylinder's along the axis.
    const k = prim.kind === "cone" ? 1 / Math.cos(prim.halfAngle) : 1;
    return [lo * k, hi * k];
  }

  /**
   * The surface, placed so that its seam (u = 0) and, for a sphere, its poles lie away from the
   * patch: a face whose boundary crosses the seam or holds a pole is hard to make valid.
   */
  private surface(prim: Exclude<Primitive, { kind: "plane" }>, r: Region): Geom_Surface {
    const { oc, arena } = this;
    let mean: Vec3 = [0, 0, 0];
    for (const t of r.triangles) mean = add(mean, primitiveNormal(this.centroid(t), prim));
    const ax3 = (origin: Vec3, axis: Vec3) => {
      // X opposite to the patch's mean direction: the patch is centred at u = π.
      const radial = sub(mean, scale(axis, dot(mean, axis)));
      const x = len(radial) > 1e-9 ? scale(unit(radial), -1) : basis(axis)[0];
      return arena.track(new oc.gp_Ax3(this.pnt(origin), this.dir(axis), this.dir(x)));
    };
    switch (prim.kind) {
      case "cylinder":
        return arena.track(new oc.Geom_CylindricalSurface(ax3(prim.origin, prim.axis), prim.radius));
      case "cone":
        return arena.track(new oc.Geom_ConicalSurface(ax3(prim.apex, prim.axis), prim.halfAngle, 0));
      case "sphere": {
        // Poles on the patch's equator plane: the axis is square to the mean normal.
        const n = len(mean) > 1e-9 ? unit(mean) : ([0, 0, 1] as Vec3);
        const axis = basis(n)[0];
        return arena.track(new oc.Geom_SphericalSurface(ax3(prim.center, axis), prim.radius));
      }
    }
  }

  private centroid(t: number): Vec3 {
    const tri = this.fit.triangles;
    return scale(add(add(this.p(tri[t * 3]!), this.p(tri[t * 3 + 1]!)), this.p(tri[t * 3 + 2]!)), 1 / 3);
  }

  /* v8 ignore start -- facets (regions without a surface) only remain after a rebuild with
     invalid faces (see convertMesh), which no test mesh reproduces */
  private triangleNormal(r: Region): Vec3 | null {
    let n: Vec3 = [0, 0, 0];
    for (const t of r.triangles) {
      const tri = this.fit.triangles;
      const [a, b, c] = [this.p(tri[t * 3]!), this.p(tri[t * 3 + 1]!), this.p(tri[t * 3 + 2]!)];
      n = add(n, cross(sub(b, a), sub(c, a)));
    }
    return len(n) > 0 ? unit(n) : null;
  }
  /* v8 ignore stop */

  /** Signed area of a loop projected onto the plane with `normal` (positive = counter-clockwise). */
  private loopArea(loop: Region["loops"][number], normal: Vec3): number {
    const pts: Vec3[] = [];
    for (const ref of loop) {
      const vs = this.fit.segments[ref.segment]!.vertices;
      const ordered = ref.forward ? vs : [...vs].reverse();
      for (const v of ordered.slice(0, -1)) pts.push(this.p(v));
    }
    const [e1, e2] = basis(normal);
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      area += dot(a, e1) * dot(b, e2) - dot(b, e1) * dot(a, e2);
    }
    return area / 2;
  }

  // ------------------------------------------------------------ solid

  solid(faces: TopoDS_Face[]): { ok: true; shape: TopoDS_Shape } | { ok: false; invalidFaces: TopoDS_Face[] } {
    const { oc, arena } = this;
    const sew = arena.track(new oc.BRepBuilderAPI_Sewing(this.tol * 2, true, true, true, false));
    for (const f of faces) sew.Add(f);
    sew.Perform(arena.track(new oc.Message_ProgressRange()));
    const sewed = arena.track(sew.SewedShape());
    const builder = arena.track(new oc.TopoDS_Builder());
    const shell = arena.track(new oc.TopoDS_Shell());
    builder.MakeShell(shell);
    let count = 0;
    for (const e = arena.track(new oc.TopExp_Explorer(sewed, "TopAbs_FACE")); e.More(); e.Next()) {
      builder.Add(shell, arena.track(e.Current()));
      count++;
    }
    if (!count) throw new FeatureError("no faces could be built from the mesh");
    let shape: TopoDS_Shape;
    try {
      const solid = arena.track(arena.track(new oc.BRepBuilderAPI_MakeSolid(shell)).Solid());
      const fix = arena.track(new oc.ShapeFix_Solid(oc.TopoDS.Solid(solid)));
      fix.SetPrecision(this.tol);
      fix.SetMaxTolerance(Math.max(this.tol * 20, 0.05));
      fix.Perform(arena.track(new oc.Message_ProgressRange()));
      shape = arena.track(fix.Solid());
    } catch (e) {
      /* v8 ignore next -- OCCT throws here only on failures no test can provoke on purpose */
      throw new FeatureError(`could not close the faces into a solid: ${occtErrorMessage(oc, e)}`);
    }
    if (shape.ShapeType() !== "TopAbs_SOLID") throw new FeatureError("the faces do not close into one solid", `${sew.NbFreeEdges()} edges stayed open; a larger tolerance may help`);
    const solid = arena.track(oc.TopoDS.Solid(shape));
    oc.BRepLib.OrientClosedSolid(solid);
    /* v8 ignore start -- seen on real scans only (see convertMesh) */
    if (!arena.track(new oc.BRepCheck_Analyzer(solid, true, false)).IsValid()) {
      const invalidFaces: TopoDS_Face[] = [];
      for (const e = arena.track(new oc.TopExp_Explorer(solid, "TopAbs_FACE")); e.More(); e.Next()) {
        const face = arena.track(oc.TopoDS.Face(arena.track(e.Current())));
        if (!arena.track(new oc.BRepCheck_Analyzer(face, true, false)).IsValid()) invalidFaces.push(face);
      }
      return { ok: false, invalidFaces };
    }
    /* v8 ignore stop */
    const props = arena.track(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(solid, props, false, false, false);
    const volume = props.Mass();
    const expected = this.fit.volume;
    if (!(volume > 0) || Math.abs(volume - expected) > expected * 0.01)
      throw new FeatureError(`the converted solid's volume (${fmt(volume)} mm³) differs from the mesh (${fmt(expected)} mm³) by more than 1%`, "a smaller tolerance keeps more of the mesh's detail");
    return { ok: true, shape: solid };
  }

  // ------------------------------------------------------------ naming

  private cells: Map<string, number[]> | null = null;
  private cellSize = 0;

  /**
   * The region a face of the finished solid came from: the regions whose surface matches the
   * face's, and among those the one sharing most of the face's vertices (faces keep the mesh's
   * vertex positions).
   */
  regionOf(face: TopoDS_Face): number {
    const { oc, arena } = this;
    if (!this.cells) {
      this.cellSize = Math.max(this.tol * 4, this.fit.diag * 1e-6);
      this.cells = new Map();
      for (let i = 0; i < this.fit.positions.length / 3; i++) {
        const k = this.cellKey(this.p(i));
        this.cells.set(k, [...(this.cells.get(k) ?? []), i]);
      }
    }
    const surf = arena.track(new oc.BRepAdaptor_Surface(face, true));
    const type = surf.GetType();
    const near = this.tol * 4;
    const vec = (d: { X(): number; Y(): number; Z(): number }): Vec3 => [d.X(), d.Y(), d.Z()];
    const parallel = (a: Vec3, b: Vec3) => Math.abs(dot(a, b)) > COS_1DEG;
    const onLine = (q: Vec3, origin: Vec3, axis: Vec3) => len(sub(sub(q, origin), scale(axis, dot(sub(q, origin), axis)))) < near;
    let matches: (r: Region) => boolean;
    if (type === "GeomAbs_Plane") {
      const pln = arena.track(surf.Plane());
      const n = vec(arena.track(arena.track(pln.Axis()).Direction()));
      const loc = vec(arena.track(pln.Location()));
      matches = (r) => {
        const prim = r.primitive ?? this.facetPlane(r);
        return prim?.kind === "plane" && parallel(n, prim.normal) && Math.abs(dot(sub(loc, prim.origin), prim.normal)) < near;
      };
    } else if (type === "GeomAbs_Cylinder") {
      const cyl = arena.track(surf.Cylinder());
      const ax = arena.track(cyl.Axis());
      const d = vec(arena.track(ax.Direction()));
      const loc = vec(arena.track(ax.Location()));
      const radius = cyl.Radius();
      matches = (r) => r.primitive?.kind === "cylinder" && parallel(d, r.primitive.axis) && Math.abs(radius - r.primitive.radius) < near && onLine(loc, r.primitive.origin, r.primitive.axis);
    } else if (type === "GeomAbs_Sphere") {
      const sph = arena.track(surf.Sphere());
      const loc = vec(arena.track(sph.Location()));
      const radius = sph.Radius();
      matches = (r) => r.primitive?.kind === "sphere" && Math.abs(radius - r.primitive.radius) < near && len(sub(loc, r.primitive.center)) < near;
    } else if (type === "GeomAbs_Cone") {
      matches = (r) => r.primitive?.kind === "cone";
      /* v8 ignore start -- the converter builds planes, cylinders, cones and spheres only */
    } else {
      matches = () => true;
    }
    /* v8 ignore stop */
    const candidates = this.fit.regions.filter(matches);
    if (!candidates.length) return -1;
    if (candidates.length === 1) return candidates[0]!.index;
    const hits = new Map<number, number>();
    for (const e = arena.track(new oc.TopExp_Explorer(face, "TopAbs_VERTEX")); e.More(); e.Next()) {
      const pt = arena.track(oc.BRep_Tool.Pnt(arena.track(oc.TopoDS.Vertex(arena.track(e.Current())))));
      const v = this.nearestVertex([pt.X(), pt.Y(), pt.Z()]);
      if (v < 0) continue;
      for (const ri of this.regionsAtVertex(v)) hits.set(ri, (hits.get(ri) ?? 0) + 1);
    }
    let best = candidates[0]!;
    for (const r of candidates) {
      const h = hits.get(r.index) ?? 0;
      const hb = hits.get(best.index) ?? 0;
      if (h > hb || (h === hb && r.area < best.area)) best = r;
    }
    return best.index;
  }

  /* v8 ignore start -- facets only (see triangleNormal) */
  private facetPlanes = new Map<number, Primitive | null>();
  private facetPlane(r: Region): Primitive | null {
    let prim = this.facetPlanes.get(r.index);
    if (prim === undefined) {
      const normal = this.triangleNormal(r);
      prim = normal ? { kind: "plane", origin: this.centroid(r.triangles[0]!), normal } : null;
      this.facetPlanes.set(r.index, prim);
    }
    return prim;
  }
  /* v8 ignore stop */

  private vertexRegions: Map<number, number[]> | null = null;
  private regionsAtVertex(v: number): number[] {
    if (!this.vertexRegions) {
      this.vertexRegions = new Map();
      for (const r of this.fit.regions)
        for (const loop of r.loops)
          for (const ref of loop)
            for (const x of this.fit.segments[ref.segment]!.vertices) {
              const list = this.vertexRegions.get(x) ?? [];
              if (!list.includes(r.index)) list.push(r.index);
              this.vertexRegions.set(x, list);
            }
    }
    return this.vertexRegions.get(v) ?? [];
  }

  private cellKey(q: Vec3): string {
    return `${Math.floor(q[0] / this.cellSize)},${Math.floor(q[1] / this.cellSize)},${Math.floor(q[2] / this.cellSize)}`;
  }

  private nearestVertex(q: Vec3): number {
    const c = [Math.floor(q[0] / this.cellSize), Math.floor(q[1] / this.cellSize), Math.floor(q[2] / this.cellSize)];
    let best = -1;
    let bestD = this.cellSize;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const i of this.cells!.get(`${c[0]! + dx},${c[1]! + dy},${c[2]! + dz}`) ?? []) {
            const d = len(sub(this.p(i), q));
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
    return best;
  }
}

/** Direction of the circle two surfaces meet in, when they do: a plane with a round surface, or coaxial round surfaces. */
function circleAxis(a: Primitive | null, b: Primitive | null, tol: number): Vec3 | null {
  if (!a || !b) return null;
  const axisOf = (s: Primitive): Vec3 | null => (s.kind === "cylinder" || s.kind === "cone" ? s.axis : null);
  const pointOf = (s: Primitive): Vec3 => (s.kind === "cylinder" ? s.origin : s.kind === "cone" ? s.apex : s.kind === "sphere" ? s.center : s.origin);
  if (a.kind === "plane" && b.kind === "plane") return null;
  if (a.kind === "plane" || b.kind === "plane") {
    const [plane, other] = a.kind === "plane" ? [a, b] : [b as Extract<Primitive, { kind: "plane" }>, a];
    if (other.kind === "sphere") return plane.normal;
    const ax = axisOf(other)!;
    return Math.abs(dot(ax, plane.normal)) > COS_1DEG ? plane.normal : null;
  }
  const aa = axisOf(a);
  const ab = axisOf(b);
  if (a.kind === "sphere" && b.kind === "sphere") return unit(sub(b.center, a.center));
  if (a.kind === "sphere" || b.kind === "sphere") {
    const ax = aa ?? ab!;
    const [sphere, round] = a.kind === "sphere" ? [a, b] : [b as Extract<Primitive, { kind: "sphere" }>, a];
    const d = sub(sphere.center, pointOf(round));
    return len(sub(d, scale(ax, dot(d, ax)))) < tol ? ax : null;
  }
  if (!aa || !ab || Math.abs(dot(aa, ab)) < COS_1DEG) return null;
  const d = sub(pointOf(b), pointOf(a));
  return len(sub(d, scale(aa, dot(d, aa)))) < tol ? aa : null;
}

const fmt = (n: number) => String(Math.round(n * 10) / 10);
