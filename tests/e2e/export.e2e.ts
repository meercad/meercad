/**
 * Export from the Mac app, as a person does it: open an example, export STL, 3MF and STEP through
 * command search, and check each written file against the model the app shows: size, volume, units,
 * a closed surface. The files are saved into the run's own folder (no save dialog in this run).
 *
 *   E2E_FILE=tests/e2e/export.e2e.ts pnpm test:e2e
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { meshVolume, read3mf, readStl } from "@meercad/io";
import { doc, newSession } from "../acceptance/helpers.js";
import { sleep } from "./cdp.js";
import { startApp, type App } from "./app.js";
import { Ui } from "./ui.js";

describe("export from the app", () => {
  let app: App;
  let ui: Ui;
  let model: { volume: number; min: number[]; max: number[] };
  beforeAll(async () => {
    app = await startApp();
    ui = new Ui(app.page);
    app.page.takeErrors();
    // The examples may be folded away; the first click into a fresh window may only bring it forward.
    if (!(await ui.find("button.card", "Mounting plate"))) await ui.press("Examples", "button.home-section-toggle");
    for (let i = 0; !(await ui.state<boolean>("s.screen === 'editor'")); i++) {
      if (i === 3) throw new Error("the example did not open");
      await ui.press("Mounting plate", "button.card");
      await sleep(1500);
    }
    await ui.until("the example to build", "(s.output?.report.bodies.length ?? 0) > 0", 60000);
    await ui.settle();
    model = await ui.state("(() => { const b = s.output.report.bodies[0]; return { volume: b.volume, min: b.bbox.min, max: b.bbox.max }; })()");
    // The mounting plate: 60 × 40 × 4 with rounded corners, two holes and countersinks.
    expect(model.max.map((v, i) => +(v - model.min[i]!).toFixed(3))).toEqual([60, 40, 4]);
  });
  afterAll(async () => app?.stop());

  /** Runs a command by its name through command search, as a person would type it. */
  async function command(name: string): Promise<void> {
    await ui.press("Search commands");
    await ui.type(name);
    await sleep(200);
    await ui.key("Enter");
  }
  async function saved(file: string): Promise<Buffer> {
    const path = join(app.saved, file);
    const end = Date.now() + 60000;
    while (!existsSync(path)) {
      if (Date.now() > end) throw new Error(`${file} was not saved; saved: ${JSON.stringify(app.page.takeErrors())}`);
      await sleep(200);
    }
    await sleep(300);
    return readFileSync(path);
  }
  const extent = (v: Float32Array) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k]!, v[i + k]!)), (max[k] = Math.max(max[k]!, v[i + k]!));
    return { min, max };
  };
  const near = (got: number[], want: number[], tol: number) => got.forEach((g, i) => expect(Math.abs(g - want[i]!), `axis ${i}: ${g} vs ${want[i]}`).toBeLessThan(tol));

  it("STL: the shown size in mm and the volume within 0.1 %", async () => {
    await command("Export STL");
    const stl = readStl(new Uint8Array(await saved("Mounting plate.stl")));
    const e = extent(stl.vertices);
    near(e.min, model.min, 1e-3);
    near(e.max, model.max, 1e-3);
    expect(Math.abs(meshVolume(stl.vertices) - model.volume) / model.volume).toBeLessThan(1e-3);
  });

  it("3MF: millimetres, one named object, the same volume", async () => {
    await command("Export 3MF");
    const file = new Uint8Array(await saved("Mounting plate.3mf"));
    expect(strFromU8(unzipSync(file)["3D/3dmodel.model"]!)).toContain('unit="millimeter"');
    const parts = read3mf(file);
    expect(parts).toHaveLength(1);
    const m = parts[0]!;
    const soup = new Float32Array(m.indices.length * 3);
    m.indices.forEach((ix, i) => soup.set(m.positions.subarray(ix * 3, ix * 3 + 3), i * 3));
    expect(Math.abs(meshVolume(soup) - model.volume) / model.volume).toBeLessThan(1e-3);
    near(extent(soup).max, model.max, 1e-3);
  });

  it("STEP: exact solid, read back with the same volume and size", async () => {
    await command("Export STEP");
    const step = await saved("Mounting plate.step");
    expect(step.subarray(0, 40).toString()).toContain("ISO-10303-21");
    const { report } = (await newSession()).rebuild(doc([{ id: "im1", op: "import", format: "step", fileName: "p.step", data: step.toString("base64") }]));
    expect(report.features.filter((f) => f.status !== "ok")).toEqual([]);
    expect(report.bodies[0]!.volume).toBeCloseTo(model.volume, 3);
    near(report.bodies[0]!.bbox.max, model.max, 1e-4);
    expect(app.page.takeErrors(), "console errors").toEqual([]);
  });
});
