/**
 * The last step of a topology suggestion: its skin is made of far more triangles than its shape
 * needs. Made lighter, it shows the same shape and can be cut, drilled and joined like any part
 * within seconds (every triangle is a face of the body; with all of them a cut takes minutes).
 */
import type { TriangleSkin } from "@meercad/model";
import { withinBudget } from "./importBudget";

/** A suggestion has at most this many triangles. */
export const SUGGESTION_TRIANGLES = 15_000;

export const lightSuggestion = (mesh: TriangleSkin, budget = SUGGESTION_TRIANGLES): TriangleSkin =>
  withinBudget([mesh], budget).meshes[0]!;
