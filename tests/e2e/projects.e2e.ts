/**
 * Keeping designs in the Mac app: versions (save, change, restore), units, and the overview's
 * folders, moving and deleting parts, each checked against what must come out.
 *
 *   E2E_FILE=tests/e2e/projects.e2e.ts pnpm test:e2e
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sleep } from "./cdp.js";
import { startApp, type App } from "./app.js";
import { Ui } from "./ui.js";

describe("versions, units and the overview", () => {
  let app: App;
  let ui: Ui;
  beforeAll(async () => {
    app = await startApp();
    ui = new Ui(app.page);
  });
  afterAll(async () => app?.stop());

  const volume = () => ui.state<number>("s.output?.report.bodies[0]?.volume ?? 0");

  async function command(name: string): Promise<void> {
    await ui.press("Search commands");
    await ui.type(name);
    await sleep(250);
    await ui.key("Enter");
    await sleep(400);
  }

  it("a saved version comes back exactly after the design changed", async () => {
    await ui.newPart();
    await ui.addVariable("side", "20 mm");
    await ui.feature("Create", "Basic solid");
    for (const a of ["X", "Y", "Z"]) await ui.field(`Size ${a}`, "side");
    await ui.accept();
    expect(await volume()).toBeCloseTo(8000, 3);

    await command("Versions");
    await ui.press("Save version", ".versions-dialog button");
    await ui.until("the saved version", "(s.doc.versions?.length ?? 0) === 1");
    await ui.press("Close (Esc)", ".versions-dialog button");

    await ui.setVariable("side", "30 mm");
    expect(await volume()).toBeCloseTo(27000, 3);

    await command("Versions");
    await ui.press("Restore", ".versions-dialog button");
    await sleep(500);
    // Restoring asks nothing more or confirms; either way the design is the saved one again.
    if (await ui.find(".ask button", "Restore")) await ui.press("Restore", ".ask button");

    await ui.settle();

    if (await ui.find(".versions-dialog button", "Close (Esc)")) {
      await ui.press("Close (Esc)", ".versions-dialog button");
    }

    expect(await volume()).toBeCloseTo(8000, 3);
    expect(await ui.state<string>("String(s.doc.params.side)")).toBe("20 mm");
  });

  it("an inch design shows and takes inches while the model stays exact in mm", async () => {
    // Settings › Units › New designs in: Imperial; then a new part.
    await command("Settings");

    const sel = await ui.page.eval<[number, number] | null>(
      `(() => { const l = [...document.querySelectorAll("label.check")].find((l) => l.textContent.includes("New designs in")); const r = l?.querySelector("select")?.getBoundingClientRect(); return r ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`,
    );
    expect(sel, "the units choice in Settings").not.toBeNull();
    await ui.page.eval(
      `(() => { const s = [...document.querySelectorAll("label.check")].find((l) => l.textContent.includes("New designs in")).querySelector("select"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "imperial"); s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
    );
    await ui.key("Escape");
    await sleep(300);
    await ui.newPart();
    await ui.feature("Create", "Basic solid");
    for (const a of ["X", "Y", "Z"]) await ui.field(`Size ${a}`, 1);
    await ui.accept();
    // One cubic inch: 25.4³ mm³.
    expect(await volume()).toBeCloseTo(25.4 ** 3, 2);
    expect(await ui.state<string>("s.doc.units ?? ''")).toBe("in");
  });

  it("the overview: a new folder, a part moved into it, a part deleted to the Trash", async () => {
    await ui.closePart();
    await ui.closePart();
    if (await ui.state<boolean>("s.screen !== 'home'")) await ui.press("All projects");

    await ui.until("the overview", "s.screen === 'home'");

    const projectFiles = () =>
      readdirSync(join(app.dir, "projects"), { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".meercad"));
    const before = projectFiles();
    expect(before.length).toBeGreaterThanOrEqual(2);

    await ui.press("New folder");
    await sleep(300);
    await ui.page.key("Meta+a");
    await ui.type("Brackets");
    await ui.key("Enter");
    await sleep(800);
    expect(existsSync(join(app.dir, "projects", "Brackets"))).toBe(true);

    // The first part's menu: move it into the folder.
    await ui.press("Part actions");
    await ui.press("Move to Brackets", "[role=menuitem], button");
    await sleep(800);
    expect(projectFiles().filter((f) => f.startsWith("Brackets/"))).toHaveLength(1);

    // The next part's menu: delete it (to the Trash, after asking).
    await ui.press("Part actions");
    await ui.press("Delete…", "[role=menuitem], button");
    await sleep(300);
    await ui.press("Delete", ".ask button, .modal button");
    await sleep(1000);
    expect(projectFiles()).toHaveLength(before.length - 1);
  });
});
