import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const slow = new Set<string>();
// A file macOS guards: opening it waits (for the user's OK), it does not fail.
vi.mock("node:fs/promises", async (orig) => {
  const fs = await orig<typeof import("node:fs/promises")>();
  const hang = <T,>(p: string, run: () => Promise<T>) => ([...slow].some((d) => p.startsWith(d)) ? new Promise<T>(() => undefined) : run());
  return {
    ...fs,
    readFile: ((p: string, ...a: unknown[]) => hang(p, () => (fs.readFile as (...x: unknown[]) => Promise<Buffer>)(p, ...a))) as typeof fs.readFile,
    writeFile: ((p: string, ...a: unknown[]) => hang(p, () => (fs.writeFile as (...x: unknown[]) => Promise<void>)(p, ...a))) as typeof fs.writeFile,
  };
});

const { readLocal, resetBlocked, writeLocal } = await import("./localFiles");
const { meercadDocument } = await import("./meercadFile");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "meercad-local-"));
  slow.clear();
  resetBlocked();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const app = () => ({ read: vi.fn(async () => new TextEncoder().encode("from app")), write: vi.fn(async () => undefined) });

describe("local files", () => {
  it("reads and writes directly where it may", async () => {
    const a = app();
    await writeFile(join(dir, "a.txt"), "hello");
    expect((await readLocal(join(dir, "a.txt"), a, 200)).toString()).toBe("hello");
    await writeLocal(join(dir, "sub", "b.txt"), new TextEncoder().encode("out"), a, 200);
    expect(await readFile(join(dir, "sub", "b.txt"), "utf8")).toBe("out");
    expect(a.read).not.toHaveBeenCalled();
    expect(a.write).not.toHaveBeenCalled();
  });

  it("hands a file that does not open in time to the app, and the next ones in that folder at once", async () => {
    slow.add(dir);
    const a = app();
    const t0 = performance.now();
    expect((await readLocal(join(dir, "t1.meercad"), a, 100)).toString()).toBe("from app");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(90);
    const t1 = performance.now();
    await readLocal(join(dir, "other.meercad"), a, 5000);
    expect(performance.now() - t1).toBeLessThan(1000);
    await writeLocal(join(dir, "out.stl"), new Uint8Array([1]), a, 5000);
    expect(a.read).toHaveBeenCalledTimes(2);
    expect(a.write).toHaveBeenCalledWith(join(dir, "out.stl"), new Uint8Array([1]));
  });

  it("says what to do when neither may reach the file", async () => {
    slow.add(dir);
    const a = { read: async () => Promise.reject(new Error("EPERM")), write: async () => undefined };
    await expect(readLocal(join(dir, "x.meercad"), a, 50)).rejects.toThrow(/Privacy & Security.*another folder/s);
  });

  it("reports a missing file at once", async () => {
    await expect(readLocal(join(dir, "missing.step"), app(), 5000)).rejects.toThrow(/ENOENT/);
  });
});

describe("meercad files", () => {
  const doc = { format: "meercad/1", params: {}, features: [{ id: "b1", op: "primitive" }], rollback: null };
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  it("reads a saved design and a wrapped one", () => {
    expect(meercadDocument(bytes(doc), "a.meercad")).toEqual({ doc });
    expect(meercadDocument(bytes({ name: "importtest", document: doc }), "t1.meercad")).toEqual({ doc, name: "importtest" });
    expect(meercadDocument(bytes({ format: "meercad/1", features: [] }), "leg.meercad").doc).toEqual({ format: "meercad/1", params: {}, features: [], rollback: null });
  });
  it("rejects what is no design", () => {
    expect(() => meercadDocument(new TextEncoder().encode("{"), "x.meercad")).toThrow(/not a meerCAD file/);
    expect(() => meercadDocument(bytes({ name: "x" }), "x.meercad")).toThrow(/no features/);
  });
});
