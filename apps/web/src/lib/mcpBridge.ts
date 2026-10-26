/**
 * Connects the app to a local opencad MCP server so assistants like Claude can drive it. The app is
 * the WebSocket client; the server only listens on 127.0.0.1 and checks the page origin.
 */
import { write3mf, writeDxf, writeStl, writeSvg } from "@opencad/io";
import type { RebuildOutput } from "@opencad/kernel/client";
import { DEFAULT_PORT, type BridgeRequest } from "@opencad/mcp";
import { resolveEdges, resolveFaces } from "@opencad/naming";
import { applyOp } from "@opencad/model";
import { emptyDocument, type DocOp, type EdgeSelector, type FaceSelector, type OpencadDocument } from "@opencad/schema";
import { sketchCurves } from "../components/io";
import { apply, currentDoc, getViewport, kernel, newProject, openProject, rebuildNow, redo, refreshProjects, scheduleRebuild, undo, useApp } from "../store";
import { meshTopology } from "./topology";

type Status = "off" | "connecting" | "connected";
let socket: WebSocket | null = null;
let retry: number | undefined;
let wanted = false;
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
    localStorage.setItem("opencad.mcp", on ? "1" : "");
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
  let on = false;
  try {
    on = localStorage.getItem("opencad.mcp") === "1";
  } catch {
    on = false;
  }
  if (on) setBridgeEnabled(true);
}

function connect(): void {
  if (!wanted || socket) return;
  setStatus("connecting");
  const ws = new WebSocket(`ws://127.0.0.1:${DEFAULT_PORT}`);
  socket = ws;
  ws.onopen = () => {
    setStatus("connected");
    ws.send(JSON.stringify({ hello: "opencad", version: "0.1.0", project: useApp.getState().project?.name ?? null }));
  };
  ws.onclose = () => {
    socket = null;
    if (!wanted) return setStatus("off");
    setStatus("connecting");
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
  return {
    features: r.features.map((f) => ({ id: f.id, status: f.status, ...(f.message ? { message: f.message } : {}), ...(f.hint ? { hint: f.hint } : {}) })),
    params: r.params,
    ...(Object.keys(r.paramErrors).length ? { paramErrors: r.paramErrors } : {}),
    bodies: r.bodies.map((b) => ({ id: b.id, volume: +b.volume.toFixed(3), area: +b.area.toFixed(3), faces: b.faces, bbox: { min: b.bbox.min.map((v) => +v.toFixed(3)), max: b.bbox.max.map((v) => +v.toFixed(3)) } })),
    sketches: r.sketches.map((s) => ({ id: s.id, dof: s.diagnostics.dof, ok: s.diagnostics.ok, regions: s.regions.map((g) => g.key) })),
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
      return { project: useApp.getState().project, document: currentDoc(), rebuild: summary(await rebuildNow()) };
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
      const ops = p["ops"] as DocOp[];
      // Validate first so a bad op returns a precise error instead of a toast.
      ops.reduce<OpencadDocument>((d, op) => applyOp(d, op), currentDoc());
      if (!apply(...ops)) throw new Error("ops were rejected");
      return summary(await rebuildNow());
    }
    case "preview_ops": {
      needProject();
      const doc = (p["ops"] as DocOp[]).reduce<OpencadDocument>((d, op) => applyOp(d, op), currentDoc());
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
      const vp = getViewport();
      if (!vp) throw new Error("viewport not ready");
      if (typeof p["view"] === "string") vp.setView(p["view"] as "iso", false);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const url = vp.snapshot(Number(p["width"] ?? 800), Number(p["height"] ?? 600));
      return { png: url.slice(url.indexOf(",") + 1) };
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
      const out = await rebuildNow();
      const format = String(p["format"]);
      if (format === "stl") return { base64: toB64(writeStl(out.meshes)) };
      if (format === "3mf") return { base64: toB64(write3mf(out.meshes.map((m) => ({ ...m, name: m.bodyId })))) };
      if (format === "step") return { base64: toB64(await kernel.exportStep()) };
      if (format === "ocad") return { base64: toB64(JSON.stringify(currentDoc(), null, 2)) };
      const sketch = String(p["sketch"] ?? "");
      if (!sketch) throw new Error("dxf/svg export needs a sketch id");
      const curves = sketchCurves(sketch);
      return { base64: toB64(format === "dxf" ? writeDxf(curves) : writeSvg(curves)) };
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
