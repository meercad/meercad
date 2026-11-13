/**
 * The connection between MCP servers and the meerCAD app. Every assistant (a chat, a coding session)
 * starts its own MCP server, but the app connects to one port only. The first server to get the port
 * is the hub: the app connects to it, and every later server connects to the hub as a peer and sends
 * its requests through it. Each request carries the session of the server that made it, so the app
 * can give every assistant its own window and document. When the hub exits, a peer takes the port
 * over and the app reconnects to it.
 */
import { WebSocket, WebSocketServer } from "ws";
import type { BridgeHello, BridgeMethod } from "./protocol.js";

/** Messages between a peer and the hub (the app never sees these). */
type PeerHello = { peer: "meercad"; session: string };
type HubWelcome = { hub: "meercad"; version: number };
/** What a peer asks the hub itself: whether the app is connected. */
const HUB_STATUS = "__hub_status";
/** Hub protocol version: a server that gets no welcome is talking to an old hub (newest-wins). */
const HUB_VERSION = 2;

export interface BridgeOptions {
  port: number;
  /** This server's session, sent with every request it makes. */
  session: string;
  originAllowed: (origin: string | undefined) => boolean;
  log: (...a: unknown[]) => void;
  /** How long a peer waits for the hub's welcome before treating it as an old server (ms). */
  welcomeMs?: number;
}

