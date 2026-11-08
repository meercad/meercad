/**
 * The UI end-to-end run: every test model in tests/models is built again by hand in the Mac app,
 * with mouse and keyboard on the visible interface (scripts in ./scripts.ts), and what comes out is
 * checked against the model's expectation, the same numbers the kernel test checks
 * (tests/acceptance/models.test.ts). Models without a script yet are listed as todo.
 *
 *   pnpm test:e2e                      all scripted models
 *   E2E_ONLY="01,02" pnpm test:e2e     only these (by number)
 *   E2E_OUT=<folder> pnpm test:e2e     keep a screenshot and the .meercad file of every result
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MODELS, type Expectation } from "../models/models.js";
import { startApp, type App } from "./app.js";
import { SCRIPTS } from "./scripts.js";
import { Ui } from "./ui.js";

interface Result {
  failed: string[];
  bodies: { volume: number; bbox: { min: number[]; max: number[] } }[];
  joints: string[];
}

function check(r: Result, want: Expectation) {
  expect(r.failed).toEqual([]);
  expect(r.bodies).toHaveLength(want.bodies);
  expect(r.joints).toEqual([]);
  const volume = r.bodies.reduce((s, b) => s + b.volume, 0);
  if (typeof want.volume === "number") expect(Math.abs(volume - want.volume) / want.volume, `volume ${volume} vs ${want.volume}`).toBeLessThan(0.005);
  else if (want.volume) {
    expect(volume).toBeGreaterThan(want.volume[0]);
    expect(volume).toBeLessThan(want.volume[1]);
  }
  if (want.size) {
    const min = [0, 1, 2].map((i) => Math.min(...r.bodies.map((b) => b.bbox.min[i]!)));
    const max = [0, 1, 2].map((i) => Math.max(...r.bodies.map((b) => b.bbox.max[i]!)));
    const size = max.map((v, i) => v - min[i]!);
    size.forEach((s, i) => expect(Math.abs(s - want.size![i]!), `size ${size.map((v) => v.toFixed(2)).join(" × ")}`).toBeLessThan(0.05));
  }
}

/** What the app shows for the open part: failed features, parts, joint errors. */
const result = async (ui: Ui) => {
  await ui.settle();
  // Volumes come in a moment after the shapes (the app measures them in the background).
  await ui.until("the parts' volumes", "s.output.report.bodies.every((b) => b.volume > 0)", 120000);
  return ui.state<Result>(`({
    failed: s.output.report.features.filter((f) => f.status !== "ok").map((f) => f.id + ": " + f.message),
    bodies: s.output.report.bodies.map((b) => ({ volume: b.volume, bbox: b.bbox })),
    joints: (s.output.report.joints ?? []).filter((j) => j.error).map((j) => j.id + ": " + j.error),
  })`);
};

const only = process.env["E2E_ONLY"]?.split(",").map((s) => s.trim().padStart(2, "0"));
const out = process.env["E2E_OUT"];
const picked = MODELS.filter((m) => !only || only.includes(m.file.slice(0, 2)));

describe("test models built in the app", () => {
  let app: App;
  let ui: Ui;
  beforeAll(async () => {
    app = await startApp();
    ui = new Ui(app.page);
  });
  afterAll(async () => app?.stop());
  // Each model in a part of its own, closed afterwards even when a step failed.
  afterEach(async () => ui?.closePart().catch(() => undefined));

  for (const m of picked) {
    const script = SCRIPTS[m.file];
    if (!script) {
      it.todo(`${m.file}: ${m.name}`);
      continue;
    }
    it(`${m.file}: ${m.name}`, async () => {
      app.page.takeErrors();
      try {
        await ui.newPart();
        await script(ui);
        await ui.settle();
      } catch (e) {
        // What the screen showed when a step could not go on.
        const dir = out ?? join(app.dir, "..");
        mkdirSync(dir, { recursive: true });
        await app.page.shot(join(dir, `${m.file} FAILED.png`)).catch(() => undefined);
        throw e;
      }
      const r = await result(ui);
      if (out) {
        mkdirSync(out, { recursive: true });
        await ui.view("1");
        await ui.view("z");
        await app.page.shot(join(out, `${m.file}.png`));
        writeFileSync(join(out, `${m.file}.meercad`), JSON.stringify(await ui.state("s.doc"), null, 2));
      }
      check(r, m.expect);
      // The model's variants: each variable typed into its row in the Variables panel, the result
      // checked, the values put back.
      for (const v of m.variants ?? []) {
        for (const [k, val] of Object.entries(v.params)) await ui.setVariable(k, val);
        check(await result(ui), v.expect);
        for (const k of Object.keys(v.params)) await ui.setVariable(k, m.doc.params[k]!);
      }
      expect(app.page.takeErrors(), "console errors").toEqual([]);
    });
  }
});
