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
  | "send_to_slicer"
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
  | "write_file"
  | "staged_files";

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

// ---------------------------------------------------------------- big exports

/**
 * Exported files travel as base64 in JSON over the bridge, and the hub takes WebSocket messages of
 * at most 100 MiB (the `ws` default); a robot of a few hundred parts runs to hundreds of MB of STL.
 * Above this many bytes in all, the app keeps the files (staged) and the server fetches them in
 * pieces with staged_files.
 */
export const STAGE_OVER = 16 * 1024 * 1024;
/** Bytes per staged_files request at most (about 21 MB as base64). */
export const STAGE_PIECE = 16 * 1024 * 1024;
/** How long the app keeps staged files that nobody fetches. */
export const STAGE_KEEP_MS = 10 * 60_000;

/** An export's files: base64 by name, or (big ones) staged in the app under a token, with their sizes in bytes. */
export interface ExportedFiles {
  files: Record<string, string>;
  staged?: { token: string; sizes: Record<string, number> };
}

/** Bytes `offset` to `offset + length` of a staged file. */
export interface FilePiece {
  name: string;
  offset: number;
  length: number;
}

/**
 * The staged_files requests that fetch files of these sizes: in file order, a file bigger than
 * `piece` split into pieces of that size, and pieces grouped up to `piece` bytes per request.
 */
export function stagedRequests(sizes: Record<string, number>, piece = STAGE_PIECE): FilePiece[][] {
  const requests: FilePiece[][] = [];
  let batch: FilePiece[] = [];
  let bytes = 0;
  for (const [name, size] of Object.entries(sizes)) {
    let offset = 0;
    do {
      const length = Math.min(piece, size - offset);
      if (batch.length && bytes + length > piece) {
        requests.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push({ name, offset, length });
      bytes += length;
      offset += length;
    } while (offset < size);
  }
  if (batch.length) requests.push(batch);
  return requests;
}
