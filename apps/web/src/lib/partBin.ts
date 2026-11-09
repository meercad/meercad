/**
 * "Gridfinity bin for this part": a bin with a nest for the part (often a scan), sized, turned and
 * placed round it by the kernel. Opens the bin's dialog to adjust how deep it sinks, the play and
 * the finger grip.
 */
import { nextFeatureId } from "@meercad/model";
import { currentDoc, openDraft } from "../store";

export function binForPart(bodyId: string): void {
  const doc = currentDoc();
  openDraft({ id: nextFeatureId(doc, "gridfinity"), op: "gridfinity", kind: "bin", pocket: { body: bodyId } });
}
