import { describe, expect, it } from "vitest";
import { KernelSession, loadOcct } from "@meercad/kernel";
import { EXAMPLES } from "../../apps/web/src/lib/examples.js";
import { getSolver, newSession } from "./helpers.js";

describe("multi-threaded OCCT build", () => {
  it("rebuilds the examples to the same bodies as the single-threaded build", async () => {
    const mt = new KernelSession(await loadOcct(undefined, true), await getSolver());
    const st = await newSession();
    for (const ex of EXAMPLES.filter((e) => !e.url)) {
      const a = st.rebuild(ex.doc).report.bodies[0]!;
      const b = mt.rebuild(ex.doc).report.bodies[0]!;
      expect(b.faces, ex.name).toBe(a.faces);
      expect(b.edges, ex.name).toBe(a.edges);
      // Relative: the larger examples differ in the last digits between the builds.
      expect(Math.abs(b.volume - a.volume) / a.volume, ex.name).toBeLessThan(1e-8);
      expect(Math.abs(b.area - a.area) / a.area, ex.name).toBeLessThan(1e-8);
    }
  });
});
