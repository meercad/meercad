import { describe, expect, it } from "vitest";
import { KernelSession, loadOcct } from "@meercad/kernel";
import { EXAMPLES } from "../../apps/web/src/lib/examples.js";
import { getSolver, newSession } from "./helpers.js";

describe("multi-threaded OCCT build", () => {
  it("rebuilds the examples to the same bodies as the single-threaded build", async () => {
    const mt = new KernelSession(await loadOcct(undefined, true), await getSolver());
    const st = await newSession();
    // Springs and coils are long helical sweeps (minutes for both builds); coil.test.ts covers them.
    const helical = (e: (typeof EXAMPLES)[number]) =>
      e.doc.features.some((f) => f.op === "coil" || f.op === "spring");

    for (const ex of EXAMPLES.filter((e) => !e.url && !helical(e))) {
      // Only the solids are compared: meshing would just cost time.
      const a = st.rebuild(ex.doc, { mesh: false }).report.bodies[0]!;
      const b = mt.rebuild(ex.doc, { mesh: false }).report.bodies[0]!;
      expect(b.faces, ex.name).toBe(a.faces);
      expect(b.edges, ex.name).toBe(a.edges);
      // Relative: the larger examples differ in the last digits between the builds.
      expect(Math.abs(b.volume - a.volume) / a.volume, ex.name).toBeLessThan(1e-8);
      expect(Math.abs(b.area - a.area) / a.area, ex.name).toBeLessThan(1e-8);
    }
    // Every example twice: about a minute here, twice that on the CI machines.
  }, 360_000);
});
