/**
 * Cleaning up an imported mesh (a scan): loose bits removed, holes closed, triangles reduced
 * within a tolerance. The cleaned triangles replace the file stored in the import step, in one
 * step that undo takes back.
 */
import { repairMesh } from "@meercad/kernel/fit";
import { parseStl, writeStl } from "@meercad/io";
import { create } from "zustand";
import { apply, currentDoc, startTask, toast, useApp } from "../store";
import { partName } from "./features";
import { t } from "./i18n";

export const useMeshRepair = create<{
  body: string | null;
  removePieces: boolean;
  fillHoles: boolean;
  reduce: boolean;
  tolerance: number;
}>(() => ({
  body: null,
  removePieces: true,
  fillHoles: true,
  reduce: true,
  tolerance: 0.05,
}));

export const openMeshRepair = (body: string) => useMeshRepair.setState({ body });
export const closeMeshRepair = () => useMeshRepair.setState({ body: null });

/** The import step whose file a mesh part comes from, or null for a mesh changed by other steps. */
export function importOf(body: string) {
  const f = currentDoc().features.find((x) => x.id === body);

  return f?.op === "import" && f.format === "stl" ? f : null;
}

export async function runMeshRepair(): Promise<void> {
  const { body, removePieces, fillHoles, reduce, tolerance } = useMeshRepair.getState();
  if (!body) return;

  const f = importOf(body);
  const name = partName(body, currentDoc().features);
  if (!f) return toast(t("{name} is not an imported mesh", { name }), "error");

  const task = startTask(t("Cleaning up {name}", { name }));
  // Let the task show before the work blocks the page.
  await new Promise((r) => setTimeout(r, 30));

  try {
    const mesh = parseStl(Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)));
    const corners = new Float32Array(mesh.indices.length * 3);

    for (let i = 0; i < mesh.indices.length; i++) {
      corners.set(mesh.positions.subarray(mesh.indices[i]! * 3, mesh.indices[i]! * 3 + 3), i * 3);
    }

    const out = repairMesh(corners, { removePieces, fillHoles, reduce: reduce ? tolerance : 0 });
    const { report } = out;

    if (!report.piecesRemoved && !report.holesFilled && report.after === report.before) {
      return toast(t("{name} needed no clean-up", { name }));
    }

    let s = "";
    const bytes = writeStl([{ positions: out.positions, indices: out.indices }]);
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));

    // The picture belongs to the old triangles: it goes (undo brings both back).
    if (
      !apply({
        type: "edit_feature",
        id: f.id,
        patch: { data: btoa(s), ...(f.texture ? { texture: null } : {}) },
      })
    ) {
      return;
    }

    closeMeshRepair();
    toast(
      t(
        "{name}: {before} → {after} triangles, {pieces} loose pieces removed, {holes} holes closed. Undo brings the original back.",
        {
          name,
          before: report.before.toLocaleString(),
          after: report.after.toLocaleString(),
          pieces: report.piecesRemoved,
          holes: report.holesFilled,
        },
      ) + (f.texture ? ` ${t("Its texture was removed, as it belonged to the old triangles.")}` : ""),
    );
  } catch (e) {
    toast(
      t("Could not clean up {name}: {error}", { name, error: e instanceof Error ? e.message : String(e) }),
      "error",
    );
  } finally {
    task.done();
  }
}

// Another project or the part gone: close the card.
useApp.subscribe((s, prev) => {
  const body = useMeshRepair.getState().body;

  if (body && (s.project?.id !== prev.project?.id || !s.doc.features.some((f) => f.id === body))) {
    closeMeshRepair();
  }
});
