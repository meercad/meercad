/**
 * The document a technical drawing is made from. Drawings show threads the conventional way, as
 * plain cylinders (ISO 6410), not as helical faces, which hidden-line removal would take minutes
 * over: thread steps are left out and tapped holes become plain holes at the tap drill size.
 */

import type { Feature, MeercadDocument } from "@meercad/schema";
import { holeShape } from "./holes.js";

export function drawingDocument(doc: MeercadDocument): MeercadDocument {
  const features = doc.features.map((feature): Feature => {
    if (feature.op === "thread") return { ...feature, suppressed: true };

    if (feature.op === "hole" && feature.kind === "tapped" && feature.size) {
      const { diameter } = holeShape("tapped", { size: feature.size });
      const { size: _size, ...rest } = feature;

      return { ...rest, kind: "simple", diameter };
    }

    return feature;
  });

  return { ...doc, features };
}
