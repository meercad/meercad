/**
 * Settings from before the rename (legacy.ts): "leocad." keys are carried over to "meercad." unless
 * the new one is set already; storage that cannot be read carries nothing over.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["leocad.keys", "leocad.theme", "meercad.keys", "meercad.theme"]) localStorage.removeItem(k);
});

describe("settings from before the rename", () => {
  it("carries old keys over without overwriting new ones", async () => {
    localStorage.setItem("leocad.keys", "fusion");
    localStorage.setItem("leocad.theme", "dark");
    localStorage.setItem("meercad.theme", "light");
    vi.resetModules();
    await import("./legacy");
    expect(localStorage.getItem("meercad.keys")).toBe("fusion");
    expect(localStorage.getItem("meercad.theme")).toBe("light");
  });

  it("carries nothing over when storage cannot be read", async () => {
    localStorage.setItem("leocad.keys", "fusion");
    const real = localStorage;
    vi.stubGlobal("localStorage", {
      get length(): number {
        throw new Error("blocked");
      },
    });
    vi.resetModules();
    await import("./legacy");
    vi.unstubAllGlobals();
    expect(localStorage).toBe(real);
    expect(localStorage.getItem("meercad.keys")).toBeNull();
  });
});
