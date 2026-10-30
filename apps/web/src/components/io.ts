/** File import/export and share links. */
import { encodeShareFragment, read3mf, readDxf, readObj, write3mf, writeDxf, writeStl, writeSvg, type Curve2 } from "@meercad/io";
import { showNotice } from "./Ask";
import { usePrefs } from "../lib/keymap";
import { partColors } from "../lib/partColors";
import { partName } from "../lib/features";
import { nextFeatureId } from "@meercad/model";
import { emptyDocument, validateDocument, type Feature, type SketchConstraint, type SketchEntity } from "@meercad/schema";
import { nativeApp, shareFile } from "../lib/native";
import { desktop } from "../lib/persistence";
import { apply, currentDoc, flushSave, kernel, newProject, openSketch, rebuildNow, toast, useApp } from "../store";

const FILTERS: Record<string, { name: string; extensions: string[] }> = {
  stl: { name: "STL mesh", extensions: ["stl"] },
  "3mf": { name: "3MF package", extensions: ["3mf"] },
  step: { name: "STEP model", extensions: ["step", "stp"] },
  dxf: { name: "DXF drawing", extensions: ["dxf"] },
  svg: { name: "SVG drawing", extensions: ["svg"] },
  ocad: { name: "meerCAD part", extensions: ["meercad", "meerCAD"] },
};

