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
