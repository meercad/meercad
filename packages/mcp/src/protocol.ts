/** Messages between the MCP server (WebSocket server) and the meerCAD app (WebSocket client). */

export const DEFAULT_PORT = 47821;

export type BridgeMethod =
  | "get_model"
  | "get_sketch"
  | "apply_ops"
  | "preview_ops"
  | "undo"
  | "redo"
  | "list_projects"
  | "open_project"
  | "new_project"
  | "render_view"
  | "set_view"
  | "export"
  | "measure"
  | "set_pose"
  | "check_motion"
  | "check_clearance"
  | "render_motion"
  | "drawing"
  | "get_status"
  | "clear_preview"
  | "get_version"
  | "check_interference"
  | "wall_thickness"
  | "print_check"
  | "deviation"
  | "repair_mesh"
  | "rebuild_mesh"
  | "measure_scan"
  | "joints_from_gears"
  | "import_file"
  | "set_visibility"
  | "rename_project"
  | "list_folders"
  | "create_folder"
  | "move_project"
  | "list_examples"
  | "open_example"
  | "terrain_height"
  | "place_on_terrain"
  | "photo_terrain"
  | "list_materials";

export interface BridgeRequest {
  id: number;
  method: BridgeMethod;
  params: Record<string, unknown>;
  /** Name of the assistant calling (from the MCP client info), shown in the app. */
  client?: string;
}

export type BridgeResponse = { id: number; result: unknown } | { id: number; error: string };

/** First message the app sends after connecting. */
export interface BridgeHello {
  hello: "meercad";
  version: string;
  project: string | null;
}
