// Scratch (not committed): the INSTALLED meerCAD WIP as an invisible second instance with a temp profile.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, it } from "vitest";
import { acceptRecord, TERMS_KEY } from "../../apps/web/src/lib/terms.js";
import { Page, sleep } from "./cdp.js";
import { Ui } from "./ui.js";

const log = (...a: unknown[]) =>
  appendFileSync(process.env["LOG"]!, a.map((x) => JSON.stringify(x)).join(" ") + "\n");
const OUT = process.env["SHOTS"]!;
const BIN = "/Applications/meerCAD WIP.app/Contents/MacOS/meerCAD WIP";
const port = 9555;
let child: ChildProcess;
let page: Page;
const dir = mkdtempSync(join(tmpdir(), "meercad-installed-"));

beforeAll(async () => {
  mkdirSync(join(dir, "shared"), { recursive: true });
  mkdirSync(join(dir, "projects"), { recursive: true });
  writeFileSync(
    join(dir, "shared", "shared.json"),
    JSON.stringify({ tourDone: true, [TERMS_KEY]: acceptRecord("e2e", "en") }),
  );
  child = spawn(
    BIN,
    [
      `--user-data-dir=${join(dir, "userdata")}`,
      `--remote-debugging-port=${port}`,
      "--lang=en-US",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
    ],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${process.env["HIDDEN"]}`,
        MEERCAD_PROJECTS_DIR: join(dir, "projects"),
        MEERCAD_MCP_BRIDGE: "off",
        MEERCAD_SHARED_DIR: join(dir, "shared"),
      },
      stdio: "ignore",
    },
  );

  let target: { url: string; webSocketDebuggerUrl: string } | undefined;

  for (let i = 0; i < 120 && !target; i++) {
    await sleep(500);

    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
        type: string;
        url: string;
        webSocketDebuggerUrl: string;
      }[];
      target = list.find((t) => t.type === "page");
    } catch {}
  }

  page = await Page.open(target!.webSocketDebuggerUrl);
  await page.call("Runtime.enable");
  await page.call("Page.enable");
  await page.call("Page.addScriptToEvaluateOnNewDocument", { source: "window.__meercadUITest = true;" });
  await page.call("Page.reload", {});

  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await page.eval<boolean>("!!window.meercadTest").catch(() => false)) break;
  }
});
afterAll(async () => {
  child?.kill();
  await sleep(800);
  rmSync(dir, { recursive: true, force: true });
});

const r = (deg: number, len: number) => [
  len * Math.cos((deg * Math.PI) / 180),
  len * Math.sin((deg * Math.PI) / 180),
];
const [qx, qy] = r(21, 70);
const design = [
  {
    id: "sk1",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: [
      { id: "p1", type: "point", x: 0, y: 0 },
      { id: "p2", type: "point", x: 74.4, y: 0 },
      { id: "p3", type: "point", x: qx, y: qy },
      { id: "l1", type: "line", p1: "p1", p2: "p2" },
      { id: "l2", type: "line", p1: "p1", p2: "p3" },
      { id: "l3", type: "line", p1: "p2", p2: "p3" },
    ],
    constraints: [
      { id: "c1", type: "length", line: "l1", value: 74.4 },
      { id: "c2", type: "angle", a: "l1", b: "l2", value: 21 },
    ],
  },
];

it("installed app", async () => {
  const ui = new Ui(page);
  await page.call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  log("version", await page.eval(`document.title`), await page.eval(`location.href`));
  await page.eval(
    `(async () => { const s = meercadTest.store; await s.newProject(undefined, "Installiert Kopie"); s.apply({ type: "add_features", features: ${JSON.stringify(design)} }); return true; })()`,
  );
  await ui.settle();
  await page.eval(
    `(() => { const v = meercadTest.store.getViewport(); v.setView("iso", false); v.fit(false); return true; })()`,
  );
  await sleep(800);

  const screen = (p: number[]) =>
    page.eval<[number, number]>(
      `(() => { const v = meercadTest.store.getViewport(), r = v.renderer.domElement.getBoundingClientRect(), q = v.worldToScreen(${JSON.stringify(p)}); return [r.left + q[0], r.top + q[1]]; })()`,
    );
  const a = await screen([50, 0, 0]);
  await page.click(a[0], a[1]);
  await sleep(900);
  await page.shot(`${OUT}/inst-1.png`);

  const grips = await page.eval<string>(
    `JSON.stringify(meercadTest.store.getViewport().grips?.map((g) => g.grip) ?? "no grips field")`,
  );
  log("grips", grips);

  // (b) orbit with the right button over 30 frames; per frame the label vs its projected anchor.
  const label = await page.eval<string>(
    `(() => { const el = [...document.querySelectorAll(".value-chip")].find((x) => x.textContent.includes("74")); return el ? el.style.transform.slice(0, 60) : "none"; })()`,
  );
  log("label transform", label);
  await page.eval(`(() => {
    window.__lag = [];
    const v = meercadTest.store.getViewport();
    const el = [...document.querySelectorAll(".value-chip")].find((x) => x.textContent.includes("74"));
    const tick = () => {
      if (window.__lag.length > 60) return;
      const tr = el.style.transform;
      const cam = v.camera.position.toArray().map((x) => +x.toFixed(3)).join();
      window.__lag.push([performance.now() | 0, cam, tr.slice(9, 40)]);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  })()`);

  const c = await screen([60, 40, 0]);
  await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: c[0], y: c[1] });
  await page.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: c[0],
    y: c[1],
    button: "right",
    buttons: 2,
    clickCount: 1,
  });

  for (let k = 1; k <= 20; k++) {
    await page.call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: c[0] + k * 10,
      y: c[1],
      button: "right",
      buttons: 2,
    });
    await sleep(16);
  }

  await page.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: c[0] + 200,
    y: c[1],
    button: "right",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(1500);

  const lag = await page.eval<string>(`JSON.stringify(window.__lag)`);
  log("frames", lag);
  await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" });
  // (a) drag the dimension line with the left button.
  await page.eval(
    `(() => { const v = meercadTest.store.getViewport(); v.setView("iso", false); v.fit(false); return true; })()`,
  );
  await sleep(600);
  await page.click(a[0], a[1]);
  await sleep(900);

  const g = JSON.parse(
    await page.eval<string>(
      `JSON.stringify(meercadTest.store.getViewport().grips?.map((g) => g.grip) ?? [])`,
    ),
  ) as number[][][];
  log("grips again", g);

  if (g[0]) {
    const at = await screen(g[0][0]!.map((v, i) => v * 0.6 + g[0]![1]![i]! * 0.4));
    await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: at[0], y: at[1] });
    await sleep(100);
    log(
      "cursor over line",
      await page.eval(`meercadTest.store.getViewport().renderer.domElement.style.cursor`),
    );

    const to = await screen([g[0][0]![0]! * 0.6 + g[0][1]![0]! * 0.4, -30, 0]);
    await page.drag([at, [at[0], at[1] + 6], to]);
    await sleep(1200);
    log(
      "label after drag",
      await page.eval(
        `JSON.stringify(meercadTest.app.getState().doc.features[0].constraints.find((c) => c.id === "c1").label ?? null)`,
      ),
    );
    await page.shot(`${OUT}/inst-2-drag.png`);
  }
});
