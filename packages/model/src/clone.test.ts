import { describe, expect, it } from "vitest";
import type { MeercadDocument } from "@meercad/schema";
import { cloneJson } from "./clone.js";
import { DocumentStore } from "./store.js";

describe("cloneJson", () => {
  it("copies objects and arrays all the way down", () => {
    const original = { a: [1, { b: "x", c: [true, null] }], d: { e: 2.5 }, f: undefined };
    const copy = cloneJson(original);

    expect(copy).toEqual(original);
    expect("f" in copy).toBe(true);
    expect(copy).not.toBe(original);
    expect(copy.a).not.toBe(original.a);
    expect(copy.a[1]).not.toBe(original.a[1]);
    expect((copy.a[1] as { c: unknown[] }).c).not.toBe((original.a[1] as { c: unknown[] }).c);
    expect(copy.d).not.toBe(original.d);

    (copy.a[1] as { b: string }).b = "y";
    copy.d.e = 3;
    expect(original).toEqual({ a: [1, { b: "x", c: [true, null] }], d: { e: 2.5 }, f: undefined });
  });

  it("hands plain values back as they are", () => {
    expect(cloneJson(3)).toBe(3);
    expect(cloneJson("text")).toBe("text");
    expect(cloneJson(null)).toBeNull();
    expect(cloneJson(undefined)).toBeUndefined();
    expect(cloneJson(false)).toBe(false);
  });
});

describe("a design with a large imported file", () => {
  const megabytes = () => (process.memoryUsage().heapUsed + process.memoryUsage().external) / 1e6;

  it("does not hold the file once more with every step and every version", () => {
    // 20 MB of file contents; with a copy per step the 60 steps below came to 1.8 GB.
    const data = Buffer.alloc(20_000_000, "A").toString("latin1");
    const doc: MeercadDocument = {
      format: "meercad/1",
      params: {},
      rollback: null,
      features: [{ id: "im1", op: "import", format: "stl", fileName: "a.stl", data, suppressed: true }],
    };
    const store = new DocumentStore(doc);
    const before = megabytes();

    for (let i = 0; i < 30; i++) store.apply({ type: "set_param", name: "a", expr: i });

    store.apply({ type: "save_version", name: "v1" });
    for (let i = 0; i < 30; i++) store.apply({ type: "set_param", name: "a", expr: i });

    store.apply({ type: "restore_version", name: "v1" });

    expect(megabytes() - before).toBeLessThan(200);
    expect(store.doc.features[0]).toMatchObject({ id: "im1", data });
    expect(Object.values(store.doc.blobs ?? {})).toEqual([data]);

    // Undo still finds every step as it was.
    for (let i = 0; i < 32; i++) store.undo();

    expect(store.doc.params).toEqual({ a: 29 });
    expect(store.doc.versions).toBeUndefined();
  });
});
