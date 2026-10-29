/**
 * The document a technical drawing is made from. Drawings show threads the conventional way, as
 * plain cylinders (ISO 6410), not as helical faces, which hidden-line removal would take minutes
 * over: thread steps are left out and tapped holes become plain holes at the tap drill size.
 */

import type { Feature, MeercadDocument } from "@meercad/schema";
import { holeShape } from "./holes.js";

export function drawingDocument(doc: MeercadDocument): MeercadDocument {
  const features = doc.features.map((f): Feature => {
    if (f.op === "thread") return { ...f, suppressed: true };
    if (f.op === "hole" && f.kind === "tapped" && f.size) {
      const { diameter } = holeShape("tapped", { size: f.size });
      const { size: _size, ...rest } = f;
      return { ...rest, kind: "simple", diameter };
    }
    return f;
  });
  return { ...doc, features };
}
