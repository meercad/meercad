import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openGuard, tasksOnEditor } from "../apps/web/src/lib/opening";
import { sureTap } from "../apps/web/src/lib/gestures";

/**
 * Opening a big design from the overview (iPhone, Emil Mini v4, 1180 steps): every tap on the card
 * while it was being read started another opening, each with its own "Opening …" bar at the
 * bottom, and each one finishing loaded the design into the editor again, under the "Building the
 * model" overlay. One opening per project, and the bar ends when the editor shows the design.
 */

/** A promise resolved from outside. */
function later<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));

  return { promise, resolve };
}

describe("openGuard (tapping a card again while it opens)", () => {
  it("runs one opening per project, however often it is asked for meanwhile", async () => {
    const guard = openGuard();
    const read = later();
    const open = vi.fn(async () => read.promise);
    const taps = [
      guard.run("Emil Mini v4", open),
      guard.run("Emil Mini v4", open),
      guard.run("Emil Mini v4", open),
    ];
    expect(open).toHaveBeenCalledTimes(1);
    expect(guard.busy("Emil Mini v4")).toBe(true);
    expect(new Set(taps).size).toBe(1);
    read.resolve();
    await Promise.all(taps);
    expect(guard.busy("Emil Mini v4")).toBe(false);
  });

  it("opens again once the opening before has ended", async () => {
    const guard = openGuard();
    const open = vi.fn(async () => undefined);
    await guard.run("a", open);
    await guard.run("a", open);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("ends the opening when it fails, so the next tap tries again", async () => {
    const guard = openGuard();
    await expect(guard.run("a", async () => Promise.reject(new Error("gone")))).rejects.toThrow("gone");
    expect(guard.busy("a")).toBe(false);
  });

  it("leaves the editor to the project asked for last", async () => {
    const guard = openGuard();
    const readA = later();
    const readB = later();
    const shown: string[] = [];

    const opener = (name: string, read: Promise<void>) => async (current: () => boolean) => {
      await read;
      if (current()) shown.push(name);
    };

    const a = guard.run("a", opener("a", readA.promise));
    const b = guard.run("b", opener("b", readB.promise));
    readB.resolve();
    await b;
    readA.resolve();
    await a;
    expect(shown).toEqual(["b"]);
  });

  it("a project tapped again while it opens is again the one asked for last", async () => {
    const guard = openGuard();
    const readA = later();
    const readB = later();
    const shown: string[] = [];

    const opener = (name: string, read: Promise<void>) => async (current: () => boolean) => {
      await read;
      if (current()) shown.push(name);
    };

    const a = guard.run("a", opener("a", readA.promise));
    const b = guard.run("b", opener("b", readB.promise));
    void guard.run("a", opener("a", readA.promise));
    readB.resolve();
    readA.resolve();
    await Promise.all([a, b]);
    expect(shown).toEqual(["a"]);
  });
});

describe("tasksOnEditor (one progress display while a design opens)", () => {
  it("ends the opening bar once the editor shows the design and keeps the rest", () => {
    const tasks = [
      { id: 1, label: "Emil Mini v4 wird geöffnet …", untilEditor: true },
      { id: 2, label: "Export" },
    ];
    expect(tasksOnEditor(tasks)).toEqual([{ id: 2, label: "Export" }]);
  });

  it("returns the same list when nothing ends, so the store does not change", () => {
    const tasks: { id: number; label: string; untilEditor?: boolean }[] = [{ id: 2, label: "Export" }];
    expect(tasksOnEditor(tasks)).toBe(tasks);
  });

  it("the store ends opening bars when the editor shows a design, and both openings mark theirs", () => {
    const web = join(import.meta.dirname, "..", "apps", "web", "src");
    const store = readFileSync(join(web, "store.ts"), "utf8");
    const home = readFileSync(join(web, "components", "Home.tsx"), "utf8");
    // loadDoc switches to the editor and ends the opening bars in the same update.
    const loadDoc = store.slice(store.indexOf("function loadDoc("));
    const update = loadDoc.slice(0, loadDoc.indexOf("syncDoc();"));
    expect(update).toMatch(/screen: "editor",[\s\S]*tasks: tasksOnEditor\(s\.tasks\)/);
    expect(store).toMatch(/startTask\(t\("Opening \{name\} …"[^;]*untilEditor: true/);
    expect(home).toMatch(/startTask\(t\("Opening \{name\}"[^;]*untilEditor: true/);
    // Both go through a guard.
    expect(store).toMatch(/return opening\.run\(id,/);
    expect(home).toMatch(/return openingExamples\.run\(ex\.name,/);
  });
});

describe("sureTap and a long press", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const touch = { pointerType: "touch", clientX: 10, clientY: 10 };

  it("a long press on a card opens its menu, not the project", () => {
    const run = vi.fn();
    const h = sureTap(run);
    h.onPointerDown(touch);
    vi.advanceTimersByTime(600);
    h.onPointerUp(touch);
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
  });

  it("a quick tap still runs on the lift when iOS swallows the click", () => {
    const run = vi.fn();
    const h = sureTap(run);
    h.onPointerDown(touch);
    vi.advanceTimersByTime(80);
    h.onPointerUp(touch);
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
