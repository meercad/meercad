/**
 * What assistants can do beyond the document ops, through the MCP bridge: the checks and tools the
 * app has in its menus (interference, wall thickness, deviation, mesh clean-up and rebuild, measuring
 * on scans, joints from gears), files in and out as the app makes them, the parts shown, projects
 * and folders, examples, terrains. Each runs the app's own code, so the user sees what happens.
 */
import { compareShapes, nearestTriangle, shapeAt, shapeValues } from "@meercad/kernel/fit";
import { restored } from "@meercad/model";
import type { MeercadDocument } from "@meercad/schema";
import { filamentsOf, importFile, meshExportFiles, stepFile, variantFiles, type MeshFormat } from "../components/io";
import { currentDoc, getViewport, kernel, newProject, rebuildNow, refreshProjects, renameProject, useApp } from "../store";
import { showDeviation, hideDeviation, useDeviation, TOLERANCE } from "./deviation";
import { EXAMPLES, examplePacks } from "./examples";
import { hasPack } from "./premium";
import { partName } from "./features";
import { t } from "./i18n";
import { jointsFromGears } from "./mechanism";
import { rebuildMeshPart } from "./meshConvert";
import { importOf, runMeshRepair, useMeshRepair } from "./meshRepair";
import { createFolder, listFolders, moveProject } from "./persistence";
import { scanOf } from "./scanMeasure";
import { placeAt, setOnTerrain, useTerrainPlace } from "./terrain";
import { hideThickness, setMinWall, showThickness, useThickness } from "./thickness";
import { checkPart, hidePrintCheck, layDown, setOverhangLimit, showPrintCheck } from "./printability";

type Vec3 = [number, number, number];
const round = (v: number, d = 3) => +v.toFixed(d);
const vec = (v: readonly number[]) => v.map((x) => round(x));

export { lightDocument, restoreElided } from "./elide";
import { lightDocument } from "./elide";

/** A saved version's design (light, like get_model), without restoring it. */
export function versionDocument(name: string): MeercadDocument {
  const doc = currentDoc();
  const v = doc.versions?.find((x) => x.name === name);
  if (!v) throw new Error(`no version "${name}"; saved: ${(doc.versions ?? []).map((x) => x.name).join(", ") || "none"}`);
  return lightDocument(restored(doc, v));
}

// ---------------------------------------------------------------- what the app said

/** Runs `fn` and returns the messages the app showed meanwhile (the tools report through them). */
async function said(fn: () => unknown): Promise<{ messages: { text: string; error: boolean }[] }> {
  const before = new Set(useApp.getState().toasts.map((x) => x.id));
  await fn();
  return { messages: useApp.getState().toasts.filter((x) => !before.has(x.id)).map((x) => ({ text: x.text, error: x.kind === "error" })) };
}

