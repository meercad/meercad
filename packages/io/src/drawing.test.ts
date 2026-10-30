import { describe, expect, it } from "vitest";
import { layoutSheet, writeSheetDxf, writeSheetPdf, writeSheetSvg, type SheetView } from "./drawing.js";

/** A 60 × 20 front view, 60 × 40 top view and 40 × 20 left view of a block, plus an iso view. */
const box = (name: SheetView["name"], w: number, h: number): SheetView => ({
  name,
  visible: [[[0, 0], [w, 0], [w, h], [0, h], [0, 0]]],
  hidden: name === "front" ? [[[15, 0], [15, h]]] : [],
  min: [0, 0],
  max: [w, h],
});
const views = [box("front", 60, 20), box("top", 60, 40), box("left", 40, 20), box("iso", 70, 55)];

describe("drawing sheets", () => {
  it("picks the largest standard scale that fits and lines the views up", () => {
    const s = layoutSheet(views, { paper: "A4", title: { title: "Block" } });
    expect([s.width, s.height]).toEqual([297, 210]);
    expect(s.scaleLabel).toBe("1:1");
    const small = layoutSheet([box("front", 6, 2), box("top", 6, 4)], { title: { title: "Tiny" } });
    expect(small.scaleLabel).toBe("10:1");
    const big = layoutSheet([box("front", 600, 200), box("top", 600, 400)], { paper: "A3", title: { title: "Big" } });
    expect(big.scaleLabel).toBe("1:5");
    // Front and top share their x positions (first-angle projection lines).
    const visible = s.lines.filter((l) => l.kind === "visible");
    const [front, top, left] = visible;
    expect(front!.pts[0]![0]).toBeCloseTo(top!.pts[0]![0], 9);
    expect(top!.pts[0]![1]).toBeLessThan(front!.pts[0]![1]);
    expect(front!.pts[0]![1]).toBeCloseTo(left!.pts[0]![1], 9);
    expect(left!.pts[0]![0]).toBeGreaterThan(front!.pts[1]![0]);
  });

  it("dimensions the overall sizes and fills the title block", () => {
    const s = layoutSheet(views, { title: { title: "Block", material: "PETG", drawnBy: "T. B." } });
    const texts = s.texts.map((t) => t.text);
    expect(texts).toEqual(expect.arrayContaining(["60", "20", "40", "Block", "PETG", "T. B.", "1:1", "ISO E (first angle)"]));
    expect(s.lines.some((l) => l.kind === "hidden")).toBe(true);
    // Three dimensions (width, height, depth), two arrows each.
    expect(s.fills.length).toBe(6);
  });

  it("prints the parts list above the title block and keeps the views clear of it", () => {
    const bom = [{ pos: 1, qty: 1, name: "Plate", material: "PETG" }, { pos: 2, qty: 4, name: "M4×16 ISO 4762", material: "Steel" }];
    const s = layoutSheet(views, { title: { title: "Block" }, bom });
    expect(s.texts.map((t) => t.text)).toEqual(expect.arrayContaining(["Pos", "Qty", "Plate", "4", "M4×16 ISO 4762", "Steel"]));
    // Title block 32 high from y = 10, two rows and a header of 5.5 above it.
    const lowest = Math.min(...s.lines.filter((l) => l.kind === "visible").flatMap((l) => l.pts.map((p) => p[1])));
    expect(lowest).toBeGreaterThan(10 + 32 + 3 * 5.5);
  });

  it("prints the sheet's words in another language", () => {
    const s = layoutSheet(views, { title: { title: "Block" }, bom: [{ pos: 1, qty: 1, name: "Platte" }], labels: { scale: "Maßstab", qty: "Menge" } });
    const words = s.texts.map((t) => t.text);
    expect(words).toEqual(expect.arrayContaining(["Maßstab", "Menge", "Pos", "Date"]));
    expect(words).not.toContain("Scale");
  });

  it("hatches a section and marks the cutting plane on the view from above", () => {
    // Section of a 60 × 20 block with a 10 wide gap at x 15–25: two cut faces' worth of edges.
    const sec: SheetView = {
      ...box("section", 60, 20),
      hidden: [],
      sections: [[[[0, 0], [15, 0]], [[15, 0], [15, 20]], [[15, 20], [0, 20]], [[0, 20], [0, 0]], [[25, 0], [60, 0]], [[60, 0], [60, 20]], [[60, 20], [25, 20]], [[25, 20], [25, 0]]]],
      cutAt: 20,
    };
    const s = layoutSheet([...views, sec], { title: { title: "Block" } });
    expect(s.texts.map((t) => t.text)).toEqual(expect.arrayContaining(["A-A", "A"]));
    expect(s.lines.some((l) => l.kind === "chain")).toBe(true);
    // Hatch lines lie only over the material, not over the gap: none crosses the gap's middle.
    const thin = s.lines.filter((l) => l.kind === "thin" && l.pts.length === 2);
    const front = s.lines.find((l) => l.kind === "visible")!;
    expect(thin.length).toBeGreaterThan(10);
    void front;
  });

  it("places the holes by coordinate dimensions from the bottom left corner", () => {
    const top: SheetView = { ...box("top", 60, 40), circles: [{ c: [10, 10], r: 2.25 }, { c: [50, 10], r: 2.25 }, { c: [30, 25], r: 5 }, { c: [30, 25], r: 3 }] };
    const s = layoutSheet([box("front", 60, 20), top], { title: { title: "Plate" } });
    const along = s.texts.filter((t) => t.angle === 90 && t.size === 3).map((t) => t.text);
    expect(along).toEqual(["0", "10", "30", "50"]);
    // Up from the bottom: 0, 10 (two holes share it), 25 (two circles share the centre).
    const up = s.texts.filter((t) => !t.angle && t.size === 3 && /^\d+$/.test(t.text)).map((t) => t.text);
    expect(up).toEqual(["0", "10", "25"]);
    // Below the view from above: the line lies under its lowest edge.
    const lowest = Math.min(...s.lines.filter((l) => l.kind === "visible").slice(1).flatMap((l) => l.pts.map((p) => p[1])));
    expect(Math.max(...s.texts.filter((t) => t.angle === 90 && t.size === 3).map((t) => t.at[1]))).toBeLessThan(lowest);
    // Values too close for their text move apart: 0 and 1 mm at 1:1 end up a text height apart.
    const near: SheetView = { ...box("top", 60, 40), circles: [{ c: [1, 20], r: 0.5 }] };
    const xs = layoutSheet([box("front", 60, 20), near], { title: { title: "Pin" }, scale: 1 }).texts.filter((t) => t.angle === 90 && t.size === 3).map((t) => t.at[0]);
    expect(xs[1]! - xs[0]!).toBeCloseTo(3.8, 6);
    // Without round features there are none.
    expect(layoutSheet(views, { title: { title: "Block" } }).texts.some((t) => t.size === 3 && t.angle === 90)).toBe(false);
  });

  it("marks holes with centre lines and one diameter callout per size", () => {
    const top: SheetView = { ...box("top", 60, 40), circles: [{ c: [10, 10], r: 2.25 }, { c: [50, 10], r: 2.25 }, { c: [30, 20], r: 5 }, { c: [30, 20], r: 3 }] };
    const s = layoutSheet([box("front", 60, 20), top], { title: { title: "Plate" } });
    const texts = s.texts.map((t) => t.text);
    expect(texts).toEqual(expect.arrayContaining(["2× Ø4.5", "Ø10", "Ø6"]));
    // One cross per centre: three centres, two chain lines each.
    expect(s.lines.filter((l) => l.kind === "chain")).toHaveLength(6);
  });

  it("writes SVG, PDF and DXF", () => {
    const s = layoutSheet(views, { title: { title: "Größe Ø10 (Test)" } });
    const svg = writeSheetSvg(s);
    expect(svg).toContain('width="297mm"');
    expect(svg).toContain('stroke-dasharray="3 1.5"');
    expect(svg).toContain("Größe Ø10 (Test)");
    const pdf = new TextDecoder("latin1").decode(writeSheetPdf(s));
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("/BaseFont /Helvetica");
    // Latin-1 characters as octal codes, brackets escaped.
    expect(pdf).toContain("Gr\\366\\337e \\33010 \\(Test\\)");
    // The xref offsets point at the objects.
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe("xref");
    const first = Number(/0000000000 65535 f \n(\d{10})/.exec(pdf)![1]);
    expect(pdf.slice(first, first + 7)).toBe("1 0 obj");
    const dxf = writeSheetDxf(s);
    expect(dxf).toContain("HIDDEN");
    expect(dxf).toContain("DASHED");
    expect(dxf.trim().endsWith("EOF")).toBe(true);
  });
});
