/**
 * Reuse of a step's result (tracking.ts): what a step read is noted, and its change is laid on a
 * later state only when everything it read is the same there. Plain maps stand in for the state.
 */
import { describe, expect, it } from "vitest";
import { ask, copyMap, replayTrace, trackState } from "./tracking.js";
import type { ModelState } from "./state.js";

const arena = { tag: "arena" } as unknown as ModelState["arena"];
const state = (bodies: [string, unknown][] = [], extra: Partial<Record<string, unknown>> = {}) =>
  ({ arena, bodies: new Map(bodies), sketches: new Map(), planes: new Map(), tools: new Map(), references: new Map(), gears: new Map(), grids: new Map(), walls: new Map(), textures: new Map(), ...extra }) as unknown as ModelState;
const A = { id: "a" }, B = { id: "b" }, C = { id: "c" };
const bodiesOf = (s: ModelState | null) => (s ? [...(s.bodies as Map<string, unknown>).keys()] : null);

/** Runs `step` tracked on `prev` and returns its footprint. */
function track(prev: ModelState, step: (view: ModelState) => ModelState | null) {
  const t = trackState(prev);
  return t.finish(step(t.view))!;
}

describe("a step's footprint", () => {
  it("replays when the entries it read are the same, and says why not otherwise", () => {
    const prev = state([["a", A], ["b", B]]);
    const fp = track(prev, (v) => {
      v.bodies.get("a");
      v.bodies.has("zz");
      const bodies = copyMap(v.bodies);
      bodies.set("c", C);
      bodies.delete("b");
      return { ...v, bodies };
    });
    expect(bodiesOf(fp.replay(state([["a", A], ["b", { id: "b2" }]])))).toEqual(["a", "c"]);
    const why: string[] = [];
    replayTrace.miss = (w) => why.push(w);
    try {
      expect(fp.replay(state([["a", { id: "a2" }]]))).toBeNull();
      expect(fp.replay(state([["a", A], ["zz", C]]))).toBeNull();
    } finally {
      replayTrace.miss = null;
    }
    expect(why).toEqual(["bodies a", "bodies zz"]);
  });

  it("compares the whole map once the step went through it, in every way of going through it", () => {
    const ways: ((m: ReadonlyMap<string, unknown>) => unknown)[] = [(m) => m.size, (m) => m.forEach(() => 0), (m) => [...m.entries()], (m) => [...m.keys()], (m) => [...m.values()], (m) => [...m]];
    for (const way of ways) {
      const prev = state([["a", A]]);
      const fp = track(prev, (v) => (way(v.bodies), v));
      expect(fp.replay(state([["a", A]]))).not.toBeNull();
      expect(fp.replay(prev)).not.toBeNull();
      expect(fp.replay(state([["a", A], ["b", B]]))).toBeNull();
      expect(fp.replay(state([["a", B]]))).toBeNull();
    }
  });

  it("notes reads through a step's own copy, but not of the entries it set itself", () => {
    const prev = state([["a", A], ["b", B]]);
    const fp = track(prev, (v) => {
      const bodies = copyMap(v.bodies);
      bodies.set("c", C);
      bodies.get("c");
      bodies.has("c");
      bodies.get("a");
      const again = copyMap(bodies);
      again.has("b");
      return { ...v, bodies: again };
    });
    expect(bodiesOf(fp.replay(state([["a", A], ["b", B], ["c", { id: "old c" }]])))).toEqual(["a", "b", "c"]);
    expect(fp.replay(state([["a", A]]))).toBeNull();
  });

  it("counts going through a copy as reading the whole map", () => {
    const ways: ((m: Map<string, unknown>) => unknown)[] = [(m) => m.size, (m) => m.forEach(() => 0), (m) => [...m.entries()], (m) => [...m.keys()], (m) => [...m.values()], (m) => [...m], (m) => m.clear()];
    for (const way of ways) {
      const fp = track(state([["a", A]]), (v) => {
        const bodies = copyMap(v.bodies);
        way(bodies);
        return { ...v, bodies };
      });
      expect(fp.replay(state([["a", A], ["b", B]]))).toBeNull();
    }
  });

  it("asks a question of the whole map instead of reading it all, also of a copy", () => {
    const prev = state([["a", A], ["b", B]]);
    const named = (m: ReadonlyMap<string, unknown>) => [...m.keys()].filter((k) => k !== "b");
    const fp = track(prev, (v) => {
      expect(ask(v.bodies, named)).toEqual(["a"]);
      const bodies = copyMap(v.bodies);
      bodies.set("c", C);
      bodies.delete("a");
      expect(ask(bodies, (m) => ({ keys: [...m.keys()], first: m.get("b") }))).toEqual({ keys: ["b", "c"], first: B });
      return { ...v, bodies };
    });
    // "b" changed: the second answer differs.
    expect(fp.replay(state([["a", A], ["b", { id: "b2" }]]))).toBeNull();
    // Another part that the questions don't care about: replayed.
    expect(bodiesOf(fp.replay(state([["a", A], ["b", B]])))).toEqual(["b", "c"]);
    expect(fp.replay(state([["a", A], ["b", B], ["x", A]]))).toBeNull();
  });

  it("compares a question's answers by value, and its errors by their words", () => {
    const answers = [NaN, [1, { x: 2 }], { a: [1] }, null, new Date(0)];
    for (const answer of answers) {
      let given: unknown = answer;
      const fp = track(state(), (v) => (ask(v.bodies, () => given), v));
      expect(fp.replay(state())).not.toBeNull();
      given = Array.isArray(answer) ? [1, { x: 3 }] : answer === null ? 0 : { a: [2] };
      expect(fp.replay(state())).toBeNull();
    }
    // Answers of different shapes.
    for (const [a, b] of [[[1], { 0: 1 }], [{ a: 1 }, { b: 1 }], [{ a: 1 }, { a: 1, b: 2 }], [1, 2], ["x", { x: 1 }]] as [unknown, unknown][]) {
      let given = a;
      const fp = track(state(), (v) => (ask(v.bodies, () => given), v));
      given = b;
      expect(fp.replay(state())).toBeNull();
    }
    let fail = "no such face";
    const thrower = () => {
      throw new RangeError(fail);
    };
    const fp = track(state(), (v) => (expect(() => ask(v.bodies, thrower)).toThrow(RangeError), v));
    expect(fp.replay(state())).not.toBeNull();
    fail = "another reason";
    expect(fp.replay(state())).toBeNull();
    const strings = track(state(), (v) => (expect(() =>
      ask(v.bodies, () => {
        throw "plain";
      }),
    ).toThrow(), v));
    expect(strings.replay(state())).not.toBeNull();
    let throws = true;
    const sometimes = track(state(), (v) => {
      expect(() =>
        ask(v.bodies, () => {
          if (throws) throw new Error("x");
          return 1;
        }),
      ).toThrow("x");
      return v;
    });
    throws = false;
    expect(sometimes.replay(state())).toBeNull();
  });

  it("asks plain maps directly, and stops noting once the step went through the map anyway", () => {
    expect(ask(new Map([["a", 1]]), (m) => m.size)).toBe(1);
    let asked = 0;
    const fp = track(state([["a", A]]), (v) => {
      void v.bodies.size;
      ask(v.bodies, () => ++asked);
      return v;
    });
    expect(asked).toBe(1);
    fp.replay(state([["a", A]]));
    expect(asked).toBe(1);
  });

  it("hands on a step's copies as plain maps once it is done", () => {
    const t = trackState(state([["a", A]]));
    t.view.bodies.get("a");
    const bodies = copyMap(t.view.bodies);
    bodies.set("b", B);
    const fp = t.finish({ ...t.view, bodies })!;
    // Going through the finished map is not noted any more: the footprint still replays.
    expect([bodies.size, [...bodies.keys()], [...bodies.values()].length, [...bodies.entries()].length, bodies.get("a"), bodies.has("a")]).toEqual([2, ["a", "b"], 2, 2, A, true]);
    bodies.forEach(() => 0);
    bodies.clear();
    expect(bodiesOf(fp.replay(state([["a", A]])))).toEqual(["a", "b"]);
    // A state without the map at all reads it as empty.
    const missing = state([["a", A]]);
    delete (missing as unknown as Record<string, unknown>)["bodies"];
    expect(fp.replay(missing)).toBeNull();
  });

  it("leaves the state as it was for a step that failed", () => {
    const fp = track(state([["a", A]]), (v) => (v.bodies.get("a"), null));
    const later = state([["a", A], ["b", B]]);
    expect(fp.replay(later)).toBe(later);
  });

  it("keeps track of maps a step drops or adds and of maps older states lack", () => {
    const old = state([["a", A]]);
    delete (old as unknown as Record<string, unknown>)["textures"];
    // The step looks into the missing map and adds it.
    const fp = track(old, (v) => {
      v.textures.get("t1");
      const textures = copyMap(v.textures);
      textures.set("t1", C);
      return { ...v, textures };
    });
    const out = fp.replay(old)! as unknown as Record<string, Map<string, unknown>>;
    expect([...out["textures"]!.keys()]).toEqual(["t1"]);
    expect(fp.replay(state([["a", A]], { textures: new Map([["t1", A]]) }))).toBeNull();
    // A step that drops a map.
    const drop = track(state(), (v) => {
      const next = { ...v } as Record<string, unknown>;
      delete next["walls"];
      return next as unknown as ModelState;
    });
    expect("walls" in (drop.replay(state()) as object)).toBe(false);
    // A step that keeps a missing map missing.
    const keep = track(old, (v) => {
      const next = { ...v } as Record<string, unknown>;
      next["textures"] = copyMap(undefined).size ? undefined : (v as unknown as Record<string, unknown>)["textures"];
      return next as unknown as ModelState;
    });
    expect("textures" in (keep.replay(old) as object)).toBe(false);
  });

  it("does not reuse anything for a state with a field it does not know", () => {
    const odd = state([], { extra: new Map() });
    const t = trackState(odd);
    expect(t.view).toBe(odd);
    expect(t.finish(odd)).toBeNull();
    const t2 = trackState(state());
    expect(t2.finish({ ...t2.view, extra: 1 } as unknown as ModelState)).toBeNull();
  });
});
