/**
 * After a change to one step, only the steps that read something changed are run again; the others
 * keep their earlier result. Whatever is changed, the model must come out as it does from scratch.
 */
import { describe, expect, it } from "vitest";
import type { MeercadDocument } from "@meercad/schema";
import { nudged, sameModel } from "../incremental-check.js";
import { checkEveryStep, corpus, doc, getOcct, newSession } from "./helpers.js";

describe("rebuilding only what a change touches", () => {
  // Two quick ones here; every corpus file and test model in incremental-all.test.ts.
  for (const file of ["feature-12-booleans-and-copies", "mounting-plate"]) {
    it(`${file}: every step changed in turn gives the model built from scratch`, async () => {
      await checkEveryStep(corpus(`${file}.meercad.json`), file);
    });
  }

  it("a change to one part leaves steps on other parts alone", async () => {
    const oc = await getOcct();
    const base = doc([
      { id: "a", op: "primitive", shape: "box", size: [20, 20, 10], center: [0, 0, 5], mode: "new_body" },
      { id: "b", op: "primitive", shape: "box", size: [20, 20, 10], center: [100, 0, 5], mode: "new_body" },
      { id: "a_cut", op: "primitive", shape: "cylinder", diameter: 5, height: 30, center: [0, 0, 5], mode: "cut", targets: ["a"] },
      { id: "b_cut", op: "primitive", shape: "cylinder", diameter: 5, height: 30, center: [100, 0, 5], mode: "cut", targets: ["b"] },
      // No targets: it finds the part by where it reaches.
      { id: "b_slot", op: "primitive", shape: "box", size: [4, 30, 4], center: [100, 0, 9], mode: "cut" },
      { id: "both_up", op: "transform", bodies: ["a", "b"], translate: [0, 0, 3] },
      { id: "b_top", op: "primitive", shape: "box", size: [6, 6, 2], center: [100, 0, 14], mode: "join", targets: ["b"] },
    ] as MeercadDocument["features"]);
    const session = await newSession();
    session.rebuild(base, { props: false });
    const partB = session.state!.bodies.get("b");
    const computed: string[] = [];
    session.rebuild(nudged(base, "a_cut"), { props: false, onFeature: (_i, _n, id) => computed.push(id) });
    // The cut itself and the move (which reads part a); nothing that only concerns part b.
    expect(computed).toEqual(["a_cut", "both_up"]);
    // Part b is the very same object as before, so its mesh is not made again either.
    expect(session.state!.bodies.get("b")).toBe(partB);
    const fresh = await newSession();
    fresh.rebuild(nudged(base, "a_cut"), { props: false, mesh: false });
    expect(sameModel(oc, session.state!, fresh.state!)).toBeNull();
  });
});
