/** Messages between the MCP server (WebSocket server) and the meerCAD app (WebSocket client). */

export const DEFAULT_PORT = 47821;

/**
 * The meerCAD builds that can live on one Mac, each with its own bridge port and its own entry in an
 * assistant's MCP configuration, so an assistant set up for one never drives another:
 *   prod        the App Store release (and builds outside the store)
 *   testflight  the App Store build installed from TestFlight (it tells by its receipt)
 *   rc          "meerCAD RC", the stable build the maintainer works with (`pnpm rc`)
 *   wip         "meerCAD WIP", the build agents rebuild at will (`pnpm wip`)
 * The RC's and WIP's server.js find their port in server.json next to them; the App Store build
 * ships one Claude extension per store channel with the port in its environment.
 */
export const CHANNEL_PORTS = { prod: DEFAULT_PORT, rc: 47822, wip: 47823, testflight: 47824 } as const;
export type Channel = keyof typeof CHANNEL_PORTS;
/** The server's name in an assistant's MCP configuration: one entry per build, added next to the others. */
export const CHANNEL_MCP_NAMES: Record<Channel, string> = { prod: "meercad", testflight: "meercad-testflight", rc: "meercad-rc", wip: "meercad-wip" };

export type BridgeMethod =
  | "get_model"
  | "get_sketch"
  | "apply_ops"
  | "preview_ops"
  | "undo"
  | "redo"
  | "list_projects"
  | "open_project"
  | "close_project"
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

/**
 * An assistant's tab (Mac app) goes back to the user when its session has made no request for this
 * long: a chat or coding session keeps its MCP server running for hours, and its tab would stay
 * locked all that time. The assistant opens the project again to go on (see close_project).
 */
export const ASSISTANT_IDLE_MS = 10 * 60_000;

/**
 * The assistants' tabs to hand back to the user now: idle for `idleMs` since their last request,
 * not working and with no request waiting for an answer.
 */
export function idleAssistants<T extends { lastCall: number; busy: boolean; pending: number }>(tabs: Iterable<T>, now: number, idleMs = ASSISTANT_IDLE_MS): T[] {
  return [...tabs].filter((a) => !a.busy && a.pending === 0 && now - a.lastCall >= idleMs);
}

/** Why a session has no tab any more: the user closed or took it over, the assistant closed it (close_project), or it sat idle. */
export type EndedTab = "closed" | "released" | "idle";

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
