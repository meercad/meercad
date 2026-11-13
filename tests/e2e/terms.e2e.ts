/**
 * The terms of use nobody gets past: on a fresh profile the screen comes first, nothing behind it
 * reacts to clicks, taps or keys, the boxes unlock only once the text is read to the end, Accept only
 * with all of them, assistants (MCP) are refused until then, the consent holds after a restart, and
 * an outdated or broken record brings the screen back.
 *
 * Mac: a private copy of the Mac app (app.ts) with a fresh profile and its own MCP port.
 * iPhone and iPad: the app's layouts in an emulated device (device.ts; no simulator), where the
 * consent is kept in localStorage as in the iOS app. The iPad and iPhone app have no assistants.
 *
 *   E2E_FILE=tests/e2e/terms.e2e.ts pnpm test:e2e
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptRecord,
  TERMS_KEY,
  TERMS_MCP_ERROR,
  TERMS_POINTS,
  TERMS_VERSION,
} from "../../apps/web/src/lib/terms.js";
import { startApp, type App } from "./app.js";
import { sleep, type Page } from "./cdp.js";
import { startDevice, type Device, type DeviceApp } from "./device.js";

const root = resolve(import.meta.dirname, "../..");
const LOCAL_KEY = `meercad.${TERMS_KEY}`;
const old = () => ({ ...acceptRecord("e2e", "en"), version: "2020-01-01" });
const partial = () => ({ ...acceptRecord("e2e", "en"), points: TERMS_POINTS.slice(1).map((p) => p.id) });
type Vec2 = [number, number];

const freePort = () =>
  new Promise<number>((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });

async function until(what: string, fn: () => Promise<unknown>, ms = 20000): Promise<void> {
  const end = Date.now() + ms;

  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      // not yet
    }

    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);

    await sleep(150);
  }
}

/** The screen, read from the page; `tap` and `scroll` are the device's own input (mouse or finger). */
class Gate {
  constructor(
    private page: Page,
    private input: { tap(at: Vec2): Promise<void>; scroll(at: Vec2, dy: number): Promise<void> },
  ) {}

  shown = () => this.page.eval<boolean>("!!document.querySelector('.terms-gate [role=dialog]')");
  boxes = () =>
    this.page.eval<{ checked: boolean; disabled: boolean }[]>(
      "[...document.querySelectorAll('.terms-gate input[type=checkbox]')].map((c) => ({ checked: c.checked, disabled: c.disabled }))",
    );

  acceptDisabled = () =>
    this.page.eval<boolean>("document.querySelector('.terms-gate .terms-accept').disabled");

  centre = (expr: string) =>
    this.page.eval<Vec2>(
      `(() => { const r = (${expr}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`,
    );

  async tapBox(i: number): Promise<void> {
    await this.page.eval(
      `document.querySelectorAll('.terms-gate input[type=checkbox]')[${i}].scrollIntoView({ block: 'center' })`,
    );
    await this.input.tap(
      await this.centre(`document.querySelectorAll('.terms-gate .terms-points label')[${i}]`),
    );
    await sleep(80);
  }

  async readToEnd(): Promise<void> {
    const at = await this.centre("document.querySelector('.terms-text')");

    for (
      let i = 0;
      i < 60 &&
      !(await this.page.eval<boolean>(
        "(() => { const b = document.querySelector('.terms-text'); return b.scrollTop + b.clientHeight >= b.scrollHeight - 2; })()",
      ));
      i++
    ) {
      await this.input.scroll(at, 400);
    }

    await until("the boxes to unlock", async () => (await this.boxes()).every((b) => !b.disabled));
  }

  async accept(): Promise<void> {
    await this.page.eval(
      "document.querySelector('.terms-gate .terms-accept').scrollIntoView({ block: 'center' })",
    );
    await this.input.tap(await this.centre("document.querySelector('.terms-gate .terms-accept')"));
    await until("the screen to go", async () => !(await this.shown()));
  }

