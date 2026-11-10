/**
 * Every corpus file and test model: each step changed in turn must give the model built from
 * scratch (see incremental.test.ts for what is kept between rebuilds).
 */
import { readdirSync } from "node:fs";
import { describe, it } from "vitest";
import { MODELS } from "../models/models.js";
import { checkEveryStep, corpus } from "./helpers.js";

describe("rebuilding only what a change touches: all files", () => {
  for (const file of readdirSync(new URL("../corpus/", import.meta.url)).filter((f) => f.endsWith(".meercad.json")).sort()) {
    it(`corpus ${file}`, async () => {
      await checkEveryStep(corpus(file), file);
    });
  }
  for (const m of MODELS) {
    it(`model ${m.file}`, async () => {
      await checkEveryStep(m.doc, m.file);
    });
  }
});
