import { describe, expect, it } from "vitest";
import type { MeercadDocument } from "@meercad/schema";
import { evaluate, resolveParams } from "./expr.js";
import { FeatureError, RebuildEngine, type KernelBackend } from "./rebuild.js";
import { DocumentStore, OpError } from "./store.js";

describe("expressions", () => {
  const scope = new Map([["wall", 2]]);
  it.each([
    ["2 mm", 2],
    ["1cm + 5", 15],
    ["wall * 10", 20],
    ["-(wall + 1) * 2", -6],
    ["max(wall, 3) ^ 2", 9],
    ["1in", 25.4],
    [".5e1", 5],
  ])("%s = %d", (src, v) => expect(evaluate(src, scope)).toBeCloseTo(v));

  it.each(["", "wall +", "foo", "2 / 0", "1 $ 2", "nope(1)"])("rejects %j", (src) => {
    expect(() => evaluate(src, scope)).toThrow();
  });

  it("resolves params in dependency order and reports cycles", () => {
    const r = resolveParams({ width: "wall * 10", wall: "2 mm", a: "b", b: "a + 1", c: "a" });
    expect(r.values.get("width")).toBe(20);
    expect([...r.errors.keys()].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("DocumentStore", () => {
  it("renames params everywhere and moves features", () => {
    const s = new DocumentStore(doc("h * 2"));
    s.apply({ type: "set_param", name: "w", expr: "h + 1mm" });
    s.apply({ type: "rename_param", name: "h", to: "height" });
    expect(s.doc.params).toEqual({ height: "height * 2", w: "height + 1mm" });
    expect(s.doc.features[1]).toMatchObject({ distance: "height" });
    expect(() => s.apply({ type: "move_feature", id: "fi1", after: "sk1" })).toThrow(/later feature/);
    s.apply({
      type: "add_features",
      features: [{ id: "sk2", op: "sketch", plane: { ref: "origin.XZ" }, entities: [], constraints: [] }],
    });
    s.apply({ type: "move_feature", id: "sk2", after: null });
    expect(s.doc.features.map((f) => f.id)).toEqual(["sk2", "sk1", "ex1", "fi1"]);
  });

  it("applies ops, supports undo/redo, rejects invalid ops atomically", () => {
    const s = new DocumentStore();
    s.apply({ type: "set_param", name: "h", expr: "10 mm" });
    expect(() =>
      s.apply({ type: "set_param", name: "w", expr: 1 }, { type: "delete_feature", id: "x" }),
    ).toThrow(OpError);
    expect(s.doc.params).toEqual({ h: "10 mm" });
    s.undo();
    expect(s.doc.params).toEqual({});
    s.redo();
    expect(s.doc.params).toEqual({ h: "10 mm" });
  });

  it("keeps track of variables an assistant created", () => {
    const s = new DocumentStore();
    s.apply(
      { type: "set_param", name: "wall", expr: "2 mm", auto: true },
      { type: "set_param", name: "mine", expr: 3 },
    );
    expect(s.doc.autoParams).toEqual(["wall"]);
    s.apply({ type: "set_param", name: "wall", expr: "3 mm" });
    expect(s.doc.autoParams).toEqual(["wall"]);
    s.apply({ type: "rename_param", name: "wall", to: "thickness" });
    expect(s.doc.autoParams).toEqual(["thickness"]);
    s.apply({ type: "set_param", name: "thickness", expr: "3 mm", auto: false });
    expect(s.doc.autoParams).toBeUndefined();
    s.apply(
      { type: "set_param", name: "x", expr: 1, auto: true },
      { type: "set_param", name: "x", expr: null },
    );
    expect(s.doc.autoParams).toBeUndefined();
  });
});

/** Fake kernel: state is a list of executed feature ids; "boom" fillets fail. */
const fake = (): KernelBackend<string[]> & { runs: string[]; disposed: number } => {
  const k = {
    runs: [] as string[],
    disposed: 0,
    initialState: () => [],
    execute(f: Parameters<KernelBackend<string[]>["execute"]>[0], prev: string[]) {
      k.runs.push(f.id);
      if (f.op === "fillet" && f.radius > 5) throw new FeatureError("radius too large", "try ≤ 5");

      return { state: [...prev, f.id] };
    },
    dispose: () => void k.disposed++,
  };

  return k;
};

const doc = (h: number | string, r = 2): MeercadDocument => ({
  format: "meercad/1",
  params: { h },
  features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: [], constraints: [] },
    {
      id: "ex1",
      op: "extrude",
      profile: { sketch: "sk1" },
      extent: "blind",
      distance: "h",
      mode: "new_body",
    },
    { id: "fi1", op: "fillet", edges: { select: "edges", of: "ex1" }, radius: r },
  ],
  rollback: null,
});

describe("RebuildEngine", () => {
  it("recomputes only from the first changed feature", () => {
    const k = fake();
    const e = new RebuildEngine(k);
    e.rebuild(doc(10));
    expect(k.runs).toEqual(["sk1", "ex1", "fi1"]);
    k.runs.length = 0;

    const r = e.rebuild(doc(12));
    expect(k.runs).toEqual(["ex1", "fi1"]);
    expect(r.firstRecomputed).toBe(1);
    expect(r.features.map((f) => f.cached)).toEqual([true, false, false]);
    expect(k.disposed).toBe(2);
    k.runs.length = 0;
    expect(e.rebuild(doc(12)).firstRecomputed).toBe(-1);
    expect(k.runs).toEqual([]);
  });

  it("previews a change next to the cache without touching it", () => {
    const k = fake();
    const e = new RebuildEngine(k);
    e.rebuild(doc(10));
    k.runs.length = 0;

    const f = e.fork(doc(10, 3));
    // Only the changed fillet is built; sketch and extrude come from the cache.
    expect(k.runs).toEqual(["fi1"]);
    expect(f.firstRecomputed).toBe(2);
    expect(f.state).toEqual(["sk1", "ex1", "fi1"]);
    f.release();
    expect(k.disposed).toBe(1);
    // The cache still holds the original design whole.
    k.runs.length = 0;
    expect(e.rebuild(doc(10)).firstRecomputed).toBe(-1);
    expect(k.runs).toEqual([]);
    // A failing preview releases what it built, and the cache stays.
    k.runs.length = 0;

    const bad = e.fork(doc(12, 9));
    expect(k.runs).toEqual(["ex1", "fi1"]);
    bad.release();
    expect(k.disposed).toBe(2);
    expect(e.rebuild(doc(10)).firstRecomputed).toBe(-1);
  });

  it("reports errors with hints and passes state through", () => {
    const r = new RebuildEngine(fake()).rebuild(doc(10, 9));
    expect(r.features[2]).toMatchObject({ status: "error", message: "radius too large", hint: "try ≤ 5" });
    expect(r.state).toEqual(["sk1", "ex1"]);
  });

  it("reports bad expressions per feature and honours rollback/suppression", () => {
    const d = doc("nope * 2");
    const r = new RebuildEngine(fake()).rebuild(d);
    expect(r.paramErrors["h"]).toMatch(/unknown parameter/);
    expect(r.features[1]).toMatchObject({ status: "error" });

    const d2 = { ...doc(1), rollback: "ex1" };
    d2.features[0] = { ...d2.features[0]!, suppressed: true };

    const r2 = new RebuildEngine(fake()).rebuild(d2);
    expect(r2.features.map((f) => f.status)).toEqual(["suppressed", "ok", "rolled_back"]);
  });
});
