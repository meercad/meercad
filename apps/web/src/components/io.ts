/** File import/export and share links. */
import { filamentSlots, objFiles, read3mf, readDxf, readGlb, readObj, write3mf, writeDxf, writeObj, writeRobot, writeStl, writeSvg, writeUsdz, writeZip, type Curve2, type ObjMesh, type RobotActuator, type RobotLink, type RobotPart, type TexturedMesh } from "@meercad/io";
import type { BodyMesh } from "@meercad/kernel";
import { showNotice } from "./Ask";
import { usePrefs } from "../lib/keymap";
import { partColors } from "../lib/partColors";
import { partName } from "../lib/features";
import { applyOp, designOf, massOf, materialById, motion, nextFeatureId, partMaterial } from "@meercad/model";
import { threeMfParts } from "../lib/printParts";
import { emptyDocument, validateDocument, type Feature, type MeercadDocument, type MeshTexture, type SketchConstraint, type SketchEntity } from "@meercad/schema";
import { nativeApp, shareFile, showInAr } from "../lib/native";
import { desktop } from "../lib/persistence";
import { apply, currentDoc, flushSave, holdRebuilds, kernel, newProject, openSketch, rebuildNow, scheduleRebuild, startTask, toast, useApp } from "../store";
import { t } from "../lib/i18n";
import { currentMechanism, currentPoses } from "../lib/mechanism";
import { sceneryOf } from "../lib/terrain";
import { exportTexture } from "../lib/meshTexture";

const FILTERS: Record<string, { name: string; extensions: string[] }> = {
  stl: { name: t("STL mesh"), extensions: ["stl"] },
  "3mf": { name: t("3MF package"), extensions: ["3mf"] },
  obj: { name: t("OBJ mesh"), extensions: ["obj"] },
  step: { name: t("STEP model"), extensions: ["step", "stp"] },
  dxf: { name: t("DXF drawing"), extensions: ["dxf"] },
  svg: { name: t("SVG drawing"), extensions: ["svg"] },
  ocad: { name: t("meerCAD part"), extensions: ["meercad", "meerCAD"] },
  zip: { name: t("Zip archive"), extensions: ["zip"] },
  png: { name: t("PNG picture"), extensions: ["png"] },
};

/** Saves a file: a save dialog on the Mac, the share sheet on the iPad. */
export function download(name: string, data: BlobPart): void {
  if (nativeApp) {
    const payload = typeof data === "string" ? data : data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    void shareFile(name, payload).catch((e: Error) => toast(t("Could not share {name}: {error}", { name, error: e.message }), "error"));
    return;
  }
  const ext = name.split(".").pop() ?? "";
  const payload = typeof data === "string" ? data : data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
  void desktop?.saveFile({ name, data: payload, ...(FILTERS[ext] ? { filters: [FILTERS[ext]!] } : {}) }).then((path) => path && toast(t("Saved {path}", { path })));
}

export const baseName = () => (useApp.getState().project?.name ?? "model").replace(/[^\w\- ]+/g, "").trim() || "model";

/** The document with parts drawn see-through (or not). */
export function seeThroughDoc(doc: MeercadDocument, parts: readonly string[], on: boolean): MeercadDocument {
  const set = new Set(doc.seeThrough ?? []);
  for (const p of parts) on ? set.add(p) : set.delete(p);
  const next: MeercadDocument = { ...doc, seeThrough: [...set] };
  if (!set.size) delete next.seeThrough;
  return next;
}

/** Parts moved in the joints panel, where they are shown: exports take them as they are seen. */
function shownPoses(ids: readonly string[]): Map<string, number[]> {
  return new Map([...currentPoses()].filter(([id, m]) => ids.includes(id) && motion.isMoved(m)));
}

/** The parts an export takes: the ones asked for, else every part not hidden. */
function exportIds(parts?: readonly string[]): string[] {
  const hidden = useApp.getState().hidden;
  const all = useApp.getState().output?.report.bodies.map((b) => b.id) ?? [];
  if (!parts) return all.filter((id) => !hidden.has(id));
  const unknown = parts.filter((p) => !all.includes(p));
  if (unknown.length) throw new Error(t("unknown part {id}", { id: unknown.join(", ") }));
  return [...parts];
}

