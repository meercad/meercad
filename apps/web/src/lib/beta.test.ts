/**
 * Beta functions (beta.ts): off by default and in every App Store build; only a test build (WIP or
 * RC Mac app, TestFlight, a development build) shows them, and a switched-on function stays on
 * after a restart.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({
  desktop: null as null | { info: () => Promise<{ channel?: string; store?: string | null }> },
  native: false,
  environment: async (): Promise<{ environment: string }> => ({ environment: "production" }),
}));

vi.mock("./persistence", () => ({
  get desktop() {
    return shell.desktop;
  },
}));
vi.mock("./native", () => ({
  get nativeApp() {
    return shell.native;
  },
}));
vi.mock("@capacitor/core", () => ({ registerPlugin: () => ({ environment: () => shell.environment() }) }));

async function fresh() {
  vi.resetModules();

  return import("./beta");
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("DEV", false);
  shell.desktop = null;
  shell.native = false;
  shell.environment = async () => ({ environment: "production" });
});
afterEach(() => vi.unstubAllEnvs());

describe("beta switches", () => {
  it("are off and unavailable at first, and a switch counts only in a test build", async () => {
    const beta = await fresh();
    expect(beta.hasBeta("topology")).toBe(false);
    beta.setBeta("topology", true);
    expect(beta.hasBeta("topology")).toBe(false);
    beta.useBeta.setState({ available: true });
    expect(beta.hasBeta("topology")).toBe(true);

    const hook = renderHook(() => beta.useHasBeta("topology"));
    expect(hook.result.current).toBe(true);
    act(() => beta.setBeta("topology", false));
    expect(hook.result.current).toBe(false);
    expect(beta.hasBeta("topology")).toBe(false);
    expect(JSON.parse(localStorage.getItem("meercad.beta")!)).toEqual({});
  });

  it("stay on after a restart, ignore unknown or broken entries", async () => {
    localStorage.setItem("meercad.beta", JSON.stringify({ topology: true, gone: true }));
    expect((await fresh()).useBeta.getState().on).toEqual({ topology: true });
    localStorage.setItem("meercad.beta", JSON.stringify({ topology: "yes" }));
    expect((await fresh()).useBeta.getState().on).toEqual({});
    localStorage.setItem("meercad.beta", "{");
    expect((await fresh()).useBeta.getState().on).toEqual({});
  });

  it("still switch when the storage refuses", async () => {
    const beta = await fresh();
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    beta.setBeta("topology", true);
    expect(beta.useBeta.getState().on).toEqual({ topology: true });
    spy.mockRestore();
  });
});

describe("test builds", () => {
  const detect = async () => {
    const beta = await fresh();
    await beta.detectBetaBuild();

    return beta.useBeta.getState().available;
  };

  it("are development builds", async () => {
    vi.stubEnv("DEV", true);
    expect(await detect()).toBe(true);
  });

  it("are the WIP and RC Mac apps and a Mac App Store sandbox install, not the release", async () => {
    for (const [info, want] of [
      [{ channel: "wip" }, true],
      [{ channel: "rc" }, true],
      [{ channel: "release", store: "sandbox" }, true],
      [{ channel: "release", store: "production" }, false],
      [{}, false],
    ] as const) {
      shell.desktop = { info: async () => info };
      expect(await detect()).toBe(want);
    }
  });

  it("are TestFlight and Xcode installs on iPhone and iPad, not App Store downloads", async () => {
    shell.native = true;
    expect(await detect()).toBe(false);
    shell.environment = async () => ({ environment: "sandbox" });
    expect(await detect()).toBe(true);
  });

  it("are not a shell that cannot answer, nor a browser", async () => {
    shell.native = true;
    shell.environment = () => Promise.reject(new Error("not implemented"));
    expect(await detect()).toBe(false);
    shell.native = false;
    expect(await detect()).toBe(false);
  });
});
