/** How variables are grouped in the Variables panel and in the value picker. */
import { referencedNames } from "@leocad/model";
import type { Expr } from "@leocad/schema";

export type VariableGroup = "own" | "calculated" | "auto";

export const GROUP_LABEL: Record<VariableGroup, string> = { own: "Your variables", calculated: "Calculated", auto: "Automatic" };
export const GROUP_ORDER: VariableGroup[] = ["own", "calculated", "auto"];

/**
 * A variable that is a formula of other variables is "calculated", whoever made it; the rest are
 * the user's own or automatic (created by leocad shortcuts or an assistant).
 */
export function variableGroup(name: string, params: Record<string, Expr>, autoParams: readonly string[] = []): VariableGroup {
  const expr = params[name];
  if (expr !== undefined && referencedNames(expr).some((n) => n !== name && n in params)) return "calculated";
  return autoParams.includes(name) ? "auto" : "own";
}
