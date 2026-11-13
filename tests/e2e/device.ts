/**
 * The iPhone and iPad layouts for the UI end-to-end run, without a simulator: the app's own dev
 * server on a free port in a bare Electron window (no Mac app around it, so the app keeps its data in
 * localStorage as on the iPad and iPhone), with the device's screen size, pixel ratio, touch and user
 * agent emulated over the DevTools protocol. Capacitor is made to see iOS, as in the iOS app's web
 * view; native plugin calls go nowhere. Own temp profile; nothing of the user's is touched.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Page, sleep } from "./cdp.js";

const root = resolve(import.meta.dirname, "../..");

export const DEVICES = {
  // iPhone 18 Pro Max-sized (points), and a 13" iPad upright and on its side.
  iphone: {
    width: 440,
    height: 956,
    deviceScaleFactor: 3,
    mobile: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  },
  ipad: {
    width: 1032,
    height: 1376,
    deviceScaleFactor: 2,
    mobile: true,
    ua: "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  },
  "ipad-landscape": {
    width: 1376,
    height: 1032,
    deviceScaleFactor: 2,
    mobile: true,
    ua: "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  },
} as const;
export type Device = keyof typeof DEVICES;

const freePort = () =>
  new Promise<number>((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });

async function waitFor<T>(what: string, fn: () => Promise<T>, ms = 60000): Promise<T> {
  const end = Date.now() + ms;

  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not yet
    }

    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);

    await sleep(250);
  }
}

/** A bare window on the URL, nothing preloaded; DevTools on the given port. */
const MAIN = `
const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: Number(process.env.W), height: Number(process.env.H), show: false, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false } });
  w.loadURL("about:blank");
});
app.on("window-all-closed", () => app.quit());
// Quit properly when the test stops it, so localStorage reaches the disk as on a device.
process.on("SIGTERM", () => app.quit());
`;

export interface DeviceApp {
  page: Page;
  url: string;
  /** The temp folder: the window's profile (its localStorage) lives here. */
  dir: string;
  /** Loads the app again (as after closing and opening it on the device). */
  reload(): Promise<void>;
  stop(): Promise<void>;
}

/** `dir`: start again on an earlier run's profile (stopped with `keep`). */
export async function startDevice(device: Device, { dir = "", keep = false } = {}): Promise<DeviceApp> {
  dir ||= mkdtempSync(join(tmpdir(), `meercad-e2e-${device}-`));
  writeFileSync(join(dir, "main.cjs"), MAIN);

  const d = DEVICES[device];
  // Started again: the same address, since localStorage belongs to it.
  const portFile = join(dir, "web-port");
  const webPort = existsSync(portFile) ? Number(readFileSync(portFile, "utf8")) : await freePort();
  writeFileSync(portFile, String(webPort));

  const cdpPort = await freePort();
  const vite = spawn(
    join(root, "apps/web/node_modules/.bin/vite"),
    ["--port", String(webPort), "--strictPort", "--host", "127.0.0.1"],
    { cwd: join(root, "apps/web"), stdio: ["ignore", "pipe", "pipe"] },
  );
  const url = `http://127.0.0.1:${webPort}/`;
  let electron: ChildProcess | null = null;

  const stop = async () => {
    if (electron && electron.exitCode === null) {
      const exited = new Promise((ok) => electron!.once("exit", ok));
      electron.kill();
      await Promise.race([exited, sleep(10000)]);
    }

    vite.kill();
    await sleep(500);
    if (!keep) rmSync(dir, { recursive: true, force: true });
  };

  try {
    await waitFor("the dev server", async () => (await fetch(url)).ok);
    electron = spawn(
      join(root, "apps/desktop/node_modules/.bin/electron"),
      [
        join(dir, "main.cjs"),
        `--user-data-dir=${join(dir, "userdata")}`,
        `--remote-debugging-port=${cdpPort}`,
        "--lang=en-US",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
      ],
      { env: { ...process.env, W: String(d.width), H: String(d.height) }, stdio: ["ignore", "pipe", "pipe"] },
    );

    const target = await waitFor("the window", async () => {
      const list = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()) as {
        type: string;
        url: string;
        webSocketDebuggerUrl: string;
      }[];

      return list.find((t) => t.type === "page" && t.url === "about:blank");
    });
    const page = await Page.open(target!.webSocketDebuggerUrl);
    await page.call("Runtime.enable");
    await page.call("Page.enable");
    await page.call("Emulation.setDeviceMetricsOverride", {
      width: d.width,
      height: d.height,
      deviceScaleFactor: d.deviceScaleFactor,
      mobile: d.mobile,
    });
    await page.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.call("Emulation.setUserAgentOverride", {
      userAgent: d.ua,
      platform: device === "iphone" ? "iPhone" : "iPad",
    });
    await page.call("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
    // Capacitor takes a page with this message handler for its iOS web view (nativeApp in lib/native.ts).
    await page.call("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.webkit = { messageHandlers: { bridge: { postMessage() {} } } };",
    });

    const loaded = () =>
      waitFor("the app to load", () =>
        page.eval<boolean>(
          "!!window.meercadTest && document.readyState === 'complete' && !!document.querySelector('#root > *')",
        ),
      );
    await page.call("Page.navigate", { url });
    await loaded();

    const reload = async () => {
      await page.call("Page.reload", { ignoreCache: false });
      await sleep(300);
      await loaded();
    };

    return { page, url, dir, reload, stop };
  } catch (e) {
    await stop();

    throw e;
  }
}
