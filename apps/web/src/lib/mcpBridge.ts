/**
 * Connects the app to a local meerCAD MCP server so assistants like Claude can drive it. The app is
 * the WebSocket client; the server only listens on 127.0.0.1 and checks the page origin.
 */
import { layoutSheet, writeDxf, writeSheetDxf, writeSheetPdf, writeSheetSvg, writeSvg, type Paper, type RobotActuator } from "@meercad/io";
import type { RebuildOutput } from "@meercad/kernel/client";
import { ASSISTANT_IDLE_MS, DEFAULT_PORT, PROJECT_PARAM, ago, STAGE_KEEP_MS, chooseTab, exportTransport, mayTakeOver, newTabKey, openBlock, openBlockMessage, tabOfSession, type BridgeEvent, type BridgeRequest, type ExportedFiles, type FilePiece } from "@meercad/mcp";
import { resolveEdges, resolveFaces } from "@meercad/naming";
import { applyOp, billOfMaterials, designOf, documentMaterials, drawingDocument, massOf, massProperties, partMaterial, versionFile, withMotion } from "@meercad/model";
import type { ViewName } from "@meercad/kernel/client";
import { partName } from "./features";
import { emptyDocument, type DocOp, type EdgeSelector, type FaceSelector, type MeercadDocument } from "@meercad/schema";
import { filamentsOf, openInSlicer, robotFiles, sketchCurves, usdzFile } from "../components/io";
import * as tools from "./mcpTools";
import { requireTerms } from "./termsStore";
import { clientLabel } from "./mcpClient";
import { asTestProjects, assistantWindow, desktop, isTestProject, type AssistantTab } from "./persistence";
import { apply, currentDoc, flushSave, getViewport, goHome, handOverAssistantTab, kernel, newProject, openProject, rebuildNow, redo, refreshProjects, releaseProject, scheduleRebuild, setAssistantTabs, showAssistantTab, undo, useApp } from "../store";
import type { StandardView } from "@meercad/viewport";
import { checkMotion, checkMotionRun, clearanceNow, motionById, playMotion, setPose, stopPlaying, sweepCheck, type SweepJoint } from "./mechanism";
import { jointRange, renderMotionGif, renderMotionSheet, renderShot, type Shot } from "./render";
import { meshTopology } from "./topology";

