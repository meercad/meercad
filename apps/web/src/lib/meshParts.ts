/**
 * Parts made from an imported mesh (STL, 3MF, OBJ). They are edited as whole parts: combined, cut,
 * moved or patterned, but their faces (thousands of triangles) are not picked or edited one by one.
 * A part counts as a mesh when any of its faces still descends from a mesh import, so cutting or
 * moving it keeps it one.
 */
import type { Feature } from "@meercad/schema";

export function meshBodyIds(features: readonly Feature[], meshes: readonly { bodyId: string; faceTags: string[][] }[]): Set<string> {
  const ids = features.filter((f) => f.op === "import" && f.format === "stl").map((f) => `${f.id}.`);
  const out = new Set<string>();
  if (!ids.length) return out;
  for (const m of meshes) if (m.faceTags.some((tags) => tags.some((t) => ids.some((id) => t.startsWith(id))))) out.add(m.bodyId);
  return out;
}

/** Feature tools that work on single faces or edges, which mesh parts do not offer. */
export const FACE_TOOLS = new Set(["fillet", "chamfer", "shell", "thread", "extrude", "sketch", "plane"]);

export const MESH_HINT = "Imported meshes are edited as whole parts: combine, cut, move or pattern them. For editable faces, right-click or long-press the part: Convert to editable body, or Rebuild with features.";