/** Saves a file: a native save dialog on desktop, the share sheet on iPad, a browser download otherwise. */
export function download(name: string, data: BlobPart, type: string): void {
  if (nativeApp) {
    const payload = typeof data === "string" ? data : data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    void shareFile(name, payload).catch((e: Error) => toast(`Could not share ${name}: ${e.message}`, "error"));
    return;
  }
  if (desktop) {
    const ext = name.split(".").pop() ?? "";
    const payload = typeof data === "string" ? data : data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    void desktop.saveFile({ name, data: payload, ...(FILTERS[ext] ? { filters: [FILTERS[ext]!] } : {}) }).then((path) => path && toast(`Saved ${path}`));
    return;
  }
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const baseName = () => (useApp.getState().project?.name ?? "model").replace(/[^\w\- ]+/g, "").trim() || "model";

/** STL/3MF from a print-quality tessellation (the on-screen one is far coarser). */
export async function exportMesh(format: "stl" | "3mf"): Promise<void> {
  const hidden = useApp.getState().hidden;
  const ids = useApp.getState().output?.report.bodies.map((b) => b.id).filter((id) => !hidden.has(id));
  if (!ids?.length) return toast("Nothing to export", "error");
  try {
    const meshes = await kernel.exportMeshes(ids);
    if (format === "stl") download(`${baseName()}.stl`, writeStl(meshes) as BlobPart, "model/stl");
    else {
      const colors = partColors(useApp.getState().doc, useApp.getState().output?.report.bodies.map((b) => b.id) ?? [], usePrefs.getState().colorParts);
      download(`${baseName()}.3mf`, write3mf(meshes.map((m) => ({ ...m, name: m.bodyId, ...(colors.get(m.bodyId) ? { color: colors.get(m.bodyId)! } : {}) }))) as BlobPart, "model/3mf");
    }
  } catch (e) {
    toast(`${format.toUpperCase()} export failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

/** Each part's name and colour for STEP, so other CAD tools show the parts list and colours. */
export function stepParts(): { id: string; name: string; color?: string }[] {
  const { doc, output } = useApp.getState();
  const ids = output?.report.bodies.map((b) => b.id) ?? [];
  const colors = partColors(doc, ids, true);
  return ids.map((id) => ({ id, name: partName(id, doc.features), ...(colors.get(id) ? { color: colors.get(id)! } : {}) }));
}

export async function exportStep(): Promise<void> {
  try {
    const hidden = useApp.getState().hidden;
    const ids = useApp.getState().output?.report.bodies.map((b) => b.id).filter((id) => !hidden.has(id));
    const data = await kernel.exportStep(ids, stepParts());
    download(`${baseName()}.step`, data as BlobPart, "model/step");
  } catch (e) {
    toast(`STEP export failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

/** Curves of a sketch (excluding construction geometry) for laser/plotter formats. */
export function sketchCurves(sketchId: string): Curve2[] {
  const sk = useApp.getState().output?.report.sketches.find((s) => s.id === sketchId);
  return (sk?.curves ?? [])
    .filter((c) => !c.construction)
    // Splines go out as the fine polyline of their samples.
    .flatMap((c): Curve2[] =>
      c.kind === "spline"
        ? c.pts.slice(1).map((b, k) => ({ kind: "line", a: c.pts[k]!, b }))
        : [c.kind === "line" ? { kind: "line", a: c.a, b: c.b } : c.kind === "circle" ? { kind: "circle", center: c.center, radius: c.radius } : { kind: "arc", center: c.center, radius: c.radius, a0: c.a0, a1: c.a1 }],
    );
}

export function exportSketch(sketchId: string, format: "dxf" | "svg"): void {
  const curves = sketchCurves(sketchId);
  if (!curves.length) return toast("The sketch has no geometry", "error");
  if (format === "dxf") download(`${baseName()}-${sketchId}.dxf`, writeDxf(curves), "image/vnd.dxf");
  else download(`${baseName()}-${sketchId}.svg`, writeSvg(curves), "image/svg+xml");
}

export async function shareLink(): Promise<void> {
  const frag = await encodeShareFragment(currentDoc());
  const url = `${location.origin}${location.pathname}#${frag}`;
  try {
    await navigator.clipboard.writeText(url);
    toast(`Link copied (${Math.round(url.length / 100) / 10} kB). The model lives in the link and never touches a server.`);
  } catch {
    await showNotice({ title: "Share link", message: "Copy this link. The model lives in the link itself.", value: url });
  }
}

export function saveFile(): void {
  download(`${baseName()}.meercad`, JSON.stringify(currentDoc(), null, 2), "application/json");
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Opens a file picker; STEP/STL become import features, DXF/SVG a new sketch, .meercad a project. */
/** File types Import accepts: projects, CAD (STEP), meshes (STL, 3MF, OBJ) and 2D drawings (DXF, SVG). */
export const IMPORT_TYPES = ".step,.stp,.stl,.3mf,.obj,.dxf,.svg,.meercad,.json";

/**
 * Imports a file. In an open design it is added to that design; on the project overview it starts
 * a new design named after the file. Meshes become solid bodies; a failed import says why.
 */
/** Imports a file into the open design (or a new one); true when it came in without errors. */
export async function importFile(file?: File | null): Promise<boolean> {
  file ??= await pickFile(IMPORT_TYPES);
  if (!file) return false;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const base = file.name.replace(/\.\w+$/, "");
  if (ext === "meercad" || ext === "json") {
    const v = validateDocument(JSON.parse(await file.text()));
    if (!v.ok) {
      toast(`Not a valid meerCAD file: ${v.errors[0]}`, "error");
      return false;
    }
    await flushSave();
    await newProject(v.value, base);
    return true;
  }
  if (!["step", "stp", "stl", "3mf", "obj", "dxf", "svg"].includes(ext)) {
    toast(`Unsupported file type .${ext}`, "error");
    return false;
  }
  if (file.size > 40 * 1024 * 1024) {
    toast("File is larger than 40 MB", "error");
    return false;
  }
  // Build the features first, so a file that cannot be read starts no empty design.
  let features: Feature[];
  try {
    features = await importFeatures(file, ext);
  } catch (e) {
    toast(`Could not import ${file.name}: ${e instanceof Error ? e.message : String(e)}`, "error");
    return false;
  }
  if (useApp.getState().screen !== "editor" || !useApp.getState().project) await newProject(emptyDocument(), base);
  const doc = currentDoc();
  let n = 0;
  for (const f of features) f.id = nextFeatureId({ ...doc, features: [...doc.features, ...features.slice(0, n++)] }, f.op === "sketch" ? "sketch" : "import");
  if (!apply({ type: "add_features", features })) return false;
  const sketch = features.find((f) => f.op === "sketch");
  if (sketch) {
    openSketch(sketch.id);
    return true;
  }
  toast(`Importing ${file.name}…`);
  const out = await rebuildNow().catch(() => null);
  const failed = out?.report.features.filter((r) => features.some((f) => f.id === r.id) && r.status === "error") ?? [];
  if (failed.length) toast(`Import of ${file.name} failed: ${failed[0]!.message ?? "unknown error"}`, "error");
  return !!out && !failed.length;
}

async function importFeatures(file: File, ext: string): Promise<Feature[]> {
  // STEP assemblies come in as one part per solid.
  const imp = (fileName: string, format: "step" | "stl", bytes: Uint8Array): Feature => ({ id: "", op: "import", format, fileName, data: toBase64(bytes), ...(format === "step" ? { split: true } : {}) });
  if (ext === "step" || ext === "stp") return [imp(file.name, "step", new Uint8Array(await file.arrayBuffer()))];
  if (ext === "stl") return [imp(file.name, "stl", new Uint8Array(await file.arrayBuffer()))];
  // 3MF and OBJ meshes go in as STL, one body per object on the build plate.
  if (ext === "3mf") {
    const meshes = read3mf(new Uint8Array(await file.arrayBuffer()));
    return meshes.map((m) => imp(meshes.length > 1 ? `${file.name} › ${m.name}` : file.name, "stl", writeStl([m])));
  }
  if (ext === "obj") return [imp(file.name, "stl", writeStl([readObj(await file.text())]))];
  const text = await file.text();
  const curves = ext === "dxf" ? readDxf(text) : readSvg(text);
  if (!curves.length) throw new Error("no supported geometry found in the file");
  const { entities, constraints } = curvesToSketch(curves);
  return [{ id: "", op: "sketch", name: file.name, plane: { ref: "origin.XY" }, entities, constraints }];
}

/** Converts free curves to sketch entities, sharing points at coincident endpoints. */
export function curvesToSketch(curves: Curve2[]): { entities: SketchEntity[]; constraints: SketchConstraint[] } {
  const entities: SketchEntity[] = [];
  const pts: { id: string; x: number; y: number }[] = [];
  let n = 0;
  const scale = Math.max(1, ...curves.flatMap((c) => (c.kind === "line" ? [...c.a, ...c.b] : [...c.center])).map(Math.abs));
  const tol = scale * 1e-6;
  const point = (x: number, y: number, shared = true) => {
    if (shared) {
      const hit = pts.find((p) => Math.hypot(p.x - x, p.y - y) < tol);
      if (hit) return hit.id;
    }
    const id = `p${++n}`;
    pts.push({ id, x, y });
    entities.push({ id, type: "point", x, y });
    return id;
  };
  let k = 0;
  for (const c of curves) {
    if (c.kind === "line") {
      if (Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]) < tol) continue;
      entities.push({ id: `l${++k}`, type: "line", p1: point(...c.a), p2: point(...c.b) });
    } else if (c.kind === "circle") {
      entities.push({ id: `c${++k}`, type: "circle", center: point(...c.center, false), radius: c.radius });
    } else {
      const s = point(c.center[0] + c.radius * Math.cos(c.a0), c.center[1] + c.radius * Math.sin(c.a0));
      const e = point(c.center[0] + c.radius * Math.cos(c.a1), c.center[1] + c.radius * Math.sin(c.a1));
      entities.push({ id: `a${++k}`, type: "arc", center: point(...c.center, false), start: s, end: e });
    }
  }
  return { entities, constraints: [] };
}

/** Basic SVG import: line, rect, circle, polyline, polygon and paths (curves become polylines). */
export function readSvg(text: string): Curve2[] {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.querySelector("svg");
  if (!svg) return [];
  const vb = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const width = svg.getAttribute("width") ?? "";
  const unitScale = (() => {
    const m = /^([\d.]+)\s*(mm|cm|in|px)?$/.exec(width);
    if (m && vb.length === 4 && vb[2]) {
      const mm = Number(m[1]) * ({ mm: 1, cm: 10, in: 25.4, px: 25.4 / 96 }[m[2] ?? "px"] ?? 25.4 / 96);
      return mm / vb[2];
    }
    return 25.4 / 96;
  })();
  const out: Curve2[] = [];
  const P = (x: number, y: number): [number, number] => [x * unitScale, -y * unitScale];
  const num = (el: Element, a: string) => Number(el.getAttribute(a) ?? 0);
  const poly = (pts: [number, number][], closed: boolean) => {
    for (let i = 0; i + 1 < pts.length; i++) out.push({ kind: "line", a: P(...pts[i]!), b: P(...pts[i + 1]!) });
    if (closed && pts.length > 2) out.push({ kind: "line", a: P(...pts.at(-1)!), b: P(...pts[0]!) });
  };
  for (const el of svg.querySelectorAll("line,rect,circle,polyline,polygon,path")) {
    switch (el.tagName.toLowerCase()) {
      case "line":
        out.push({ kind: "line", a: P(num(el, "x1"), num(el, "y1")), b: P(num(el, "x2"), num(el, "y2")) });
        break;
      case "rect": {
        const [x, y, w, h] = [num(el, "x"), num(el, "y"), num(el, "width"), num(el, "height")];
        poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
        break;
      }
      case "circle": {
        const c = P(num(el, "cx"), num(el, "cy"));
        out.push({ kind: "circle", center: c, radius: num(el, "r") * unitScale });
        break;
      }
      case "polyline":
      case "polygon": {
        const ns = (el.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number);
        const pts: [number, number][] = [];
        for (let i = 0; i + 1 < ns.length; i += 2) pts.push([ns[i]!, ns[i + 1]!]);
        poly(pts, el.tagName.toLowerCase() === "polygon");
        break;
      }
      case "path":
        for (const sub of pathPolylines(el.getAttribute("d") ?? "")) poly(sub.pts, sub.closed);
        break;
    }
  }
  return out;
}

function pathPolylines(d: string): { pts: [number, number][]; closed: boolean }[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const subs: { pts: [number, number][]; closed: boolean }[] = [];
  let cur: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];
  let pts: [number, number][] = [];
  let cmd = "";
  let i = 0;
  const n = () => Number(tokens[i++]);
  const flush = (closed: boolean) => {
    if (pts.length > 1) subs.push({ pts, closed });
    pts = [];
  };
  const bezier = (ctrl: [number, number][], to: [number, number]) => {
    const all = [cur, ...ctrl, to];
    for (let s = 1; s <= 12; s++) {
      const t = s / 12;
      let layer = all;
      while (layer.length > 1) layer = layer.slice(1).map((p, k) => [layer[k]![0] + (p[0] - layer[k]![0]) * t, layer[k]![1] + (p[1] - layer[k]![1]) * t] as [number, number]);
      pts.push(layer[0]!);
    }
    cur = to;
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i]!)) cmd = tokens[i++]!;
    const rel = cmd === cmd.toLowerCase();
    const at = (x: number, y: number): [number, number] => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    switch (cmd.toUpperCase()) {
      case "M":
        flush(false);
        cur = at(n(), n());
        start = cur;
        pts = [cur];
        cmd = rel ? "l" : "L";
        break;
      case "L":
        cur = at(n(), n());
        pts.push(cur);
        break;
      case "H":
        cur = [rel ? cur[0] + n() : n(), cur[1]];
        pts.push(cur);
        break;
      case "V":
        cur = [cur[0], rel ? cur[1] + n() : n()];
        pts.push(cur);
        break;
      case "C":
        bezier([at(n(), n()), at(n(), n())], at(n(), n()));
        break;
      case "Q":
        bezier([at(n(), n())], at(n(), n()));
        break;
      case "S":
      case "T":
        bezier(cmd.toUpperCase() === "S" ? [at(n(), n())] : [], at(n(), n()));
        break;
      case "A": {
        n(); n(); n(); n(); n();
        cur = at(n(), n());
        pts.push(cur);
        break;
      }
      case "Z":
        if (pts.length) pts.push(start);
        cur = start;
        flush(false);
        break;
      default:
        i++;
    }
  }
  flush(false);
  return subs;
}
