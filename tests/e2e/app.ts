/**
 * Starts a private copy of the Mac app for the UI end-to-end run: its own dev server on a free
 * port, its own app data and an empty projects folder in a temp directory, no connection to the
 * user's assistants (MEERCAD_MCP_BRIDGE=off). The user's projects, iCloud and running apps are
 * never touched. Development builds expose `window.meercadTest` to read results back.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Page, sleep } from "./cdp.js";
import { acceptRecord, TERMS_KEY } from "../../apps/web/src/lib/terms.js";

const root = resolve(import.meta.dirname, "../..");

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

export interface App {
  page: Page;
  /** The temp folder with the app data and the projects. */
  dir: string;
  /** Where exports land (instead of a save dialog). */
  saved: string;
  stop(): Promise<void>;
}

/**
 * `dir`: start again on the folder of an earlier run (stopped with `keep`), as after quitting the app.
 * `shared`: the flags to start with instead of terms accepted and tour seen (tests/e2e/terms.e2e.ts).
 * `inspect`: a port for the main process's inspector, to send what the menu bar sends.
 */
export async function startApp({
  keep = false,
  dir = "",
  shared,
  inspect,
}: { keep?: boolean; dir?: string; shared?: Record<string, unknown>; inspect?: number } = {}): Promise<App> {
  const again = !!dir;
  dir ||= mkdtempSync(join(tmpdir(), "meercad-e2e-"));

  const webPort = await freePort();
  const cdpPort = await freePort();
  // A Mac where the terms of use are accepted and the tour was seen (the flags every meerCAD on the Mac
  // shares, here in the temp folder).
  mkdirSync(join(dir, "shared"), { recursive: true });

  if (!again || shared) {
    writeFileSync(
      join(dir, "shared", "shared.json"),
      JSON.stringify(shared ?? { tourDone: true, [TERMS_KEY]: acceptRecord("e2e", "en") }),
    );
  }

  // Exports are saved here without the save dialog (see files:save in apps/desktop).
  mkdirSync(join(dir, "saved"), { recursive: true });

  const r = spawnSync("node", ["build.mjs"], { cwd: join(root, "apps/desktop"), stdio: "inherit" });
  if (r.status !== 0) throw new Error("desktop build failed");

  const vite = spawn(
    join(root, "apps/web/node_modules/.bin/vite"),
    ["--port", String(webPort), "--strictPort", "--host", "127.0.0.1"],
    { cwd: join(root, "apps/web"), stdio: ["ignore", "pipe", "pipe"] },
  );
  const devUrl = `http://127.0.0.1:${webPort}`;
  await waitFor("the dev server", async () => (await fetch(devUrl)).ok);

  const electron = spawn(
    join(root, "apps/desktop/node_modules/.bin/electron"),
    [
      ".",
      "--dev",
      `--user-data-dir=${join(dir, "userdata")}`,
      `--remote-debugging-port=${cdpPort}`,
      "--lang=en-US",
      // The window may sit behind the user's: it must keep animating and timing as if in front.
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      ...(inspect ? [`--inspect=127.0.0.1:${inspect}`] : []),
    ],
    {
      cwd: join(root, "apps/desktop"),
      env: {
        ...process.env,
        MEERCAD_DEV_URL: devUrl,
        MEERCAD_PROJECTS_DIR: join(dir, "projects"),
        MEERCAD_MCP_BRIDGE: "off",
        MEERCAD_SHARED_DIR: join(dir, "shared"),
        MEERCAD_E2E_SAVE_DIR: join(dir, "saved"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const target = await waitFor("the app window", async () => {
    const list = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()) as {
      type: string;
      url: string;
      webSocketDebuggerUrl: string;
    }[];

    return list.find((t) => t.type === "page" && t.url.startsWith(devUrl));
  });
  const page = await Page.open(target!.webSocketDebuggerUrl);
  await page.call("Runtime.enable");
  await page.call("Page.enable");
  await waitFor("the app to load", () =>
    page.eval<boolean>("!!window.meercadTest && document.readyState === 'complete'"),
  );

  // E2E_COVERAGE=1: which of the app's code the run executes (`node scripts/e2e-coverage.mjs`).
  // Counting starts before the page's scripts load, so the page loads once more.
  const coverage = !!process.env["E2E_COVERAGE"];

  if (coverage) {
    await page.call("Profiler.enable");
    await page.call("Profiler.startPreciseCoverage", { callCount: false, detailed: true });
    await page.call("Page.reload", { ignoreCache: true });
    await sleep(500);
    await waitFor("the app to load again", () =>
      page.eval<boolean>("!!window.meercadTest && document.readyState === 'complete'"),
    );
  }

  const stop = async () => {
    if (coverage) {
      try {
        const { result } = (await page.call("Profiler.takePreciseCoverage")) as {
          result: {
            url: string;
            functions: { ranges: { startOffset: number; endOffset: number; count: number }[] }[];
          }[];
        };
        const own = result.filter(
          (r) => r.url.startsWith(devUrl) && /\/(src|@fs)\//.test(r.url) && !r.url.includes("node_modules"),
        );
        // Each module's code ends where its inline source map starts; the map must not count as code.
        const scripts = await Promise.all(
          own.map(async (r) => {
            const text = await (await fetch(r.url)).text().catch(() => "");
            const at = text.lastIndexOf("\n//# sourceMappingURL=");

            return { ...r, codeLength: at > 0 ? at : text.length || undefined };
          }),
        );
        const out = join(root, "test-results/e2e-coverage");
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, `${Date.now()}-${process.pid}.json`), JSON.stringify({ devUrl, scripts }));
      } catch (e) {
        console.warn("E2E coverage not written:", e);
      }
    }

    electron.kill();
    vite.kill();
    await sleep(500);
    if (!keep) rmSync(dir, { recursive: true, force: true });
  };

  return { page, dir, saved: join(dir, "saved"), stop };
}
