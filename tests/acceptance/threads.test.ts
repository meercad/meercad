import { describe, expect, it } from "vitest";
import { KernelSession, loadOcct } from "@meercad/kernel";
import { EXAMPLES } from "../../apps/web/src/lib/examples.js";
import { getSolver, newSession } from "./helpers.js";

describe("multi-threaded OCCT build", () => {
  it("rebuilds the examples to the same bodies as the single-threaded build", async () => {
    const mt = new KernelSession(await loadOcct(undefined, true), await getSolver());
    const st = await newSession();
    for (const ex of EXAMPLES) {
      const a = st.rebuild(ex.doc).report.bodies[0]!;
      const b = mt.rebuild(ex.doc).report.bodies[0]!;
      expect(b.faces, ex.name).toBe(a.faces);
      expect(b.edges, ex.name).toBe(a.edges);
      expect(b.volume, ex.name).toBeCloseTo(a.volume, 6);
      expect(b.area, ex.name).toBeCloseTo(a.area, 6);
    }
  });
});
