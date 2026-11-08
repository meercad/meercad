/**
 * Memory and files: the kernel must not grow with every rebuild (a long session would run out of
 * memory, on the iPad first), and export/import of big parts must stay quick.
 */
import { describe, expect, it } from "vitest";
import { KernelSession, exportMeshes, exportStep, loadOcct, type OC } from "@meercad/kernel";
import { parseStl, write3mf, writeStl } from "@meercad/io";
import { SketchSolver } from "@meercad/sketch";
import { MODELS } from "../models/models.js";
import { check, report, time } from "./harness.js";

report();

const model = (file: string) => {
  const m = MODELS.find((x) => x.file === file);
  if (!m) throw new Error(`no test model ${file}`);
  return m;
};
/** Many features, several parts and a variant: a typical "real" design. */
const BIG = model("39 Stapelbox");
const MB = 2 ** 20;

let oc: OC;
let solver: SketchSolver;

describe("memory and file performance", () => {
  it("does not grow with every rebuild", async () => {
    oc = await loadOcct();
    solver = await SketchSolver.create();
    const changed = { ...BIG.doc, params: { ...BIG.doc.params, ...BIG.variants![0]!.params } };
    const wasm = () => oc.wasmMemory.buffer.byteLength / MB;
    const run = (n: number) => {
      // A fresh session per round, like opening and closing a tab, plus value changes in it.
      for (let i = 0; i < n; i++) {
        const s = new KernelSession(oc, solver);
        s.rebuild(BIG.doc);
        s.rebuild(changed);
        s.rebuild(BIG.doc);
        s.dispose();
      }
    };
    run(3); // warm up: WASM memory grows to its working size and stays there
    const before = wasm();
    run(10);
    const growth = wasm() - before;
    // WASM memory never shrinks, so growth here is memory that was not given back (or not yet: some
    // OCCT objects are freed only when the JS garbage collector runs).
    // Known on 2026-11-08: the Stapelbox grows about 15 MB per open and levels off near 600 MB.
    // The budget holds that state so it gets no worse; lower it once the cause is fixed.
    check("memory: WASM growth over 10 open/change/close rounds", { value: growth, unit: "MB" }, 640);
    check("memory: WASM size after the rounds", { value: wasm(), unit: "MB" }, 1024);
  });

  it("exports a big part", () => {
    const s = new KernelSession(oc, solver);
    s.rebuild(BIG.doc);
    const state = s.state!;
    let step: Uint8Array = new Uint8Array();
    check("export: STEP", time(() => (step = exportStep(oc, state)), 3), 3000);
    expect(step.length).toBeGreaterThan(1000);
    let meshes = exportMeshes(oc, state);
    check("export: fine print meshes", time(() => (meshes = exportMeshes(oc, state)), 3), 3000);
    check("export: print mesh triangles", { value: meshes.reduce((n, m) => n + m.indices.length / 3, 0), unit: "tris" }, 3_000_000);
    check("export: 3MF", time(() => write3mf(meshes.map((m) => ({ positions: m.positions, indices: m.indices, name: m.bodyId }))), 3), 1500);
    check("export: STL", time(() => writeStl(meshes), 3), 1000);
    s.dispose();
  });

  it("reads a big STL", () => {
    // About a million triangles: a detailed scan or a downloaded figure.
    const n = 320;
    const positions = new Float32Array((n + 1) * (n + 1) * 3);
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) positions.set([i, j, Math.sin(i / 9) * Math.cos(j / 7) * 5], (i * (n + 1) + j) * 3);
    const indices = new Uint32Array(n * n * 6);
    for (let i = 0, k = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const a = i * (n + 1) + j;
        indices.set([a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1], k);
        k += 6;
      }
    const mesh = { positions, indices };
    const stl = writeStl([mesh, mesh, mesh, mesh, mesh]);
    let tris = 0;
    check("import: STL, 1 M triangles", time(() => (tris = parseStl(stl).indices.length / 3), 3), 2000);
    expect(tris).toBe(5 * n * n * 2);
  });
});