/**
 * The files of an STL/3MF/OBJ export from a print-quality tessellation (the on-screen one is far
 * coarser), named `name`.ext; OBJ also takes the visible terrains and scans with their pictures.
 * `posed` (default) takes moved parts where they are shown. `moved` tells whether any were.
 */
export async function meshExportFiles(format: MeshFormat, opts: { parts?: readonly string[]; posed?: boolean; name?: string } = {}): Promise<{ files: Record<string, Uint8Array>; moved: boolean; meshes: BodyMesh[] }> {
  const name = opts.name ?? baseName();
  const ids = exportIds(opts.parts);
  const surroundings = format === "obj" && !opts.parts && (currentDoc().references ?? []).some((r) => !r.hidden);
  if (!ids.length && !surroundings) throw new Error(t("Nothing to export"));
  const poses = opts.posed === false ? new Map<string, number[]>() : shownPoses(ids);
  const meshes = ids.length ? (await kernel.exportMeshes(ids)).map((m) => (poses.has(m.bodyId) ? motion.placeMesh(m, poses.get(m.bodyId)!) : m)) : [];
  if (format === "obj") return { files: objExport(name, meshes, surroundings), moved: poses.size > 0, meshes };
  return { files: { [`${name}.${format}`]: meshFile(format, meshes) }, moved: poses.size > 0, meshes };
}

export async function exportMesh(format: MeshFormat): Promise<void> {
  try {
    const { files, moved, meshes } = await meshExportFiles(format);
    if (moved) toast(t("Exported as shown: moved parts are where they are now"), "info");
    const names = Object.keys(files);
    if (names.length > 1) toast(t("Exported as a zip: the OBJ with its materials and pictures"), "info");
    download(names.length > 1 ? `${baseName()}.zip` : names[0]!, (names.length > 1 ? writeZip(files) : files[names[0]!]!) as BlobPart);
    if (format === "3mf") tellFilaments(meshes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === t("Nothing to export")) return toast(msg, "error");
    toast(t("{format} export failed: {error}", { format: format.toUpperCase(), error: msg }), "error");
  }
}

/**
 * The parts as USDZ for AR: each with its colour and its material's sheen, moved parts where
 * they are shown, standing on the table in real size (see writeUsdz).
 */
export async function usdzFile(opts: { parts?: readonly string[]; posed?: boolean } = {}): Promise<Uint8Array> {
  const ids = exportIds(opts.parts);
  if (!ids.length) throw new Error(t("Nothing to export"));
  const poses = opts.posed === false ? new Map<string, number[]>() : shownPoses(ids);
  const meshes = (await kernel.exportMeshes(ids)).map((m) => (poses.has(m.bodyId) ? motion.placeMesh(m, poses.get(m.bodyId)!) : m));
  const doc = currentDoc();
  const colors = partColors(doc, meshes.map((m) => m.bodyId), usePrefs.getState().colorParts);
  return writeUsdz(
    meshes.map((m) => {
      const look = partMaterial(doc, m.bodyId)?.look;
      return {
        positions: m.positions,
        indices: m.indices,
        normals: m.normals,
        name: partName(m.bodyId, doc.features),
        ...(colors.get(m.bodyId) ? { color: colors.get(m.bodyId)! } : {}),
        ...(look ? { metalness: look.metalness, roughness: look.roughness } : {}),
      };
    }),
  );
}

/**
 * The AR preview: on iPhone and iPad the parts stand on the table in real size (AR Quick Look);
 * on the Mac and in the browser, where there is no AR, the USDZ is saved to open on an iPhone or
 * iPad (AirDrop, Messages, Files all show it in AR).
 */
export async function viewInAr(): Promise<void> {
  const task = startTask(t("Preparing the AR view"));
  try {
    const data = await usdzFile();
    const name = `${baseName()}.usdz`;
    task.done();
    if (nativeApp) return await showInAr(name, data);
    download(name, data as BlobPart);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    toast(msg === t("Nothing to export") ? msg : t("{format} export failed: {error}", { format: "USDZ", error: msg }), "error");
  } finally {
    task.done();
  }
}

