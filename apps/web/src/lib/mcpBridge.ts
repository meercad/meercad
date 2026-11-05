/**
 * Connects the app to a local meerCAD MCP server so assistants like Claude can drive it. The app is
 * the WebSocket client; the server only listens on 127.0.0.1 and checks the page origin.
 */
import { layoutSheet, write3mf, writeDxf, writeObj, writeSheetDxf, writeSheetPdf, writeSheetSvg, writeStl, writeSvg, type Paper } from "@meercad/io";
import type { RebuildOutput } from "@meercad/kernel/client";
import { DEFAULT_PORT, type BridgeRequest } from "@meercad/mcp";
import { resolveEdges, resolveFaces } from "@meercad/naming";
import { applyOp, billOfMaterials, designOf, drawingDocument, massOf, massProperties, materialById } from "@meercad/model";
import type { ViewName } from "@meercad/kernel/client";
import { partName } from "./features";
import { emptyDocument, type DocOp, type EdgeSelector, type FaceSelector, type MeercadDocument } from "@meercad/schema";
import { sketchCurves, stepParts } from "../components/io";
import { apply, currentDoc, getViewport, kernel, newProject, openProject, rebuildNow, redo, refreshProjects, scheduleRebuild, undo, useApp } from "../store";
import type { StandardView } from "@meercad/viewport";
import { checkMotion, clearanceNow, setPose } from "./mechanism";
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

export function setBridgeEnabled(on: boolean): void {
  wanted = on;
  try {
    localStorage.setItem("meercad.mcp", on ? "1" : "0");
  } catch {
    // preference not persisted
  }
  if (on) connect();
  else {
    clearTimeout(retry);
    socket?.close();
    socket = null;
    setStatus("off");
  }
}

export function initBridge(): void {
  let pref: string | null = null;
  try {
    pref = localStorage.getItem("meercad.mcp");
  } catch {
    pref = null;
  }
  // The Mac app is ready for assistants out of the box (the iPad app has no assistants).
  if (pref !== "0" && (window as { meercadDesktop?: unknown }).meercadDesktop) setBridgeEnabled(true);
}

function connect(): void {
  if (!wanted || socket) return;
  setStatus("connecting");
  const ws = new WebSocket(`ws://127.0.0.1:${DEFAULT_PORT}`);
  socket = ws;
  ws.onopen = () => {
    setStatus("connected");
    ws.send(JSON.stringify({ hello: "meercad", version: "0.1.0", project: useApp.getState().project?.name ?? null }));
  };
  ws.onclose = (e) => {
    socket = null;
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
    const req = JSON.parse(String(e.data)) as BridgeRequest;
    showActivity(req.client ?? "Assistant", req.method);
    try {
      ws.send(JSON.stringify({ id: req.id, result: await handle(req) }));
    } catch (err) {
      ws.send(JSON.stringify({ id: req.id, error: err instanceof Error ? err.message : String(err) }));
    }
  };
}

let activityTimer: number | undefined;
function showActivity(client: string, tool: string): void {
  useApp.setState({ aiActivity: { client, tool, at: Date.now() } });
  clearTimeout(activityTimer);
  activityTimer = window.setTimeout(() => useApp.setState({ aiActivity: null }), 4000);
}

function summary(out: RebuildOutput) {
  const r = out.report;
  const materials = useApp.getState().doc.partMaterials ?? {};
  const mat = (id: string) => materialById(materials[id]);
  const total = massProperties(r.bodies.map((b) => ({ volume: b.volume, ...(b.centroid ? { centroid: b.centroid } : {}), ...(b.inertia ? { inertia: b.inertia } : {}), ...(mat(b.id) ? { material: mat(b.id)! } : {}) })));
  return {
    features: r.features.map((f) => ({ id: f.id, status: f.status, ...(f.message ? { message: f.message } : {}), ...(f.hint ? { hint: f.hint } : {}) })),
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
        return { project: useApp.getState().project, document: designOf(doc), ...(doc.versions ? { versions: doc.versions.map((v) => ({ name: v.name, at: new Date(v.at).toISOString() })) } : {}), rebuild: summary(await rebuildNow()) };
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
      };
    }
    case "clear_preview":
      useApp.setState({ proposalDoc: null });
      scheduleRebuild();
      return "ok";
    case "apply_ops": {
      needProject();
      useApp.setState({ proposalDoc: null });
      // Variables an assistant creates are listed apart from the user's own.
      const ops = (p["ops"] as DocOp[]).map((op) => (op.type === "set_param" && op.expr !== null && op.auto === undefined && !(op.name in currentDoc().params) ? { ...op, auto: true } : op));
      // Validate first so a bad op returns a precise error instead of a toast.
      ops.reduce<MeercadDocument>((d, op) => applyOp(d, op), currentDoc());
      if (!apply(...ops)) throw new Error("ops were rejected");
      return summary(await rebuildNow());
    }
    case "preview_ops": {
      needProject();
      const doc = (p["ops"] as DocOp[]).reduce<MeercadDocument>((d, op) => applyOp(d, op), currentDoc());
      const result = summary(await kernel.sandbox(doc));
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
      await openProject(String(p["id"]));
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
      const joint = String(p["joint"]);
      const [lo, hi] = jointRange(joint);
      const from = p["from"] === undefined ? lo : Number(p["from"]);
      const to = p["to"] === undefined ? hi : Number(p["to"]);
      const sheet = await renderMotionSheet(joint, from, to, p["frames"] === undefined ? 9 : Number(p["frames"]), shotOf(p), p["collisions"] !== false);
      const video = p["video"] as { frames?: number; width?: number; height?: number } | undefined;
      const gif = video ? await renderMotionGif(joint, from, to, video.frames ?? 36, { ...shotOf(p), width: video.width ?? 480, height: video.height ?? 360 }) : null;
      return { png: sheet.png.slice(sheet.png.indexOf(",") + 1), frames: sheet.frames, ...(gif ? { gif: toB64(gif) } : {}) };
    }
    case "drawing": {
      needProject();
      const out = await rebuildNow();
      const doc = currentDoc();
      const names = (p["views"] as ViewName[] | undefined) ?? ["front", "top", "left", "iso"];
      const views = await kernel.drawing(names, undefined, drawingDocument(doc));
      const bom = billOfMaterials(out.report.bodies, (id) => partName(id, doc.features), doc.partMaterials ?? {});
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
    case "export": {
      needProject();
      await rebuildNow();
      const format = String(p["format"]);
      if (format === "stl") return { base64: toB64(writeStl(await kernel.exportMeshes())) };
      if (format === "3mf") return { base64: toB64(write3mf((await kernel.exportMeshes()).map((m) => ({ ...m, name: m.bodyId })))) };
      if (format === "obj") return { base64: toB64(writeObj((await kernel.exportMeshes()).map((m) => ({ ...m, name: m.bodyId })))) };
      if (format === "step") return { base64: toB64(await kernel.exportStep(undefined, stepParts())) };
      if (format === "meercad") return { base64: toB64(JSON.stringify(currentDoc(), null, 2)) };
      const sketch = String(p["sketch"] ?? "");
      if (!sketch) throw new Error("dxf/svg export needs a sketch id");
      const curves = sketchCurves(sketch);
      return { base64: toB64(format === "dxf" ? writeDxf(curves) : writeSvg(curves)) };
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
      return checkMotion(String(p["joint"]), Number(p["from"]), Number(p["to"]), p["steps"] === undefined ? undefined : Number(p["steps"]));
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
  }
}
