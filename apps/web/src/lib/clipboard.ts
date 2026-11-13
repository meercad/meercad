/**
 * Selecting, copying and pasting whole parts: ⌘A selects every shown part, ⌘C / ⌘X keep the
 * selected parts, ⌘V puts copies in, ⌘D duplicates at once. In the same project a copy is a Move
 * step that copies (it stays parametric and follows the original's changes); in another project the
 * parts come in as a mesh of their current shape. Every action is also in the part menus, so the
 * iPad without a keyboard has it too.
 */
import { nextFeatureId } from "@meercad/model";
import type { Feature } from "@meercad/schema";
import type { Pick } from "@meercad/viewport";
import { writeStl } from "@meercad/io";
import { apply, currentDoc, toast, useApp } from "../store";
import { importFile } from "../components/io";
import { deleteBodies } from "./deletion";
import { partName } from "./features";
import { t, tn } from "./i18n";

/** Parts whose every face is selected (a double-clicked or listed part). */
export function selectedParts(selection: readonly Pick[] = useApp.getState().selection): string[] {
  const meshes = useApp.getState().output?.meshes ?? [];
  const faces = new Map<string, Set<number>>();

  for (const pick of selection) {
    if (pick.kind === "face") faces.set(pick.bodyId, (faces.get(pick.bodyId) ?? new Set()).add(pick.face));
  }

  return [...faces]
    .filter(([id, f]) => meshes.find((mesh) => mesh.bodyId === id)?.faceTags.length === f.size)
    .map(([id]) => id);
}

/** Selects whole parts (all their faces), replacing the selection or adding to it. */
export function selectParts(ids: readonly string[], add = false, keepFeature = false): void {
  const state = useApp.getState();
  const picks: Pick[] = [];

  for (const id of ids) {
    const mesh = state.output?.meshes.find((x) => x.bodyId === id);
    if (!mesh) continue;

    const c = mesh.positions;
    const point: [number, number, number] = [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
    mesh.faceTags.forEach((tags, face) =>
      picks.push({ kind: "face", bodyId: id, face, tags, point, normal: null }),
    );
  }

  useApp.setState({
    selection: add
      ? [...state.selection.filter((pick) => !(pick.kind === "face" && ids.includes(pick.bodyId))), ...picks]
      : picks,
    ...(keepFeature ? {} : { selectedFeature: null }),
  });
}

export function selectAll(): void {
  const state = useApp.getState();
  const ids = (state.output?.meshes ?? []).map((mesh) => mesh.bodyId).filter((id) => !state.hidden.has(id));
  if (!ids.length) return;

  selectParts(ids);
  toast(tn(ids.length, "{n} part selected", "{n} parts selected"));
}

/**
 * What was copied: the parts, the project they are in, and their shape at that moment (for other projects).
 */
let clip: { project: string; parts: string[]; stl: Uint8Array; name: string } | null = null;
let pastes = 0;

export const hasClip = (): boolean => !!clip;

export function copyParts(ids = selectedParts()): boolean {
  const state = useApp.getState();
  const meshes = (state.output?.meshes ?? []).filter((mesh) => ids.includes(mesh.bodyId));

  if (!meshes.length || !state.project) {
    toast(t("Select a part first (double-click it, or pick it in the list)."), "error");

    return false;
  }

  const name =
    ids.length === 1 ? partName(ids[0]!, currentDoc().features) : t("{n} parts", { n: ids.length });
  clip = { project: state.project.id, parts: ids, stl: writeStl(meshes) as Uint8Array, name };
  pastes = 0;
  toast(tn(ids.length, "Copied {n} part", "Copied {n} parts"));

  return true;
}

export function cutParts(): void {
  const ids = selectedParts();
  if (copyParts(ids)) deleteBodies(ids);
}

/** Puts in copies of what was copied, a little beside the original (further with each paste). */
export async function pasteParts(): Promise<void> {
  if (!clip) return toast(t("Nothing copied yet."), "error");

  const state = useApp.getState();
  const doc = currentDoc();
  const here =
    state.project?.id === clip.project &&
    clip.parts.every((id) => state.output?.meshes.some((mesh) => mesh.bodyId === id));

  if (!here) {
    // Another project (or the parts are gone): their shape as a mesh part.
    const ok = await importFile(new File([clip.stl as BlobPart], `${clip.name}.stl`, { type: "model/stl" }));
    if (ok) toast(t("Pasted {name} as a mesh part.", { name: clip.name }));

    return;
  }

  // Beside the originals: their width plus a gap, along X.
  let lo = Infinity,
    hi = -Infinity;

  for (const mesh of state.output!.meshes.filter((x) => clip!.parts.includes(x.bodyId))) {
    for (let i = 0; i < mesh.positions.length; i += 3) {
      ((lo = Math.min(lo, mesh.positions[i]!)), (hi = Math.max(hi, mesh.positions[i]!)));
    }
  }

  const step = Math.round((hi - lo) * 1.2 + 5);
  pastes++;

  const id = nextFeatureId(doc, "transform");

  if (
    !apply({
      type: "add_features",
      features: [
        {
          id,
          op: "transform",
          name: clip.parts.length === 1 ? t("Copy of {name}", { name: clip.name }) : t("Copy"),
          bodies: clip.parts,
          translate: [step * pastes, 0, 0],
          copy: true,
        } as Feature,
      ],
    })
  ) {
    return;
  }

  // The copies (ids from the Move step) become the selection, ready to be moved.
  setTimeout(() => selectParts(clip!.parts.map((p) => `${id}_${p}`)), 400);
}

export function duplicateParts(): void {
  if (copyParts()) void pasteParts();
}
