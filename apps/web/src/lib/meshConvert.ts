/**
 * Mesh parts made editable. "Convert to editable body" adds a mesh_convert step: flat, round,
 * conical and spherical areas of the triangles become real faces. "Rebuild with features" rebuilds
 * a layered part as dimensioned sketches and extrudes with parameters, next to the mesh (hidden).
 */
import { fitMesh, reconstruct } from "@meercad/kernel/fit";
import { nextFeatureId, type FeatureStatus } from "@meercad/model";
import type { DocOp, Feature } from "@meercad/schema";
import { apply, currentDoc, editFeature, toast, useApp } from "../store";
import { partName } from "./features";
import { fmtVolume } from "./units";

export function convertMeshPart(bodyId: string): void {
  const doc = currentDoc();
  const name = partName(bodyId, doc.features);
  const existing = doc.features.find((f) => f.op === "mesh_convert" && f.body === bodyId);
  if (existing) {
    const st = useApp.getState().output?.report.features.find((f) => f.id === existing.id);
    if (st?.status === "error") {
      toast(`Converting ${name} failed: ${st.message ?? "unknown error"}${st.hint ? ` (${st.hint})` : ""}`, "error");
      editFeature(existing.id);
    } else toast(`${name} is already converted by step ${existing.id}`);
    return;
  }
  const id = nextFeatureId(doc, "mesh_convert");
  if (!apply({ type: "add_features", features: [{ id, op: "mesh_convert", body: bodyId }] })) return;
  useApp.setState({ selection: [] });
  toast(`Converting ${name}…`);
  void statusOf(id).then((st) => {
    if (!st) return;
    if (st.status === "error") {
      toast(`Converting ${name} failed: ${st.message ?? "unknown error"}${st.hint ? ` (${st.hint})` : ""}. The mesh stays as it was; raise the tolerance in step ${id} or undo.`, "error");
      editFeature(id);
    } else toast(`${name} has editable faces now${st.message ? ` (${st.message})` : ""}. Undo brings the mesh back.`);
  });
}

export async function rebuildMeshPart(bodyId: string): Promise<void> {
  const s = useApp.getState();
  const mesh = s.output?.meshes.find((m) => m.bodyId === bodyId);
  const doc = currentDoc();
  const name = partName(bodyId, doc.features);
  if (!mesh) return toast(`${name} is not in the model`, "error");
  let n = 1;
  while (doc.features.some((f) => f.id.startsWith(`rb${n}_`))) n++;
  const prefix = `rb${n}`;
  let plan: ReturnType<typeof reconstruct>;
  let meshVolume: number;
  try {
    const fit = fitMesh(mesh.positions);
    meshVolume = fit.volume;
    plan = reconstruct(fit, { prefix });
  } catch (e) {
    return toast(`Could not rebuild ${name}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
  const ops: DocOp[] = Object.entries(plan.params).map(([param, expr]) => ({ type: "set_param", name: param, expr, auto: true }));
  ops.push({ type: "add_features", features: plan.features as Feature[] });
  if (!apply(...ops)) return;
  useApp.setState({ selection: [] });
  // Layers are fused into the first one.
  const body = `${prefix}_ex1`;
  const result = await builtVolume(prefix, body);
  if (!result) return toast(`Rebuilt ${name} with ${plan.features.length} steps.`);
  if (result.error) return toast(`Rebuilt ${name}, but ${result.error}`, "error");
  // The mesh stays as the reference to compare against, hidden.
  useApp.setState((st) => ({ hidden: new Set([...st.hidden, bodyId]) }));
  const off = Math.abs(result.volume - meshVolume) / meshVolume;
  toast(
    `Rebuilt ${name} from ${plan.features.length} steps with ${Object.keys(plan.params).length} parameters; ${off < 0.01 ? "same volume as the mesh" : `volume ${fmtVolume(result.volume)} against ${fmtVolume(meshVolume)} in the mesh`}${plan.warnings.length ? ` (${plan.warnings.join("; ")})` : ""}. The mesh is hidden; show it from the parts list to compare.`,
    off < 0.05 ? "info" : "error",
  );
}

/** The feature's status once a rebuild that includes it has finished (null after 60 s or when it was removed). */
function statusOf(id: string): Promise<FeatureStatus | null> {
  return waitFor(() => {
    const s = useApp.getState();
    if (!s.doc.features.some((f) => f.id === id)) return null;
    if (s.building) return undefined;
    const st = s.output?.report.features.find((f) => f.id === id);
    return !st || st.status === "rolled_back" ? undefined : st;
  });
}

/** Volume of the rebuilt body, or the first step that failed. */
function builtVolume(prefix: string, body: string): Promise<{ volume: number; error?: string } | null> {
  return waitFor(() => {
    const s = useApp.getState();
    if (!s.doc.features.some((f) => f.id === body)) return null;
    const out = s.output;
    if (s.building || !out) return undefined;
    const failed = out.report.features.find((f) => f.id.startsWith(`${prefix}_`) && f.status === "error");
    if (failed) return { volume: 0, error: `step ${failed.id} failed: ${failed.message ?? ""}` };
    const b = out.report.bodies.find((x) => x.id === body);
    return b && Number.isFinite(b.volume) ? { volume: b.volume } : undefined;
  });
}

/** Resolves with what `check` returns once it is not undefined (null after 60 s). */
function waitFor<T>(check: () => T | null | undefined): Promise<T | null> {
  return new Promise((resolve) => {
    const first = check();
    if (first !== undefined) return resolve(first);
    const stop = useApp.subscribe(() => {
      const v = check();
      if (v === undefined) return;
      stop();
      clearTimeout(timer);
      resolve(v);
    });
    const timer = setTimeout(() => {
      stop();
      resolve(null);
    }, 60000);
  });
}
