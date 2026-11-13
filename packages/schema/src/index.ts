export * from "./types.js";
export { definitions, documentSchema, docOpSchema } from "./schema.js";
export {
  validateDocument,
  validateOp,
  asArray,
  sketchSymbols,
  withoutRemovedFeatures,
  REMOVED_OPS,
  type Validation,
} from "./validate.js";

import type { ProfileRef } from "./types.js";

/** Sketch id of a profile, or null for face profiles. */
export const profileSketch = (profile: ProfileRef): string | null =>
  "sketch" in profile ? profile.sketch : null;
