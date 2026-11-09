/** Part colours: the ones the user picked, their materials' colours, and a palette for the rest so parts tell apart. */
import { partMaterial } from "@meercad/model";
import type { MeercadDocument } from "@meercad/schema";

/**
 * The usual part grey (the viewport's own, a tick lighter than before) and one purple for every
 * further part, so parts tell apart without the model turning colourful.
 */
export const PART_PALETTE = ["#7a7f86", "#8a63d2"] as const;

/**
 * Colour of every part ("#rrggbb" by body id): the one picked for it, else its material's own
 * colour (carbon, wood, metal, an own material's), else in parts-list order the grey for the first
 * part and the purple for all others.
 */
export function partColors(doc: MeercadDocument, bodyIds: readonly string[], auto: boolean): Map<string, string> {
  const out = new Map<string, string>();
  const picked = doc.partColors ?? {};
  const order = [...(doc.partOrder ?? []).filter((id) => bodyIds.includes(id)), ...bodyIds.filter((id) => !(doc.partOrder ?? []).includes(id))];
  let k = 0;
  for (const id of order) {
    const own = picked[id] ?? partMaterial(doc, id)?.look.color;
    if (own) out.set(id, own);
    else if (auto && bodyIds.length > 1) out.set(id, PART_PALETTE[k++ === 0 ? 0 : 1]);
  }
  return out;
}
