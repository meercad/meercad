import { describe, expect, it } from "vitest";
import { ASSISTANT_IDLE_MS, idleAssistants } from "./protocol.js";

describe("assistants' tabs going back to the user", () => {
  const now = 1_000_000_000;
  const tab = (session: string, idleFor: number, more: { busy?: boolean; pending?: number } = {}) => ({
    session,
    lastCall: now - idleFor,
    busy: more.busy ?? false,
    pending: more.pending ?? 0,
  });

  it("hands back a tab whose session made no request for the idle time", () => {
    const tabs = [tab("fresh", 30_000), tab("old", ASSISTANT_IDLE_MS), tab("older", ASSISTANT_IDLE_MS * 3)];
    expect(idleAssistants(tabs, now).map((t) => t.session)).toEqual(["old", "older"]);
  });

  it("keeps a tab that is working or still waits for an answer, however long ago its last request started", () => {
    const tabs = [
      tab("busy", ASSISTANT_IDLE_MS * 2, { busy: true }),
      tab("rendering", ASSISTANT_IDLE_MS * 2, { pending: 1 }),
    ];
    expect(idleAssistants(tabs, now)).toEqual([]);
  });

  it("takes a shorter idle time (test runs)", () => {
    expect(idleAssistants([tab("a", 5_000)], now, 4_000).map((t) => t.session)).toEqual(["a"]);
    expect(idleAssistants([tab("a", 3_000)], now, 4_000)).toEqual([]);
  });

  it("gives the assistant a while to think between two requests", () => {
    expect(ASSISTANT_IDLE_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
