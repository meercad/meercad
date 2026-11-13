/**
 * Control schemes in the Mac app: the scheme picked through command search changes what keys and a
 * right click do, in the model and in a sketch.
 *
 *   E2E_FILE=tests/e2e/controls.e2e.ts pnpm test:e2e
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sleep } from "./cdp.js";
import { startApp, type App } from "./app.js";
import { Ui } from "./ui.js";

describe("control schemes", () => {
  let app: App;
  let ui: Ui;
  beforeAll(async () => {
    app = await startApp();
    ui = new Ui(app.page);
  });
  afterAll(async () => app?.stop());

  const tool = () => app.page.eval<string>("meercadTest.sketch.getState().tool");
  const paletteOpen = () => app.page.eval<boolean>("!!document.querySelector('.palette')");

  const rightClick = async () => {
    // Empty view beside the model, inside the canvas.
    const [x, y] = await app.page.eval<[number, number]>(
      `(() => { const r = meercadTest.store.getViewport().renderer.domElement.getBoundingClientRect(); return [r.right - 80, r.bottom - 120]; })()`,
    );
    await app.page.click(x, y, { button: "right" });
    await sleep(250);
  };

  it("the search button opens command search, which switches to the Plasticity scheme", async () => {
    app.page.takeErrors();
    await ui.newPart();
    await ui.press("Search commands");
    expect(await paletteOpen()).toBe(true);
    await ui.type("Plasticity");
    await ui.key("Enter");
    expect(await paletteOpen()).toBe(false);
    expect(await app.page.eval("JSON.parse(localStorage.getItem('meercad.prefs')).keys")).toBe("plasticity");
    // F opens command search in this scheme, Esc closes it.
    await ui.key("f");
    expect(await paletteOpen()).toBe(true);
    await ui.key("Escape");
    expect(await paletteOpen()).toBe(false);
  });

  it("in a sketch, Shift+A draws lines and a right click ends the line, then the tool, then the sketch", async () => {
    await ui.sketchOn("Top");
    await ui.zoomSketch(40);
    await ui.key("Shift+A");
    expect(await tool()).toBe("line");
    await ui.clickSketch([0, 0]);
    await ui.clickSketch([20, 0]);
    await ui.clickSketch([20, 15]);
    await rightClick();
    expect(await tool()).toBe("line");
    expect(
      await ui.state<number>(
        "s.doc.features.find((f) => f.id === s.sketchId).entities.filter((e) => e.type === 'line').length",
      ),
    ).toBe(2);
    await rightClick();
    expect(await tool()).toBe("select");
    await rightClick();
    await ui.until("the sketch to close", "!s.sketchId");
  });

  it("in the model, E opens extrude and a right click finishes it; H hides, Alt+H shows", async () => {
    // A closed rectangle to extrude.
    await ui.sketchOn("Top");
    await ui.rect([0, 0], 20, 10);
    await ui.key("Enter");
    await ui.until("the sketch to close", "!s.sketchId");
    await ui.settle();
    await ui.key("e");
    await ui.until("the extrude dialog", "s.dialog?.feature.op === 'extrude'");
    await sleep(500);
    await rightClick();
    await ui.until("the dialog to close", "!s.dialog");
    await ui.settle();
    expect(await ui.state<number>("s.output.report.bodies.length")).toBe(1);
    // Hide and show again: H, then Alt+H.
    await ui.clickFace("(f) => f.normal[2] > 0.9");
    await ui.key("h");
    expect(await ui.state<number>("s.hidden.size")).toBe(1);
    await ui.key("Alt+h");
    expect(await ui.state<number>("s.hidden.size")).toBe(0);
    expect(app.page.takeErrors(), "console errors").toEqual([]);
  });
});
