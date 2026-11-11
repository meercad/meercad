import { describe, expect, it } from "vitest";
import { appTarget, createLauncher, launchEnv, openArgs, STORE_BUNDLE_ID } from "./launchApp.js";

const mac = { platform: "darwin", env: {}, port: 47823 };

describe("which app the MCP server opens", () => {
  it("opens the bundle it ships in", () => {
    expect(appTarget({ ...mac, serverPath: "/Applications/meerCAD WIP.app/Contents/Resources/mcp/server.js" })).toEqual({ path: "/Applications/meerCAD WIP.app" });
  });
  it("takes MEERCAD_APP as a path or a bundle id", () => {
    expect(appTarget({ ...mac, serverPath: "/x/server/server.js", env: { MEERCAD_APP: "app.meercad" } })).toEqual({ bundleId: "app.meercad" });
    expect(appTarget({ ...mac, serverPath: "/x/server/server.js", env: { MEERCAD_APP: "/Applications/meerCAD.app" } })).toEqual({ path: "/Applications/meerCAD.app" });
  });
  it("falls back to the store app on the store ports, nothing for a dev checkout", () => {
    expect(appTarget({ ...mac, port: 47821, serverPath: "/x/server/server.js" })).toEqual({ bundleId: STORE_BUNDLE_ID });
    expect(appTarget({ ...mac, port: 47824, serverPath: "/x/server/server.js" })).toEqual({ bundleId: STORE_BUNDLE_ID });
    expect(appTarget({ ...mac, serverPath: "/repo/packages/mcp/dist/server.js" })).toBeNull();
  });
  it("never opens anything for a test run or off macOS", () => {
    const wip = "/Applications/meerCAD WIP.app/Contents/Resources/mcp/server.js";
    expect(appTarget({ ...mac, serverPath: wip, env: { MEERCAD_NO_LAUNCH: "1" } })).toBeNull();
    expect(appTarget({ ...mac, serverPath: wip, env: { MEERCAD_MCP_PORT: "47999" } })).toBeNull();
    expect(appTarget({ ...mac, serverPath: wip, env: { MEERCAD_MCP_PORT: "47821", MEERCAD_APP: "app.meercad" } })).toEqual({ path: "/Applications/meerCAD WIP.app" });
    expect(appTarget({ ...mac, platform: "linux", serverPath: wip })).toBeNull();
  });
  it("opens the app without the server's own environment (it would start as plain Node)", () => {
    expect(launchEnv({ PATH: "/bin", HOME: "/h", ELECTRON_RUN_AS_NODE: "1", MEERCAD_MCP_PORT: "47821", MEERCAD_APP: "x", U: undefined })).toEqual({ PATH: "/bin", HOME: "/h" });
  });
  it("opens in the background", () => {
    expect(openArgs({ path: "/A.app" })).toEqual(["-g", "/A.app"]);
    expect(openArgs({ bundleId: "x.y" })).toEqual(["-g", "-b", "x.y"]);
  });
});

describe("app launcher", () => {
  it("opens once, waits until connected, and shares the wait", async () => {
    const opened: string[][] = [];
    let polls = 0;
    const l = createLauncher({ target: { path: "/A.app" }, open: (a) => opened.push(a), connected: async () => ++polls > 3, pollMs: 1, graceMs: 0 });
    const [a, b] = await Promise.all([l.ensure(), l.ensure()]);
    expect(a).toEqual({ connected: true, opened: true });
    expect(b).toEqual({ connected: true, opened: true });
    expect(opened).toEqual([["-g", "/A.app"]]);
  });
  it("gives up after the wait and does not open again right away", async () => {
    const opened: string[][] = [];
    let t = 0;
    const l = createLauncher({ target: { bundleId: "x" }, open: (a) => opened.push(a), connected: async () => false, pollMs: 1, waitMs: 50, againMs: 100, graceMs: 0, now: () => (t += 10) });
    expect(await l.ensure()).toEqual({ connected: false, opened: true });
    // The pause counts from the end of the wait, which took longer than the pause itself.
    expect(await l.ensure()).toEqual({ connected: false, opened: true });
    expect(opened.length).toBe(1);
    t += 200;
    await l.ensure();
    expect(opened.length).toBe(2);
  });
  it("does not open an app that reconnects by itself within the grace time", async () => {
    let polls = 0;
    const l = createLauncher({ target: { path: "/A.app" }, open: () => expect.fail("opened"), connected: async () => ++polls > 2, pollMs: 1, graceMs: 1000 });
    expect((await l.ensure()).connected).toBe(true);
  });
  it("does nothing without a target", async () => {
    const l = createLauncher({ target: null, open: () => expect.fail("opened"), connected: async () => false });
    expect(await l.ensure()).toEqual({ connected: false, opened: false });
  });
});