  /**
   * (a) Nothing behind the screen can be reached: every visible control of the app is covered and a click or
   * tap on it does nothing.
   */
  async blocksTheApp(): Promise<void> {
    const before = await this.page.eval<string>(
      "JSON.stringify({ screen: meercadTest.app.getState().screen, projects: meercadTest.app.getState().projects.length, project: meercadTest.app.getState().project?.id ?? null })",
    );
    const targets = await this.page.eval<
      Vec2[]
    >(`[...document.querySelectorAll('button, a, input, [role=button], [tabindex]')]
      .filter((e) => !e.closest('.terms-gate'))
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth)
      .map((r) => [Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2))])`);
    expect(targets.length, "controls of the app behind the screen").toBeGreaterThan(0);

    // The corners too, and the middle of every edge.
    const [w, h] = await this.page.eval<Vec2>("[innerWidth, innerHeight]");

    for (const p of [
      [2, 2],
      [w - 2, 2],
      [2, h - 2],
      [w - 2, h - 2],
      [w / 2, 2],
      [w / 2, h - 2],
      [2, h / 2],
      [w - 2, h / 2],
    ] as Vec2[]) {
      targets.push(p);
    }

    for (const [x, y] of targets) {
      expect(
        await this.page.eval<boolean>(`!!document.elementFromPoint(${x}, ${y})?.closest('.terms-gate')`),
        `(${x}, ${y}) is covered`,
      ).toBe(true);
    }

    for (const t of targets.slice(0, 12)) await this.input.tap(t);
    await sleep(300);
    expect(await this.shown()).toBe(true);
    expect(
      await this.page.eval<string>(
        "JSON.stringify({ screen: meercadTest.app.getState().screen, projects: meercadTest.app.getState().projects.length, project: meercadTest.app.getState().project?.id ?? null })",
      ),
    ).toBe(before);
    expect(
      await this.page.eval<number>("document.querySelectorAll('.menu, .palette, [role=menu]').length"),
      "no menu opened",
    ).toBe(0);
  }

  /** (b) Boxes locked until read; Accept only with all of them (each one left out keeps it off). */
  async onlyWithEveryBox({ fits = false } = {}): Promise<void> {
    const sizes = await this.page.eval<{ sh: number; ch: number }>(
      "(() => { const b = document.querySelector('.terms-text'); return { sh: b.scrollHeight, ch: b.clientHeight }; })()",
    );
    expect(sizes.sh <= sizes.ch, `the whole text fits the box (${sizes.sh} in ${sizes.ch} px)`).toBe(fits);
    expect(await this.acceptDisabled()).toBe(true);

    if (fits) {
      // Nothing to scroll: the text is read as it stands.
      expect((await this.boxes()).map((b) => b.disabled)).toEqual(TERMS_POINTS.map(() => false));
    } else {
      expect((await this.boxes()).map((b) => b.disabled)).toEqual(TERMS_POINTS.map(() => true));
      await this.tapBox(0);
      await this.tapBox(5);
      expect(
        (await this.boxes()).some((b) => b.checked),
        "a locked box cannot be ticked",
      ).toBe(false);
      await this.readToEnd();
    }

    expect(await this.acceptDisabled()).toBe(true);
    for (let i = 0; i < TERMS_POINTS.length; i++) await this.tapBox(i);
    expect((await this.boxes()).every((b) => b.checked)).toBe(true);
    expect(await this.acceptDisabled()).toBe(false);

    for (let i = 0; i < TERMS_POINTS.length; i++) {
      await this.tapBox(i);
      expect(await this.acceptDisabled(), `without "${TERMS_POINTS[i]!.id}"`).toBe(true);
      await this.tapBox(i);
      expect(await this.acceptDisabled()).toBe(false);
    }
  }
}

const mouse = (page: Page) => ({
  tap: ([x, y]: Vec2) => page.click(x, y),
  scroll: async ([x, y]: Vec2, dy: number) => {
    await page.call("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy });
    await sleep(60);
  },
});
const finger = (page: Page) => ({
  tap: async ([x, y]: Vec2) => {
    await page.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await sleep(40);
    await page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  },
  scroll: async ([x, y]: Vec2, dy: number) => {
    await page.call("Input.synthesizeScrollGesture", {
      x,
      y,
      yDistance: -dy,
      gestureSourceType: "touch",
      speed: 2000,
    });
  },
});

/**
 * The app as an assistant sees it: a bridge server on the test copy's own port that sends every request the
 * app knows.
 */
async function rawBridge(port: number) {
  const { WebSocketServer } = (await import(join(root, "packages/mcp/node_modules/ws/wrapper.mjs"))) as {
    WebSocketServer: new (o: { port: number; host: string }) => {
      on(e: "connection", fn: (ws: RawSocket) => void): void;
      close(): void;
      clients: Set<RawSocket>;
    };
  };
  type RawSocket = { send(s: string): void; on(e: "message", fn: (d: unknown) => void): void; close(): void };

  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  let sock: RawSocket | null = null;
  const pending = new Map<number, (m: { result?: unknown; error?: string }) => void>();
  wss.on("connection", (ws) => {
    sock = ws;
    ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as { id?: number; result?: unknown; error?: string };
      if (m.id && pending.has(m.id)) (pending.get(m.id)!(m), pending.delete(m.id));
    });
  });

  let n = 0;

  return {
    connected: () => !!sock,
    call: (method: string, params: Record<string, unknown> = {}) =>
      new Promise<{ result?: unknown; error?: string }>((ok) => {
        const id = ++n;
        pending.set(id, ok);
        sock!.send(JSON.stringify({ id, method, params, client: "e2e", session: "e2e-session" }));
      }),
    close: () => {
      for (const c of wss.clients) c.close();
      wss.close();
    },
  };
}

