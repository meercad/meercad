import { describe, expect, it } from "vitest";
import { exportStep } from "@meercad/kernel";
import type { Feature } from "@meercad/schema";
import { doc, getOcct, newSession, rect, sketch } from "./helpers.js";

const two: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("a", 0, 0, 10, 10)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  sketch("sk2", { ref: "origin.XY" }, rect("b", 30, 0, 20, 10)),
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "new_body" },
];

describe("STEP with names and colours", () => {
  it("writes each part with its name and colour, and the file reads back", async () => {
    const s = await newSession();
    s.rebuild(doc(two));

    const oc = await getOcct();
    const data = exportStep(oc, s.state!, undefined, [
      { id: "ex1", name: "Weight", color: "#ff0000" },
      { id: "ex2", name: "Housing ä", color: "#3366cc" },
    ]);
    const text = new TextDecoder().decode(data);
    expect(text).toContain("ISO-10303-21");
    expect(text).toMatch(/PRODUCT\('Weight'/);
    expect(text).toContain("STYLED_ITEM");
    // Pure red is one of STEP's named colours; the blue goes out as its RGB values.
    expect(text).toMatch(/PRE_DEFINED_COLOUR\('red'\)/);

    const rgb = /COLOUR_RGB\('[^']*',([\d.]+),([\d.]+),([\d.]+)\)/.exec(text)!.slice(1).map(Number);
    expect(rgb.map((v) => Math.round(v * 255))).toEqual([0x33, 0x66, 0xcc]);
    // One file: no extra documents per part.
    expect(text).not.toContain(".stp-Doc");

    // The parts read back as two solids.
    const back = await newSession();
    const { report } = back.rebuild(
      doc([
        {
          id: "im1",
          op: "import",
          format: "step",
          fileName: "x.step",
          data: Buffer.from(data).toString("base64"),
        } as Feature,
      ]),
    );
    expect(report.features[0]!.status).toBe("ok");
    expect(report.bodies[0]!.volume).toBeCloseTo(1000 + 2000, 3);
  });

  it("writes plain STEP without part details", async () => {
    const s = await newSession();
    s.rebuild(doc(two));

    const text = new TextDecoder().decode(exportStep(await getOcct(), s.state!));
    expect(text).not.toContain("STYLED_ITEM");
  });

  it("reads a STEP assembly back as one part per solid when split", async () => {
    const s = await newSession();
    s.rebuild(doc(two));

    const data = Buffer.from(
      exportStep(await getOcct(), s.state!, undefined, [
        { id: "ex1", name: "A" },
        { id: "ex2", name: "B" },
      ]),
    ).toString("base64");
    const back = await newSession();
    const { report } = back.rebuild(
      doc([{ id: "im1", op: "import", format: "step", fileName: "x.step", data, split: true } as Feature]),
    );
    expect(report.bodies.map((b) => [b.id, Math.round(b.volume)])).toEqual([
      ["im1", 1000],
      ["im1_2", 2000],
    ]);
  });

  it("writes moved parts where they are shown", async () => {
    const s = await newSession();
    s.rebuild(doc(two));

    // ex1 turned a quarter about z through the origin: from x 0…10 to x −10…0.
    const quarter = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

    for (const parts of [
      [
        { id: "ex1", name: "A", pose: quarter },
        { id: "ex2", name: "B" },
      ],
      [{ id: "ex1", name: "A", pose: quarter }],
    ]) {
      const data = Buffer.from(exportStep(await getOcct(), s.state!, ["ex1"], parts)).toString("base64");
      const back = await newSession();
      const { report } = back.rebuild(
        doc([{ id: "im1", op: "import", format: "step", fileName: "x.step", data } as Feature]),
      );
      expect(report.bodies[0]!.bbox.min[0]).toBeCloseTo(-10, 5);
      expect(report.bodies[0]!.bbox.max[0]).toBeCloseTo(0, 5);
    }
  });
});
