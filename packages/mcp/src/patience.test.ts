import { describe, expect, it } from "vitest";
import { callKey, createPatience } from "./patience.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const later = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const still = (ms: number): any => `still ${ms >= 0}`;

describe("tool calls that take longer than a client waits", () => {
  it("answers a quick call with its result and keeps nothing", async () => {
    const p = createPatience({ answerWithinMs: 200, keepMs: 1000 });
    expect(await p.run("a", () => later(10, "done"), still)).toBe("done");
    expect(p.size).toBe(0);
  });

  it("answers a slow call in time, and the same call again gets its result without a second run", async () => {
    const p = createPatience({ answerWithinMs: 50, keepMs: 1000 });
    let runs = 0;

    const slow = () => {
      runs++;

      return later(150, "opened");
    };

    expect(await p.run("open Robo", slow, still)).toBe("still true");
    // Asked again while it still runs: waits again, still no second run.
    expect(await p.run("open Robo", slow, still)).toBe("still true");
    expect(await p.run("open Robo", slow, still)).toBe("opened");
    expect(runs).toBe(1);
    // Fetched: the next identical call is a new one.
    expect(p.size).toBe(0);
    expect(await p.run("open Robo", () => later(5, "again"), still)).toBe("again");
  });

  it("keeps a finished result for the call that fetches it, and its error too", async () => {
    const p = createPatience({ answerWithinMs: 20, keepMs: 1000 });
    expect(await p.run("ok", () => later(60, 42), still)).toBe("still true");
    expect(
      await p.run("bad", () => later(60, 0).then(() => Promise.reject(new Error("app gone"))), still),
    ).toBe("still true");
    await wait(100);
    expect(await p.run("ok", () => later(1, -1), still)).toBe(42);
    await expect(p.run("bad", () => later(1, -1), still)).rejects.toThrow("app gone");
  });

  it("forgets an unfetched result after keepMs", async () => {
    const p = createPatience({ answerWithinMs: 10, keepMs: 30 });
    await p.run("x", () => later(20, "old"), still);
    await wait(80);
    expect(p.size).toBe(0);
    expect(await p.run("x", () => later(1, "new"), still)).toBe("new");
  });

  it("other calls are not joined", async () => {
    const p = createPatience({ answerWithinMs: 10, keepMs: 1000 });
    await p.run(callKey("motion_tool", { joint: "j_nk", to: 20 }), () => later(50, "a"), still);
    expect(await p.run(callKey("motion_tool", { joint: "j_nk", to: 30 }), () => later(1, "b"), still)).toBe(
      "b",
    );
    // Key order does not matter.
    expect(callKey("t", { a: 1, b: { d: 1, c: 2 } })).toBe(callKey("t", { b: { c: 2, d: 1 }, a: 1 }));
  });
});
