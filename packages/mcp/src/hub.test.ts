import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createBridge } from "./hub.js";

const quiet = () => undefined;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await wait(25);
  }
}
let nextPort = 47950 + Math.floor(Math.random() * 40);

/** A stand-in for the meerCAD app: answers every request with its method and session, reconnects when dropped. */
function fakeApp(port: number) {
  const seen: { method: string; session: string; params: unknown }[] = [];
  const events: unknown[] = [];
  let ws: WebSocket | null = null;
  let closed = false;
  const connect = () => {
    if (closed) return;
    const s = new WebSocket(`ws://127.0.0.1:${port}`);
    ws = s;
    s.on("open", () => s.send(JSON.stringify({ hello: "meercad", version: "test", project: "P" })));
    s.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.event) return void events.push(m);
      seen.push({ method: m.method, session: m.session, params: m.params });
      s.send(JSON.stringify({ id: m.id, result: { method: m.method, session: m.session } }));
    });
    s.on("close", () => setTimeout(connect, 50));
    s.on("error", () => undefined);
  };
  connect();
  return {
    seen,
    events,
    get open() {
      return ws?.readyState === WebSocket.OPEN;
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

describe("MCP bridge hub", () => {
  it("routes several servers' requests through the first one, each with its own session", async () => {
    const port = nextPort++;
    const a = createBridge({ port, session: "A", originAllowed: () => true, log: quiet });
    stops.push(a.stop);
    await until(() => a.role === "hub");
    const b = createBridge({ port, session: "B", originAllowed: () => true, log: quiet });
    stops.push(b.stop);
    await until(() => b.role === "peer");
    const app = fakeApp(port);
    stops.push(app.close);
    await until(async () => (await b.status()).connected);

    const [ra, rb] = await Promise.all([a.call("get_model"), b.call("get_model", { full: true })]);
    expect(ra).toEqual({ method: "get_model", session: "A" });
    expect(rb).toEqual({ method: "get_model", session: "B" });
    expect(app.seen.find((s) => s.session === "B")?.params).toEqual({ full: true });
  });

  it("sends a peer's close_project with its own session, so the app frees that session's tab only", async () => {
    const port = nextPort++;
    const a = createBridge({ port, session: "A", originAllowed: () => true, log: quiet });
    stops.push(a.stop);
    await until(() => a.role === "hub");
    const b = createBridge({ port, session: "B", originAllowed: () => true, log: quiet });
    stops.push(b.stop);
    await until(() => b.role === "peer");
    const app = fakeApp(port);
    stops.push(app.close);
    await until(async () => (await b.status()).connected);

    expect(await b.call("close_project")).toEqual({ method: "close_project", session: "B" });
    expect(app.seen.filter((s) => s.method === "close_project").map((s) => s.session)).toEqual(["B"]);
  });

  it("tells the app when a peer's session ends", async () => {
    const port = nextPort++;
    const a = createBridge({ port, session: "A", originAllowed: () => true, log: quiet });
    stops.push(a.stop);
    await until(() => a.role === "hub");
    const app = fakeApp(port);
    stops.push(app.close);
    await until(async () => (await a.status()).connected);
    const b = createBridge({ port, session: "B", originAllowed: () => true, log: quiet });
    await until(() => b.role === "peer");
    await b.stop();
    expect(app.events).toContainEqual({ event: "hub_session", session: "A" });
    await until(() => app.events.some((e) => (e as { event: string }).event === "session_ended"));
    expect(app.events).toContainEqual({ event: "session_ended", session: "B" });
  });

  it("a peer takes over when the hub exits, and the app reconnects to it", async () => {
    const port = nextPort++;
    const a = createBridge({ port, session: "A", originAllowed: () => true, log: quiet });
    await until(() => a.role === "hub");
    const b = createBridge({ port, session: "B", originAllowed: () => true, log: quiet });
    stops.push(b.stop);
    await until(() => b.role === "peer");
    const app = fakeApp(port);
    stops.push(app.close);
    await until(async () => (await b.status()).connected);
    await a.stop();
    await until(() => b.role === "hub");
    await until(async () => (await b.status()).connected);
    expect(await b.call("undo")).toEqual({ method: "undo", session: "B" });
  });

  it("takes the port over from an old server that does not know hubs", async () => {
    const port = nextPort++;
    // An old server: ignores peers, hands over (closes) when asked.
    const old = new WebSocketServer({ host: "127.0.0.1", port });
    old.on("connection", (ws) =>
      ws.on("message", (raw) => {
        if (JSON.parse(String(raw)).takeover) old.close();
      }),
    );
    await new Promise((r) => old.on("listening", r));
    const b = createBridge({ port, session: "B", originAllowed: () => true, log: quiet, welcomeMs: 200 });
    stops.push(b.stop);
    for (const c of old.clients) c.terminate();
    await until(() => b.role === "hub");
  });

  it("a request without the app connected says so", async () => {
    const port = nextPort++;
    const a = createBridge({ port, session: "A", originAllowed: () => true, log: quiet });
    stops.push(a.stop);
    await until(() => a.role === "hub");
    const b = createBridge({ port, session: "B", originAllowed: () => true, log: quiet });
    stops.push(b.stop);
    await until(() => b.role === "peer");
    await expect(a.call("get_model")).rejects.toThrow(/not connected/);
    await expect(b.call("get_model")).rejects.toThrow(/not connected/);
  });

  it("hands a newer app connection the place of the old one, and fails what waited on the old", async () => {
    const port = nextPort++;
    const a = createBridge({ port, session: "A", originAllowed: () => true, log: quiet });
    stops.push(() => a.stop());
    await until(() => a.role === "hub");
    // An app that never answers.
    const first = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => first.on("open", r));
    first.send(JSON.stringify({ hello: "meercad", version: "1", project: "P" }));
    await until(async () => (await a.status()).connected);
    const waiting = a.call("get_model", {}, 5000);
    const second = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => second.on("open", r));
    second.send(JSON.stringify({ hello: "meercad", version: "2", project: "Q" }));
    await expect(waiting).rejects.toThrow(/the meerCAD app disconnected/);
    expect((await a.status()).hello).toMatchObject({ version: "2" });
    // A request the app does not answer in time.
    await expect(a.call("get_model", {}, 50)).rejects.toThrow(/get_model timed out/);
    // An older server asking for the port is told no; the hub stays.
    const old = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => old.on("open", r));
    old.send(JSON.stringify({ takeover: "meercad" }));
    old.send("not json");
    await wait(50);
    expect(a.role).toBe("hub");
    old.close();
    second.close();
    first.close();
  });

  it("passes a peer's requests on, and tells it when the app goes away mid-request", async () => {
    const port = nextPort++;
    const a = createBridge({ port, session: "A", originAllowed: () => true, log: quiet });
    stops.push(() => a.stop());
    await until(() => a.role === "hub");
    const b = createBridge({ port, session: "B", originAllowed: () => true, log: quiet });
    stops.push(() => b.stop());
    await until(() => b.role === "peer");
    // The peer asks the hub's status itself: not connected yet.
    expect(await b.status()).toMatchObject({ role: "peer", connected: false });
    await expect(b.call("get_model")).rejects.toThrow(/not connected/);
    const app = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => app.on("open", r));
    app.send(JSON.stringify({ hello: "meercad", version: "1", project: "P" }));
    await until(async () => (await b.status()).connected);
    const waiting = b.call("get_model", {}, 5000);
    await wait(50);
    app.close();
    await expect(waiting).rejects.toThrow(/the meerCAD app disconnected/);
  });

  it("as a peer: ignores what is not JSON, and says the app is not there when the hub does not answer", async () => {
    const port = nextPort++;
    // A hub that welcomes peers but never answers their requests, after a line of noise.
    const hub = new WebSocketServer({ host: "127.0.0.1", port });
    hub.on("connection", (ws) => {
      ws.send("not json {");
      ws.send(JSON.stringify({ hub: "meercad" }));
    });
    await new Promise((r) => hub.on("listening", r));
    const b = createBridge({ port, session: "P", originAllowed: () => true, log: quiet });
    stops.push(() => b.stop());
    stops.push(() => {
      for (const c of hub.clients) c.terminate();
      return new Promise((r) => hub.close(() => r(undefined)));
    });
    // Before it has found its place it knows no app.
    expect(await b.status()).toMatchObject({ connected: false, hello: null });
    await until(async () => (await b.status()).role === "peer", 6000);
    expect(await b.status()).toEqual({ role: "peer", connected: false, hello: null });
  }, 15_000);
});