/** Every request the app answers for assistants (packages/mcp/src/protocol.ts). */
function bridgeMethods(): string[] {
  const src = readFileSync(join(root, "packages/mcp/src/protocol.ts"), "utf8");
  const block = src.slice(src.indexOf("export type BridgeMethod ="));

  return [...block.slice(0, block.indexOf(";")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

/**
 * Points the app's page at the bridge port (as test runs do, see bridgePort in mcpBridge.ts) and waits for it
 * to connect.
 */
async function useBridgePort(
  page: Page,
  port: number,
  connected: () => Promise<boolean> | boolean,
): Promise<void> {
  await page.eval(
    `sessionStorage.setItem("meercad.mcp.port", "${port}"); location.href = location.origin + "/"; true`,
  );
  await sleep(1500);
  await until(
    "the page to load",
    () =>
      page.eval<boolean>(
        "document.readyState === 'complete' && !!window.meercadTest && !location.search.includes('bridge=off')",
      ),
    60000,
  );
  await until("the bridge to connect", async () => connected(), 30000);
}

type McpClient = {
  callTool(
    r: { name: string; arguments: Record<string, unknown> },
    s?: unknown,
    o?: { timeout: number },
  ): Promise<{ isError?: boolean; content: { type: string; text?: string }[] }>;
  close(): Promise<void>;
};

/** The real MCP server (packages/mcp) on the test copy's port, as an assistant starts it. */
async function mcpServer(port: number): Promise<{
  client: McpClient;
  call(name: string, args?: Record<string, unknown>): Promise<{ error: boolean; text: string }>;
}> {
  const sdk = join(root, "packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client");
  const { Client } = (await import(join(sdk, "index.js"))) as {
    Client: new (i: { name: string; version: string }) => McpClient & { connect(t: unknown): Promise<void> };
  };
  const { StdioClientTransport } = (await import(join(sdk, "stdio.js"))) as {
    StdioClientTransport: new (o: object) => unknown;
  };
  const client = new Client({ name: "e2e-terms", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [join(root, "packages/mcp/dist/server.js")],
      env: { ...process.env, MEERCAD_MCP_PORT: String(port), MEERCAD_NO_LAUNCH: "1" },
      stderr: "ignore",
    }),
  );

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });

    return { error: !!r.isError, text: r.content.map((c) => c.text ?? "").join("") };
  };

  return { client, call };
}

/** The Mac app's main process (its inspector): sends what the menu bar sends to the window. */
async function mainProcess(port: number) {
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
    webSocketDebuggerUrl: string;
  }[];
  const ws = new WebSocket(list[0]!.webSocketDebuggerUrl);
  await new Promise((ok, fail) => (ws.addEventListener("open", ok), ws.addEventListener("error", fail)));

  let n = 0;
  const run = (expr: string) =>
    new Promise<unknown>((ok, fail) => {
      const id = ++n;

      const on = (e: MessageEvent) => {
        const m = JSON.parse(String(e.data)) as {
          id?: number;
          result?: {
            result?: { value?: unknown };
            exceptionDetails?: { text: string; exception?: { description?: string } };
          };
        };
        if (m.id !== id) return;

        ws.removeEventListener("message", on);

        const ex = m.result?.exceptionDetails;
        ex
          ? fail(new Error(`in the main process: ${ex.exception?.description ?? ex.text}`))
          : ok(m.result?.result?.value);
      };

      ws.addEventListener("message", on);
      ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression: expr, includeCommandLineAPI: true, returnByValue: true },
        }),
      );
    });

  return {
    menu: (cmd: string) =>
      run(
        `require("electron").BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).forEach((w) => w.webContents.send("menu", ${JSON.stringify(cmd)})); true`,
      ),
    close: () => ws.close(),
  };
}

