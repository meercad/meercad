/**
 * The app's end of the assistant connection (mcpBridge.ts) on the Mac, with a stand-in for the MCP
 * server's socket and for the main process's assistant tabs: requests arrive over the socket and
 * are answered on it; before a session has opened a project only lookups are answered; opening
 * gives the session a tab of its own and later calls go there by project; a second open on one
 * connection is refused with the reason; a tab that went idle or was taken over says so; closing
 * hands the project back; the socket coming and going is shown and retried.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantTab } from "./persistence";
import { bridgeStatus, onBridgeStatus, setBridgeEnabled } from "./mcpBridge";
import { newProject, useApp } from "../store";

/** The MCP server's end: what the app sent, and a way to send it requests. */
class FakeSocket {
  static last: FakeSocket | null = null;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(text: string) {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
  }
}
const sock = () => FakeSocket.last!;
let nextId = 1;
/** Sends a request as the MCP server would and waits for the app's answer. */
async function request(method: string, params: Record<string, unknown> = {}, session = "S1"): Promise<{ result?: unknown; error?: string }> {
  const id = nextId++;
  const ws = sock();
  ws.onmessage!({ data: JSON.stringify({ id, method, params, session, tabs: "project", client: "claude-ai" }) });
  await vi.waitFor(() => expect(ws.sent.some((m) => m["id"] === id)).toBe(true), { timeout: 20_000 });
  return ws.sent.find((m) => m["id"] === id) as { result?: unknown; error?: string };
}

/** The main process's assistant tabs: each tab answers what is asked in it. */
const tabs: AssistantTab[] = [];
let windowState: Record<string, number | "idle" | "closed" | null> = {};
const handedOver: [string, string | undefined][] = [];
const calls: [number, { method: string }][] = [];
const assistant = {
  open: async ({ session, client }: { session: string; client: string }) => {
    let t = tabs.find((x) => x.session === session);
    if (!t) tabs.push((t = { session, client, project: null, name: null, busy: false, tool: null }));
    windowState[session] = tabs.indexOf(t) + 1;
    return tabs.indexOf(t) + 1;
  },
  windowOf: async (session: string) => windowState[session] ?? null,
  call: async (win: number, req: { method: string; params: Record<string, unknown> }) => {
    calls.push([win, req]);
    const t = tabs[win - 1]!;
    if (req.method === "new_project" || req.method === "open_project") {
      t.project = String(req.params["id"] ?? `p-${req.params["name"]}`);
      t.name = String(req.params["name"] ?? t.project);
      return { opened: t.project };
    }
    return { method: req.method, in: t.project };
  },
  tabs: async () => tabs.map((t) => ({ ...t })),
  show: () => undefined,
  snapshot: async () => null,
  handOver: async (session: string, why?: string) => {
    handedOver.push([session, why]);
    const i = tabs.findIndex((t) => t.session === session);
    const t = i >= 0 ? tabs.splice(i, 1)[0]! : null;
    windowState[session] = null;
    return t?.project ? { id: t.project, name: t.name ?? t.project } : null;
  },
};
const desktop = () => (window as unknown as { meercadDesktop: Record<string, unknown> }).meercadDesktop;
const WS = globalThis.WebSocket;

beforeAll(async () => {
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  desktop()["assistant"] = assistant;
  await newProject(undefined, "User's own");
});
afterAll(() => {
  setBridgeEnabled(false, false);
  (globalThis as { WebSocket: unknown }).WebSocket = WS;
  delete desktop()["assistant"];
});
beforeEach(() => {
  calls.length = 0;
});

