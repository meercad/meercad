/**
 * Parts made from an imported mesh (STL, 3MF, OBJ). They are edited as whole parts: combined, cut,
 * moved or patterned, but their faces (thousands of triangles) are not picked or edited one by one.
 * A part counts as a mesh when any of its faces still descends from a mesh import, so cutting or
 * moving it keeps it one.
 */
import type { Feature } from "@meercad/schema";
import { t } from "./i18n";

export function meshBodyIds(
  features: readonly Feature[],
  meshes: readonly { bodyId: string; faceTags: string[][] }[],
): Set<string> {
  const ids = features
    .filter((feature) => feature.op === "import" && feature.format === "stl")
    .map((feature) => `${feature.id}.`);
  const out = new Set<string>();
  if (!ids.length) return out;

  for (const m of meshes) {
    if (m.faceTags.some((tags) => tags.some((t) => ids.some((id) => t.startsWith(id))))) out.add(m.bodyId);
  }

  return out;
}

/** Feature tools that work on single faces or edges, which mesh parts do not offer. */
export const FACE_TOOLS = new Set([
  "fillet",
  "chamfer",
  "shell",
  "thread",
  "hole",
  "extrude",
  "sketch",
  "plane",
]);

/** Why a mesh part's faces cannot be picked, and the way to editable faces. */
export const meshHint = (): string =>
  t(
    "Imported meshes are edited as whole parts: combine, cut, move or pattern them. For editable faces, right-click or long-press the part: Convert to editable body, or Rebuild with features.",
  );
