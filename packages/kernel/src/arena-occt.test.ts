import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Arena } from "./arena.js";
import { loadOcct, occtErrorMessage, reserveHeap, type OC } from "./occt.js";

class Thing {
  deleted = 0;
  constructor(private readonly fails = false) {}
  delete() {
    this.deleted++;
    if (this.fails) throw new Error("already deleted");
  }
}
class TopoDS_Fake extends Thing {}

describe("Arena", () => {
  it("frees everything it holds once, last first, also when an object was freed elsewhere", () => {
    const a = new Arena();
    const order: string[] = [];
    const x = { delete: () => order.push("x") };
    const y = { delete: () => order.push("y") };
    a.track(x);
    a.track(new Thing(true));
    a.track(y);
    expect(a.size).toBe(3);
    a.dispose();
    expect(order).toEqual(["y", "x"]);
    expect(a.size).toBe(0);
    a.dispose();
    expect(order).toEqual(["y", "x"]);
    expect(() => a.track(new Thing())).toThrow(/already disposed/);
  });

  it("frees an adopted arena with itself, and never adopts itself or twice", () => {
    const a = new Arena();
    const b = new Arena();
    const t = b.track(new Thing());
    a.adopt(b);
    a.adopt(b);
    a.adopt(a);
    a.dispose();
    expect(t.deleted).toBe(1);
    expect(() => b.track(new Thing())).toThrow(/already disposed/);
  });

  it("keeps the shapes when trimmed and frees the rest", () => {
    const a = new Arena();
    const shape = a.track(new TopoDS_Fake());
    const algo = a.track(new Thing());
    const gone = a.track(new Thing(true));
    const shape2 = a.track(new TopoDS_Fake());
    a.trim();
    expect([shape.deleted, shape2.deleted, algo.deleted, gone.deleted]).toEqual([0, 0, 1, 1]);
    expect(a.size).toBe(2);
    expect([...a.census()]).toEqual([["TopoDS_Fake", 2]]);
    a.track(Object.create(null) as Thing);
    expect(a.census(new Map([["TopoDS_Fake", 1]])).get("TopoDS_Fake")).toBe(3);
    a.dispose();
    a.trim();
    expect(shape.deleted).toBe(1);
  });
});

describe("OCCT helpers", () => {
  it("loads the module from a given .wasm file", async () => {
    const wasm = fileURLToPath(
      new URL(
        "../../../node_modules/.pnpm/replicad-opencascadejs@1.1.0/node_modules/replicad-opencascadejs/dist/replicad_single.wasm",
        import.meta.url,
      ),
    );
    const oc = await loadOcct(wasm);
    const p = new oc.gp_Pnt(1, 2, 3);
    expect(p.Y()).toBe(2);
    p.delete();
  });

  it("loads the threaded build, also where the page hides SharedArrayBuffer (iPad)", async () => {
    const scope = globalThis as { SharedArrayBuffer?: unknown };
    const original = scope.SharedArrayBuffer;
    delete scope.SharedArrayBuffer;

    try {
      const oc = await loadOcct(undefined, true);
      expect(scope.SharedArrayBuffer).toBe(original);

      // A cut in parallel mode: a 10 mm cube less a 5 mm cube at its corner.
      const a = new oc.BRepPrimAPI_MakeBox(10, 10, 10).Shape();
      const b = new oc.BRepPrimAPI_MakeBox(5, 5, 5).Shape();
      const cut = new oc.BRepAlgoAPI_Cut(a, b, new oc.Message_ProgressRange());
      const props = new oc.GProp_GProps();
      oc.BRepGProp.VolumeProperties(cut.Shape(), props, false, false, false);
      expect(props.Mass()).toBeCloseTo(875, 6);
      // With the global already there it is left alone.
      await loadOcct(undefined, true);
      expect(scope.SharedArrayBuffer).toBe(original);
    } finally {
      scope.SharedArrayBuffer = original;
    }
  });

  it("reserves memory in steps of 256 MB down from the wish, or says it cannot", () => {
    expect(reserveHeap({} as OC, 2 ** 30)).toBe(0);

    const asked: number[] = [];
    const freed: number[] = [];
    const fake = {
      _emscripten_builtin_malloc: (n: number) => (asked.push(n), n <= 512 * 2 ** 20 ? 4096 : 0),
      _emscripten_builtin_free: (p: number) => freed.push(p),
      wasmMemory: { buffer: { byteLength: 600 * 2 ** 20 } },
    } as unknown as OC;
    expect(reserveHeap(fake, 2 ** 30)).toBe(600 * 2 ** 20);
    expect(asked).toEqual([1024, 768, 512].map((m) => m * 2 ** 20));
    expect(freed).toEqual([4096]);

    const never = { ...(fake as object), _emscripten_builtin_malloc: () => 0 } as unknown as OC;
    expect(reserveHeap(never, 2 ** 30)).toBe(0);
  });

  it("turns OCCT's exceptions into words", () => {
    // Tag and Exception are newer than the TypeScript DOM types.
    const W = WebAssembly as unknown as {
      Tag: new (d: { parameters: string[] }) => object;
      Exception: new (tag: object, payload: unknown[]) => object;
    };
    const ex = new W.Exception(new W.Tag({ parameters: [] }), []);
    const says = (r: () => [string, string]) => ({ getExceptionMessage: r }) as unknown as OC;
    expect(
      occtErrorMessage(
        says(() => ["Standard_Failure", "BRep_API: command not done"]),
        ex,
      ),
    ).toBe("Standard_Failure: BRep_API: command not done");
    expect(
      occtErrorMessage(
        says(() => ["StdFail_NotDone", ""]),
        ex,
      ),
    ).toBe("StdFail_NotDone");
    expect(
      occtErrorMessage(
        says(() => {
          throw new Error("no message");
        }),
        ex,
      ),
    ).toBe("OCCT exception");
    expect(occtErrorMessage({} as OC, "plain")).toBe("plain");
    expect(occtErrorMessage({} as OC, new Error("an error"))).toBe("an error");
  });
});