/** Options of a robot export (MJCF/URDF); the menu uses none of them. */
export interface RobotExportOptions {
  /** Model and file name; default the project's name. */
  name?: string;
  /** A free joint for links that hang on nothing (a walking robot). Default true. */
  floating?: boolean;
  /** Grams per part, e.g. bought motors or printed parts with their infill; others by material. */
  masses?: Readonly<Record<string, number>>;
  /** Drive data by joint id (effort, velocity, kp, kv, armature, damping, friction). */
  actuators?: Readonly<Record<string, RobotActuator>>;
}

/**
 * The design as a robot for simulation and robot learning: MJCF (MuJoCo, mjlab) and URDF with one
 * STL per part (see writeRobot). Parts held by fixed joints become one link, turning and sliding
 * joints become the robot's joints, each link gets its mass, centre of gravity and inertia. Parts
 * without a material count as PLA. The parts at rest, the screen's tessellation (light meshes).
 */
export async function robotFiles(opts: RobotExportOptions = {}): Promise<{ files: Record<string, Uint8Array>; links: RobotLink[]; warnings: string[] }> {
  await rebuildNow();
  const out = useApp.getState().output;
  const doc = currentDoc();
  const bodies = out?.report.bodies ?? [];
  if (!out || !bodies.length) throw new Error(t("Nothing to export"));
  const ids = bodies.map((b) => b.id);
  const unknown = Object.keys(opts.masses ?? {}).filter((id) => !ids.includes(id));
  if (unknown.length) throw new Error(t("unknown part {id}", { id: unknown.join(", ") }));
  const meshes = new Map(out.meshes.map((m) => [m.bodyId, m]));
  const colors = partColors(doc, ids, true);
  const pla = materialById("pla")!;
  const warnings: string[] = [];
  const plain: string[] = [];
  const parts: RobotPart[] = [];
  for (const b of bodies) {
    const mesh = meshes.get(b.id);
    if (!mesh || !Number.isFinite(b.volume) || b.volume <= 0) continue;
    const material = partMaterial(doc, b.id);
    if (!material && opts.masses?.[b.id] === undefined) plain.push(b.id);
    const mass = opts.masses?.[b.id] ?? massOf(b.volume, material ?? pla);
    const [lo, hi] = [b.bbox.min, b.bbox.max];
    const centroid = b.centroid ?? ([0, 1, 2].map((k) => (lo[k]! + hi[k]!) / 2) as [number, number, number]);
    // The kernel's moments are of the volume (mm⁵); without them, the box around the part.
    const [x, y, z] = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const k = mass / b.volume;
    const m = b.inertia;
    const inertia: RobotPart["inertia"] = m ? [m[0] * k, m[1] * k, m[2] * k, m[3] * k, m[4] * k, m[5] * k] : [(mass * (y * y + z * z)) / 12, (mass * (x * x + z * z)) / 12, (mass * (x * x + y * y)) / 12, 0, 0, 0];
    const color = colors.get(b.id);
    parts.push({ id: b.id, name: partName(b.id, doc.features), mesh: { positions: mesh.positions, indices: mesh.indices }, ...(color ? { color } : {}), mass, centroid, inertia });
  }
  if (plain.length) warnings.push(`${plain.length} parts have no material and count as PLA (${plain.slice(0, 6).join(", ")}${plain.length > 6 ? ", …" : ""})`);
  const { mech, problems } = currentMechanism();
  for (const [id, msg] of Object.entries(problems)) warnings.push(`joint ${id} left out: ${msg}`);
  const name = (opts.name ?? baseName()).replace(/[^\w\-]+/g, "_") || "robot";
  const r = writeRobot(
    parts,
    mech.joints.map((j) => ({ id: j.id, type: j.type, a: j.a, b: j.b, origin: j.origin, axis: j.axis, ...(j.limits ? { limits: j.limits } : {}) })),
    mech.couplings.map((c) => ({ driver: c.driver, driven: c.driven, ratio: c.ratio })),
    { name, ...(opts.floating !== undefined ? { floating: opts.floating } : {}), ...(opts.actuators ? { actuators: opts.actuators } : {}) },
  );
  return { files: r.files, links: r.links, warnings: [...warnings, ...r.warnings] };
}

