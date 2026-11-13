/**
 * Joints, drawings and sharing in the Mac app: the hinged box's lid turned by its slider and back,
 * a technical drawing saved as PDF, SVG and DXF, and the design shared as a file that holds every
 * step, each checked against what must come out.
 *
 *   E2E_FILE=tests/e2e/mechanics.e2e.ts pnpm test:e2e
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sleep } from "./cdp.js";
import { startApp, type App } from "./app.js";
import { Ui } from "./ui.js";

describe("joints, drawings and sharing", () => {
  let app: App;
  let ui: Ui;
  beforeAll(async () => {
    app = await startApp();
    ui = new Ui(app.page);
  });
  afterAll(async () => app?.stop());
  afterEach(async () => {
    expect(app.page.takeErrors(), "console errors").toEqual([]);

    for (const sel of [".motion-panel button[title='Close']", ".modal button[title='Close (Esc)']"]) {
      if (await ui.find(sel)) await ui.press("Close", sel);
    }

    await ui.closePart();
  });

  async function command(name: string): Promise<void> {
    await ui.press("Search commands");
    await ui.type(name);
    await sleep(250);
    await ui.key("Enter");
    await sleep(500);
  }

  async function example(name: string): Promise<void> {
    if (await ui.state<boolean>("s.screen !== 'home'")) await ui.press("All projects");
    if (!(await ui.find("button.card", name))) await ui.press("Examples", "button.home-section-toggle");

    for (let i = 0; !(await ui.state<boolean>("s.screen === 'editor'")); i++) {
      if (i === 3) throw new Error(`${name} did not open`);

      await ui.press(name, "button.card");
      await sleep(1500);
    }

    await ui.until(`${name} to build`, "(s.output?.report.bodies.length ?? 0) > 0", 60000);
    await ui.settle();
  }

  /** The file the app saved last with this ending (exports go to the run's folder). */
  async function saved(ending: string): Promise<string> {
    const end = Date.now() + 30000;

    for (;;) {
      const f = readdirSync(app.saved).find((n) => n.endsWith(ending));

      if (f) {
        await sleep(300);

        return join(app.saved, f);
      }

      if (Date.now() > end) {
        throw new Error(`nothing saved as ${ending}: ${readdirSync(app.saved).join(", ")}`);
      }

      await sleep(200);
    }
  }

  it("hinged box: the lid's slider turns it to 90° within its 0–110° limits, Rest position brings it back", async () => {
    await example("Hinged box");
    await command("Joints");
    await ui.until("the joints panel", `!!document.querySelector(".joint-value input[type=range]")`);

    const slider = await ui.page.eval<{ x: number; y: number; w: number; min: number; max: number }>(`(() => {
      const r = [...document.querySelectorAll(".joint-value input[type=range]")].find((e) => e.max === "110");
      const b = r.getBoundingClientRect();
      return { x: b.left, y: b.top + b.height / 2, w: b.width, min: +r.min, max: +r.max };
    })()`);
    expect([slider.min, slider.max]).toEqual([0, 110]);

    // Drag the thumb from 0 to the 90° spot, as a person does.
    const at = (deg: number) =>
      slider.x + 8 + ((slider.w - 16) * (deg - slider.min)) / (slider.max - slider.min);
    await app.page.drag([
      [at(0), slider.y],
      [at(45), slider.y],
      [at(90), slider.y],
    ]);
    await sleep(500);

    const shown = await ui.page.eval<string>(
      `[...document.querySelectorAll(".joint-value")].find((r) => r.querySelector("input")?.max === "110").querySelector(".joint-num").textContent`,
    );
    const deg = parseFloat(shown);
    expect(deg).toBeGreaterThan(85);
    expect(deg).toBeLessThan(95);
    // Dragging past the end stops at the limit.
    await app.page.drag([
      [at(deg), slider.y],
      [slider.x + slider.w + 60, slider.y],
    ]);
    await sleep(400);
    expect(
      parseFloat(
        await ui.page.eval<string>(
          `[...document.querySelectorAll(".joint-value")].find((r) => r.querySelector("input")?.max === "110").querySelector(".joint-num").textContent`,
        ),
      ),
    ).toBe(110);
    await ui.press("Rest position");
    await sleep(400);
    expect(
      parseFloat(
        await ui.page.eval<string>(
          `[...document.querySelectorAll(".joint-value")].find((r) => r.querySelector("input")?.max === "110").querySelector(".joint-num").textContent`,
        ),
      ),
    ).toBe(0);
    // The model itself never changed: posing is only a view.
    expect(await ui.state<number>("s.doc.features.length")).toBeGreaterThan(0);
  });

  it("technical drawing: PDF, SVG and DXF of the mounting plate, with its 60 mm width", async () => {
    await example("Mounting plate");
    await command("Technical drawing");
    await ui.waitFind(".modal button", "PDF");
    await sleep(1500);
    await ui.press("PDF", ".modal button");
    expect(
      readFileSync(await saved(".pdf"))
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
    await ui.press("SVG", ".modal button");

    const svg = readFileSync(await saved(".svg"), "utf8");
    expect(svg).toContain("<svg");
    expect(svg).toMatch(/>\s*60\s*</);
    await ui.press("DXF", ".modal button");

    const dxf = readFileSync(await saved(".dxf"), "utf8");
    expect(dxf).toContain("ENTITIES");
    expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
  });

  it("share: the file holds every step and variable of the design", async () => {
    await example("Mounting plate");

    const doc = await ui.state<{ features: { id: string }[]; params: Record<string, unknown> }>(
      "({ features: s.doc.features.map((f) => ({ id: f.id })), params: s.doc.params })",
    );
    await command("Share the design");
    await ui.press("Share…", ".modal button");

    const file = JSON.parse(readFileSync(await saved(".meercad"), "utf8"));
    const shared = file.doc ?? file;
    expect(shared.features.map((f: { id: string }) => f.id)).toEqual(doc.features.map((f) => f.id));
    expect(shared.params).toEqual(doc.params);
  });
});
