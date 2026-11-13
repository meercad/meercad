/**
 * Sketch tools and pictures in the Mac app: trimming a line where it crosses a rectangle, rounding
 * a corner, repeating a circle, and a lithophane from a picture picked in the file dialog, each
 * checked against the geometry that must come out.
 *
 *   E2E_FILE=tests/e2e/sketching.e2e.ts pnpm test:e2e
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sleep } from "./cdp.js";
import { startApp, type App } from "./app.js";
import { Ui } from "./ui.js";

type Curve = { id: string; kind: string; a?: number[]; b?: number[]; center?: number[]; radius?: number };

/** A grey-scale PNG, dark on the left and bright on the right. */
function gradientPng(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;

    return c >>> 0;
  });

  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);

    return (c ^ 0xffffffff) >>> 0;
  };

  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);

    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));

    return Buffer.concat([len, td, c]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grey

  const rows = Buffer.alloc((w + 1) * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) rows[y * (w + 1) + 1 + x] = Math.round((255 * x) / (w - 1));
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("sketch tools and pictures", () => {
  let app: App;
  let ui: Ui;
  beforeAll(async () => {
    app = await startApp();
    ui = new Ui(app.page);
  });
  afterAll(async () => app?.stop());
  afterEach(async () => {
    expect(app.page.takeErrors(), "console errors").toEqual([]);
    await ui.closePart();
  });

  const curves = () =>
    ui.state<Curve[]>(
      "s.output?.report.sketches.find((k) => k.id === s.sketchId)?.curves.filter((c) => !c.construction).map((c) => ({ id: c.id, kind: c.kind, a: c.a, b: c.b, center: c.center, radius: c.radius })) ?? []",
    );

  it("trim: the part of a line outside a rectangle goes, the line now ends on its edge", async () => {
    await ui.newPart();
    await ui.sketchOn("Top");
    await ui.zoomSketch(80);
    await ui.rect([0, 0], 40, 30);
    await ui.line([20, -10], [20, 40]);
    await ui.settle();

    const before = (await curves()).filter((c) => c.kind === "line");
    expect(before).toHaveLength(5);
    await ui.tool("Trim");
    await ui.clickSketch([20, 36], { free: true });
    await sleep(400);
    await ui.key("Escape");
    await ui.settle();

    const after = (await curves()).filter((c) => c.kind === "line");
    const vertical = after.filter((c) => Math.abs(c.a![0]! - 20) < 1e-6 && Math.abs(c.b![0]! - 20) < 1e-6);
    expect(vertical).toHaveLength(1);

    const ys = [vertical[0]!.a![1]!, vertical[0]!.b![1]!].sort((p, q) => p - q);
    expect(ys[0]).toBeCloseTo(-10, 6);
    expect(ys[1]).toBeCloseTo(30, 6);
    await ui.finishSketch();
  });

  it("round a corner: an arc of the typed radius, tangent to both lines", async () => {
    await ui.newPart();
    await ui.sketchOn("Top");
    await ui.zoomSketch(80);
    await ui.rect([0, 0], 40, 30);
    await ui.tool("Tools", "Round a corner");
    await ui.sketchSize("Radius", 5);
    await ui.clickSketch([40, 30]);
    await ui.key("Escape");
    await ui.settle();

    const arc = (await curves()).find((c) => c.kind === "arc");
    expect(arc, "the rounded corner").toBeTruthy();
    expect(arc!.radius).toBeCloseTo(5, 6);
    expect(arc!.center![0]).toBeCloseTo(35, 6);
    expect(arc!.center![1]).toBeCloseTo(25, 6);
    await ui.finishSketch();
    // Extruded 10 mm: the plate minus the corner's r²(1 − π/4).
    await ui.feature("Create", "Extrude");
    await ui.field("Distance", 10);
    await ui.accept();
    expect(await ui.state<number>("s.output.report.bodies[0].volume")).toBeCloseTo(
      (1200 - 25 * (1 - Math.PI / 4)) * 10,
      3,
    );
  });

  it("lithophane: a picture picked in the file dialog becomes a plate of the picture's proportions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meercad-e2e-litho-"));
    const png = join(dir, "gradient.png");
    writeFileSync(png, gradientPng(80, 40));
    await ui.newPart();
    await ui.feature("Create", "Lithophane");
    await app.page.chooseFiles([png], () => ui.press("Choose a photo…", ".dialog button"));
    await ui.until("the picture in the step", "!!s.dialog?.feature.image?.pixels", 20000);
    await ui.accept();
    await ui.settle();
    expect(
      await ui.state<string[]>(
        "(s.output?.report.features ?? []).filter((f) => f.status === 'error').map((f) => f.message)",
      ),
    ).toEqual([]);

    const b = await ui.state<{ min: number[]; max: number[] }>("s.output.report.bodies[0].bbox");
    const size = b.max.map((v, i) => v - b.min[i]!);
    const [w, h] = [Math.max(size[0]!, size[1]!), Math.min(size[0]!, size[1]!)];
    // 100 mm wide (the default) and half as deep as wide, as the 80 × 40 picture, give or take a frame.
    expect(w).toBeGreaterThanOrEqual(100);
    expect(w).toBeLessThan(112);
    expect((h - (w - 100)) / 100).toBeCloseTo(0.5, 1);
  });
});