/**
 * Commands of the menu bar (apps/desktop/src/main.ts) that act on the page; Open and Save As would show a
 * system dialog.
 */
const MENU_COMMANDS = [
  "new",
  "home",
  "settings",
  "shortcuts",
  "share",
  "close-tab",
  "reopen-tab",
  "next-tab",
  "prev-tab",
  "undo",
  "redo",
  "duplicate",
  "selectAll",
  "paste",
];

describe("terms of use on the Mac", () => {
  let app: App;
  let gate: Gate;
  let mcp: Awaited<ReturnType<typeof mcpServer>> | null = null;
  const mcpPort = { raw: 0, real: 0 };
  let inspect = 0;
  beforeAll(async () => {
    if (spawnSync("node", ["build.mjs"], { cwd: join(root, "packages/mcp"), stdio: "inherit" }).status) {
      throw new Error("mcp build failed");
    }

    mcpPort.raw = await freePort();
    mcpPort.real = await freePort();
    inspect = await freePort();
    // A Mac where meerCAD has never been accepted (the tour is not what this is about).
    app = await startApp({ keep: true, shared: { tourDone: true }, inspect });
    gate = new Gate(app.page, mouse(app.page));
  });
  afterAll(async () => {
    await mcp?.client.close().catch(() => undefined);

    if (app) {
      await app.stop();
      spawnSync("rm", ["-rf", app.dir]);
    }
  });

  it("comes up first, and the app behind takes no clicks", async () => {
    expect(await gate.shown()).toBe(true);
    expect(await app.page.eval<string>("meercadTest.app.getState().screen")).toBe("home");
    await gate.blocksTheApp();
  });

  it("keeps the keyboard: Tab stays inside, Escape and the app's shortcuts do nothing", async () => {
    const inside = () => app.page.eval<boolean>("!!document.activeElement?.closest('.terms-gate')");
    // The clicks before left the focus on the page itself (nothing of the app's): the first key brings it
    // back.
    expect(
      await app.page.eval<boolean>(
        "document.activeElement === document.body || !!document.activeElement?.closest('.terms-gate')",
      ),
    ).toBe(true);
    await app.page.key("Tab");
    expect(await inside()).toBe(true);

    for (let i = 0; i < 12; i++) {
      await app.page.key(i % 3 === 2 ? "Shift+Tab" : "Tab");
      expect(await inside(), `after Tab ${i + 1}`).toBe(true);
    }

    // Focus pushed onto the app behind comes back on the next key.
    await app.page.eval("document.querySelector('.home button')?.focus(); true");
    await app.page.key("Tab");
    expect(await inside()).toBe(true);

    for (const k of ["Escape", "Meta+n", "Meta+o", "Meta+k", "Meta+,", "n", "Delete", "Enter", " "]) {
      await app.page.key(k);
    }

    await sleep(300);
    expect(await gate.shown()).toBe(true);
    expect(await app.page.eval<string>("meercadTest.app.getState().screen")).toBe("home");
    expect(await app.page.eval<number>("meercadTest.app.getState().projects.length")).toBe(0);
    expect(
      await app.page.eval<number>("document.querySelectorAll('.menu, .palette, [role=menu]').length"),
    ).toBe(0);
  });

  it("the menu bar and a file dropped on it do nothing behind it", async () => {
    const main = await mainProcess(inspect);

    try {
      for (const cmd of MENU_COMMANDS) await main.menu(cmd);
    } finally {
      main.close();
    }

    // A model file dropped onto the window.
    const stl = join(app.dir, "dropped.stl");
    writeFileSync(
      stl,
      "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid t\n",
    );

    const [x, y] = await gate.centre("document.querySelector('.terms-text')");

    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await app.page.call("Input.dispatchDragEvent", {
        type,
        x,
        y,
        data: { items: [], files: [stl], dragOperationsMask: 1 },
      });
    }

    await sleep(1500);
    expect(await gate.shown()).toBe(true);
    expect(await app.page.eval<string>("location.href")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(await app.page.eval<string>("meercadTest.app.getState().screen")).toBe("home");
    expect(await app.page.eval<number>("meercadTest.app.getState().projects.length")).toBe(0);
    expect(await app.page.eval<number>("meercadTest.app.getState().tabs?.length ?? 0")).toBe(0);
    // No dialog, panel or menu besides the screen itself.
    expect(await app.page.eval<number>("document.querySelectorAll('[role=dialog]').length")).toBe(1);
    expect(
      await app.page.eval<number>(
        "document.querySelectorAll('.menu, .palette, [role=menu], .shortcut-help').length",
      ),
    ).toBe(0);
  });

  it("refuses every assistant request before the terms are accepted", async () => {
    const bridge = await rawBridge(mcpPort.raw);

    try {
      await useBridgePort(app.page, mcpPort.raw, bridge.connected);
      expect(await gate.shown()).toBe(true);

      const methods = bridgeMethods();
      expect(methods.length).toBeGreaterThan(40);

      for (const method of methods) {
        const r = await bridge.call(method, method === "open_project" ? { id: "x", project: "x" } : {});
        expect(r.error, method).toBe(TERMS_MCP_ERROR);
        expect(r.result, method).toBeUndefined();
      }

      // Nothing was opened or made for the assistant.
      expect(await app.page.eval<number>("meercadTest.app.getState().projects.length")).toBe(0);
      expect(await gate.shown()).toBe(true);
    } finally {
      bridge.close();
    }
  });

  it("the real MCP server gets the same refusal", async () => {
    mcp = await mcpServer(mcpPort.real);
    await useBridgePort(
      app.page,
      mcpPort.real,
      async () => JSON.parse((await mcp!.call("status")).text).connected === true,
    );

    for (const [tool, args] of [
      ["list_projects", {}],
      ["new_project", { name: "should not exist" }],
      ["list_examples", {}],
      ["get_model", {}],
    ] as const) {
      const r = await mcp.call(tool, args);
      expect(r.error, tool).toBe(true);
      expect(r.text, tool).toContain(TERMS_MCP_ERROR);
    }

    expect(await gate.shown()).toBe(true);
  });

  it("boxes unlock only once read to the end; Accept needs every box", async () => {
    await gate.onlyWithEveryBox();
  });

  it("accepting stores the consent for every meerCAD on the Mac and lets the assistant in", async () => {
    await gate.accept();

    const shared = JSON.parse(readFileSync(join(app.dir, "shared", "shared.json"), "utf8")) as Record<
      string,
      { version: string; points: string[]; appVersion: string }
    >;
    expect(shared[TERMS_KEY]).toMatchObject({
      version: TERMS_VERSION,
      points: TERMS_POINTS.map((p) => p.id),
      lang: "en",
    });
    expect(shared[TERMS_KEY]!.appVersion).not.toBe("");
    expect(await app.page.eval<string>("meercadTest.app.getState().screen")).toBe("home");

    const r = await mcp!.call("list_projects");
    expect(r.error, r.text).toBe(false);
    expect(r.text).not.toContain(TERMS_MCP_ERROR);

    const s = await mcp!.call("list_examples");
    expect(s.error, s.text).toBe(false);
  });

  it("after quitting and starting again: no screen", async () => {
    await app.stop();
    inspect = await freePort();
    app = await startApp({ keep: true, dir: app.dir, inspect });
    gate = new Gate(app.page, mouse(app.page));
    await sleep(500);
    expect(await gate.shown()).toBe(false);
    expect(await app.page.eval<string>("meercadTest.app.getState().screen")).toBe("home");
  });

  it("an outdated, partial, broken or missing record brings the screen back, and locks the assistant again", async () => {
    const sharedFile = join(app.dir, "shared", "shared.json");
    await useBridgePort(
      app.page,
      mcpPort.real,
      async () => JSON.parse((await mcp!.call("status")).text).connected === true,
    );
    expect((await mcp!.call("list_projects")).error).toBe(false);

    for (const [what, record] of [
      ["outdated", old()],
      ["partial", partial()],
      ["broken", "{kaputt"],
      ["missing", undefined],
    ] as const) {
      // Both places hold it (a new text is outdated everywhere; shared.json and the app's own storage).
      writeFileSync(
        sharedFile,
        JSON.stringify({ tourDone: true, ...(record === undefined ? {} : { [TERMS_KEY]: record }) }),
      );
      await app.page.eval(
        `(() => { ${record === undefined ? `localStorage.removeItem("${LOCAL_KEY}")` : `localStorage.setItem("${LOCAL_KEY}", ${JSON.stringify(typeof record === "string" ? record : JSON.stringify(record))})`}; location.reload(); return true; })()`,
      );
      await sleep(1000);
      await until(
        "the app to load",
        () => app.page.eval<boolean>("document.readyState === 'complete' && !!window.meercadTest"),
        60000,
      );
      await until(`the screen (${what})`, () => gate.shown());
      await until("the bridge", async () => JSON.parse((await mcp!.call("status")).text).connected === true);

      const r = await mcp!.call("list_projects");
      expect(r.error, what).toBe(true);
      expect(r.text, what).toContain(TERMS_MCP_ERROR);
    }

    // Accepting again lets everything in again.
    gate = new Gate(app.page, mouse(app.page));
    await gate.readToEnd();
    for (let i = 0; i < TERMS_POINTS.length; i++) await gate.tapBox(i);
    await gate.accept();
    expect((await mcp!.call("list_projects")).error).toBe(false);

    // The menu bar works again (the same command that did nothing behind the screen).
    const main = await mainProcess(inspect);

    try {
      await main.menu("new");
    } finally {
      main.close();
    }

    await until(
      "a new part from the menu",
      async () => (await app.page.eval<string>("meercadTest.app.getState().screen")) === "editor",
    );
  });
});

