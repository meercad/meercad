/** How variables are grouped in the Variables panel and in the value picker. */
import { referencedNames } from "@meercad/model";
import type { Expr } from "@meercad/schema";
import { t } from "./i18n";

export type VariableGroup = "own" | "calculated" | "auto";

export const GROUP_LABEL: Record<VariableGroup, string> = {
  own: t("Your variables"),
  calculated: t("Calculated"),
  auto: t("Automatic"),
};
export const GROUP_ORDER: VariableGroup[] = ["own", "calculated", "auto"];

/**
 * A variable that is a formula of other variables is "calculated", whoever made it; the rest are
 * the user's own or automatic (created by meerCAD shortcuts or an assistant).
 */
export function variableGroup(
  name: string,
  params: Record<string, Expr>,
  autoParams: readonly string[] = [],
): VariableGroup {
  const expr = params[name];
  if (expr !== undefined && referencedNames(expr).some((n) => n !== name && n in params)) return "calculated";

  return autoParams.includes(name) ? "auto" : "own";
}
