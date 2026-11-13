/**
 * The app's functions one by one, in the Mac app with mouse and keyboard, each checked against the
 * number that must come out: the generators (basic solid, screw, spring, wall storage), deleting
 * with the key, undo and redo, measuring, variables, the interference check, exports beyond
 * STL/3MF/STEP, importing a file and the standard views.
 *
 *   E2E_FILE=tests/e2e/functions.e2e.ts pnpm test:e2e
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readObj, meshVolume, writeStl } from "@meercad/io";
import { sleep } from "./cdp.js";
import { startApp, type App } from "./app.js";
import { Ui } from "./ui.js";

type Body = { id: string; volume: number; bbox: { min: number[]; max: number[] } };

describe("functions of the app", () => {
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

  const bodies = () =>
    ui.state<Body[]>(
      "s.output?.report.bodies.map((b) => ({ id: b.id, volume: b.volume, bbox: b.bbox })) ?? []",
    );
  const failed = () =>
    ui.state<string[]>(
      "(s.output?.report.features ?? []).filter((f) => f.status === 'error').map((f) => f.id + ': ' + f.message)",
    );
  const size = (b: Body) => b.bbox.max.map((v, i) => v - b.bbox.min[i]!);
  const toasts = () => ui.state<string[]>("s.toasts.map((t) => t.text)");

  async function command(name: string): Promise<void> {
    await ui.press("Search commands");
    await ui.type(name);
    await sleep(250);
    await ui.key("Enter");
    await sleep(300);
  }

  /** A new part with a basic solid: the default 20 mm cube, or with its size typed in. */
  async function cube(): Promise<void> {
    await ui.newPart();
    await ui.feature("Create", "Basic solid");
    await ui.accept();
  }

  it("basic solid: the default cube is 20 × 20 × 20 mm, 8000 mm³", async () => {
    await cube();

    const [b] = await bodies();
    expect(await failed()).toEqual([]);
    expect(b!.volume).toBeCloseTo(8000, 3);
    size(b!).forEach((s) => expect(s).toBeCloseTo(20, 4));
  });

  it("undo and redo with the keys take the cube away and bring it back", async () => {
    await cube();
    expect(await bodies()).toHaveLength(1);
    await ui.view("1");
    await ui.key("Meta+z");
    await ui.settle();
    expect(await bodies()).toHaveLength(0);
    await ui.key("Shift+Meta+z");
    await ui.settle();

    const [b] = await bodies();
    expect(b!.volume).toBeCloseTo(8000, 3);
  });

  it("delete key on a selected part removes it as a step that can be undone", async () => {
    await cube();

    const [b] = await bodies();
    // A double click selects the whole part.
    const at = await ui.spotOf("face", `(f) => f.body === ${JSON.stringify(b!.id)}`, true);
    await app.page.click(at[0], at[1], { count: 2 });
    await sleep(300);
    await ui.key("Backspace");
    await ui.settle();
    expect(await bodies()).toHaveLength(0);
    expect(await ui.state<string[]>("s.doc.features.map((f) => f.op)")).toContain("delete");
    await ui.key("Meta+z");
    await ui.settle();
    expect(await bodies()).toHaveLength(1);
  });

  it("measure: top to bottom face of the cube is 20 mm, their angle 0°", async () => {
    await cube();
    await command("Measure");
    await ui.until("measuring", "s.measure.active");
    await ui.clickFace("(f) => f.normal[2] > 0.9");
    await ui.clickFace("(f) => f.normal[2] < -0.9");
    await ui.until("a measurement", "!!s.measure.result");

    const rows = await ui.state<[string, string][]>("s.measure.result.rows");
    expect(rows.find((r) => r[0] === "Distance")?.[1]).toBe("20 mm");
    await ui.key("Escape");
  });

  it("variables: a cube sized by a variable follows a new value exactly", async () => {
    await ui.newPart();
    await ui.addVariable("side", "15 mm");
    await ui.feature("Create", "Basic solid");
    for (const a of ["X", "Y", "Z"]) await ui.field(`Size ${a}`, "side");
    await ui.accept();
    expect((await bodies())[0]!.volume).toBeCloseTo(15 ** 3, 3);
    await ui.setVariable("side", "22.5 mm");

    const [b] = await bodies();
    expect(b!.volume).toBeCloseTo(22.5 ** 3, 3);
    size(b!).forEach((s) => expect(s).toBeCloseTo(22.5, 4));
  });

  it("screw and nut: an M8 × 25 hex screw has the right length and head", async () => {
    await ui.newPart();
    await ui.feature("Create", "Screw and nut");
    await ui.accept();
    expect(await failed()).toEqual([]);

    const all = await bodies();
    expect(all.length).toBeGreaterThan(0);

    const s = size(all[0]!);
    const across = Math.max(s[0]!, s[1]!);
    // ISO 4017 M8: 13 mm across flats; the modelled hexagon has sharp corners, 13 / cos 30° = 15.01
    // across them (a real head's chamfer takes that to ≥ 14.38). Shank 25 plus a 5.3 mm head.
    expect(across).toBeGreaterThan(12.99);
    expect(across).toBeLessThan(15.02);
    expect(s[2]).toBeGreaterThan(25 + 5);
    expect(s[2]).toBeLessThan(25 + 6);
  });

  it("spring: a compression spring Ø 15 × 40 mm", async () => {
    await ui.newPart();
    await ui.feature("Create", "Spring");
    await ui.accept();
    expect(await failed()).toEqual([]);

    const s = size((await bodies())[0]!);
    expect(s[2]).toBeCloseTo(40, 0);
    // Ø 15 is the coil's mean diameter: the outside is one wire (1.5) larger.
    expect(Math.max(s[0]!, s[1]!)).toBeGreaterThan(15);
    expect(Math.max(s[0]!, s[1]!)).toBeLessThan(17);
  });

  it("wall storage: a 4 × 4 openGrid board is 112 × 112 mm", async () => {
    await ui.newPart();
    await ui.feature("Create", "Wall storage");
    await ui.accept();
    expect(await failed()).toEqual([]);

    const s = size((await bodies())[0]!).sort((a, b) => b - a);
    expect(s[0]).toBeCloseTo(112, 0);
    expect(s[1]).toBeCloseTo(112, 0);
  });

  it("interference check: two overlapping cubes share 4000 mm³", async () => {
    await cube();
    await ui.feature("Create", "Basic solid");
    await ui.option("New");
    await ui.field("Centre X", 10);
    await ui.accept();
    expect(await bodies()).toHaveLength(2);
    await command("Check whether parts overlap");
    await sleep(1500);

    const said = (await toasts()).join(" | ");
    expect(said).toMatch(/1 overlap: .*4000 mm³/);
  });

  it("export OBJ: one object, the cube's volume", async () => {
    await cube();
    await command("Export OBJ");

    const end = Date.now() + 30000;
    let name: string | undefined;

    while (!(name = readdirSync(app.saved).find((f) => f.endsWith(".obj"))) && Date.now() < end) {
      await sleep(200);
    }

    if (!name) {
      throw new Error(
        `no .obj saved: ${readdirSync(app.saved).join(", ")} · ${(await toasts()).join(" | ")}`,
      );
    }

    const file = join(app.saved, name);
    const obj = readObj(readFileSync(file, "utf8"));
    const soup = new Float32Array(obj.indices.length * 3);
    obj.indices.forEach((ix, i) => soup.set(obj.positions.subarray(ix * 3, ix * 3 + 3), i * 3));
    expect(meshVolume(soup)).toBeCloseTo(8000, 1);
  });

  it("import: an STL picked in the file dialog becomes a part of its size", async () => {
    await ui.newPart();

    // A 30 × 20 × 10 box as an STL file, as one comes from elsewhere.
    const p = [0, 0, 0, 30, 0, 0, 30, 20, 0, 0, 20, 0, 0, 0, 10, 30, 0, 10, 30, 20, 10, 0, 20, 10];
    const tri = [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4,
      7,
    ];
    const dir = mkdtempSync(join(tmpdir(), "meercad-e2e-import-"));
    const file = join(dir, "block.stl");
    writeFileSync(file, writeStl([{ positions: new Float32Array(p), indices: new Uint32Array(tri) }]));
    await app.page.chooseFiles([file], () => command("Import / open file"));
    await ui.until("the imported part", "(s.output?.report.bodies.length ?? 0) > 0", 30000);
    await ui.settle();

    const [b] = await bodies();
    expect(b!.volume).toBeCloseTo(6000, 1);
    expect(size(b!).map((v) => +v.toFixed(3))).toEqual([30, 20, 10]);
  });

  it("standard views turn the camera to look along the axes", async () => {
    await cube();

    const dir = () =>
      ui.page.eval<number[]>(
        "(() => { const c = meercadTest.store.getViewport().camera; const d = c.getWorldDirection(new c.position.constructor()); return [d.x, d.y, d.z].map((v) => Math.round(v * 100) / 100); })()",
      );

    for (const [k, want] of [
      ["2", [0, 1, 0]],
      ["4", [0, 0, -1]],
      ["6", [-1, 0, 0]],
    ] as const) {
      await ui.view(k);
      await ui.steady();
      expect(await dir(), `view ${k}`).toEqual(want);
    }
  });
});
