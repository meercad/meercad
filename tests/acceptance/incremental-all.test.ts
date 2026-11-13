/**
 * Every corpus file and test model: each step changed in turn must give the model built from
 * scratch (see incremental.test.ts for what is kept between rebuilds).
 */
import { readdirSync } from "node:fs";
import { describe, it } from "vitest";
import { MODELS } from "../models/models.js";
import { checkEveryStep, corpus } from "./helpers.js";

// Each file is built from scratch twice per step, so big files take long: the Stapelbox (36 steps)
// needs about 115 s on a 4-core runner alone and more next to the other slow files.
const TIMEOUT = 600_000;

describe("rebuilding only what a change touches: all files", () => {
  for (const file of readdirSync(new URL("../corpus/", import.meta.url))
    .filter((f) => f.endsWith(".meercad.json"))
    .sort()) {
    it(
      `corpus ${file}`,
      async () => {
        await checkEveryStep(corpus(file), file);
      },
      TIMEOUT,
    );
  }

  for (const m of MODELS) {
    it(
      `model ${m.file}`,
      async () => {
        await checkEveryStep(m.doc, m.file);
      },
      TIMEOUT,
    );
  }
});
