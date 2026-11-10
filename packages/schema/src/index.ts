export * from "./types.js";
export { definitions, documentSchema, docOpSchema } from "./schema.js";
export { validateDocument, validateOp, asArray, sketchSymbols, withoutRemovedFeatures, REMOVED_OPS, CABLES_ENABLED, PAUSED_OPS, isPausedOp, type Validation } from "./validate.js";

import type { ProfileRef } from "./types.js";
/** Sketch id of a profile, or null for face profiles. */
export const profileSketch = (p: ProfileRef): string | null => ("sketch" in p ? p.sketch : null);