/** The robot export from the menu: a zip with the MJCF, the URDF and the meshes. */
export async function exportRobot(): Promise<void> {
  const task = startTask(t("Preparing the robot for simulation"));
  try {
    const { files, links, warnings } = await robotFiles();
    task.done();
    download(`${baseName()} robot.zip`, writeZip(files) as BlobPart);
    const joints = links.filter((l) => l.joint).length;
    void showNotice({
      title: t("Robot exported: {links} links, {joints} joints", { links: links.length, joints }),
      message: `${t("The zip holds an MJCF file for MuJoCo and mjlab, a URDF for ROS and Isaac Sim, and one mesh per part. Masses come from the parts' materials; joints without drive data are passive.")}${warnings.length ? `\n\n${warnings.join("\n")}` : ""}`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    toast(msg === t("Nothing to export") ? msg : t("{format} export failed: {error}", { format: "MJCF/URDF", error: msg }), "error");
  } finally {
    task.done();
  }
}

export type MeshFormat = "stl" | "3mf" | "obj";

/** Parts for OBJ, with their names and colours, and scans with their pictures (unless switched off). */
function objParts(meshes: readonly BodyMesh[]): (ObjMesh & { image?: { data: Uint8Array; mime: string } })[] {
  const { doc } = useApp.getState();
  const colors = partColors(doc, meshes.map((m) => m.bodyId), usePrefs.getState().colorParts);
  return meshes.map((m) => {
    const tex = exportTexture(doc.features, m);
    return { positions: m.positions, indices: m.indices, name: partName(m.bodyId, doc.features), ...(tex ? { uvs: tex.uvs, image: tex.image } : colors.get(m.bodyId) ? { color: colors.get(m.bodyId)! } : {}) };
  });
}

/**
 * The visible reference models (terrains from drone photos, scanned areas) as meshes in design
 * coordinates, with their pictures or vertex colours and their size correction.
 */
function surroundingMeshes(): (TexturedMesh & { name: string })[] {
  const doc = currentDoc();
  const views = sceneryOf(doc);
  return (doc.references ?? []).flatMap((r) => {
    const view = views.find((v) => v.id === r.id);
    if (r.hidden || !view) return [];
    const pieces = readGlb(new Uint8Array(view.data));
    return pieces.map((m, k) => {
      if (r.scale && r.scale !== 1) {
        const p = new Float32Array(m.positions);
        for (let i = 0; i < p.length; i++) p[i] = p[i]! * r.scale;
        m = { ...m, positions: p };
      }
      return { ...m, name: pieces.length > 1 ? `${r.name} ${k + 1}` : r.name };
    });
  });
}

/** The files of an OBJ export: the parts, and with `surroundings` the visible terrains and scans. */
export function objExport(name: string, meshes: readonly BodyMesh[], surroundings: boolean): Record<string, Uint8Array> {
  return objFiles(name, [...objParts(meshes), ...(surroundings ? surroundingMeshes() : [])]);
}

/** After a 3MF with several filaments: which slot gets which material, to set up in the slicer. */
/** The filaments a 3MF of these parts asks for, in slot order (material and colour). */
export function filamentsOf(meshes: readonly BodyMesh[]) {
  const doc = currentDoc();
  const colors = partColors(doc, meshes.map((m) => m.bodyId), usePrefs.getState().colorParts);
  return filamentSlots(threeMfParts(doc, meshes, colors)).filaments;
}

function tellFilaments(meshes: readonly BodyMesh[]): void {
  const filaments = filamentsOf(meshes);
  if (filaments.length < 2) return;
  const lines = filaments.map((f, i) => t("Filament {n}: {material} {color}", { n: i + 1, material: f.material ?? t("any material"), color: f.color }));
  void showNotice({ title: t("{n} filaments assigned", { n: filaments.length }), message: `${lines.join("\n")}\n\n${t("Load these filaments in the slicer in this order; each part is already assigned to its filament.")}` });
}

/** Parts as an STL, or a 3MF or OBJ with their names and colours. */
function meshFile(format: MeshFormat, meshes: BodyMesh[]): Uint8Array {
  if (format === "stl") return writeStl(meshes);
  const { doc } = useApp.getState();
  const colors = partColors(doc, meshes.map((m) => m.bodyId), usePrefs.getState().colorParts);
  if (format === "obj") return new TextEncoder().encode(writeObj(objParts(meshes)));
  return write3mf(threeMfParts(doc, meshes, colors));
}

/**
 * Every variant exported at once, one file each in a zip ("holder-Pipe 25.stl", …). The kernel
 * builds each variant in turn; afterwards the design is built as it is again.
 */
export async function exportVariants(format: MeshFormat | "step"): Promise<void> {
  if (!(currentDoc().variants ?? []).length) return toast(t("This design has no variants"), "error");
  const task = startTask(t("Exporting {n} variants", { n: currentDoc().variants!.length }));
  try {
    download(`${baseName()}-${t("variants")}.zip`, writeZip(await variantFiles(format, (k, n) => task.update(k / n))) as BlobPart);
  } catch (e) {
    toast(t("{format} export failed: {error}", { format: format.toUpperCase(), error: e instanceof Error ? e.message : String(e) }), "error");
  } finally {
    task.done();
  }
}

/**
 * Every variant as a file of its own ("holder-Pipe 25.stl", …). The kernel builds each variant in
 * turn; afterwards the design is built as it is again.
 */
export async function variantFiles(format: MeshFormat | "step", progress?: (k: number, n: number) => void, parts?: readonly string[]): Promise<Record<string, Uint8Array>> {
  const doc = currentDoc();
  const variants = doc.variants ?? [];
  if (!variants.length) throw new Error(t("This design has no variants"));
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").trim();
  const files: Record<string, Uint8Array> = {};
  holdRebuilds(true);
  try {
    for (const [k, v] of variants.entries()) {
      progress?.(k, variants.length);
      const out = await kernel.rebuild({ ...designOf(doc), variant: v.name }, { props: false });
      const failed = out.report.features.find((f) => f.status === "error");
      if (failed) throw new Error(t("variant “{name}” does not build: {error}", { name: v.name, error: failed.message ?? "" }));
      const hidden = useApp.getState().hidden;
      const ids = out.report.bodies.map((b) => b.id).filter((id) => (parts ? parts.includes(id) : !hidden.has(id)));
      const file = `${safe(baseName())}-${safe(v.name)}.${format}`;
      if (format === "obj") {
        const obj = objExport(`${safe(baseName())}-${safe(v.name)}`, await kernel.exportMeshes(ids), false);
        Object.assign(files, obj);
      } else files[file] = format === "step" ? await kernel.exportStep(ids, stepParts().filter((p) => ids.includes(p.id))) : meshFile(format, await kernel.exportMeshes(ids));
    }
    return files;
  } finally {
    holdRebuilds(false);
    scheduleRebuild();
  }
}

/** Each part's name and colour for STEP, so other CAD tools show the parts list and colours. */
export function stepParts(): { id: string; name: string; color?: string }[] {
  const { doc, output } = useApp.getState();
  const ids = output?.report.bodies.map((b) => b.id) ?? [];
  const colors = partColors(doc, ids, true);
  return ids.map((id) => ({ id, name: partName(id, doc.features), ...(colors.get(id) ? { color: colors.get(id)! } : {}) }));
}

/** A STEP file of the parts (default: the ones not hidden), moved parts where they are shown unless `posed` is false. */
export async function stepFile(opts: { parts?: readonly string[]; posed?: boolean } = {}): Promise<{ data: Uint8Array; moved: boolean }> {
  const ids = exportIds(opts.parts);
  const poses = opts.posed === false ? new Map<string, number[]>() : shownPoses(ids);
  const data = await kernel.exportStep(ids, stepParts().filter((p) => ids.includes(p.id)).map((p) => (poses.has(p.id) ? { ...p, pose: poses.get(p.id)! } : p)));
  return { data, moved: poses.size > 0 };
}

export async function exportStep(): Promise<void> {
  try {
    const { data, moved } = await stepFile();
    if (moved) toast(t("Exported as shown: moved parts are where they are now"), "info");
    download(`${baseName()}.step`, data as BlobPart);
    if (currentDoc().features.some((f) => (f.op === "texture" || f.op === "lithophane") && !f.suppressed)) toast(t("STEP keeps the smooth faces: surface textures come along in STL, 3MF and OBJ"), "info");
  } catch (e) {
    toast(t("{format} export failed: {error}", { format: "STEP", error: e instanceof Error ? e.message : String(e) }), "error");
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
  if (!curves.length) return toast(t("The sketch has no geometry"), "error");
  if (format === "dxf") download(`${baseName()}-${sketchId}.dxf`, writeDxf(curves));
  else download(`${baseName()}-${sketchId}.svg`, writeSvg(curves));
}

export function saveFile(): void {
  download(`${baseName()}.meercad`, JSON.stringify(currentDoc(), null, 2));
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
export async function importFile(file?: File | null, opts: { seeThrough?: boolean; texture?: MeshTexture } = {}): Promise<boolean> {
  file ??= await pickFile(IMPORT_TYPES);
  if (!file) return false;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const base = file.name.replace(/\.\w+$/, "");
  if (ext === "meercad" || ext === "json") {
    const json = JSON.parse(await file.text()) as unknown;
    // A design some scripts write wrapped as {name, document} comes in too.
    const inner = json && typeof json === "object" && !("format" in json) && "document" in json ? (json as { name?: unknown; document: unknown }) : null;
    const raw = inner ? inner.document : json;
    // Files written by scripts may leave out what an empty design has.
    const v = validateDocument(raw && typeof raw === "object" ? { params: {}, rollback: null, ...raw } : raw);
    if (!v.ok) {
      toast(t("Not a valid meerCAD file: {error}", { error: String(v.errors[0]) }), "error");
      return false;
    }
    await flushSave();
    await newProject(v.value, inner && typeof inner.name === "string" && inner.name ? inner.name : base);
    return true;
  }
  if (!["step", "stp", "stl", "3mf", "obj", "dxf", "svg"].includes(ext)) {
    toast(t("Unsupported file type .{ext}", { ext }), "error");
    return false;
  }
  if (file.size > 40 * 1024 * 1024) {
    toast(t("File is larger than 40 MB"), "error");
    return false;
  }
  // Build the features first, so a file that cannot be read starts no empty design.
  let features: Feature[];
  const reading = startTask(t("Reading {name}", { name: file.name }));
  try {
    features = await importFeatures(file, ext);
  } catch (e) {
    toast(t("Could not import {name}: {error}", { name: file.name, error: e instanceof Error ? e.message : String(e) }), "error");
    return false;
  } finally {
    reading.done();
  }
  if (useApp.getState().screen !== "editor" || !useApp.getState().project) await newProject(emptyDocument(), base);
  // A scan's picture goes onto its mesh (one mesh per file, so it is the first import).
  const mesh = features.find((f) => f.op === "import" && f.format === "stl");
  if (opts.texture && mesh?.op === "import") mesh.texture = opts.texture;
  const doc = currentDoc();
  let n = 0;
  for (const f of features) f.id = nextFeatureId({ ...doc, features: [...doc.features, ...features.slice(0, n++)] }, f.op === "sketch" ? "sketch" : "import");
  const add = { type: "add_features" as const, features };
  // A part to model against (a scan) comes in see-through, in the same step.
  const meshes = opts.seeThrough ? features.filter((f) => f.op === "import").map((f) => f.id) : [];
  if (!(meshes.length ? apply({ type: "replace", doc: seeThroughDoc(applyOp(doc, add), meshes, true) }) : apply(add))) return false;
  const sketch = features.find((f) => f.op === "sketch");
  if (sketch) {
    openSketch(sketch.id);
    return true;
  }
  toast(t("Importing {name}…", { name: file.name }));
  const out = await rebuildNow().catch(() => null);
  const failed = out?.report.features.filter((r) => features.some((f) => f.id === r.id) && r.status === "error") ?? [];
  if (failed.length) toast(t("Import of {name} failed: {error}", { name: file.name, error: failed[0]!.message ?? t("unknown error") }), "error");
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
  if (!curves.length) throw new Error(t("no supported geometry found in the file"));
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
