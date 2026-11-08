/**
 * Connects the app to a local meerCAD MCP server so assistants like Claude can drive it. The app is
 * the WebSocket client; the server only listens on 127.0.0.1 and checks the page origin.
 */
import { layoutSheet, writeDxf, writeSheetDxf, writeSheetPdf, writeSheetSvg, writeSvg, type Paper, type RobotActuator } from "@meercad/io";
import type { RebuildOutput } from "@meercad/kernel/client";
import { DEFAULT_PORT, type BridgeEvent, type BridgeRequest } from "@meercad/mcp";
import { resolveEdges, resolveFaces } from "@meercad/naming";
import { applyOp, billOfMaterials, designOf, documentMaterials, drawingDocument, massOf, massProperties, partMaterial, withMotion } from "@meercad/model";
import type { ViewName } from "@meercad/kernel/client";
import { partName } from "./features";
import { emptyDocument, type DocOp, type EdgeSelector, type FaceSelector, type MeercadDocument } from "@meercad/schema";
import { robotFiles, sketchCurves, usdzFile } from "../components/io";
import * as tools from "./mcpTools";
import { clientLabel } from "./mcpClient";
import { assistantWindow, desktop } from "./persistence";
import { apply, currentDoc, getViewport, kernel, newProject, openProject, rebuildNow, redo, refreshProjects, scheduleRebuild, undo, useApp } from "../store";
import type { StandardView } from "@meercad/viewport";
import { checkMotion, checkMotionRun, clearanceNow, motionById, playMotion, setPose, stopPlaying } from "./mechanism";
import { jointRange, renderMotionGif, renderMotionSheet, renderShot, type Shot } from "./render";
import { meshTopology } from "./topology";