describe("the connection", () => {
  it("connects, says hello, and shows its state", () => {
    const seen: string[] = [];
    const off = onBridgeStatus((s) => seen.push(s));
    setBridgeEnabled(true, false);
    expect(sock().url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(bridgeStatus()).toBe("connecting");
    sock().onopen!();
    expect(bridgeStatus()).toBe("connected");
    expect(sock().sent[0]).toMatchObject({ hello: "meercad", project: "User's own" });
    expect(seen).toEqual(["connecting", "connected"]);
    off();
  });
});

describe("an assistant's requests on the Mac", () => {
  it("answers lookups before anything is open, and asks to open a project for the rest", async () => {
    expect((await request("list_projects")).result).toBeTruthy();
    const r = await request("apply_ops", { ops: [] });
    expect(r.error).toMatch(/^Open the project to work on first .* The user has "User's own" open/);
  });

  it("opens a new project in a tab of the session's own, and goes there by project", async () => {
    const opened = await request("new_project", { name: "Bracket" });
    expect(opened.result).toMatchObject({ opened: "p-Bracket", project: { id: "p-Bracket", name: "Bracket" } });
    expect(tabs.map((t) => [t.session, t.project])).toEqual([["S1", "p-Bracket"]]);
    const r = await request("get_model", { project: "p-Bracket" });
    expect(r.result).toEqual({ method: "get_model", in: "p-Bracket" });
    // With one tab, the project need not be named.
    expect((await request("undo")).result).toEqual({ method: "undo", in: "p-Bracket" });
  });

  it("refuses a second open on the same connection and says why", async () => {
    const r = await request("new_project", { name: "Second" });
    expect(r.error).toMatch(/Another chat is already working on project "Bracket" \(id "p-Bracket"\) over this meerCAD connection/);
    const same = await request("open_project", { id: "p-Bracket" });
    expect(same.error).toMatch(/is already open over this meerCAD connection/);
  });

  it("says when a project named is not open in a tab of the session", async () => {
    const r = await request("get_model", { project: "p-Other" });
    expect(r.error).toMatch(/Project "p-Other" is not open in a meerCAD tab of yours\. Open it first \(open_project\); yours are "Bracket"/);
    // A lookup goes through anyway.
    expect((await request("list_examples", { project: "p-Other" })).result).toBeTruthy();
  });

  it("refuses another session's project, unless it is the same assistant taking over", async () => {
    tabs.push({ session: "S9", client: "Cursor", project: "p-Theirs", name: "Theirs", busy: false, tool: null });
    windowState["S9"] = tabs.length;
    const r = await request("open_project", { id: "p-Theirs" }, "S2");
    expect(r.error).toMatch(/^Cursor is working on this project in its own meerCAD tab right now\. Pick another project, or wait until it is done/);
    tabs[tabs.length - 1]!.client = "Claude";
    const taken = await request("open_project", { id: "p-Theirs", takeover: true }, "S2");
    expect(taken.result).toMatchObject({ opened: "p-Theirs" });
    expect(handedOver).toContainEqual(["S9", "released"]);
  });

  it("tells a session its tab went idle or was taken over", async () => {
    windowState["S1"] = "idle";
    expect((await request("get_model")).error).toMatch(/went back to the user after \d+ minutes without a request/);
    windowState["S1"] = "closed";
    expect((await request("get_model")).error).toMatch(/The user took the project over or closed your meerCAD tab/);
    windowState["S1"] = tabs.findIndex((t) => t.session === "S1") + 1;
  });

  it("closes the session's project: it goes back to the user", async () => {
    const r = await request("close_project");
    expect(r.result).toMatchObject({ closed: true, project: { id: "p-Bracket", name: "Bracket" } });
    expect(handedOver).toContainEqual(["S1", "released"]);
    expect((await request("close_project")).result).toMatchObject({ closed: false, note: "This session has no project open: nothing to close." });
    expect((await request("close_project", { project: "p-X" })).result).toMatchObject({ closed: false, note: expect.stringMatching(/Project "p-X" is not open/) });
  });

  it("lists the session's projects when several are open and none is named", async () => {
    tabs.push({ session: "S3", client: "Claude", project: "a", name: "A", busy: false, tool: null }, { session: "S3~2", client: "Claude", project: "b", name: "B", busy: false, tool: null });
    const r = await request("get_model", {}, "S3");
    expect(r.error).toMatch(/You have 2 projects open in meerCAD tabs of yours: "A" \(id "a"\), "B" \(id "b"\)\. Pass project: "<id>"/);
    const st = await request("get_status", {}, "S3");
    expect(st.result).toMatchObject({ project: null, projects: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
  });

  it("answers a server's end of session by handing its tabs back", async () => {
    sock().onmessage!({ data: JSON.stringify({ event: "session_ended", session: "S3" }) });
    await vi.waitFor(() => expect(tabs.some((t) => t.session.startsWith("S3"))).toBe(false));
  });
});

describe("the connection going", () => {
  it("waits, then connects again; another app taking it waits for the next use", async () => {
    vi.useFakeTimers();
    try {
      const first = sock();
      first.onclose!({ code: 1006 });
      expect(bridgeStatus()).toBe("connecting");
      vi.advanceTimersByTime(2000);
      expect(sock()).not.toBe(first);
      sock().onopen!();
      expect(bridgeStatus()).toBe("connected");
      const second = sock();
      second.onclose!({ code: 4000 });
      vi.advanceTimersByTime(2500);
      // Taken by another meerCAD: no swapping back and forth while this window is not in use.
      expect(sock() === second || document.hasFocus()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    setBridgeEnabled(false, false);
    expect(bridgeStatus()).toBe("off");
  });
});
