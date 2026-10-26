import { describe, expect, it } from "vitest";
import type { LeocadDocument } from "@leocad/schema";
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
    s.apply({ type: "add_features", features: [{ id: "sk2", op: "sketch", plane: { ref: "origin.XZ" }, entities: [], constraints: [] }] });
    s.apply({ type: "move_feature", id: "sk2", after: null });
    expect(s.doc.features.map((f) => f.id)).toEqual(["sk2", "sk1", "ex1", "fi1"]);
  });

  it("applies ops, supports undo/redo, rejects invalid ops atomically", () => {
    const s = new DocumentStore();
    s.apply({ type: "set_param", name: "h", expr: "10 mm" });
    expect(() => s.apply({ type: "set_param", name: "w", expr: 1 }, { type: "delete_feature", id: "x" })).toThrow(OpError);
    expect(s.doc.params).toEqual({ h: "10 mm" });
    s.undo();
    expect(s.doc.params).toEqual({});
    s.redo();
    expect(s.doc.params).toEqual({ h: "10 mm" });
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

const doc = (h: number | string, r = 2): LeocadDocument => ({
  format: "leocad/1",
  params: { h },
  features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: [], constraints: [] },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: "h", mode: "new_body" },
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