type Status = "off" | "connecting" | "connected";
let socket: WebSocket | null = null;
let retry: number | undefined;
let wanted = false;
/** When this window lost the connection to another meerCAD window recently. */
let replaced: number[] = [];
const listeners = new Set<(s: Status) => void>();
let status: Status = "off";
const setStatus = (s: Status) => {
  status = s;
  for (const fn of listeners) fn(s);
};
export const bridgeStatus = () => status;
export const onBridgeStatus = (fn: (s: Status) => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function setBridgeEnabled(on: boolean, remember = true): void {
  // An assistant's window gets its requests from the user's window, never over its own connection.
  if (assistantWindow) return;
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

export function initBridge(): void {
  if (assistantWindow) return initAssistantWindow();
  // A test run's window (MEERCAD_MCP_BRIDGE=off) never talks to assistants.
  if (new URLSearchParams(location.search).get("bridge") === "off") return;
  let pref: string | null = null;
  try {
    pref = localStorage.getItem("meercad.mcp");
  } catch {
    pref = null;
  }
  // The Mac app is ready for assistants out of the box (the iPad app has no assistants).
  if (pref !== "0" && (window as { meercadDesktop?: unknown }).meercadDesktop) setBridgeEnabled(true);
}

/** The bridge port: the default, or for test runs the one in localStorage "meercad.mcp.port" (a server started with MEERCAD_MCP_PORT). */
function bridgePort(): number {
  try {
    const p = Number(localStorage.getItem("meercad.mcp.port"));
    if (Number.isInteger(p) && p > 1024 && p < 65536) return p;
  } catch {
    // default
  }
  return DEFAULT_PORT;
}

function connect(): void {
  if (!wanted || socket) return;
  setStatus("connecting");
  const ws = new WebSocket(`ws://127.0.0.1:${bridgePort()}`);
  socket = ws;
  ws.onopen = () => {
    setStatus("connected");
    ws.send(JSON.stringify({ hello: "meercad", version: "0.1.0", project: useApp.getState().project?.name ?? null }));
  };
  ws.onclose = (e) => {
    socket = null;
    // The server this window talked to has gone: its session has ended (the others reconnect).
    if (hubSession) {
      here.delete(hubSession);
      desktop?.assistant?.ended(hubSession);
      hubSession = null;
    }
    if (!wanted) return setStatus("off");
    setStatus("connecting");
    // Another meerCAD window (e.g. the WIP build next to the release) took the connection: take it back
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
      if (msg.event === "session_ended") {
        here.delete(msg.session);
        desktop?.assistant?.ended(msg.session);
      }
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

/** Requests that open a project for the session: where they open decides where the session works. */
const OPENS = new Set(["open_project", "new_project", "open_example"]);
/** The session of the MCP server this window is connected to (the hub). */
let hubSession: string | null = null;
/** Sessions working in this (the user's) window: they asked to, or opened the project the user has in front. */
const here = new Set<string>();

/**
 * Where a request is served. On the Mac every assistant session (one MCP server each) works in a
 * window of its own, so the user keeps working in theirs: opening a project opens that window
 * (behind the user's), and from then on the session's requests go there. A session that never
 * opened a project, or opened the one the user has in front, works here as before.
 */
async function route(req: BridgeRequest): Promise<unknown> {
  const a = desktop?.assistant;
  const session = req.session;
  if (!a || !session) return serve(req);
  if (OPENS.has(req.method)) {
    if (req.method === "open_project") {
      const id = String(req.params["id"]);
      const holder = await a.holder(id);
      if (holder && holder.session !== session && !holder.ended) throw new Error(`${holder.client} is working on this project in its own meerCAD window right now. Pick another project, or wait until it is done.`);
      // A window left by an assistant that has finished is taken over.
      if (holder) {
        here.delete(session);
        return a.call(await a.open({ session, client: clientLabel(req.client), project: id }), req);
      }
      const s = useApp.getState();
      const inFront = s.screen === "editor" && s.project?.id === id;
      if (!holder && (inFront || req.params["here"] === true)) {
        here.add(session);
        return serve(req);
      }
    } else if (req.params["here"] === true) {
      here.add(session);
      return serve(req);
    }
    here.delete(session);
    return a.call(await a.open({ session, client: clientLabel(req.client) }), req);
  }
  if (!here.has(session)) {
    const win = await a.windowOf(session);
    if (win === "closed") throw new Error("The user closed your meerCAD window. Open the project again (open_project) to go on.");
    if (win !== null) return a.call(win, req);
  }
  return serve(req);
}

/** In this window: shows who is working, and locks the app while the request changes things. */
async function serve(req: BridgeRequest): Promise<unknown> {
  if (stopped) throw new Error("The user stopped your editing in this window. Ask them before going on.");
  const client = clientLabel(req.client);
  showActivity(client, req.method);
  const locks = !READS.has(req.method);
  const gen = lockGen;
  if (locks) lock(client);
  try {
    return await handle(req);
  } finally {
    if (locks && gen === lockGen) release();
  }
}

/** Set in an assistant's window when the user stopped it there. */
let stopped = false;
export const assistantStopped = () => stopped;

/**
 * An assistant session's own window: requests come from the user's window (through the main
 * process), the window says whose it is, and the main process learns which project it shows.
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
  desktop.on("assistant-adopted", ({ client }) => {
    // Another assistant session takes over this window (its own one had finished).
    assistantWindow!.client = client;
    stopped = false;
    useApp.setState({ aiSessionEnded: false });
    report();
  });
  desktop.on("assistant-ended", () => {
    unlock();
    useApp.setState({ aiActivity: null, aiSessionEnded: true });
  });
  let shown: string | null = null;
  const report = () => {
    const project = useApp.getState().project;
    document.title = `${project?.name ?? "meerCAD"} · ${assistantWindow!.client}`;
    if ((project?.id ?? null) === shown) return;
    shown = project?.id ?? null;
    a.project(shown);
  };
  useApp.subscribe(report);
  report();
  a.ready();
}

/** Requests that only look things up: they do not lock the app. */
const READS = new Set(["status", "get_status", "get_version", "list_projects", "list_folders", "list_examples", "list_materials"]);
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
 * The user ends the assistant's editing: the app is free again and the assistant is disconnected
 * until it is allowed again with the plug icon (next start it is connected as before).
 */
export function stopAssistant(): void {
  // In an assistant's own window only that window stops; the other sessions go on.
  if (assistantWindow) {
    stopped = true;
    unlock();
  } else setBridgeEnabled(false, false);
  clearTimeout(activityTimer);
  useApp.setState({ aiActivity: null });
}

// While an assistant works, keys do nothing in the app (registered before any other key handler),
// except on the bar that offers to stop it.
for (const type of ["keydown", "keyup"] as const)
  window.addEventListener(
    type,
    (e) => {
      if (!useApp.getState().aiLock) return;
      if (e.target instanceof Element && e.target.closest(".ai-lock-bar")) return;
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
 * something, new or changed bodies, sketches of the edited steps (and any not solved), joints when
 * one changed or broke. The full summary of a big design runs to thousands of lines; this keeps the
 * answer to an edit about the edit. `touched`: ids of the steps the ops added or changed.
 */
function briefSummary(out: RebuildOutput, before: RebuildOutput | null | undefined, touched: Set<string>, mechanismChanged: boolean) {
  const full = summary(out);
  const prev = new Map((before?.report.bodies ?? []).map((b) => [b.id, bodyKey(b)]));
  const changed = new Set(out.report.bodies.filter((b) => prev.get(b.id) !== bodyKey(b)).map((b) => b.id));
  const gone = [...prev.keys()].filter((id) => !out.report.bodies.some((b) => b.id === id));
  const features = full.features.filter((f) => f.status !== "ok" || "info" in f || "hint" in f || touched.has(f.id));
  const sketches = full.sketches.filter((s) => !s.ok || touched.has(s.id));
  const { joints, ...rest } = full;
  return {
    ...rest,
    features,
    featuresOk: full.features.filter((f) => f.status === "ok").length,
    bodies: full.bodies.filter((b) => changed.has(b.id)),
    unchangedBodies: full.bodies.length - changed.size,
    ...(gone.length ? { removedBodies: gone } : {}),
    sketches,
    ...(joints && (mechanismChanged || joints.some((j) => "error" in j)) ? { joints } : {}),
    note: 'Brief result: steps that are ok and bodies and sketches this change did not touch are left out (get_model or detail:"full" shows everything).',
  };
}

/** Ids of the steps a list of ops adds or edits, and whether it changes moving parts. */
function touchedBy(ops: readonly DocOp[]): { ids: Set<string>; mechanism: boolean } {
  const ids = new Set<string>();
  let mechanism = false;
  for (const op of ops) {
    if (op.type === "add_features") for (const f of op.features) ids.add(f.id);
    else if (op.type === "edit_feature" || op.type === "delete_feature" || op.type === "move_feature") ids.add(op.id);
    else if (op.type === "replace") mechanism = true;
    if (/joint|coupling|motion/.test(op.type)) mechanism = true;
  }
  return { ids, mechanism };
}

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

async function handle(req: BridgeRequest): Promise<unknown> {
  const p = req.params;
  switch (req.method) {
    case "get_model":
      needProject();
      {
        // Versions are listed by name; their states would only fill the assistant's context.
        const doc = currentDoc();
        return { project: useApp.getState().project, document: p["full"] ? designOf(doc) : tools.lightDocument(doc), ...(doc.versions ? { versions: doc.versions.map((v) => ({ name: v.name, at: new Date(v.at).toISOString() })) } : {}), rebuild: summary(await rebuildNow()) };
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
        projects: useApp.getState().projects.map(({ id, name }) => ({ id, name })),
        previewing: !!useApp.getState().proposalDoc,
        // Where this session works: its own window, or the user's (who then cannot edit meanwhile).
        ...(desktop?.assistant && req.session ? { window: assistantWindow ? "own" : "user's" } : {}),
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
      const out = await rebuildNow();
      if (p["detail"] === "full") return summary(out);
      const t = touchedBy(ops);
      return briefSummary(out, before, t.ids, t.mechanism);
    }
    case "preview_ops": {
      needProject();
      const ops = tools.restoreElided(p["ops"] as DocOp[], currentDoc());
      const doc = ops.reduce<MeercadDocument>((d, op) => applyOp(d, op), currentDoc());
      const sandbox = await kernel.sandbox(doc);
      const t = touchedBy(ops);
      const result = p["detail"] === "full" ? summary(sandbox) : briefSummary(sandbox, useApp.getState().output, t.ids, t.mechanism);
      // Show it live; the document itself stays untouched.
      useApp.setState({ proposalDoc: doc });
      scheduleRebuild();
      return result;
    }
    case "undo":
      needProject();
      useApp.setState({ proposalDoc: null });
      undo();
      return summary(await rebuildNow());
    case "redo":
      needProject();
      redo();
      return summary(await rebuildNow());
    case "list_projects":
      await refreshProjects();
      return useApp.getState().projects.map(({ id, name, updatedAt }) => ({ id, name, updated: new Date(updatedAt).toISOString() }));
    case "open_project":
      // Who else has it open was checked when the request was routed.
      await openProject(String(p["id"]), { force: true });
      return summary(await rebuildNow());
    case "new_project":
      await newProject(emptyDocument(), typeof p["name"] === "string" && p["name"] ? p["name"] : "Untitled part");
      return { project: useApp.getState().project };
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
      });
      return { files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, toB64(v)])), links, warnings };
    }
    case "export": {
      needProject();
      await rebuildNow();
      const format = String(p["format"]);
      if (format === "meercad") return { files: { "model.meercad": toB64(JSON.stringify(currentDoc(), null, 2)) } };
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
      const { files, filaments } = await tools.exportFiles(format as "stl", {
        ...(Array.isArray(p["parts"]) ? { parts: p["parts"] as string[] } : {}),
        ...(typeof p["posed"] === "boolean" ? { posed: p["posed"] } : {}),
        ...(p["variants"] ? { variants: true } : {}),
        ...(typeof p["name"] === "string" ? { name: p["name"] } : {}),
      });
      return { files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, toB64(v)])), ...(filaments ? { filaments } : {}) };
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
      return tools.interference();
    case "wall_thickness":
      needProject();
      return tools.wallThickness(String(p["part"]), p["minWall"] === undefined ? 1 : Number(p["minWall"]), p["show"] !== false);
    case "print_check":
      needProject();
      return tools.printCheck(String(p["part"]), { ...(p["limit"] !== undefined ? { limit: Number(p["limit"]) } : {}), show: p["show"] !== false, ...(p["turn"] !== undefined ? { turn: p["turn"] as "best" | [number, number, number] } : {}) });
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
      return tools.importBytes(String(p["name"]), String(p["base64"]));
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
      return tools.openExample(typeof p["id"] === "number" ? p["id"] : String(p["id"]));
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
