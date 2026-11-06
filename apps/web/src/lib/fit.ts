/** The design's fit (Spiel) in the app: the test part to measure it. */
import { fitTestDocument } from "@meercad/model";
import { t } from "./i18n";
import { newProject } from "../store";

/** Opens the fit test part as a new project, ready to export for printing. */
export function openFitTest(): Promise<void> {
  return newProject(fitTestDocument(), t("Fit test"));
}