export interface BridgeStatus {
  role: "hub" | "peer" | "starting";
  connected: boolean;
  hello: BridgeHello | null;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Response = { id: number; result?: unknown; error?: string };

export const NOT_CONNECTED = "The meerCAD app is not connected. Open meerCAD and enable 'Allow assistants to control meerCAD' (plug icon in the top bar), then try again.";

export function createBridge(o: BridgeOptions) {
  const { port, session, log } = o;
  let role: BridgeStatus["role"] = "starting";
  let stopped = false;
  // As hub
  let wss: WebSocketServer | null = null;
  let app: WebSocket | null = null;
  let hello: BridgeHello | null = null;
  const peers = new Map<WebSocket, string>();
  /** Requests of peers on their way to the app: the hub's id → the peer and its own id. */
  const relayed = new Map<number, { peer: WebSocket; id: number }>();
  // As peer
  let upstream: WebSocket | null = null;
  // Own requests
  let seq = 0;
  const pending = new Map<number, Pending>();
  let retry: NodeJS.Timeout | undefined;

  const later = (fn: () => void, ms: number) => {
    if (stopped) return;
    clearTimeout(retry);
    retry = setTimeout(fn, ms);
    retry.unref();
  };
  const settle = (msg: Response) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (typeof msg.error === "string") p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  };
  const failAll = (why: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
      pending.delete(id);
    }
  };
  /** Everything waiting on the app, here and at peers, fails. */
  const appGone = () => {
    failAll("the meerCAD app disconnected");
    for (const [id, r] of relayed) {
      relayed.delete(id);
      if (r.peer.readyState === r.peer.OPEN) r.peer.send(JSON.stringify({ id: r.id, error: "the meerCAD app disconnected" }));
    }
  };

  function start(): void {
    if (stopped) return;
    const server = new WebSocketServer({ host: "127.0.0.1", port, verifyClient: ({ origin }: { origin?: string }) => o.originAllowed(origin) });
    server.on("listening", () => {
      role = "hub";
      wss = server;
      log(`waiting for the meerCAD app on ws://127.0.0.1:${port}`);
    });
    server.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        server.close();
        join();
        return;
      }
      /* v8 ignore next -- other listen errors (no permission) do not happen on 127.0.0.1 */
      log(`bridge error: ${e.message}`);
    });
    server.on("connection", onConnection);
  }

  /** Another server holds the port: send requests through it. */
  function join(): void {
    if (stopped) return;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let welcomed = false;
    // An old server (newest wins) never welcomes: ask it to hand over, then take the port.
    const old = setTimeout(() => {
      if (welcomed || ws.readyState !== ws.OPEN) return;
      log(`port ${port} is held by an older meerCAD MCP server; asking it to hand over`);
      ws.send(JSON.stringify({ takeover: "meercad" }));
      ws.close();
    }, o.welcomeMs ?? 1500);
    ws.on("open", () => ws.send(JSON.stringify({ peer: "meercad", session } satisfies PeerHello)));
    ws.on("message", (raw) => {
      let msg: Response | HubWelcome;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if ("hub" in msg) {
        welcomed = true;
        clearTimeout(old);
        role = "peer";
        upstream = ws;
        log(`another meerCAD MCP server holds port ${port}; requests go through it`);
        return;
      }
      settle(msg);
    });
    ws.on("close", () => {
      clearTimeout(old);
      if (upstream === ws) {
        upstream = null;
        failAll("The connection to meerCAD was interrupted (another assistant session ended). Try again.");
      }
      if (role === "peer" || !welcomed) role = "starting";
      // The hub went away (or handed over): try to become the hub, else join the next one.
      later(start, 200 + Math.random() * 300);
    });
    ws.on("error", () => undefined);
  }

  function onConnection(ws: WebSocket): void {
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg["takeover"]) {
        // An older server wants the port; this one keeps it (it serves everyone).
        log("an older meerCAD MCP server asked for the port; it stays here and serves all sessions");
        return;
      }
      if (msg["peer"] === "meercad" && typeof msg["session"] === "string") {
        peers.set(ws, msg["session"]);
        ws.send(JSON.stringify({ hub: "meercad", version: HUB_VERSION } satisfies HubWelcome));
        return;
      }
      if (msg["hello"] === "meercad") {
        if (app && app !== ws) {
          app.close(4000, "replaced by a newer connection");
          // What waited on the old connection is never answered: fail it now, not at its timeout.
          appGone();
        }
        app = ws;
        hello = msg as unknown as BridgeHello;
        log(`app connected (project: ${hello.project ?? "none"})`);
        // The app learns this server's session, to free its window when this connection ends.
        ws.send(JSON.stringify({ event: "hub_session", session }));
        return;
      }
      const peerSession = peers.get(ws);
      if (peerSession !== undefined) return relay(ws, peerSession, msg);
      if (ws === app && typeof msg["id"] === "number") {
        const r = relayed.get(msg["id"]);
        if (r) {
          relayed.delete(msg["id"]);
          if (r.peer.readyState === r.peer.OPEN) r.peer.send(JSON.stringify({ ...msg, id: r.id }));
          return;
        }
        settle(msg as unknown as Response);
      }
    });
    ws.on("close", () => {
      if (peers.has(ws)) {
        const s = peers.get(ws)!;
        peers.delete(ws);
        for (const [id, r] of relayed) if (r.peer === ws) relayed.delete(id);
        // The app may free that session's window.
        if (app?.readyState === app?.OPEN) app?.send(JSON.stringify({ event: "session_ended", session: s }));
      }
      if (app === ws) {
        app = null;
        hello = null;
        appGone();
      }
    });
  }

  /** A peer's request: answered here (hub status) or passed on to the app under the hub's own id. */
  function relay(peer: WebSocket, peerSession: string, msg: Record<string, unknown>): void {
    const id = msg["id"];
    if (typeof id !== "number") return;
    if (msg["method"] === HUB_STATUS) return void peer.send(JSON.stringify({ id, result: { connected: !!app, hello } }));
    if (!app || app.readyState !== app.OPEN) return void peer.send(JSON.stringify({ id, error: NOT_CONNECTED }));
    const own = ++seq;
    relayed.set(own, { peer, id });
    app.send(JSON.stringify({ ...msg, id: own, session: peerSession }));
  }

  function call<T = unknown>(method: BridgeMethod | typeof HUB_STATUS, params: Record<string, unknown> = {}, timeoutMs = 60_000, client = "Assistant"): Promise<T> {
    let target: WebSocket | null = null;
    if (role === "hub") {
      if (method === HUB_STATUS) return Promise.resolve({ connected: !!app, hello } as T);
      target = app;
      if (!target || target.readyState !== target.OPEN) return Promise.reject(new Error(NOT_CONNECTED));
    } else if (role === "peer") target = upstream;
    if (!target || target.readyState !== target.OPEN) return Promise.reject(new Error("Connecting to meerCAD (another assistant session just ended). Try again in a moment."));
    const id = ++seq;
    const ws = target;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      // tabs: this server knows params.project, so the app may give the session a tab per project.
      ws.send(JSON.stringify({ id, method, params, client, session, tabs: "project" }));
    });
  }

  async function status(): Promise<BridgeStatus> {
    if (role === "hub") return { role, connected: !!app, hello };
    if (role === "peer") {
      try {
        const s = await call<{ connected: boolean; hello: BridgeHello | null }>(HUB_STATUS, {}, 3000);
        return { role, ...s };
      } catch {
        return { role, connected: false, hello: null };
      }
    }
    return { role, connected: false, hello: null };
  }

  function stop(): Promise<void> {
    stopped = true;
    clearTimeout(retry);
    upstream?.close();
    for (const c of wss?.clients ?? []) c.terminate();
    return new Promise((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  }

  start();
  return { call, status, stop, get role() {
    return role;
  } };
}
