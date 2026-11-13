/**
 * Mesh parts made editable. "Convert to editable body" adds a mesh_convert step: flat, round,
 * conical and spherical areas of the triangles become real faces. "Rebuild with features" rebuilds
 * a layered part as dimensioned sketches and extrudes with parameters, next to the mesh (hidden);
 * a part lying at an angle is built upright and turned back into place.
 */
import { fitMesh, reconstruct } from "@meercad/kernel/fit";
import { nextFeatureId, type FeatureStatus } from "@meercad/model";
import type { DocOp, Feature } from "@meercad/schema";
import { apply, currentDoc, editFeature, toast, useApp } from "../store";
import { partName } from "./features";
import { fmtVolume } from "./units";
import { t } from "./i18n";

export function convertMeshPart(bodyId: string): void {
  const doc = currentDoc();
  const name = partName(bodyId, doc.features);
  const existing = doc.features.find((feature) => feature.op === "mesh_convert" && feature.body === bodyId);

  if (existing) {
    const status = useApp.getState().output?.report.features.find((status) => status.id === existing.id);

    if (status?.status === "error") {
      toast(
        t("Converting {name} failed: {error}", {
          name,
          error: (status.message ?? t("unknown error")) + (status.hint ? ` (${status.hint})` : ""),
        }),
        "error",
      );
      editFeature(existing.id);
    } else {
      toast(t("{name} is already converted by step {step}", { name, step: existing.id }));
    }

    return;
  }

  const id = nextFeatureId(doc, "mesh_convert");
  if (!apply({ type: "add_features", features: [{ id, op: "mesh_convert", body: bodyId }] })) return;

  useApp.setState({ selection: [] });
  toast(t("Converting {name}…", { name }));
  void statusOf(id).then((status) => {
    if (!status) return;

    if (status.status === "error") {
      toast(
        t(
          "Converting {name} failed: {error}. The mesh stays as it was; raise the tolerance in step {step} or undo.",
          {
            name,
            error: (status.message ?? t("unknown error")) + (status.hint ? ` (${status.hint})` : ""),
            step: id,
          },
        ),
        "error",
      );
      editFeature(id);
    } else {
      toast(
        t("{name} has editable faces now{details}. Undo brings the mesh back.", {
          name,
          details: status.message ? ` (${status.message})` : "",
        }),
      );
    }
  });
}

export async function rebuildMeshPart(bodyId: string): Promise<void> {
  const state = useApp.getState();
  const mesh = state.output?.meshes.find((mesh) => mesh.bodyId === bodyId);
  const doc = currentDoc();
  const name = partName(bodyId, doc.features);
  if (!mesh) return toast(t("{name} is not in the model", { name }), "error");

  let n = 1;
  while (doc.features.some((feature) => feature.id.startsWith(`rb${n}_`))) n++;

  const prefix = `rb${n}`;
  let plan: ReturnType<typeof reconstruct>;
  let meshVolume: number;

  try {
    // The fit takes the triangles' corners; the display mesh shares its vertices through `indices`
    // (an imported STL's happen to come one per corner, a converted part's do not).
    const corners = new Float32Array(mesh.indices.length * 3);

    for (let i = 0; i < mesh.indices.length; i++) {
      corners.set(mesh.positions.subarray(mesh.indices[i]! * 3, mesh.indices[i]! * 3 + 3), i * 3);
    }

    const fit = fitMesh(corners);
    meshVolume = fit.volume;
    plan = reconstruct(fit, { prefix });
  } catch (error) {
    return toast(
      t("Could not rebuild {name}: {error}", {
        name,
        error: error instanceof Error ? error.message : String(error),
      }),
      "error",
    );
  }

  const ops: DocOp[] = Object.entries(plan.params).map(([param, expr]) => ({
    type: "set_param",
    name: param,
    expr,
    auto: true,
  }));
  ops.push({ type: "add_features", features: plan.features as Feature[] });
  if (!apply(...ops)) return;

  useApp.setState({ selection: [] });

  const result = await builtVolume(prefix, plan.body);
  if (!result) return toast(t("Rebuilt {name} with {n} steps.", { name, n: plan.features.length }));
  if (result.error) return toast(t("Rebuilt {name}, but {error}", { name, error: result.error }), "error");

  // The mesh stays as the reference to compare against, hidden.
  useApp.setState((state) => ({ hidden: new Set([...state.hidden, bodyId]) }));

  const off = Math.abs(result.volume - meshVolume) / meshVolume;
  toast(
    t(
      "Rebuilt {name} from {n} steps with {params} parameters; {volume}{warnings}. The mesh is hidden; show it from the parts list to compare.",
      {
        name,
        n: plan.features.length,
        params: Object.keys(plan.params).length,
        volume:
          off < 0.01
            ? t("same volume as the mesh")
            : t("volume {built} against {mesh} in the mesh", {
                built: fmtVolume(result.volume),
                mesh: fmtVolume(meshVolume),
              }),
        warnings: plan.warnings.length ? ` (${plan.warnings.join("; ")})` : "",
      },
    ),
    off < 0.05 ? "info" : "error",
  );
}

/**
 * The feature's status once a rebuild that includes it has finished (null after 60 s or when it was removed).
 */
function statusOf(id: string): Promise<FeatureStatus | null> {
  return waitFor(() => {
    const state = useApp.getState();
    if (!state.doc.features.some((feature) => feature.id === id)) return null;
    if (state.building) return undefined;

    const status = state.output?.report.features.find((status) => status.id === id);

    return !status || status.status === "rolled_back" ? undefined : status;
  });
}

/** Volume of the rebuilt body, or the first step that failed. */
function builtVolume(prefix: string, body: string): Promise<{ volume: number; error?: string } | null> {
  return waitFor(() => {
    const state = useApp.getState();
    if (!state.doc.features.some((feature) => feature.id === body)) return null;

    const out = state.output;
    if (state.building || !out) return undefined;

    const failed = out.report.features.find(
      (status) => status.id.startsWith(`${prefix}_`) && status.status === "error",
    );

    if (failed) {
      return {
        volume: 0,
        error: t("step {step} failed: {error}", { step: failed.id, error: failed.message ?? "" }),
      };
    }

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
