import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateDocument, type MeercadDocument } from "@meercad/schema";
import { MODELS, type Expectation } from "../models/models.js";
import { newSession, withParams } from "./helpers.js";

async function check(doc: MeercadDocument, want: Expectation) {
  const { report } = (await newSession()).rebuild(doc);
  expect(report.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
  expect(report.bodies).toHaveLength(want.bodies);
  const volume = report.bodies.reduce((s, b) => s + b.volume, 0);
  if (typeof want.volume === "number") expect(Math.abs(volume - want.volume) / want.volume, `volume ${volume} vs ${want.volume}`).toBeLessThan(0.005);
  else if (want.volume) {
    expect(volume).toBeGreaterThan(want.volume[0]);
    expect(volume).toBeLessThan(want.volume[1]);
  }
  if (want.size) {
    const min = [0, 1, 2].map((i) => Math.min(...report.bodies.map((b) => b.bbox.min[i]!)));
    const max = [0, 1, 2].map((i) => Math.max(...report.bodies.map((b) => b.bbox.max[i]!)));
    const size = max.map((v, i) => v - min[i]!);
    size.forEach((s, i) => expect(Math.abs(s - want.size![i]!), `size ${size.map((v) => v.toFixed(2)).join(" × ")}`).toBeLessThan(0.05));
  }
}

describe("test models", () => {
  it.each(MODELS.map((m) => [m.file, m] as const))("%s", async (_, m) => {
    expect(validateDocument(m.doc).ok).toBe(true);
    await check(m.doc, m.expect);
    for (const v of m.variants ?? []) await check(withParams(m.doc, v.params), v.expect);
  }, 120_000);

  // MEERCAD_MODELS_OUT=<folder> writes the models as .meercad files to open in the app.
  const out = process.env["MEERCAD_MODELS_OUT"];
  it.skipIf(!out)("writes the models", () => {
    mkdirSync(out!, { recursive: true });
    for (const m of MODELS) writeFileSync(join(out!, `${m.file}.meercad`), `${JSON.stringify(m.doc, null, 2)}\n`);
  });
});