type Status = "off" | "connecting" | "connected";
let socket: WebSocket | null = null;
let retry: number | undefined;
let wanted = false;
/** When this app lost the connection to another meerCAD app recently. */
let replaced: number[] = [];
const listeners = new Set<(s: Status) => void>();
let status: Status = "off";
/** The window's page holds the connection; the assistants' tabs show its state and ask it to switch. */
const hostWindow = !assistantWindow;
const setStatus = (s: Status) => {
  status = s;
  for (const fn of listeners) fn(s);
  if (hostWindow) desktop?.mcp?.status(s);
};
export const bridgeStatus = () => status;
export const onBridgeStatus = (fn: (s: Status) => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function setBridgeEnabled(on: boolean, remember = true): void {
  // An assistant's tab gets its requests from the window's page, never over its own connection; it
  // switches the page's connection (the main process opens the window again if it was closed).
  if (!hostWindow) return void desktop?.mcp?.setEnabled(on);
  wanted = on;
  if (remember)
    try {
      localStorage.setItem("meercad.mcp", on ? "1" : "0");
    } catch {
      // preference not persisted
    }
  if (!on) unlock();
  if (on) connect();
  else {
    clearTimeout(retry);
    socket?.close();
    socket = null;
    setStatus("off");
  }
}

/** Set once the bridge is started: React's development mode runs the effect that starts it twice. */
let bridgeStarted = false;

export function initBridge(): void {
  if (bridgeStarted) return;
  bridgeStarted = true;
  if (!hostWindow && desktop?.mcp) {
    desktop.on("mcp-status", setStatus);
    void desktop.mcp.hostStatus().then(setStatus);
  }
  if (assistantWindow) return initAssistantWindow();
  // A test run's window (MEERCAD_MCP_BRIDGE=off) never talks to assistants.
  if (new URLSearchParams(location.search).get("bridge") === "off") return;
  initUserWindow();
  // An assistant's tab switched assistants on or off.
  desktop?.on("mcp-set-enabled", (on) => setBridgeEnabled(on));
  let pref: string | null = null;
  try {
    pref = localStorage.getItem("meercad.mcp");
  } catch {
    pref = null;
  }
  // The Mac app is ready for assistants out of the box (the iPad app has no assistants).
  if (pref !== "0" && (window as { meercadDesktop?: unknown }).meercadDesktop) setBridgeEnabled(true);
  // Tells the main process (and with it the assistants' tabs) the state, and that this page can take requests to switch.
  else desktop?.mcp?.status(status);
}

/**
 * The bridge port: this desktop build's own (the RC, the WIP and the store release each have one,
 * see CHANNEL_PORTS), or for a test run the one in sessionStorage "meercad.mcp.port" (a server
 * started with MEERCAD_MCP_PORT). Session storage, so a test override never outlives the window.
 */
function bridgePort(): number {
  try {
    const p = Number(sessionStorage.getItem("meercad.mcp.port"));
    if (Number.isInteger(p) && p > 1024 && p < 65536) return p;
  } catch {
    // default
  }
  return desktop?.mcpPort ?? DEFAULT_PORT;
}

function connect(): void {
  if (!wanted || socket) return;
  setStatus("connecting");
  const ws = new WebSocket(`ws://127.0.0.1:${bridgePort()}`);
  socket = ws;
  ws.onopen = () => {
    connectionSession = `connection-${Date.now().toString(36)}`;
    setStatus("connected");
    ws.send(JSON.stringify({ hello: "meercad", version: "0.1.0", project: useApp.getState().project?.name ?? null }));
  };
  ws.onclose = (e) => {
    socket = null;
    // The server this page talked to has gone: its session has ended (the others reconnect), its tab is the user's now.
    for (const ended of [hubSession, connectionSession]) {
      if (!ended) continue;
      void handOverSession(ended);
    }
    hubSession = null;
    connectionSession = "";
    if (!wanted) return setStatus("off");
    setStatus("connecting");
    // Another meerCAD app (e.g. the WIP build next to the release) took the connection: take it back
    // only when this one is used again, instead of the two swapping it every few seconds.
    if (e.code === 4000) {
      const now = Date.now();
      replaced = replaced.filter((t) => now - t < 30_000).concat(now);
      // Older builds grab it back unconditionally; after a few swaps, wait for the next focus.
      if (document.hasFocus() && replaced.length < 3) retry = window.setTimeout(connect, 2000);
      else window.addEventListener("focus", () => connect(), { once: true });
      return;
    }
    retry = window.setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = async (e) => {
    const msg = JSON.parse(String(e.data)) as BridgeRequest | BridgeEvent;
    if ("event" in msg) {
      if (msg.event === "hub_session") hubSession = msg.session;
      if (msg.event === "session_ended") void handOverSession(msg.session);
      return;
    }
    try {
      const result = await route(msg);
      if (socket === ws) ws.send(JSON.stringify({ id: msg.id, result }));
    } catch (err) {
      if (socket === ws) ws.send(JSON.stringify({ id: msg.id, error: errorText(err) }));
    }
  };
}

/** An error's message, without what Electron adds to errors from another window. */
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/**
 * A request that may create a project: without `keep`, the WIP build keeps it in its test folder
 * (see asTestProjects), and the answer says so.
 */
async function created(p: Record<string, unknown>, fn: () => Promise<unknown>): Promise<unknown> {
  const r = await asTestProjects(p["keep"] !== true, fn);
  const id = useApp.getState().project?.id;
  if (!id || !isTestProject(id) || !r || typeof r !== "object") return r;
  return { ...r, note: "This is a test project: it is saved in the WIP build's own test folder, not in the user's projects, and goes after a week. Call again with keep: true (or move_project) to put a project into the user's projects." };
}

/** Requests that open a project for the session: where they open decides where the session works. */
const OPENS = new Set(["open_project", "new_project", "open_example"]);
/** The session of the MCP server this page is connected to (the hub). */
let hubSession: string | null = null;
/** Requests from older MCP servers carry no session: the connection stands for one. */
let connectionSession = "";

/** A session's MCP server went: all of its tabs (one per project, see PROJECT_PARAM) go back to the user. */
async function handOverSession(session: string): Promise<void> {
  const keys = new Set([session, ...((await desktop?.assistant?.tabs()) ?? []).map((t) => t.session).filter((k) => tabOfSession(k, session))]);
  await Promise.all([...keys].map((k) => handOverAssistantTab(k)));
}

/** Keys of tabs being opened right now: two opens at once must not pick the same one. */
const opening = new Set<string>();
/** The tab key a session last opened a project in, by session and by session + project (for the answers after a tab went). */
const lastTab = new Map<string, string>();
/** When each tab (by key) last got a request: the refusal of a second open says how long ago. */
const lastCall = new Map<string, number>();

/** A tab named for the assistant: the project and its id. */
const tabLabel = (t: AssistantTab) => `"${t.name ?? t.project ?? "nothing yet"}"${t.project ? ` (id "${t.project}")` : ""}`;

/** Requests that need no project: with several tabs and no project named, the user's page answers them. */
const PROJECTLESS = new Set(["get_status", "list_projects", "list_folders", "list_examples", "read_file", "write_file"]);

/**
 * Where a request is served. On the Mac every assistant session (one MCP server each) works in a
 * tab of its own (a page of its own inside the window, locked for the user) and never in the
 * user's: opening a project opens that tab (without bringing it to the front), and from then on
 * the session's requests go there. A project the user has open in a tab goes over to the
 * assistant's tab (saved first). Before a session has opened anything, only lookups are answered.
 *
 * One MCP server may serve several chats at once (Claude Desktop starts one for all of them). A
 * current server (`tabs: "project"`) gets a tab per project: each request names its project
 * (PROJECT_PARAM) and goes to that tab, so one chat opening a project never moves another chat's
 * calls over to it. Older servers keep one tab per session, whose project an open replaces.
 */
async function route(req: BridgeRequest): Promise<unknown> {
  // Before the user has accepted the terms of use, no assistant tab opens and nothing is answered.
  requireTerms();
  const a = desktop?.assistant;
  const named = req.params[PROJECT_PARAM];
  const project = typeof named === "string" && named ? named : undefined;
  const { [PROJECT_PARAM]: _named, ...params } = req.params;
  if (!a) return serve({ ...req, params });
  const session = req.session ?? connectionSession;
  const perProject = req.tabs === "project";
  req = { ...req, session, params };
  const client = clientLabel(req.client);
  const tabs = await a.tabs();
  const mine = tabs.filter((t) => tabOfSession(t.session, session));
  /** Opens (or reuses) the tab `key` and serves the request there; the answer names the project for later calls. */
  const openIn = async (key: string, before?: () => Promise<void>, front = false) => {
    opening.add(key);
    lastCall.set(key, Date.now());
    try {
      await before?.();
      const tab = await a.open({ session: key, client });
      if (front) showAssistantTab(key);
      const result = await a.call(tab, req);
      const now = (await a.tabs()).find((t) => t.session === key);
      if (now?.project) {
        lastTab.set(session, key);
        lastTab.set(`${session}\n${now.project}`, key);
      }
      if (!perProject || !now?.project || !result || typeof result !== "object" || Array.isArray(result)) return result;
      const r = result as Record<string, unknown>;
      return { ...r, ...("project" in r ? {} : { project: { id: now.project, name: now.name } }), ...(mine.some((t) => t.session !== key) ? { hint: `You have more than one project open now: pass project: "${now.project}" with every call for this one.` } : {}) };
    } finally {
      opening.delete(key);
    }
  };
  // A tab of the session left without a project (an open that failed) is reused.
  const freshKey = () => (perProject ? (mine.find((t) => t.project === null && !opening.has(t.session))?.session ?? newTabKey(session, [...tabs.map((t) => t.session), ...opening])) : session);
  // Importing a design opens it as a new project, like new_project.
  if (OPENS.has(req.method) || (req.method === "import_file" && /\.(meercad|json)$/i.test(String(req.params["name"] ?? "")))) {
    const id = req.method === "open_project" ? String(req.params["id"]) : undefined;
    const holder = id === undefined ? undefined : tabs.find((x) => x.project === id && !tabOfSession(x.session, session));
    if (holder) {
      const since = lastCall.get(holder.session);
      const may = mayTakeOver(holder.client === client, since === undefined ? undefined : Date.now() - since);
      if (req.params["takeover"] === true && may) await handOverAssistantTab(holder.session, true, "released");
      else {
        const hint = may ? ` If that is your own session from before a lost connection, open_project with takeover: true takes the project over.` : "";
        throw new Error(`${holder.client} is working on this project in its own meerCAD tab right now${since ? ` (last call ${ago(Date.now() - since)} ago)` : ""}. Pick another project, or wait until it is done: the project is freed when that session calls close_project, after ${Math.round(LOCK_RELEASE_MIN)} minutes without a call, or when the user clicks Take over in its tab.${hint}`);
      }
    }
    // One project at a time per session: the chats sharing a session cannot be told apart (see openBlock).
    const block = openBlock(tabs, session, opening, id);
    if (block) {
      const since = "tab" in block ? lastCall.get(block.tab.session) : undefined;
      throw new Error(openBlockMessage(block, since === undefined ? undefined : Date.now() - since, ASSISTANT_IDLE_MS));
    }
    if (id === undefined) return openIn(freshKey());
    const key = perProject ? freshKey() : session;
    // The user's tab of it closes: a project is open in one tab only. Was it the one in front, the assistant's tab comes to the front instead.
    const s = useApp.getState();
    const front = s.screen === "editor" && s.project?.id === id;
    return openIn(
      key,
      async () => {
        if (s.project?.id === id || s.tabs.some((x) => x.id === id)) await releaseProject(id);
      },
      front,
    );
  }
  const pick = chooseTab(tabs, session, perProject ? project : undefined);
  if ("several" in pick) {
    if (PROJECTLESS.has(req.method)) {
      const r = await serve(req);
      return req.method === "get_status" && r && typeof r === "object" ? { ...r, project: null, tab: "several: pass project with your calls", projects: pick.several.map((t) => ({ id: t.project, name: t.name })) } : r;
    }
    throw new Error(`You have ${pick.several.length} projects open in meerCAD tabs of yours: ${pick.several.map(tabLabel).join(", ")}. Pass project: "<id>" with the call to say which one it is for.`);
  }
  // With no tab to go to: the one it had (its answer says why it went).
  const key = "tab" in pick ? pick.tab.session : "project" in pick ? lastTab.get(`${session}\n${pick.project}`) : (lastTab.get(session) ?? session);
  const tab = key ? await a.windowOf(key) : null;
  if (req.method === "close_project") {
    if (typeof tab !== "number" || !("tab" in pick)) return { closed: false, note: "project" in pick ? `Project "${pick.project}" is not open in a meerCAD tab of yours: nothing to close.` : "This session has no project open: nothing to close." };
    await handOverAssistantTab(pick.tab.session, true, "released");
    return { closed: true, project: pick.tab.project ? { id: pick.tab.project, name: pick.tab.name } : null, note: "Saved and handed back to the user: it is open, unlocked, in a tab of theirs. open_project to work on it again." };
  }
  if (typeof tab === "number" && "tab" in pick) {
    lastCall.set(pick.tab.session, Date.now());
    return a.call(tab, req);
  }
  if (tab === "idle") throw new Error(`Your meerCAD tab went back to the user after ${Math.round(LOCK_RELEASE_MIN)} minutes without a request, so they can work on the project. Open it again (open_project) to go on; the user may have changed it meanwhile.`);
  if (tab === "closed") throw new Error("The user took the project over or closed your meerCAD tab. Open the project again (open_project) to go on, or ask the user first.");
  if ("project" in pick) {
    if (PROJECTLESS.has(req.method)) return serve(req);
    throw new Error(`Project "${pick.project}" is not open in a meerCAD tab of yours. Open it first (open_project)${mine.length ? `; yours are ${mine.map(tabLabel).join(", ")}` : ""}.`);
  }
  if (READS.has(req.method)) return serve(req);
  const front = useApp.getState().screen === "editor" ? useApp.getState().project : null;
  throw new Error(`Open the project to work on first (open_project, new_project or open_example): it opens in a meerCAD tab of your own, the user keeps working in theirs.${front ? ` The user has "${front.name}" open (id "${front.id}"); open_project with that id moves it over to your tab.` : ""}`);
}

/** The window's page keeps the assistants' tabs in its tab strip and hands a tab over when asked. */
function initUserWindow(): void {
  const a = desktop?.assistant;
  if (!a || !desktop) return;
  desktop.on("assistant-tabs", setAssistantTabs);
  void a.tabs().then(setAssistantTabs);
  // The Take over button in an assistant's tab.
  desktop.on("assistant-stop", (session: string) => void handOverAssistantTab(session));
  // A tab whose session has made no request for a while (main process, see ASSISTANT_IDLE_MS).
  desktop.on("assistant-idle", (session: string) => void handOverAssistantTab(session, true, "idle"));
}

/** In this page: shows who is working, and locks the app while the request changes things. */
async function serve(req: BridgeRequest): Promise<unknown> {
  // Nothing for the assistant before the user has accepted the terms of use.
  requireTerms();
  const client = clientLabel(req.client);
  const locks = !READS.has(req.method);
  // Lookups an assistant makes before opening its own tab do not flash in the user's.
  if (locks || assistantWindow || !desktop?.assistant) showActivity(client, req.method);
  const gen = lockGen;
  if (locks) lock(client);
  try {
    return await handle(req);
  } finally {
    if (locks && gen === lockGen) release();
  }
}

/**
 * An assistant session's own tab: requests come from the window's page (through the main
 * process); the main process learns which project it has open and whether it is working.
 */
function initAssistantWindow(): void {
  const a = desktop?.assistant;
  if (!a || !desktop) return;
  desktop.on("bridge-request", ({ callId, req }) => {
    serve(req as BridgeRequest).then(
      (result) => a.respond({ callId, result }),
      (err: unknown) => a.respond({ callId, error: errorText(err) }),
    );
  });
  // The user takes the tab over (or the session ended): the project is saved before the page goes.
  desktop.on("release-project", ({ callId }) => void flushSave(true).finally(() => a.released(callId)));
  let shown = "";
  let work = "";
  const report = () => {
    const s = useApp.getState();
    document.title = `${s.project?.name ?? "meerCAD"} · ${assistantWindow!.client}`;
    const project = s.project ? JSON.stringify([s.project.id, s.project.name]) : "";
    if (project !== shown) {
      shown = project;
      a.project(s.project ? { id: s.project.id, name: s.project.name } : null);
    }
    const busy = { busy: !!s.aiLock, tool: s.aiLock ? (s.aiActivity?.tool ?? null) : null };
    if (JSON.stringify(busy) !== work) {
      work = JSON.stringify(busy);
      a.busy(busy);
    }
  };
  useApp.subscribe(report);
  report();
  a.ready();
}

/** Minutes after which an idle assistant's tab goes back to the user (in its answer). */
const LOCK_RELEASE_MIN = ASSISTANT_IDLE_MS / 60_000;

/** Requests that only look things up: they do not lock the app. */
const READS = new Set(["status", "get_status", "get_version", "list_projects", "list_folders", "list_examples", "list_materials", "read_file", "write_file"]);
/** How long the app stays locked after the assistant's last request: it often thinks a while between two. */
export const LOCK_IDLE_MS = 12_000;
let running = 0;
/** Counts unlocks, so a request that ends after the user stopped the assistant does not count down. */
let lockGen = 0;
let lockTimer: number | undefined;
function lock(client: string): void {
  running++;
  clearTimeout(lockTimer);
  if (useApp.getState().aiLock?.client !== client) useApp.setState({ aiLock: { client } });
}
function release(): void {
  running = Math.max(0, running - 1);
  if (running) return;
  clearTimeout(lockTimer);
  lockTimer = window.setTimeout(unlock, LOCK_IDLE_MS);
}
function unlock(): void {
  lockGen++;
  running = 0;
  clearTimeout(lockTimer);
  if (useApp.getState().aiLock) useApp.setState({ aiLock: null });
}

/**
 * The user ends the assistant's editing. In an assistant's tab the user takes the tab over (the
 * other sessions go on); elsewhere (the web app) the app is free again and the assistant is
 * disconnected until it is allowed again with the plug icon (next start it is connected as before).
 */
export function stopAssistant(): void {
  if (assistantWindow) return void desktop?.assistant?.stop();
  setBridgeEnabled(false, false);
  clearTimeout(activityTimer);
  useApp.setState({ aiActivity: null });
}

// While an assistant works, keys do nothing in the app (registered before any other key handler),
// except on the bar that offers to stop it. An assistant's tab is the assistant's: always locked.
for (const type of ["keydown", "keyup"] as const)
  window.addEventListener(
    type,
    (e) => {
      if (!useApp.getState().aiLock && !assistantWindow) return;
      if (e.target instanceof Element && e.target.closest(".ai-lock-bar, .assistant-bar")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );

let activityTimer: number | undefined;
function showActivity(client: string, tool: string): void {
  useApp.setState({ aiActivity: { client, tool, at: Date.now() } });
  clearTimeout(activityTimer);
  activityTimer = window.setTimeout(() => useApp.setState({ aiActivity: null }), 4000);
}

/** A step's numbers for the assistant (e.g. a bend's turns and size), rounded; directions left out. */
function reportInfo(info: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(info).filter(([k]) => !/^[oa][xyz]$/.test(k)).map(([k, v]) => [k, +v.toFixed(3)]));
}

type BodyKey = string;
/** A body as compared between two rebuilds (rounded like the report). */
const bodyKey = (b: RebuildOutput["report"]["bodies"][number]): BodyKey => `${b.volume.toFixed(3)}|${b.bbox.min.map((v) => v.toFixed(3))}|${b.bbox.max.map((v) => v.toFixed(3))}|${b.faces}`;

/**
 * What changed since `before` (the rebuild before an edit): only the steps that are not ok or say
 * something, new or changed bodies, sketches of the edited steps (and any not solved), the joints
 * the ops set or that broke, the params when the ops changed one. The full summary of a big design runs to thousands of lines; this keeps the
 * answer to an edit about the edit. `touched`: ids of the steps the ops added or changed.
 */
function briefSummary(out: RebuildOutput, before: RebuildOutput | null | undefined, touched: Set<string>, shown: Shown) {
  const full = summary(out);
  const prev = new Map((before?.report.bodies ?? []).map((b) => [b.id, bodyKey(b)]));
  const changed = new Set(out.report.bodies.filter((b) => prev.get(b.id) !== bodyKey(b)).map((b) => b.id));
  const gone = [...prev.keys()].filter((id) => !out.report.bodies.some((b) => b.id === id));
  // Steps switched off (or after the rollback bar) are only named when the ops were about them:
  // a big design has a hundred of them, the same in every answer.
  const quiet = (f: { status: string }) => f.status === "ok" || f.status === "suppressed" || f.status === "rolled_back";
  const features = full.features.filter((f) => !quiet(f) || "info" in f || "hint" in f || touched.has(f.id));
  const off = full.features.filter((f) => f.status === "suppressed" || f.status === "rolled_back").length;
  const sketches = full.sketches.filter((s) => !s.ok || touched.has(s.id));
  const { joints: allJoints, params, ...rest } = full;
  // Joints the ops set (or all, after a replace), and any that broke.
  const joints = allJoints?.filter((j) => shown.all || shown.ids.has(j.id) || "error" in j);
  return {
    ...rest,
    // Params only when the ops changed one: they are in get_model, and the assistant knows what it set.
    ...(shown.params ? { params } : {}),
    features,
    featuresOk: full.features.filter((f) => f.status === "ok").length,
    ...(off ? { featuresOff: off } : {}),
    bodies: full.bodies.filter((b) => changed.has(b.id)),
    unchangedBodies: full.bodies.length - changed.size,
    ...(gone.length ? { removedBodies: gone } : {}),
    sketches,
    ...(joints?.length ? { joints } : {}),
  };
}

/** What the brief result shows beyond the steps: the joints the ops set (all of them after a replace, coupling or motion) and the params when the ops changed one. */
interface Shown {
  ids: Set<string>;
  all: boolean;
  params: boolean;
}

/** Ids of the steps a list of ops adds or edits, and what else the brief result shows (see Shown). */
function touchedBy(ops: readonly DocOp[]): { ids: Set<string>; shown: Shown } {
  const ids = new Set<string>();
  const shown: Shown = { ids: new Set(), all: false, params: false };
  for (const op of ops) {
    if (op.type === "add_features") for (const f of op.features) ids.add(f.id);
    else if (op.type === "edit_feature" || op.type === "delete_feature" || op.type === "move_feature") ids.add(op.id);
    else if (op.type === "replace") shown.all = shown.params = true;
    else if (op.type === "set_joint") shown.ids.add(op.joint.id);
    else if (op.type === "set_coupling" || op.type === "set_motion") shown.all = true;
    if (/param|variant|version|fit|units/.test(op.type)) shown.params = true;
  }
  return { ids, shown };
}

/** The brief result after undo or redo: what is not ok, and the bodies that changed. */
const briefAfter = (out: RebuildOutput, before: RebuildOutput | null | undefined) => briefSummary(out, before, new Set(), { ids: new Set(), all: false, params: !before });

/**
 * The answer to opening a project: how big it is and what is not in order. The parts and steps
 * themselves are in get_model (a big design's parts alone ran to a hundred thousand characters here).
 */
function openSummary(out: RebuildOutput) {
  const { bodies, unchangedBodies: _u, params: _p, ...rest } = briefSummary(out, out, new Set(), { ids: new Set(), all: false, params: false });
  void bodies;
  return { project: useApp.getState().project, ...rest, parts: out.report.bodies.length, note: "get_model lists the steps, parts and params." };
}

/** Ops that only file the design away or rename what was filed: the model itself stays as it is. */
const VERSION_OPS = new Set(["save_version", "rename_version", "delete_version"]);

function summary(out: RebuildOutput) {
  const r = out.report;
  const doc = useApp.getState().doc;
  const mat = (id: string) => partMaterial(doc, id);
  const total = massProperties(r.bodies.map((b) => ({ volume: b.volume, ...(b.centroid ? { centroid: b.centroid } : {}), ...(b.inertia ? { inertia: b.inertia } : {}), ...(mat(b.id) ? { material: mat(b.id)! } : {}) })));
  return {
    features: r.features.map((f) => ({ id: f.id, status: f.status, ...(f.message ? { message: f.message } : {}), ...(f.hint ? { hint: f.hint } : {}), ...(f.info ? { info: reportInfo(f.info) } : {}) })),
    params: r.params,
    ...(Object.keys(r.paramErrors).length ? { paramErrors: r.paramErrors } : {}),
    bodies: r.bodies.map((b) => ({
      id: b.id,
      volume: +b.volume.toFixed(3),
      area: +b.area.toFixed(3),
      faces: b.faces,
      bbox: { min: b.bbox.min.map((v) => +v.toFixed(3)), max: b.bbox.max.map((v) => +v.toFixed(3)) },
      ...(b.centroid ? { centroid: b.centroid.map((v) => +v.toFixed(3)) } : {}),
      ...(mat(b.id) && Number.isFinite(b.volume) ? { material: mat(b.id)!.id, massGrams: +massOf(b.volume, mat(b.id)!).toFixed(2) } : {}),
    })),
    ...(total.mass ? { mass: { grams: +total.mass.toFixed(2), centreOfGravity: total.center?.map((v) => +v.toFixed(3)), ...(total.inertia ? { inertiaGmm2: { about: "centre of gravity, axes parallel to X/Y/Z", Ixx: +total.inertia[0].toFixed(2), Iyy: +total.inertia[1].toFixed(2), Izz: +total.inertia[2].toFixed(2), Ixy: +total.inertia[3].toFixed(2), Ixz: +total.inertia[4].toFixed(2), Iyz: +total.inertia[5].toFixed(2) } } : {}), partsWithoutMaterial: total.missing } } : {}),
    sketches: r.sketches.map((s) => ({ id: s.id, dof: s.diagnostics.dof, ok: s.diagnostics.ok, regions: s.regions.map((g) => g.key) })),
    ...(r.joints.length ? { joints: r.joints.map((j) => ({ id: j.id, ...(j.error ? { error: j.error } : { origin: j.origin.map((v) => +v.toFixed(3)), axis: j.axis.map((v) => +v.toFixed(4)) }) })) } : {}),
    ...(r.gears.length ? { gears: r.gears.map((g) => ({ ...g, radius: Number.isFinite(g.radius) ? +g.radius.toFixed(4) : null, origin: g.origin.map((v) => +v.toFixed(3)), axis: g.axis.map((v) => +v.toFixed(4)) })) } : {}),
  };
}

/** The rebuild in get_model: steps that are ok are counted, not listed (the document lists them). */
function modelSummary(out: RebuildOutput) {
  const full = summary(out);
  return { ...full, features: full.features.filter((f) => f.status !== "ok" || "info" in f || "hint" in f), featuresOk: full.features.filter((f) => f.status === "ok").length };
}

/** Picture options from a tool call (render_view, render_motion). */
function shotOf(p: Record<string, unknown>): Shot {
  const planes: Record<string, [number, number, number]> = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
  const sec = p["section"] as { plane?: string; normal?: [number, number, number]; offset?: number } | undefined;
  const normal = sec ? (sec.normal ?? planes[sec.plane ?? ""]) : undefined;
  if (sec && !normal) throw new Error('section needs plane "XY", "XZ" or "YZ", or a normal');
  return {
    ...(p["width"] !== undefined ? { width: Number(p["width"]) } : {}),
    ...(p["height"] !== undefined ? { height: Number(p["height"]) } : {}),
    ...(typeof p["view"] === "string" ? { view: p["view"] as StandardView } : {}),
    ...(Array.isArray(p["direction"]) ? { direction: p["direction"] as [number, number, number] } : {}),
    ...(Array.isArray(p["focus"]) ? { focus: p["focus"] as string[], isolate: !!p["isolate"] } : {}),
    ...(normal ? { section: { normal, offset: sec?.offset ?? 0 } } : {}),
    ...(p["highlight"] ? { highlight: p["highlight"] as Shot["highlight"] & object } : {}),
    ...(p["style"] === "rendered" ? { rendered: true } : {}),
    ...(p["frame"] && typeof p["frame"] === "object" ? { box: p["frame"] as { min: [number, number, number]; max: [number, number, number] } } : {}),
  };
}

function needProject(): void {
  if (!useApp.getState().project) throw new Error("No project is open. Call list_projects / open_project or new_project first.");
}

const toB64 = (u: Uint8Array | string) => {
  const bytes = typeof u === "string" ? new TextEncoder().encode(u) : u;
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Big exports waiting for the server to fetch them piece by piece (staged_files), by token. */
const staged = new Map<string, { files: Record<string, Uint8Array>; timer: number }>();
const keepStaged = (token: string) => window.setTimeout(() => staged.delete(token), STAGE_KEEP_MS);

/**
 * An export's files for the server: base64 in the answer, or above STAGE_OVER bytes kept here for
 * staged_files, since one message over the bridge may not hold hundreds of MB.
 */
function exportedFiles(files: Record<string, Uint8Array | string>, p: Record<string, unknown>): ExportedFiles {
  const bytes = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? new TextEncoder().encode(v) : v]));
  const total = Object.values(bytes).reduce((n, b) => n + b.length, 0);
  const how = exportTransport(total, p["stage"] === true);
  if (how === "inline") return { files: Object.fromEntries(Object.entries(bytes).map(([k, v]) => [k, toB64(v)])) };
  if (how === "too_big")
    throw new Error(
      `this export is ${Math.round(total / 1e6)} MB, too big for the meerCAD MCP server that is running: it is older than this app. Quit and reopen the assistant app (e.g. Claude Desktop) so it starts the current server, then export again`,
    );
  const token = crypto.randomUUID();
  staged.set(token, { files: bytes, timer: keepStaged(token) });
  return { files: {}, staged: { token, sizes: Object.fromEntries(Object.entries(bytes).map(([k, v]) => [k, v.length])) } };
}

/** For test and timing runs in development builds: what a request from an assistant does in this page, without a server. */
export const testCall = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => handle({ id: 0, method, params } as unknown as BridgeRequest);

async function handle(req: BridgeRequest): Promise<unknown> {
  const p = req.params;
  switch (req.method) {
    case "get_model":
      needProject();
      {
        // Versions are listed by name; their states would only fill the assistant's context.
        const doc = currentDoc();
        return { project: useApp.getState().project, document: p["full"] ? designOf(doc) : tools.lightDocument(doc), ...(doc.versions ? { versions: doc.versions.map((v) => ({ name: v.name, at: new Date(v.at).toISOString() })) } : {}), rebuild: modelSummary(await rebuildNow()) };
      }
    case "get_sketch": {
      needProject();
      const sk = (await rebuildNow()).report.sketches.find((s) => s.id === p["id"]);
      if (!sk) throw new Error(`sketch "${String(p["id"])}" not found`);
      return { ...sk, regions: sk.regions.map(({ key, depth, area, sample }) => ({ key, depth, area, sample })) };
    }
    case "get_status": {
      await refreshProjects();
      return {
        project: useApp.getState().project,
        // The newest few: the whole list (list_projects) runs to hundreds of entries.
        recentProjects: [...useApp.getState().projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5).map(({ id, name }) => ({ id, name })),
        projectCount: useApp.getState().projects.length,
        previewing: !!useApp.getState().proposalDoc,
        // Where this session works: its own tab, or none yet (then `userProject` is what the user has open).
        ...(desktop?.assistant ? (assistantWindow ? { tab: "own" } : { tab: "none yet: open_project, new_project or open_example opens one", userProject: useApp.getState().project, project: null }) : {}),
      };
    }
    case "clear_preview":
      useApp.setState({ proposalDoc: null });
      scheduleRebuild();
      return "ok";
    case "apply_ops": {
      needProject();
      useApp.setState({ proposalDoc: null });
      // Variables an assistant creates are the user's (the dimensions they asked for); helpers it marks auto: true.
      // Rails with carriages and lead screws with nuts get their joints, as in the app.
      const ops = withMotion(tools.restoreElided(p["ops"] as DocOp[], currentDoc()), currentDoc());
      // Validate first so a bad op returns a precise error instead of a toast.
      ops.reduce<MeercadDocument>((d, op) => applyOp(d, op), currentDoc());
      const before = useApp.getState().output;
      if (!apply(...ops)) throw new Error("ops were rejected");
      // Nothing to build after saving a version: the answer is there at once.
      if (ops.length && ops.every((op) => VERSION_OPS.has(op.type)) && p["detail"] !== "full") return { ok: true, versions: (currentDoc().versions ?? []).map((v) => v.name) };
      const out = await rebuildNow();
      if (p["detail"] === "full") return summary(out);
      const t = touchedBy(ops);
      return briefSummary(out, before, t.ids, t.shown);
    }
    case "preview_ops": {
      needProject();
      const ops = tools.restoreElided(p["ops"] as DocOp[], currentDoc());
      const doc = ops.reduce<MeercadDocument>((d, op) => applyOp(d, op), currentDoc());
      const sandbox = await kernel.sandbox(doc);
      const t = touchedBy(ops);
      const result = p["detail"] === "full" ? summary(sandbox) : briefSummary(sandbox, useApp.getState().output, t.ids, t.shown);
      // Show it live; the document itself stays untouched.
      useApp.setState({ proposalDoc: doc });
      scheduleRebuild();
      return result;
    }
    case "undo": {
      needProject();
      useApp.setState({ proposalDoc: null });
      const before = useApp.getState().output;
      undo();
      return briefAfter(await rebuildNow(), before);
    }
    case "redo": {
      needProject();
      const before = useApp.getState().output;
      redo();
      return briefAfter(await rebuildNow(), before);
    }
    case "list_projects":
      await refreshProjects();
      return useApp.getState().projects.map(({ id, name, updatedAt }) => ({ id, name, updated: new Date(updatedAt).toISOString() }));
    case "close_project":
      // The web app (no tabs of the assistants'): the app is the user's again right away.
      unlock();
      return { closed: true, note: "The app is free for the user again." };
    case "open_project":
      // Who else has it open was checked when the request was routed.
      await openProject(String(p["id"]));
      return openSummary(await rebuildNow());
    case "new_project":
      return created(p, async () => {
        await newProject(emptyDocument(), typeof p["name"] === "string" && p["name"] ? p["name"] : "Untitled part");
        return { project: useApp.getState().project };
      });
    case "render_view": {
      needProject();
      await rebuildNow();
      // No waiting for an animation frame: they stop while the window is in the background,
      // which is where it usually is while an assistant works.
      const url = renderShot(shotOf(p));
      return { png: url.slice(url.indexOf(",") + 1) };
    }
    case "render_motion": {
      needProject();
      await rebuildNow();
      const motionId = typeof p["motion"] === "string" ? p["motion"] : undefined;
      if (!motionId && typeof p["joint"] !== "string") throw new Error("give a joint (one joint's move) or a motion (several joints over time)");
      const joint = String(p["joint"] ?? "");
      const [lo, hi] = motionId ? [0, 0] : jointRange(joint);
      const from = p["from"] === undefined ? lo : Number(p["from"]);
      const to = p["to"] === undefined ? hi : Number(p["to"]);
      const sheet = await renderMotionSheet(joint, from, to, p["frames"] === undefined ? 9 : Number(p["frames"]), shotOf(p), p["collisions"] !== false, motionId);
      const video = p["video"] as { frames?: number; width?: number; height?: number } | undefined;
      const gif = video ? await renderMotionGif(joint, from, to, video.frames ?? 36, { ...shotOf(p), width: video.width ?? 480, height: video.height ?? 360 }, motionId) : null;
      return { png: sheet.png.slice(sheet.png.indexOf(",") + 1), frames: sheet.frames, ...(gif ? { gif: toB64(gif) } : {}) };
    }
    case "drawing": {
      needProject();
      const out = await rebuildNow();
      const doc = currentDoc();
      const names = (p["views"] as ViewName[] | undefined) ?? ["front", "top", "left", "iso"];
      const views = await kernel.drawing(names, undefined, drawingDocument(doc));
      const bom = billOfMaterials(out.report.bodies, (id) => partName(id, doc.features), doc.partMaterials ?? {}, doc.materials);
      const sheet = layoutSheet(views, {
        paper: (p["paper"] as Paper | undefined) ?? "A4",
        title: { title: String(p["title"] ?? useApp.getState().project?.name ?? "Untitled"), material: p["material"] as string | undefined, drawnBy: p["drawnBy"] as string | undefined, number: p["number"] as string | undefined, date: new Date().toLocaleDateString("sv") },
        ...(p["bom"] !== false && bom.length > 1 ? { bom } : {}),
      });
      const svg = writeSheetSvg(sheet);
      const format = (p["format"] as string | undefined) ?? "pdf";
      const file = format === "svg" ? toB64(svg) : format === "dxf" ? toB64(writeSheetDxf(sheet)) : toB64(writeSheetPdf(sheet));
      // A picture of the sheet for checking it, drawn from its SVG.
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("could not draw the sheet"));
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      });
      const width = Number(p["width"] ?? 1400);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = Math.round((width * sheet.height) / sheet.width);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      const png = canvas.toDataURL("image/png");
      return { file, png: png.slice(png.indexOf(",") + 1), scale: sheet.scaleLabel, paper: `${sheet.width} × ${sheet.height} mm`, views: views.map((v) => v.name), parts: bom.map((r) => ({ pos: r.pos, qty: r.qty, name: r.name, ...(r.material ? { material: r.material } : {}) })) };
    }
    case "set_view": {
      const vp = getViewport();
      if (!vp) throw new Error("viewport not ready");
      if (p["view"] === "fit") vp.fit();
      else vp.setView(p["view"] as "iso");
      return "ok";
    }
    case "export_robot": {
      needProject();
      const { files, links, warnings } = await robotFiles({
        ...(typeof p["name"] === "string" ? { name: p["name"] } : {}),
        ...(typeof p["floating"] === "boolean" ? { floating: p["floating"] } : {}),
        ...(p["masses"] && typeof p["masses"] === "object" ? { masses: p["masses"] as Record<string, number> } : {}),
        ...(p["actuators"] && typeof p["actuators"] === "object" ? { actuators: p["actuators"] as Record<string, RobotActuator> } : {}),
        ...(p["collision"] === "mesh" || p["collision"] === "shapes" ? { collision: p["collision"] } : {}),
        ...(Array.isArray(p["parts"]) ? { parts: p["parts"] as string[] } : {}),
        ...(Array.isArray(p["exclude"]) ? { exclude: p["exclude"] as string[] } : {}),
      });
      return { ...exportedFiles(files, p), links, warnings };
    }
    case "send_to_slicer": {
      needProject();
      await rebuildNow();
      const slicer = p["slicer"] === "bambu" || p["slicer"] === "prusa" ? p["slicer"] : undefined;
      const materials = typeof p["materials"] === "boolean" ? p["materials"] : undefined;
      const r = await openInSlicer(slicer, {
        ...(Array.isArray(p["parts"]) ? { parts: p["parts"] as string[] } : {}),
        ...(typeof p["posed"] === "boolean" ? { posed: p["posed"] } : {}),
        ...(materials !== undefined ? { materials } : {}),
      });
      const filaments = filamentsOf(r.meshes, materials);
      return { slicer: r.slicer, file: r.file, moved: r.moved, ...(filaments.length > 1 ? { filaments: filaments.map((f, i) => ({ slot: i + 1, ...f })) } : {}), ...(r.cables.length ? { cablesLeftOut: r.cables } : {}) };
    }
    case "export": {
      needProject();
      await rebuildNow();
      const format = String(p["format"]);
      if (format === "meercad") {
        const version = typeof p["version"] === "string" ? p["version"] : null;
        return { files: { "model.meercad": toB64(JSON.stringify(version ? versionFile(currentDoc(), version) : currentDoc(), null, 2)) } };
      }
      if (format === "dxf" || format === "svg") {
        const sketch = String(p["sketch"] ?? "");
        if (!sketch) throw new Error("dxf/svg export needs a sketch id");
        const curves = sketchCurves(sketch);
        return { files: { [`sketch.${format}`]: toB64(format === "dxf" ? writeDxf(curves) : writeSvg(curves)) } };
      }
      if (format === "usdz") {
        if (p["variants"]) throw new Error("usdz export takes the design as it is, not its variants");
        const data = await usdzFile({ ...(Array.isArray(p["parts"]) ? { parts: p["parts"] as string[] } : {}), ...(typeof p["posed"] === "boolean" ? { posed: p["posed"] } : {}) });
        return { files: { [`${typeof p["name"] === "string" ? p["name"] : "model"}.usdz`]: toB64(data) } };
      }
      const { files, filaments, cablesLeftOut } = await tools.exportFiles(format as "stl", {
        ...(Array.isArray(p["parts"]) ? { parts: p["parts"] as string[] } : {}),
        ...(typeof p["posed"] === "boolean" ? { posed: p["posed"] } : {}),
        ...(p["variants"] ? { variants: true } : {}),
        ...(typeof p["name"] === "string" ? { name: p["name"] } : {}),
        ...(typeof p["materials"] === "boolean" ? { materials: p["materials"] } : {}),
      });
      return { ...exportedFiles(files, p), ...(filaments ? { filaments } : {}), ...(cablesLeftOut ? { cablesLeftOut } : {}) };
    }
    case "list_materials": {
      const doc = currentDoc();
      const describe = (m: ReturnType<typeof documentMaterials>[number]) => ({
        id: m.id,
        name: m.name,
        ...(m.base ? { base: m.base } : {}),
        density: m.density,
        kind: m.kind,
        ...(m.filament ? { filament: m.filament } : {}),
        ...(m.nozzle ? { nozzleC: m.nozzle } : {}),
        ...(m.bed ? { bedC: m.bed } : {}),
        ...(m.shore ? { shore: m.shore } : {}),
        look: m.look,
        notes: m.notes,
      });
      return { materials: documentMaterials(doc).map(describe), parts: doc.partMaterials ?? {} };
    }
    case "set_pose": {
      needProject();
      await rebuildNow();
      return setPose(p["values"] as Record<string, number>);
    }
    case "check_clearance": {
      needProject();
      await rebuildNow();
      return clearanceNow();
    }
    case "check_motion": {
      needProject();
      await rebuildNow();
      if (typeof p["motion"] === "string") return checkMotionRun(p["motion"], p["steps"] === undefined ? undefined : Number(p["steps"]));
      // The sweep for big designs: several joints, chosen parts, fasteners left out, one line per pair.
      if (Array.isArray(p["joints"]) || ["parts", "against", "fasteners", "touchBelow", "most"].some((k) => p[k] !== undefined)) {
        const joints = Array.isArray(p["joints"]) ? (p["joints"] as SweepJoint[]) : typeof p["joint"] === "string" ? [{ joint: p["joint"], ...(p["from"] !== undefined ? { from: Number(p["from"]) } : {}), ...(p["to"] !== undefined ? { to: Number(p["to"]) } : {}), ...(p["steps"] !== undefined ? { steps: Number(p["steps"]) } : {}) }] : [];
        return sweepCheck({
          joints,
          ...(Array.isArray(p["parts"]) ? { parts: p["parts"] as string[] } : {}),
          ...(Array.isArray(p["against"]) ? { against: p["against"] as string[] } : {}),
          ...(typeof p["fasteners"] === "boolean" ? { fasteners: p["fasteners"] } : {}),
          ...(typeof p["touchBelow"] === "number" ? { touchBelow: p["touchBelow"] } : {}),
          ...(typeof p["most"] === "number" ? { most: p["most"] } : {}),
        });
      }
      if (typeof p["joint"] !== "string" || p["from"] === undefined || p["to"] === undefined) throw new Error("give a joint with from and to, or a motion");
      return checkMotion(String(p["joint"]), Number(p["from"]), Number(p["to"]), p["steps"] === undefined ? undefined : Number(p["steps"]));
    }
    case "play_motion": {
      needProject();
      await rebuildNow();
      if (p["motion"] === null || p["motion"] === undefined) {
        stopPlaying();
        return "stopped";
      }
      playMotion(String(p["motion"]));
      const m = motionById(String(p["motion"]));
      return `playing "${m.name ?? m.id}" in the app (${m.duration} s${m.loop ? ", looping" : ""}); play_motion with motion null stops it`;
    }
    case "measure": {
      needProject();
      const out = await rebuildNow();
      const topos = out.meshes.map(meshTopology);
      const ref = (s: unknown) => {
        const sel = s as FaceSelector | EdgeSelector;
        if ("edge" in sel || ("select" in sel && sel.select === "edges")) {
          const r = resolveEdges([sel as EdgeSelector], topos);
          return { bodyId: r.body, kind: "edge" as const, index: r.edges[0]! };
        }
        const r = resolveFaces(sel as FaceSelector, topos)[0]!;
        return { bodyId: r.body, kind: "face" as const, index: r.faces[0]! };
      };
      return kernel.measure(ref(p["a"]), p["b"] ? ref(p["b"]) : undefined);
    }
    case "get_version":
      needProject();
      return { name: p["name"], document: tools.versionDocument(String(p["name"])) };
    case "check_interference":
      needProject();
      return tools.interference({ ...(Array.isArray(p["parts"]) ? { parts: p["parts"] as string[] } : {}), ...(p["box"] && typeof p["box"] === "object" ? { box: p["box"] as { min: [number, number, number]; max: [number, number, number] } } : {}), ...(typeof p["seconds"] === "number" ? { seconds: p["seconds"] } : {}) });
    case "wall_thickness":
      needProject();
      return tools.wallThickness(String(p["part"]), p["minWall"] === undefined ? 1 : Number(p["minWall"]), {
        show: p["show"] !== false,
        ...(p["quality"] === "fast" || p["quality"] === "fine" ? { quality: p["quality"] } : {}),
        ...(p["box"] && typeof p["box"] === "object" ? { box: p["box"] as { min: [number, number, number]; max: [number, number, number] } } : {}),
      });
    case "print_check":
      needProject();
      return tools.printCheck(String(p["part"]), { ...(p["limit"] !== undefined ? { limit: Number(p["limit"]) } : {}), show: p["show"] !== false, ...(p["turn"] !== undefined ? { turn: p["turn"] as "best" | [number, number, number] } : {}), ...(p["down"] !== undefined ? { down: p["down"] as [number, number, number] | FaceSelector } : {}) });
    case "deviation":
      needProject();
      return tools.deviation(String(p["part"]), String(p["mesh"]), p["show"] !== false);
    case "repair_mesh":
      needProject();
      return tools.repairMesh(String(p["part"]), p as { removePieces?: boolean; fillHoles?: boolean; reduce?: number });
    case "rebuild_mesh":
      needProject();
      return tools.rebuildMesh(String(p["part"]));
    case "measure_scan":
      needProject();
      return tools.measureScan(String(p["part"]), p["point"] as [number, number, number], p["other"] as { part?: string; point: [number, number, number] } | undefined, p["tolerance"] === undefined ? undefined : Number(p["tolerance"]));
    case "joints_from_gears":
      needProject();
      return tools.gearJoints();
    case "import_file":
      return created(p, () => tools.importBytes(String(p["name"]), String(p["base64"])));
    case "staged_files": {
      const token = String(p["token"]);
      const s = staged.get(token);
      if (!s) throw new Error("the exported files are no longer here (fetched already, or older than 10 minutes): export again");
      window.clearTimeout(s.timer);
      if (p["done"]) {
        staged.delete(token);
        return { ok: true };
      }
      s.timer = keepStaged(token);
      return {
        data: (p["pieces"] as FilePiece[]).map(({ name, offset, length }) => {
          const file = s.files[name];
          if (!file) throw new Error(`no exported file "${name}"`);
          return toB64(file.subarray(offset, offset + length));
        }),
      };
    }
    case "read_file":
      if (!desktop?.readLocalFile) throw new Error("this meerCAD app cannot read files for the assistant (update it)");
      return { base64: await desktop.readLocalFile(String(p["path"])) };
    case "write_file":
      if (!desktop?.writeLocalFile) throw new Error("this meerCAD app cannot write files for the assistant (update it)");
      await desktop.writeLocalFile({ path: String(p["path"]), base64: String(p["base64"]) });
      return { ok: true };
    case "set_visibility":
      needProject();
      return tools.setVisibility(p as { hide?: string[]; show?: string[]; only?: string[]; all?: boolean });
    case "rename_project":
      needProject();
      return tools.renameOpenProject(String(p["name"]));
    case "list_folders":
      return tools.folders();
    case "create_folder":
      return tools.newFolder(String(p["parent"] ?? ""), String(p["name"]));
    case "move_project":
      needProject();
      return tools.moveOpenProject(String(p["folder"] ?? ""));
    case "list_examples":
      return tools.examples();
    case "open_example":
      return created(p, () => tools.openExample(typeof p["id"] === "number" ? p["id"] : String(p["id"])));
    case "terrain_height":
      needProject();
      return tools.terrainHeights((p["points"] as [number, number][] | undefined) ?? []);
    case "place_on_terrain":
      needProject();
      return tools.placeOnTerrain(String(p["part"]), p["at"] as [number, number] | undefined, p["offset"] === undefined ? 0 : Number(p["offset"]));
    case "photo_terrain":
      needProject();
      return tools.photoTerrain(String(p["folder"]));
  }
}
