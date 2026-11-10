import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearOldSends, findSlicer, KEEP_MS, sendName, SLICERS, TEMP_PREFIX, writeSend } from "../apps/desktop/src/slicers";

/**
 * "Send to Bambu Studio / PrusaSlicer": the Mac app finds the slicers where they are installed
 * (PrusaSlicer's installer puts it into a subfolder), writes the 3MF to a temporary folder and
 * clears old ones away.
 */
const bambu = SLICERS.find((s) => s.id === "bambu")!;
const prusa = SLICERS.find((s) => s.id === "prusa")!;

describe("finding the slicers", () => {
  it("lists Bambu Studio first", () => {
    expect(SLICERS.map((s) => s.id)).toEqual(["bambu", "prusa"]);
  });

  it("finds them in the Applications folders, PrusaSlicer also in Original Prusa Drivers", async () => {
    const at = (...paths: string[]) => (p: string) => paths.includes(p);
    expect(await findSlicer(bambu, undefined, ["/Applications"], at("/Applications/BambuStudio.app"))).toBe("/Applications/BambuStudio.app");
    expect(await findSlicer(prusa, undefined, ["/Applications", "/Users/x/Applications"], at("/Applications/Original Prusa Drivers/PrusaSlicer.app"))).toBe("/Applications/Original Prusa Drivers/PrusaSlicer.app");
    expect(await findSlicer(prusa, undefined, ["/Applications", "/Users/x/Applications"], at("/Users/x/Applications/PrusaSlicer.app"))).toBe("/Users/x/Applications/PrusaSlicer.app");
    expect(await findSlicer(bambu, undefined, ["/Applications"], at())).toBeNull();
  });

  it("finds them elsewhere by their URL scheme, but not a fork that claims it", async () => {
    const none = () => false;
    expect(await findSlicer(bambu, async (u) => (u === "bambustudioopen://" ? "/Volumes/Tools/BambuStudio.app" : null), [], none)).toBe("/Volumes/Tools/BambuStudio.app");
    expect(await findSlicer(bambu, async () => "/Applications/OrcaSlicer.app", [], none)).toBeNull();
    expect(await findSlicer(prusa, async () => "/Opt/PrusaSlicer.app", [], none)).toBe("/Opt/PrusaSlicer.app");
    expect(await findSlicer(prusa, async () => Promise.reject(new Error("no app")), [], none)).toBeNull();
  });
});

describe("the file sent", () => {
  const dirs: string[] = [];
  const temp = () => {
    const d = mkdtempSync(join(tmpdir(), "meercad-slicer-test-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("goes into a fresh folder under its name", async () => {
    const t = temp();
    const file = await writeSend(t, "Halter.3mf", new Uint8Array([1, 2, 3]));
    expect(file.startsWith(join(t, TEMP_PREFIX))).toBe(true);
    expect(file.endsWith("/Halter.3mf")).toBe(true);
    expect([...readFileSync(file)]).toEqual([1, 2, 3]);
    expect(sendName("a/b:c.3mf")).toBe("a-b-c.3mf");
    expect(sendName("  ")).toBe("model.3mf");
  });

  it("clears away old sends, keeps recent ones and other folders", async () => {
    const t = temp();
    const old = join(t, `${TEMP_PREFIX}old`);
    const fresh = join(t, `${TEMP_PREFIX}fresh`);
    const other = join(t, "something-else");
    for (const d of [old, fresh, other]) await mkdir(d);
    const past = (Date.now() - KEEP_MS - 60_000) / 1000;
    utimesSync(old, past, past);
    utimesSync(other, past, past);
    expect(await clearOldSends(t)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
    // The next send clears too.
    utimesSync(fresh, past, past);
    await writeSend(t, "x.3mf", new Uint8Array());
    expect(readdirSync(t).filter((n) => n.startsWith(TEMP_PREFIX))).toHaveLength(1);
  });
});

describe("send_to_slicer over MCP", () => {
  it("is a tool of the MCP server that the app answers", () => {
    const root = join(import.meta.dirname, "..");
    const server = readFileSync(join(root, "packages/mcp/src/server.ts"), "utf8");
    const bridge = readFileSync(join(root, "apps/web/src/lib/mcpBridge.ts"), "utf8");
    expect(server).toMatch(/registerTool\(\s*"send_to_slicer"/);
    expect(server).toContain('slicer: z.enum(["bambu", "prusa"])');
    expect(bridge).toContain('case "send_to_slicer"');
  });
});
