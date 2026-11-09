/** Part colours: the ones the user picked, their materials' colours, and a palette for the rest so parts tell apart. */
import { partMaterial } from "@meercad/model";
import type { MeercadDocument } from "@meercad/schema";

/**
 * Strong, mid-light colours that stay apart from each other, from the selection blue and orange, and
 * from the dark edges on both backgrounds; the first is the usual part grey.
 */
export const PART_PALETTE = ["#6c7178", "#e9b949", "#3fae6a", "#d6517d", "#2aa3a8", "#8a63d2", "#e0604f", "#9cba3c", "#b07a4f", "#c86fb0"] as const;

/**
 * Colour of every part ("#rrggbb" by body id): the one picked for it, else its material's own
 * colour (carbon, wood, metal, an own material's), else the palette in parts-list order.
 */
export function partColors(doc: MeercadDocument, bodyIds: readonly string[], auto: boolean): Map<string, string> {
  const out = new Map<string, string>();
  const picked = doc.partColors ?? {};
  const order = [...(doc.partOrder ?? []).filter((id) => bodyIds.includes(id)), ...bodyIds.filter((id) => !(doc.partOrder ?? []).includes(id))];
  let k = 0;
  for (const id of order) {
    const own = picked[id] ?? partMaterial(doc, id)?.look.color;
    if (own) out.set(id, own);
    else if (auto && bodyIds.length > 1) out.set(id, PART_PALETTE[k++ % PART_PALETTE.length]!);
  }
  return out;
}