function wait<T>(check: () => T | null | undefined, ms = 120_000): Promise<T> {
  const until = performance.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = check();
      if (v !== undefined && v !== null) return resolve(v);
      if (performance.now() > until) return reject(new Error("timed out"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

const needPart = (id: string) => {
  if (!useApp.getState().output?.report.bodies.some((b) => b.id === id)) throw new Error(`no part "${id}"; parts: ${useApp.getState().output?.report.bodies.map((b) => b.id).join(", ")}`);
  return id;
};

// ---------------------------------------------------------------- checks

/** Every part against every other, where they are modelled: overlaps with their volume, and touching pairs. */
/**
 * `parts`: only pairs with one of these; `box`: only parts reaching into it. A design of hundreds
 * of parts has thousands of pairs: what is not done after `seconds` is counted, not waited for.
 */
export async function interference(opts: { parts?: string[]; box?: { min: Vec3; max: Vec3 }; seconds?: number } = {}) {
  const out = await rebuildNow();
  const ids = out.report.bodies.map((b) => b.id);
  if (ids.length < 2) return { overlaps: [], touching: [], note: "only one part" };
  const unknown = opts.parts?.filter((id) => !ids.includes(id)) ?? [];
  if (unknown.length) throw new Error(`no part ${unknown.map((id) => `"${id}"`).join(", ")}`);
  const { pairs, left } = await kernel.overlaps(opts.parts?.length ? opts.parts : ids, { ...(opts.box ? { box: opts.box } : {}), budgetMs: (opts.seconds ?? 120) * 1000 });
  const name = (id: string) => partName(id, currentDoc().features);
  return {
    overlaps: pairs.filter((p) => p.overlap > 1e-3).sort((a, b) => b.overlap - a.overlap).map((p) => ({ a: p.a, b: p.b, names: [name(p.a), name(p.b)], overlapMm3: round(p.overlap) })),
    touching: pairs.filter((p) => p.overlap <= 1e-3 && p.distance < 1e-4).map((p) => [p.a, p.b]),
    ...(left ? { unchecked: left, note: `Out of time: ${left} pairs of parts close to each other were not checked. Narrow the check with parts (ids) or box ({min, max}), or give it more seconds.` } : {}),
  };
}

/** Wall thickness of a part against the wall a printer needs; the colour map stays shown unless `show` is false. */
export async function wallThickness(part: string, minWall = 1, show = true) {
  await rebuildNow();
  needPart(part);
  useThickness.setState({ stats: null, error: undefined });
  setMinWall(minWall);
  showThickness(part);
  const stats = await wait(() => {
    const s = useThickness.getState();
    if (s.error) throw new Error(s.error);
    return s.stats && s.stats.minWall === minWall && s.body === part ? s.stats : null;
  });
  if (!show) hideThickness();
  return { part, minWall, thinnestMm: Number.isFinite(stats.min) ? round(stats.min) : null, ...(stats.absoluteMin !== undefined && Number.isFinite(stats.absoluteMin) ? { smallestRayMm: round(stats.absoluteMin) } : {}), ...(stats.at ? { thinnestAt: vec(stats.at) } : {}), shareThinnerThanMinWall: round(stats.thin, 4), shown: show };
}

/**
 * Printability of a part on an FDM printer as it stands (down = -Z): overhangs steeper than `limit`
 * degrees from vertical, rough support volume, and the best way up found. `turn` turns it first:
 * "best", or the direction (in the part's coordinates now) that should go onto the bed.
 */
export async function printCheck(part: string, opts: { limit?: number; show?: boolean; turn?: "best" | Vec3 }) {
  await rebuildNow();
  needPart(part);
  const limit = opts.limit ?? 45;
  let turned: Awaited<ReturnType<typeof said>> | undefined;
  if (opts.turn) {
    const down = opts.turn === "best" ? checkPart(part, limit)?.stats.best?.down : opts.turn;
    turned = await said(() => (down ? layDown(part, down) : undefined));
    if (!down) turned.messages.push({ text: "already the best way up", error: false });
    await rebuildNow();
  }
  const r = checkPart(part, limit);
  if (!r) throw new Error(`no part "${part}"`);
  if (opts.show !== false) {
    hideThickness();
    hideDeviation();
    setOverhangLimit(limit);
    showPrintCheck(part);
  } else hidePrintCheck();
  const s = r.stats;
  return {
    part,
    limitDeg: limit,
    overhangMm2: round(s.overhangArea, 1),
    overhangShare: round(s.overhangShare, 4),
    supportMm3: round(s.supportVolume, 0),
    onBedMm2: round(s.plateArea, 1),
    heightMm: round(s.height, 2),
    best: s.best ? { down: vec(s.best.down), supportMm3: round(s.best.supportVolume, 0), onBedMm2: round(s.best.plateArea, 1), heightMm: round(s.best.height, 2) } : "as it stands",
    ...(turned ? { turned: turned.messages } : {}),
    shown: opts.show !== false,
  };
}

/** How far a part's surface is from a mesh (a scan it was modelled after). */
export async function deviation(part: string, mesh: string, show = true) {
  await rebuildNow();
  needPart(part);
  needPart(mesh);
  useDeviation.setState({ stats: null, error: undefined });
  showDeviation(part, mesh);
  const stats = await wait(() => {
    const s = useDeviation.getState();
    if (s.error) throw new Error(s.error);
    return s.stats && s.body === part ? s.stats : null;
  });
  if (!show) hideDeviation();
  return { part, mesh, minMm: round(stats.min), maxMm: round(stats.max), shareWithinTolerance: round(stats.within, 4), toleranceMm: stats.tolerance ?? TOLERANCE, shown: show };
}

// ---------------------------------------------------------------- meshes

/** Cleans up an imported mesh: loose pieces, holes, and (with `reduce`, a tolerance in mm) fewer triangles. */
export async function repairMesh(part: string, opts: { removePieces?: boolean; fillHoles?: boolean; reduce?: number }) {
  await rebuildNow();
  if (!importOf(part)) throw new Error(`"${part}" is not an imported mesh (only STL/3MF/OBJ/scan imports can be cleaned up)`);
  useMeshRepair.setState({ body: part, removePieces: opts.removePieces ?? true, fillHoles: opts.fillHoles ?? true, reduce: !!opts.reduce, tolerance: opts.reduce || useMeshRepair.getState().tolerance });
  const r = await said(runMeshRepair);
  await rebuildNow();
  return r;
}

/** Rebuilds a mesh part from sketches and extrudes fitted to it; the mesh stays, hidden, to compare. */
export async function rebuildMesh(part: string) {
  await rebuildNow();
  needPart(part);
  const before = new Set(currentDoc().features.map((f) => f.id));
  const r = await said(() => rebuildMeshPart(part));
  return { ...r, added: currentDoc().features.filter((f) => !before.has(f.id)).map((f) => f.id) };
}

/** The plane, cylinder, cone or sphere a mesh follows at a point (within `tolerance` mm), and between two such. */
export async function measureScan(part: string, point: Vec3, other?: { part?: string; point: Vec3 }, tolerance = 0.1) {
  await rebuildNow();
  const shape = (id: string, p: Vec3) => {
    const m = scanOf(needPart(id));
    const s = m ? shapeAt(m, nearestTriangle(m, p), tolerance) : null;
    if (!s) throw new Error(`no plane, cylinder, cone or sphere fits at [${p.join(", ")}] on ${id} within ${tolerance} mm; raise tolerance for rough scans`);
    return s;
  };
  const values = (vs: { label: string; value: number; unit: string }[]) => vs.map((v) => ({ [v.label]: `${round(v.value)} ${v.unit}` }));
  const a = shape(part, point);
  if (!other) return { shape: a.kind, values: values(shapeValues(a)) };
  const b = shape(other.part ?? part, other.point);
  return { a: { shape: a.kind, values: values(shapeValues(a)) }, b: { shape: b.kind, values: values(shapeValues(b)) }, between: values(compareShapes(a, b)) };
}

// ---------------------------------------------------------------- mechanism

export async function gearJoints() {
  await rebuildNow();
  const n = jointsFromGears();
  return { jointsAdded: n, joints: currentDoc().mechanism?.joints.map((j) => j.id) ?? [], couplings: currentDoc().mechanism?.couplings?.map((c) => `${c.driver} → ${c.driven} × ${c.ratio}`) ?? [] };
}

// ---------------------------------------------------------------- files

/** Imports a file as the app does (also DXF/SVG as a sketch, and .meercad as a new project). */
export async function importBytes(name: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const before = new Set(currentDoc().features.map((f) => f.id));
  const project = useApp.getState().project?.id;
  const r = await said(() => importFile(new File([bytes], name)));
  if (useApp.getState().project?.id !== project) return { ...r, openedProject: useApp.getState().project };
  useApp.setState({ sketchId: null });
  return { ...r, added: currentDoc().features.filter((f) => !before.has(f.id)).map((f) => f.id) };
}

export interface ExportOptions {
  parts?: string[];
  posed?: boolean;
  variants?: boolean;
  name?: string;
  /** 3MF: materials, colours and filament slots; default the app's setting (off). */
  materials?: boolean;
}

/** The files of an export as the app makes them: names, colours, materials and filaments, visible parts, poses, variants. */
export async function exportFiles(format: MeshFormat | "step", o: ExportOptions): Promise<{ files: Record<string, Uint8Array>; filaments?: { slot: number; material?: string; color: string }[] }> {
  await rebuildNow();
  if (o.variants) return { files: await variantFiles(format, undefined, o.parts, o.materials) };
  if (format === "step") return { files: { [`${o.name ?? "model"}.step`]: (await stepFile({ ...(o.parts ? { parts: o.parts } : {}), ...(o.posed !== undefined ? { posed: o.posed } : {}) })).data } };
  const r = await meshExportFiles(format, { ...(o.parts ? { parts: o.parts } : {}), ...(o.posed !== undefined ? { posed: o.posed } : {}), ...(o.name ? { name: o.name } : {}), ...(o.materials !== undefined ? { materials: o.materials } : {}) });
  const filaments = format === "3mf" ? filamentsOf(r.meshes, o.materials) : [];
  return { files: r.files, ...(filaments.length > 1 ? { filaments: filaments.map((f, i) => ({ slot: i + 1, ...f })) } : {}) };
}

// ---------------------------------------------------------------- what is shown

/** Hides or shows parts in the user's view (not saved with the design). */
export function setVisibility(p: { hide?: string[]; show?: string[]; only?: string[]; all?: boolean }) {
  const ids = useApp.getState().output?.report.bodies.map((b) => b.id) ?? [];
  let hidden = new Set(useApp.getState().hidden);
  if (p.all) hidden = new Set();
  if (p.only) hidden = new Set(ids.filter((id) => !p.only!.includes(id)));
  for (const id of p.hide ?? []) hidden.add(id);
  for (const id of p.show ?? []) hidden.delete(id);
  useApp.setState({ hidden });
  return { hidden: [...hidden], shown: ids.filter((id) => !hidden.has(id)) };
}

// ---------------------------------------------------------------- projects

export async function renameOpenProject(name: string) {
  await renameProject(name);
  return { project: useApp.getState().project };
}

export async function folders() {
  return { folders: await listFolders(), current: useApp.getState().project?.folder ?? "" };
}

export async function newFolder(parent: string, name: string) {
  return { folder: await createFolder(parent, name) };
}

export async function moveOpenProject(folder: string) {
  const p = useApp.getState().project;
  if (!p) throw new Error("No project is open.");
  const meta = await moveProject(p.id, folder);
  useApp.setState({ project: { ...p, ...meta } });
  await refreshProjects();
  return { project: useApp.getState().project };
}

/** The examples the user's app shows: those its packs can show and change. */
const shownExamples = () => EXAMPLES.filter((e) => examplePacks(e).every(hasPack));

export const examples = () => shownExamples().map((e, i) => ({ id: i, name: e.name, description: e.description }));

/** Opens an example as a new project (a copy: the example itself never changes). */
export async function openExample(which: number | string) {
  const list = shownExamples();
  const ex = typeof which === "number" ? list[which] : list.find((e) => e.name.toLowerCase() === String(which).toLowerCase());
  if (!ex) throw new Error(`no example ${String(which)}; see list_examples`);
  const doc = ex.url ? ((await (await fetch(ex.url)).json()) as MeercadDocument) : structuredClone(ex.doc);
  await newProject(doc, t(ex.name));
  return { project: useApp.getState().project };
}

// ---------------------------------------------------------------- terrains

/** The shown terrains once the viewport has loaded them (opening a project decodes them in the background). */
async function terrainReady() {
  if (!(currentDoc().references ?? []).some((r) => !r.hidden)) throw new Error("no terrain or scanned area is shown in this design");
  return wait(() => getViewport()?.sceneryBox() ?? null, 60_000);
}

/** Ground heights of the shown terrains at x/y points (mm, design coordinates; null where there is none), and their extent. */
export async function terrainHeights(points: [number, number][]) {
  const box = await terrainReady();
  const vp = getViewport()!;
  return {
    extent: { min: vec(box.min), max: vec(box.max) },
    points: points.map(([x, y]) => {
      const h = vp.sceneryHeight(x, y);
      return { x, y, z: h === null ? null : round(h) };
    }),
  };
}

/** Stands a part on the terrain: under where it is, or at x/y (its lowest point on the ground plus `offset` mm). */
export async function placeOnTerrain(part: string, at?: [number, number], offset = 0) {
  await rebuildNow();
  needPart(part);
  await terrainReady();
  const r = await said(() => {
    if (!at) return setOnTerrain(part);
    const z = getViewport()?.sceneryHeight(at[0], at[1]);
    if (z === null || z === undefined) throw new Error(`there is no terrain at [${at.join(", ")}]`);
    useTerrainPlace.setState({ body: part, offset, move: null });
    placeAt([at[0], at[1], z]);
  });
  const out = await rebuildNow();
  const b = out.report.bodies.find((x) => x.id === part);
  return { ...r, ...(b ? { bbox: { min: vec(b.bbox.min), max: vec(b.bbox.max) } } : {}) };
}

/** A terrain from a folder of drone photos on this Mac (minutes); it is added to the open design. */
export async function photoTerrain(folder: string) {
  const { desktop } = await import("./persistence");
  if (!desktop) throw new Error("models from photos are built by the Mac app");
  const { buildTerrain } = await import("./terrain");
  const before = new Set((currentDoc().references ?? []).map((r) => r.id));
  const r = await said(() => buildTerrain(folder));
  const added = (currentDoc().references ?? []).filter((x) => !before.has(x.id));
  return { ...r, added: added.map((x) => ({ id: x.id, name: x.name })) };
}
