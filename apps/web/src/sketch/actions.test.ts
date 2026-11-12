/**
 * The sketch constraint buttons (actions.ts) on a selection: each makes the constraint it names, and
 * the solved sketch then has that shape (lines at 90°, equal lengths, a point in the middle...).
 * A selection that does not fit a constraint says what it needs and changes nothing. Construction
 * lines, deleting and selecting everything round it off.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { SketchEntity, SketchFeature } from "@meercad/schema";
import { apply, currentDoc, newProject, rebuildNow, useApp } from "../store";
import { applyConstraint, curveKind, deleteSelection, freshId, selectAll, toggleConstruction } from "./actions";
import { setSketchSelection, useSketchUi, type SketchSel } from "./state";

const P = (id: string, x: number, y: number): SketchEntity => ({ id, type: "point", x, y });
const L = (id: string, p1: string, p2: string): SketchEntity => ({ id, type: "line", p1, p2 });
const entities: SketchEntity[] = [
  P("a1", 0, 0), P("a2", 30, 2), L("la", "a1", "a2"),
  P("b1", 0, 10), P("b2", 5, 40), L("lb", "b1", "b2"),
  P("c", 60, 0), { id: "k1", type: "circle", center: "c", radius: 5 },
  P("d", 61, 1), { id: "k2", type: "circle", center: "d", radius: 8 },
  P("ac", 0, -40), P("as", 10, -40), P("ae", 0, -30), { id: "ar", type: "arc", center: "ac", start: "as", end: "ae" },
  P("s1", 40, 40), P("s2", 50, 50), P("s3", 60, 40), { id: "sp", type: "spline", points: ["s1", "s2", "s3"] },
  P("m", 12, 5), P("q1", 20, 20), P("q2", 26, 30),
];

const sketch = () => currentDoc().features.find((f) => f.id === "sk1") as SketchFeature;
const select = (...s: [SketchSel["kind"], string][]) => setSketchSelection(s.map(([kind, id]) => ({ kind, id }) as SketchSel));
const lastToast = () => useApp.getState().toasts.at(-1)?.text ?? "";
async function solved() {
  const out = await rebuildNow();
  const sk = out.report.sketches.find((s) => s.id === "sk1")!;
  expect(sk.diagnostics?.ok ?? true).toBe(true);
  return sk;
}
const lineOf = (s: Awaited<ReturnType<typeof solved>>, id: string) => s.curves.find((c) => c.id === id) as { a: [number, number]; b: [number, number] };
const dir = (l: { a: [number, number]; b: [number, number] }) => [l.b[0] - l.a[0], l.b[1] - l.a[1]] as const;
const len = (l: { a: [number, number]; b: [number, number] }) => Math.hypot(...dir(l));

beforeEach(async () => {
  await newProject(undefined, "Constraints");
  apply({ type: "add_features", features: [{ id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities, constraints: [] }] });
  useApp.setState({ sketchId: "sk1" });
});

describe("constraint buttons", () => {
  it("makes two lines perpendicular, then parallel, then collinear", async () => {
    select(["curve", "la"], ["curve", "lb"]);
    applyConstraint("perpendicular");
    expect(useSketchUi.getState().selection).toEqual([]);
    let s = await solved();
    const [u, v] = [dir(lineOf(s, "la")), dir(lineOf(s, "lb"))];
    expect((u[0] * v[0] + u[1] * v[1]) / (len(lineOf(s, "la")) * len(lineOf(s, "lb")))).toBeCloseTo(0, 9);
    apply({ type: "edit_feature", id: "sk1", patch: { constraints: [] } });
    select(["curve", "la"], ["curve", "lb"]);
    applyConstraint("parallel");
    s = await solved();
    const [p, q] = [dir(lineOf(s, "la")), dir(lineOf(s, "lb"))];
    expect(p[0] * q[1] - p[1] * q[0]).toBeCloseTo(0, 6);
    select(["curve", "la"], ["curve", "lb"]);
    applyConstraint("collinear");
    expect(sketch().constraints.map((c) => c.type)).toEqual(["parallel", "collinear"]);
  });

  it("makes lines equal, horizontal or vertical by the nearer axis, and circles equal and concentric", async () => {
    select(["curve", "la"], ["curve", "lb"]);
    applyConstraint("equal");
    select(["curve", "la"], ["curve", "lb"]);
    applyConstraint("hv");
    expect(sketch().constraints.map((c) => c.type)).toEqual(["equal", "horizontal", "vertical"]);
    const s = await solved();
    expect(len(lineOf(s, "la"))).toBeCloseTo(len(lineOf(s, "lb")), 6);
    expect(dir(lineOf(s, "la"))[1]).toBeCloseTo(0, 9);
    expect(dir(lineOf(s, "lb"))[0]).toBeCloseTo(0, 9);
    select(["curve", "k1"], ["curve", "k2"]);
    applyConstraint("equal");
    select(["curve", "k1"], ["curve", "k2"]);
    applyConstraint("concentric");
    const s2 = await solved();
    const [k1, k2] = ["k1", "k2"].map((id) => s2.curves.find((c) => c.id === id) as { center: [number, number]; radius: number });
    expect(k1!.radius).toBeCloseTo(k2!.radius, 6);
    expect(Math.hypot(k1!.center[0] - k2!.center[0], k1!.center[1] - k2!.center[1])).toBeCloseTo(0, 6);
  });

  it("puts a point in a line's middle and two points symmetric to a line", async () => {
    select(["point", "m"], ["curve", "la"]);
    applyConstraint("midpoint");
    select(["point", "q1"], ["point", "q2"], ["curve", "lb"]);
    applyConstraint("symmetric");
    const s = await solved();
    const la = lineOf(s, "la");
    const lb = lineOf(s, "lb");
    const pt = (id: string) => (s.points as unknown as [string, number, number][]).find((x) => x[0] === id)!.slice(1) as [number, number];
    const m = pt("m");
    expect(m[0]).toBeCloseTo((la.a[0] + la.b[0]) / 2, 6);
    expect(m[1]).toBeCloseTo((la.a[1] + la.b[1]) / 2, 6);
    // q1 and q2: their middle on lb, the line between them square to it.
    const [q1, q2] = [pt("q1"), pt("q2")];
    const mid: [number, number] = [(q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2];
    const d = dir(lb);
    expect(d[0] * (mid[1] - lb.a[1]) - d[1] * (mid[0] - lb.a[0])).toBeCloseTo(0, 6);
    expect(d[0] * (q2[0] - q1[0]) + d[1] * (q2[1] - q1[1])).toBeCloseTo(0, 6);
  });

  it("joins points, a point to a curve, two circles' centres, and makes tangents", async () => {
    select(["point", "q1"], ["point", "q2"]);
    applyConstraint("coincident");
    select(["point", "m"], ["curve", "k1"]);
    applyConstraint("coincident");
    select(["curve", "k1"], ["curve", "k2"]);
    applyConstraint("coincident");
    select(["curve", "la"], ["curve", "ar"]);
    applyConstraint("tangent");
    expect(sketch().constraints.map((c) => c.type)).toEqual(["coincident", "point_on", "coincident", "tangent"]);
    // A spline is tangent only where it shares an end with the other curve.
    select(["curve", "sp"], ["curve", "la"]);
    applyConstraint("tangent");
    expect(lastToast()).toMatch(/a spline and a curve that ends where it ends/);
    await solved();
  });

  it("locks points and every point of the curves selected", () => {
    select(["point", "m"], ["curve", "la"], ["curve", "k1"], ["curve", "ar"]);
    applyConstraint("fix");
    expect(sketch().constraints.map((c) => (c as { point: string }).point).sort()).toEqual(["a1", "a2", "ac", "ae", "as", "c", "m"]);
    select(["point", "q1"], ["point", "q2"]);
    applyConstraint("horizontal");
    select(["point", "q1"], ["point", "q2"]);
    applyConstraint("vertical");
    select(["point", "q1"], ["point", "q2"]);
    applyConstraint("hv");
    expect(sketch().constraints.slice(-3).map((c) => c.type)).toEqual(["horizontal_points", "vertical_points", "vertical_points"]);
  });

  it("says what a constraint needs and changes nothing", () => {
    const before = sketch().constraints.length;
    const cases: [string, [SketchSel["kind"], string][], RegExp][] = [
      ["concentric", [["curve", "k1"]], /two circles or arcs/],
      ["hv", [["curve", "k1"]], /lines or two points/],
      ["coincident", [["curve", "la"]], /two points, a point and a curve/],
      ["horizontal", [["curve", "k1"]], /lines or two points/],
      ["parallel", [["curve", "la"]], /two lines/],
      ["tangent", [["curve", "la"], ["curve", "lb"]], /a line and an arc\/circle/],
      ["equal", [["curve", "la"], ["curve", "k1"]], /two lines or two circles/],
      ["midpoint", [["point", "m"]], /a point and a line/],
      ["symmetric", [["point", "m"], ["curve", "la"]], /two points and a line/],
      ["fix", [], /points or curves/],
    ];
    for (const [type, sel, msg] of cases) {
      select(...sel);
      applyConstraint(type);
      expect(lastToast(), type).toMatch(msg);
    }
    applyConstraint("no_such_thing");
    expect(sketch().constraints).toHaveLength(before);
  });
});

describe("other sketch actions", () => {
  it("turns geometry into construction lines and the drawing mode on and off", () => {
    select(["curve", "la"], ["point", "m"]);
    toggleConstruction();
    expect(sketch().entities.filter((e) => (e as { construction?: boolean }).construction).map((e) => e.id)).toEqual(["la", "m"]);
    setSketchSelection([]);
    const was = useSketchUi.getState().construction;
    toggleConstruction();
    expect(useSketchUi.getState().construction).toBe(!was);
    toggleConstruction();
  });

  it("deletes a point with its curves and their constraints, and a constraint alone", () => {
    select(["curve", "la"], ["curve", "lb"]);
    applyConstraint("parallel");
    select(["point", "m"], ["curve", "la"]);
    applyConstraint("midpoint");
    const midpoint = sketch().constraints.find((c) => c.type === "midpoint")!.id;
    select(["constraint", midpoint]);
    deleteSelection();
    expect(sketch().constraints.map((c) => c.type)).toEqual(["parallel"]);
    // The arc's centre goes: the arc and its now unused start and end go too.
    select(["point", "ac"], ["point", "a1"]);
    deleteSelection();
    const ids = sketch().entities.map((e) => e.id);
    for (const gone of ["ac", "as", "ae", "ar", "a1", "a2", "la"]) expect(ids).not.toContain(gone);
    expect(sketch().constraints).toEqual([]);
    selectAll();
    expect(useSketchUi.getState().selection.length).toBe(sketch().entities.length);
  });

  it("names new ids freshly and knows the kinds of curves", () => {
    expect(freshId(sketch(), "a")).toBe("a3");
    const taken = new Set<string>();
    expect([freshId(sketch(), "x", taken), freshId(sketch(), "x", taken)]).toEqual(["x1", "x2"]);
    expect(curveKind(sketch(), "k1", new Map())).toBe("circle");
    expect(curveKind(sketch(), "origin.y", new Map())).toBe("line");
    expect(curveKind(sketch(), "pr.0", new Map([["pr.0", "arc"]]))).toBe("arc");
    expect(curveKind(sketch(), "sp", new Map())).toBeNull();
  });
});
