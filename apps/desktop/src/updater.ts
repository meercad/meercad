/**
 * Self-updater for unsigned builds (Squirrel.Mac requires a Developer ID signature): checks the
 * GitHub releases, downloads the zip for this architecture and swaps the app bundle on restart.
 */
import { app, BrowserWindow, net, shell } from "electron";
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { access, constants, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = process.env["MEERCAD_UPDATE_REPO"] ?? "torbenberger/meercad";

export interface UpdateInfo {
  version: string;
  url: string;
  page: string;
  notes: string;
  /** Commit subjects between the running build and this one, newest first. */
  changes: string[];
}

/** The commit this build was made from (written into package.json by the release pipeline). */
export function buildSha(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as { buildSha?: string };
    return pkg.buildSha ?? null;
  } catch {
    return null;
  }
}

const api = (path: string) => net.fetch(`https://api.github.com/repos/${REPO}/${path}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "meercad" } });

async function changesBetween(from: string | null, to: string): Promise<string[]> {
  if (!from || !to || from === to) return [];
  try {
    const res = await api(`compare/${from}...${to}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { commits?: { commit: { message: string } }[] };
    return (data.commits ?? []).map((c) => c.commit.message.split("\n")[0]!).filter((m) => !/^Merge /.test(m)).reverse().slice(0, 12);
  } catch {
    return [];
  }
}

const parse = (v: string) => v.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
export function newer(a: string, b: string): boolean {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const res = await api("releases?per_page=15");
  if (!res.ok) throw new Error(`update check failed (${res.status})`);
  const releases = (await res.json()) as { html_url: string; body?: string; target_commitish?: string; assets: { name: string; browser_download_url: string }[] }[];
  let target = "";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  let best: UpdateInfo | null = null;
  for (const r of releases) {
    for (const a of r.assets) {
      const m = new RegExp(`^meercad-(\\d+\\.\\d+\\.\\d+)-${arch}\\.zip$`).exec(a.name);
      if (m && newer(m[1]!, best?.version ?? app.getVersion())) {
        best = { version: m[1]!, url: a.browser_download_url, page: r.html_url, notes: (r.body ?? "").slice(0, 2000), changes: [] };
        target = r.target_commitish ?? "";
      }
    }
  }
  if (best) best.changes = await changesBetween(buildSha(), target);
  return best;
}

/** Path of the running .app bundle, or null when not running from one (dev). */
function bundlePath(): string | null {
  const p = resolve(process.execPath, "../../..");
  return p.endsWith(".app") ? p : null;
}

export async function canSelfUpdate(): Promise<boolean> {
  const bundle = bundlePath();
  if (!app.isPackaged || !bundle) return false;
  try {
    await access(dirname(bundle), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Downloads and unpacks the update, then replaces the bundle after the app quits and relaunches it. */
export async function installUpdate(info: UpdateInfo, win: BrowserWindow | null): Promise<void> {
  const bundle = bundlePath();
  if (!(await canSelfUpdate()) || !bundle) {
    await shell.openExternal(info.page);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "meercad-update-"));
  const zip = join(dir, "update.zip");
  const res = await net.fetch(info.url);
  // The rolling release is deleted and recreated while a new build is published.
  if (res.status === 404) throw new Error("a newer build is being published right now — try again in a few minutes");
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let done = 0;
  const out = createWriteStream(zip);
  const reader = res.body.getReader();
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    done += value.length;
    if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
    win?.webContents.send("update-progress", total ? done / total : 0);
  }
  await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
  await run("ditto", ["-x", "-k", zip, join(dir, "unpacked")]);
  const name = (await readdir(join(dir, "unpacked"))).find((f) => f.endsWith(".app"));
  if (!name) throw new Error("update archive contains no app");
  const fresh = join(dir, "unpacked", name);
  await run("codesign", ["--verify", "--deep", fresh]);
  // A detached helper waits for this process to exit, swaps the bundle and starts the new version.
  const script = join(dir, "swap.sh");
  await writeFile(
    script,
    `#!/bin/sh
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done
rm -rf "${bundle}.old" && mv "${bundle}" "${bundle}.old" && mv "${fresh}" "${bundle}" && rm -rf "${bundle}.old"
xattr -dr com.apple.quarantine "${bundle}" 2>/dev/null
open "${bundle}"
`,
    { mode: 0o755 },
  );
  spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
  app.quit();
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const p = spawn(cmd, args, { stdio: "ignore" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolveRun() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}
