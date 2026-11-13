import { emptyDocument, type MeercadDocument } from "@meercad/schema";
import type { RebuildOutput } from "@meercad/kernel/client";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Opening a big design took up to minutes (every feature again, then meshing every part). The last
 * result is kept per project on the device and shown at once when the same document opens again.
 */

/** Just enough IndexedDB for openCache: stores of values by key, requests that answer on the next tick. */
function fakeIndexedDb() {
  const stores = new Map<string, Map<string, unknown>>();

  const request = <T>(fn: () => T) => {
    const req: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
    queueMicrotask(() => {
      try {
        req.result = fn();
        req.onsuccess?.();
      } catch (e) {
        req.error = e;
        req.onerror?.();
      }
    });

    return req;
  };

  const db = {
    createObjectStore: (name: string) => stores.set(name, new Map()),
    transaction: (names: string | string[]) => {
      const tx: {
        oncomplete?: () => void;
        onerror?: () => void;
        onabort?: () => void;
        objectStore: (n: string) => unknown;
      } = {
        objectStore: (n: string) => {
          const s = stores.get(n)!;

          return {
            get: (k: string) => request(() => structuredClone(s.get(k))),
            put: (v: unknown, k: string) => request(() => s.set(k, structuredClone(v))),
            delete: (k: string) => request(() => s.delete(k)),
            getAll: () => request(() => [...s.values()]),
            getAllKeys: () => request(() => [...s.keys()]),
          };
        },
      };
      void names;
      setTimeout(() => tx.oncomplete?.(), 0);

      return tx;
    },
  };

  return {
    stores,
    open: () => {
      const req: { result?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void } = {};
      queueMicrotask(() => {
        req.result = db;
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });

      return req;
    },
  };
}

const fake = fakeIndexedDb();
let cache: typeof import("../apps/web/src/lib/openCache");
beforeAll(async () => {
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = fake;
  cache = await import("../apps/web/src/lib/openCache");
});

const opts = { build: "/assets/kernel.worker-abc123.js", coarse: 1, textures: true };

function output(triangles: number): RebuildOutput {
  const mesh = {
    bodyId: "ex1",
    positions: new Float32Array(triangles * 9),
    normals: new Float32Array(triangles * 9),
    indices: new Uint32Array(triangles * 3),
    faceRanges: new Int32Array([0, triangles * 3, 0]),
    edgeLines: new Float32Array(),
    edgeRanges: new Int32Array(),
    faceTags: [["ex1.side"]],
    edgeFaces: [],
  };

  return { report: { bodies: [] } as unknown as RebuildOutput["report"], meshes: [mesh], references: [] };
}

describe("kept results for opening", () => {
  const doc: MeercadDocument = emptyDocument();
  const changed: MeercadDocument = { ...doc, params: { width: "60 mm" } };

  it("tells documents, mesh settings and kernel builds apart", () => {
    const key = cache.outputKey(doc, opts);
    expect(cache.outputKey(structuredClone(doc), opts)).toBe(key);
    expect(cache.outputKey(changed, opts)).not.toBe(key);
    expect(cache.outputKey(doc, { ...opts, coarse: 2 })).not.toBe(key);
    expect(cache.outputKey(doc, { ...opts, textures: false })).not.toBe(key);
    expect(cache.outputKey(doc, { ...opts, build: "/assets/kernel.worker-def456.js" })).not.toBe(key);
    expect(cache.hashText("a")).not.toBe(cache.hashText("b"));
  });

  it("gives back a result only for the document it was made from", async () => {
    const out = output(10);
    await cache.writeOutput("Box.meercad", cache.outputKey(doc, opts), out);

    const back = await cache.readOutput("Box.meercad", cache.outputKey(doc, opts));
    expect(back?.meshes[0]!.indices.length).toBe(30);
    expect(back?.meshes[0]!.faceTags).toEqual([["ex1.side"]]);
    expect(await cache.readOutput("Box.meercad", cache.outputKey(changed, opts))).toBeNull();
    expect(await cache.readOutput("Other.meercad", cache.outputKey(doc, opts))).toBeNull();
  });

  it("forgets a deleted project", async () => {
    await cache.writeOutput("Gone.meercad", cache.outputKey(doc, opts), output(5));
    await cache.dropOutput("Gone.meercad");
    expect(await cache.readOutput("Gone.meercad", cache.outputKey(doc, opts))).toBeNull();
  });

  it("drops the least recently used results beyond its budget", async () => {
    // Three results of 300 kB in a budget of 768 kB (768 MB on a Mac): the oldest goes.
    cache.setBudget(768 * 1024);

    const big = (n: number) => output(Math.round((300 * 1024) / 84) + n);
    await cache.writeOutput("A.meercad", cache.outputKey(doc, opts), big(1));
    await new Promise((r) => setTimeout(r, 5));
    await cache.writeOutput("B.meercad", cache.outputKey(doc, opts), big(2));
    await new Promise((r) => setTimeout(r, 5));
    await cache.writeOutput("C.meercad", cache.outputKey(doc, opts), big(3));
    expect(fake.stores.get("outputs")!.has("A.meercad")).toBe(false);
    expect(fake.stores.get("outputs")!.has("B.meercad")).toBe(true);
    expect(fake.stores.get("outputs")!.has("C.meercad")).toBe(true);
    // A result too large for half the budget is not kept at all.
    await cache.writeOutput(
      "Huge.meercad",
      cache.outputKey(doc, opts),
      output(Math.round((400 * 1024) / 84)),
    );
    expect(fake.stores.get("outputs")!.has("Huge.meercad")).toBe(false);
  });
});
