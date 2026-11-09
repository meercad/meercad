/** Messages between the MCP server (WebSocket server) and the meerCAD app (WebSocket client). */

export const DEFAULT_PORT = 47821;

/**
 * The Mac builds that can be installed side by side, each with its own bridge port, so an assistant
 * set up for one never drives another: the store release on DEFAULT_PORT, "meerCAD RC" (the stable
 * build the maintainer works with, `pnpm rc`) and "meerCAD WIP" (the build agents rebuild at will,
 * `pnpm wip`) on their own. Each build's server.js finds its port in server.json next to it.
 */
export const CHANNEL_PORTS = { release: DEFAULT_PORT, rc: 47822, wip: 47823 } as const;
export type Channel = keyof typeof CHANNEL_PORTS;
/** The server's name in an assistant's MCP configuration: one entry per installed build. */
export const CHANNEL_MCP_NAMES: Record<Channel, string> = { release: "meercad", rc: "meercad", wip: "meercad-wip" };

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
  | "export_robot"
  | "measure"
  | "set_pose"
  | "check_motion"
  | "play_motion"
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
  | "list_materials"
  | "read_file"
  | "write_file";

export interface BridgeRequest {
  id: number;
  method: BridgeMethod;
  params: Record<string, unknown>;
  /** Name of the assistant calling (from the MCP client info), shown in the app. */
  client?: string;
  /** The MCP server (one per assistant session) that sent it: the app gives each session its own window. */
  session?: string;
}

/** Sent by the hub, not answered: a session's MCP server exited, or (on connecting) the hub's own session. */
export interface BridgeEvent {
  event: "session_ended" | "hub_session";
  session: string;
}

export type BridgeResponse = { id: number; result: unknown } | { id: number; error: string };

/** First message the app sends after connecting. */
export interface BridgeHello {
  hello: "meercad";
  version: string;
  project: string | null;
}
