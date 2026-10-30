/**
 * Delete key on the model. What gets removed depends on what was picked, so the history stays
 * meaningful: a whole part becomes a Delete step, a rounded or bevelled face drops that edge from
 * its fillet/chamfer, a hole or boss drops its region from the extrude, and anything else offers to
 * delete the feature that made it.
 */
import { t, tn } from "./i18n";
import type { DocOp, EdgeSelector, Feature } from "@meercad/schema";
import type { Pick } from "@meercad/viewport";
import { askConfirm } from "../components/Ask";
import { deleteFeature } from "../components/FeatureTree";
import { apply, currentDoc, toast, useApp } from "../store";
import { nextFeatureId } from "@meercad/model";
import { featureName } from "./features";

type FacePick = Extract<Pick, { kind: "face" }>;

/** Bodies whose every face is in the selection (a double-clicked part). */
function wholeBodies(selection: Pick[]): string[] {
  const meshes = useApp.getState().output?.meshes ?? [];
  const byBody = new Map<string, Set<number>>();
  for (const p of selection) if (p.kind === "face") byBody.set(p.bodyId, (byBody.get(p.bodyId) ?? new Set()).add(p.face));
  return [...byBody].filter(([id, faces]) => meshes.find((m) => m.bodyId === id)?.faceTags.length === faces.size).map(([id]) => id);
}

export function deleteBodies(bodies: string[]): void {
  if (!bodies.length) return;
  const id = nextFeatureId(currentDoc(), "delete");
  if (apply({ type: "add_features", features: [{ id, op: "delete", bodies }] })) {
    useApp.setState({ selection: [] });
    toast(tn(bodies.length, "Deleted part {parts} — undo with ⌘Z", "Deleted parts {parts} — undo with ⌘Z", { parts: bodies.join(", ") }));
  }
}

const sameEdge = (s: EdgeSelector, a: string, b: string) => "edge" in s && ((s.edge[0] === a && s.edge[1] === b) || (s.edge[0] === b && s.edge[1] === a));

/** One op that removes what a face stands for, or a reason why it can't be done that way. */
/** Fillets and chamfers on the edges of a face that is going away would fail; drop those edges too. */
function cleanupEdgesOf(tag: string): DocOp[] {
  const ops: DocOp[] = [];
  for (const f of currentDoc().features) {
    if (f.op !== "fillet" && f.op !== "chamfer") continue;
    const edges = (Array.isArray(f.edges) ? f.edges : [f.edges]) as EdgeSelector[];
    const rest = edges.filter((s) => !JSON.stringify(s).includes(JSON.stringify(tag)));
    if (rest.length === edges.length) continue;
    ops.push(rest.length ? { type: "edit_feature", id: f.id, patch: { edges: rest } } : { type: "delete_feature", id: f.id });
  }
  return ops;
}

