/** How the app shows an assistant at work (MCP): a turning mark, and its tool calls in words. */
import { t } from "../lib/i18n";

/** What an assistant's tool call does, in words for the user. */
export function toolLabel(tool: string | null | undefined): string | null {
  if (!tool) return null;
  const words: Record<string, string> = {
    apply_ops: t("Changing the model"),
    preview_ops: t("Trying a variant"),
    clear_preview: t("Trying a variant"),
    undo: t("Undoing a step"),
    redo: t("Redoing a step"),
    open_project: t("Opening the project"),
    close_project: t("Handing the project back"),
    new_project: t("Starting a new part"),
    open_example: t("Opening an example"),
    import_file: t("Importing a file"),
    render_view: t("Looking at the model"),
    render_motion: t("Filming the motion"),
    set_view: t("Turning the view"),
    set_visibility: t("Showing and hiding parts"),
    get_model: t("Reading the model"),
    get_sketch: t("Reading a sketch"),
    measure: t("Measuring"),
    measure_scan: t("Measuring"),
    export: t("Exporting"),
    export_drawing: t("Making a drawing"),
    export_robot: t("Exporting a robot"),
    play_motion: t("Playing the motion"),
    set_pose: t("Moving the joints"),
    check_motion: t("Checking the motion"),
    check_interference: t("Checking for collisions"),
    check_clearance: t("Checking the clearance"),
    wall_thickness: t("Checking wall thickness"),
    print_check: t("Checking printability"),
    deviation: t("Comparing with the scan"),
    rebuild_mesh: t("Rebuilding the mesh"),
    repair_mesh: t("Repairing the mesh"),
    gear_calc: t("Calculating gears"),
  };
  return words[tool] ?? tool.replace(/_/g, " ");
}

/** A round, slowly turning mark for an assistant at work (still while it waits). */
export function AiOrb({ busy, small = false }: { busy: boolean; small?: boolean }) {
  return <span className={`ai-orb ${busy ? "busy" : ""} ${small ? "sm" : ""}`} aria-hidden="true" />;
}
