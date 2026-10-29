/** Part colours: the ones the user picked, and a palette for the rest so parts tell apart. */
import type { MeercadDocument } from "@meercad/schema";

/** Soft colours that stay apart from each other and from the selection blue; the first is the usual part grey-blue. */
export const PART_PALETTE = ["#c4cfdc", "#e8c39e", "#a9d4b0", "#e3b1c8", "#d8d0a0", "#a7d3d6", "#c3b8e6", "#eab0a6", "#b9c99a", "#d9b8a0"] as const;

/** Colour of every part ("#rrggbb" by body id): picked ones, then the palette in parts-list order. */
export function partColors(doc: MeercadDocument, bodyIds: readonly string[], auto: boolean): Map<string, string> {
  const out = new Map<string, string>();
  const picked = doc.partColors ?? {};
  const order = [...(doc.partOrder ?? []).filter((id) => bodyIds.includes(id)), ...bodyIds.filter((id) => !(doc.partOrder ?? []).includes(id))];
  let k = 0;
  for (const id of order) {
    if (picked[id]) out.set(id, picked[id]);
    else if (auto && bodyIds.length > 1) out.set(id, PART_PALETTE[k++ % PART_PALETTE.length]!);
  }
  return out;
}
