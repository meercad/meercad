/** One opening per project at a time; the one asked for last keeps the editor. */
import { describe, expect, it } from "vitest";
import { openGuard, tasksOnEditor } from "./opening";

/** A promise with its resolve and reject at hand. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => ([resolve, reject] = [yes, no]));

  return { promise, resolve, reject };
}

describe("openGuard", () => {
  it("runs one opening per key and hands a second tap the running one", async () => {
    const guard = openGuard();
    const gate = deferred();
    let calls = 0;

    const open = async () => {
      calls++;
      await gate.promise;
    };

    const first = guard.run("a", open);
    const again = guard.run("a", open);

    expect(again).toBe(first);
    expect(guard.busy("a")).toBe(true);
    expect(calls).toBe(1);
    gate.resolve();
    await first;
    expect(guard.busy("a")).toBe(false);
  });

  it("tells an older opening that a newer one was asked for, until it is tapped again", async () => {
    const guard = openGuard();
    const gates = { a: deferred(), b: deferred() };
    const current: Record<string, () => boolean> = {};
    const run = (key: "a" | "b") =>
      guard.run(key, async (isCurrent) => {
        current[key] = isCurrent;
        await gates[key].promise;
      });

    const a = run("a");
    const b = run("b");

    expect(current.a!()).toBe(false);
    expect(current.b!()).toBe(true);
    void run("a");
    expect(current.a!()).toBe(true);
    gates.a.resolve();
    gates.b.resolve();
    await Promise.all([a, b]);
  });

  it("frees the key when an opening fails", async () => {
    const guard = openGuard();
    const gate = deferred();
    const run = guard.run("a", () => gate.promise);

    gate.reject(new Error("unreadable"));
    await expect(run).rejects.toThrow("unreadable");
    expect(guard.busy("a")).toBe(false);
  });

  it("frees the key when an opening fails before its first step", async () => {
    const guard = openGuard();
    const run = guard.run("a", () => {
      throw new Error("no file");
    });

    await expect(run).rejects.toThrow("no file");
    expect(guard.busy("a")).toBe(false);
  });
});

describe("tasksOnEditor", () => {
  it("ends the tasks that only lead to the editor", () => {
    const tasks = [{ id: 1, untilEditor: true }, { id: 2 }];

    expect(tasksOnEditor(tasks)).toEqual([{ id: 2 }]);

    const others = [{ id: 2 }];

    expect(tasksOnEditor(others)).toBe(others);
  });
});