const DEVICE_RUNS: { device: Device; name: string; fits: boolean }[] = [
  { device: "iphone", name: "iPhone", fits: false },
  // Upright the 13" iPad shows the whole text: the boxes are open at once.
  { device: "ipad", name: "iPad, upright", fits: true },
  { device: "ipad-landscape", name: "iPad, on its side", fits: false },
];

for (const { device, name, fits } of DEVICE_RUNS) {
  describe(`terms of use on the ${name} (emulated)`, () => {
    let app: DeviceApp;
    let gate: Gate;
    beforeAll(async () => {
      app = await startDevice(device, { keep: true });
      gate = new Gate(app.page, finger(app.page));
    });
    afterAll(async () => {
      if (app) {
        await app.stop();
        spawnSync("rm", ["-rf", app.dir]);
      }
    });

    it("runs as the iOS app would: touch, the device's size, no Mac around it", async () => {
      expect(
        await app.page.eval<boolean>(
          "!window.meercadDesktop && navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches",
        ),
      ).toBe(true);
      expect(await app.page.eval<number>("innerWidth")).toBe(
        { iphone: 440, ipad: 1032, "ipad-landscape": 1376 }[device],
      );
    });

    it("comes up first, and the app behind takes no taps", async () => {
      await until("the screen", () => gate.shown());
      await gate.blocksTheApp();
    });

    it(
      fits
        ? "the whole text fits, so the boxes are open; Accept needs every box"
        : "boxes unlock only once read to the end; Accept needs every box",
      async () => {
        await gate.onlyWithEveryBox({ fits });
      },
    );

    it("accepting stores the consent on the device", async () => {
      await gate.accept();

      const r = JSON.parse(await app.page.eval<string>(`localStorage.getItem("${LOCAL_KEY}")`)) as {
        version: string;
        points: string[];
      };
      expect(r).toMatchObject({ version: TERMS_VERSION, points: TERMS_POINTS.map((p) => p.id) });
    });

    it("after closing and opening the app: no screen", async () => {
      await app.stop();
      app = await startDevice(device, { keep: true, dir: app.dir });
      gate = new Gate(app.page, finger(app.page));
      await sleep(500);
      expect(await gate.shown()).toBe(false);
    });

    it("an outdated, partial, broken or missing record brings the screen back", async () => {
      for (const [what, record] of [
        ["outdated", JSON.stringify(old())],
        ["partial", JSON.stringify(partial())],
        ["broken", "{kaputt"],
        ["missing", null],
      ] as const) {
        await app.page.eval(
          record === null
            ? `localStorage.removeItem("${LOCAL_KEY}")`
            : `localStorage.setItem("${LOCAL_KEY}", ${JSON.stringify(record)})`,
        );
        await app.reload();
        await until(`the screen (${what})`, () => gate.shown());
      }
    });
  });
}
