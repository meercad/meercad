/**
 * Opens the meerCAD app when an assistant needs it and it is not running (or not connected yet), so
 * the user always sees what the assistant does. Only on macOS, and never for a test run.
 */
import { CHANNEL_PORTS } from "./protocol.js";

/** The app to open: a bundle on disk or a bundle id. */
export type AppTarget = { path: string } | { bundleId: string };

/** The App Store build's bundle id (the release and TestFlight). */
export const STORE_BUNDLE_ID = "app.meercad";

/**
 * Which app this server belongs to: the bundle it ships in (RC, WIP, a local release), else
 * MEERCAD_APP (an absolute path to an .app or a bundle id; the App Store extension sets it), else the store
 * app for the store ports. Null for a dev checkout, off macOS, and for test runs (MEERCAD_NO_LAUNCH=1,
 * or MEERCAD_MCP_PORT set to a port no build uses).
 */
export function appTarget(o: { serverPath: string; env: Record<string, string | undefined>; port: number; platform: string }): AppTarget | null {
  if (o.platform !== "darwin" || o.env["MEERCAD_NO_LAUNCH"] === "1") return null;
  const override = o.env["MEERCAD_MCP_PORT"];
  if (override !== undefined && !(Object.values(CHANNEL_PORTS) as number[]).includes(Number(override))) return null;
  const bundle = /^(.*?\.app)\/Contents\/Resources\/mcp\//.exec(o.serverPath);
  if (bundle) return { path: bundle[1]! };
  const app = o.env["MEERCAD_APP"]?.trim();
  // An absolute path is a bundle on disk; anything else a bundle id (which ends in ".app" too, e.g. app.meercad).
  if (app) return app.startsWith("/") ? { path: app } : { bundleId: app };
  if (o.port === CHANNEL_PORTS.prod || o.port === CHANNEL_PORTS.testflight) return { bundleId: STORE_BUNDLE_ID };
  return null;
}

/** The `open` arguments for a target: in the background (-g), so it does not take the focus; its window still shows. */
export const openArgs = (t: AppTarget): string[] => ("path" in t ? ["-g", t.path] : ["-g", "-b", t.bundleId]);

/** The environment to open the app with: this server's, without what only concerns the server (`open` passes it on to the app). */
export function launchEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE" && !k.startsWith("MEERCAD_")) out[k] = v;
  return out;
}

export interface LauncherOptions {
  target: AppTarget | null;
  /** Starts `open` with these arguments. */
  open: (args: string[]) => void;
  /** Whether the app is connected now. */
  connected: () => Promise<boolean>;
  log?: (...a: unknown[]) => void;
  /** How long to wait for the app to connect (ms). */
  waitMs?: number;
  pollMs?: number;
  /** No second launch within this time after a wait (ms). */
  againMs?: number;
  /** A running app reconnects every 2 s: wait this long before opening it (ms). */
  graceMs?: number;
  now?: () => number;
}

/**
 * `ensure()` opens the app (at most once per `againMs`) and waits until it is connected. It
 * resolves to whether it is, and whether the app was opened for it (null: nothing to open).
 */
export function createLauncher(o: LauncherOptions) {
  const now = o.now ?? Date.now;
  const waitMs = o.waitMs ?? 30_000;
  const pollMs = o.pollMs ?? 500;
  const againMs = o.againMs ?? 30_000;
  const graceMs = o.graceMs ?? 2500;
  let lastLaunch = -Infinity;
  let waiting: Promise<boolean> | null = null;

  async function waitConnected(ms: number): Promise<boolean> {
    const end = now() + ms;
    for (;;) {
      if (await o.connected().catch(() => false)) return true;
      if (now() >= end) return false;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async function ensure(): Promise<{ connected: boolean; opened: boolean }> {
    if (!o.target) return { connected: false, opened: false };
    if (waiting) return { connected: await waiting, opened: true };
    // Opened a moment ago and still not connected (e.g. the user turned assistants off): no new wait.
    if (now() - lastLaunch < againMs) return { connected: await o.connected().catch(() => false), opened: true };
    lastLaunch = now();
    waiting = launch(o.target).finally(() => {
      waiting = null;
      // The pause before opening it again counts from the end of the wait.
      lastLaunch = now();
    });
    return { connected: await waiting, opened: true };
  }

  async function launch(target: AppTarget): Promise<boolean> {
    if (graceMs > 0 && (await waitConnected(graceMs))) return true;
    o.log?.(`opening the meerCAD app (${"path" in target ? target.path : target.bundleId})`);
    try {
      o.open(openArgs(target));
    } catch (e) {
      o.log?.(`could not open the meerCAD app: ${e instanceof Error ? e.message : String(e)}`);
    }
    return waitConnected(waitMs);
  }

  return { ensure };
}