function opForFace(p: FacePick): { op: DocOp | null; extra?: DocOp[]; feature: Feature; what: string } | { problem: string; feature?: Feature } {
  const doc = currentDoc();
  const tag = p.tags[0];
  if (!tag) return { problem: t("This face has no name to work with") };
  const owner = doc.features.find((f) => f.id === tag.split(/[.@[]/)[0]);
  if (!owner) return { problem: t("Could not find the feature that made this face") };
  const copy = /@([\w-]+)\.\d+$/.exec(tag);
  if (copy) {
    const pattern = doc.features.find((f) => f.id === copy[1]);
    return { problem: t("This is a copy made by {name}. Lower its count, or delete the pattern.", { name: pattern ? featureName(pattern) : copy[1]! }), ...(pattern ? { feature: pattern } : {}) };
  }
  // Rounded / bevelled face: drop that edge from the fillet or chamfer.
  const edge = /^[\w-]+\.(?:round|bevel)\[(.+)\|(.+)\]$/.exec(tag);
  if (edge && (owner.op === "fillet" || owner.op === "chamfer")) {
    const [, a, b] = edge as unknown as [string, string, string];
    const edges = (Array.isArray(owner.edges) ? owner.edges : [owner.edges]) as EdgeSelector[];
    const rest = edges.filter((s) => !sameEdge(s, a, b));
    if (rest.length === edges.length) return { problem: t("{name} selects its edges as a group, so one edge can't be removed alone.", { name: featureName(owner) }), feature: owner };
    return rest.length
      ? { op: { type: "edit_feature", id: owner.id, patch: { edges: rest } }, feature: owner, what: owner.op === "fillet" ? t("the fillet on this edge") : t("the chamfer on this edge") }
      : { op: { type: "delete_feature", id: owner.id }, feature: owner, what: featureName(owner) };
  }
  // Hole or boss wall from a sketch circle (or other closed curve): drop its region from the extrude.
  const side = /^[\w-]+\.side\[([\w-]+)\.([\w-]+)\]$/.exec(tag);
  if (side && (owner.op === "extrude" || owner.op === "revolve") && "sketch" in owner.profile) {
    const [, sketchId, curveId] = side as unknown as [string, string, string];
    const view = useApp.getState().output?.report.sketches.find((s) => s.id === sketchId);
    if (view) {
      const all = view.regions.filter((r) => r.depth % 2 === 1).map((r) => r.key);
      const current = Array.isArray(owner.profile.regions) ? owner.profile.regions : all;
      const outer = (key: string) => key.split("|")[0]!.split("+");
      const rest = current.filter((k) => !outer(k).includes(curveId));
      if (rest.length < current.length) {
        const what = owner.op === "extrude" && owner.mode === "cut" ? t("this hole") : t("this shape");
        const op: DocOp = rest.length
          ? { type: "edit_feature", id: owner.id, patch: { profile: { sketch: sketchId, regions: rest } } }
          : { type: "delete_feature", id: owner.id };
        return { op, extra: cleanupEdgesOf(tag), feature: owner, what };
      }
    }
  }
  return { problem: t("This face is part of {name}.", { name: featureName(owner) }), feature: owner };
}

/** Delete key / menu entry for whatever is selected on the model. */
export async function deleteModelSelection(): Promise<void> {
  const { selection, selectedFeature, doc } = useApp.getState();
  if (!selection.length) {
    const f = selectedFeature ? doc.features.find((x) => x.id === selectedFeature) : undefined;
    if (f) await deleteFeature(f);
    return;
  }
  const bodies = wholeBodies(selection);
  if (bodies.length) return deleteBodies(bodies);

  const faces = selection.filter((p): p is FacePick => p.kind === "face");
  if (!faces.length) {
    toast(selection.some((p) => p.kind === "edge") ? t("Edges can't be deleted on their own — select a face, or double-click to select the whole part") : t("Nothing here can be deleted"));
    return;
  }
  const ops: DocOp[] = [];
  const whats: string[] = [];
  const done = new Set<string>();
  for (const p of faces) {
    const r = opForFace(p);
    if ("problem" in r) {
      // Fall back to the owning feature, after asking.
      if (faces.length === 1 && r.feature) {
        const ok = await askConfirm({ title: t("Delete {name}?", { name: featureName(r.feature) }), message: t("{problem} Deleting the whole feature removes everything it made.", { problem: r.problem }), confirmLabel: t("Delete {name}", { name: featureName(r.feature) }), danger: true });
        if (ok) await deleteFeature(r.feature);
      } else toast(r.problem, "error");
      return;
    }
    if (!r.op) continue;
    whats.push(r.what);
    // Several faces of the same feature: re-derive from the updated document after applying.
    for (const op of [r.op, ...(r.extra ?? [])]) {
      const key = JSON.stringify(op);
      if (done.has(key)) continue;
      done.add(key);
      ops.push(op);
    }
  }
  if (ops.length === 1 || new Set(ops.map((o) => ("id" in o ? o.id : ""))).size === ops.length) {
    if (apply(...ops)) {
      useApp.setState({ selection: [] });
      toast(t("Deleted {what} — undo with ⌘Z", { what: whats.length === 1 ? whats[0]! : t("{n} items", { n: whats.length }) }));
    }
    return;
  }
  // Several faces from one feature (e.g. two holes of one cut): apply one at a time.
  let count = 0;
  for (const p of faces) {
    const r = opForFace(p);
    if (!("problem" in r) && r.op && apply(r.op, ...(r.extra ?? []))) count++;
  }
  useApp.setState({ selection: [] });
  toast(t("Deleted {what} — undo with ⌘Z", { what: count === 1 ? whats[0]! : t("{n} items", { n: count }) }));
}
