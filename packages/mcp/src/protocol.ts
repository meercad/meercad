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
  /**
   * "project": the server knows `params.project` (see PROJECT_PARAM), and the app gives its session
   * one tab per project. Older servers send nothing: one tab per session, opening replaces its project.
   */
  tabs?: "project";
}

/**
 * The project a request acts on, in its params: one MCP server can serve several chats at once
 * (Claude Desktop starts one for all of them), each working on a project of its own. The app keeps
 * a tab per project of a session and sends the request to the one with this project.
 */
export const PROJECT_PARAM = "project";

/**
 * The key of a session's tab: the session for its first tab, `<session>~<n>` for more (one per
 * project, see PROJECT_PARAM). The app's main process knows keys only, as the sessions of its tabs.
 */
export const tabOfSession = (key: string, session: string) => key === session || key.startsWith(`${session}~`);

/** A key for a new tab of `session` that none of `taken` has. */
export function newTabKey(session: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(session)) return session;
  let n = 2;
  while (used.has(`${session}~${n}`)) n++;
  return `${session}~${n}`;
}

/** Which of a session's tabs a request goes to (`project`: the project it names, see PROJECT_PARAM). */
export type TabChoice<T> = { tab: T } | { none: "open" } | { none: "project"; project: string } | { several: T[] };

export function chooseTab<T extends { session: string; project: string | null }>(tabs: readonly T[], session: string, project?: string): TabChoice<T> {
  const own = tabs.filter((t) => tabOfSession(t.session, session));
  if (project !== undefined) {
    const t = own.find((x) => x.project === project);
    return t ? { tab: t } : { none: "project", project };
  }
  if (own.length === 1) return { tab: own[0]! };
  return own.length ? { several: own } : { none: "open" };
}

/**
 * An assistant's tab (Mac app) goes back to the user when its session has made no request for this
 * long: a chat or coding session keeps its MCP server running for hours, and its tab would stay
 * locked all that time. The assistant opens the project again to go on (see close_project).
 */
export const ASSISTANT_IDLE_MS = 30 * 60_000;

/**
 * Whether open_project with takeover may take a project from another session's tab: from a session
 * of the same assistant app (most likely this one's before a lost connection: the old server never
 * ended, its tab kept the project for half an hour, 2026-11-11), or from one that has made no
 * request for TAKEOVER_IDLE_MS. Another assistant's work in progress stays untouched.
 */
export const TAKEOVER_IDLE_MS = 5 * 60_000;
export function mayTakeOver(sameClient: boolean, idleMs: number | undefined): boolean {
  return sameClient || idleMs === undefined || idleMs >= TAKEOVER_IDLE_MS;
}

/**
 * What stands in the way of a session opening a project: one project at a time per session.
 * Claude Desktop runs one MCP server for all of its chats, so the app cannot tell those chats apart:
 * a second chat opening a project next to the first one's would have every call without (or with
 * a wrong) project land in the other chat's project. So while a tab of the session is open (it goes
 * after ASSISTANT_IDLE_MS without a request, or with close_project), opening is refused and the
 * answer says why. `opening`: tab keys being opened right now. `target`: the project to open, if known.
 */
export type OpenBlock<T> = { tab: T; same: boolean } | { opening: true } | null;

export function openBlock<T extends { session: string; project: string | null }>(tabs: readonly T[], session: string, opening: Iterable<string>, target?: string): OpenBlock<T> {
  const own = tabs.filter((t) => tabOfSession(t.session, session));
  const held = own.find((t) => t.project !== null && t.project === target) ?? own.find((t) => t.project !== null);
  if (held) return { tab: held, same: target !== undefined && held.project === target };
  // A tab without a project (an open that failed) blocks nothing: the next open reuses it.
  if ([...opening].some((k) => tabOfSession(k, session))) return { opening: true };
  return null;
}

/** "12 s", "3 min": how long ago `at` was. */
export const ago = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

/**
 * The refusal for an open that openBlock stopped: who holds what, why only one project at a time
 * works, and how it is freed. `lastCallMs`: how long ago the holding tab got its last request.
 */
export function openBlockMessage(block: NonNullable<OpenBlock<{ project: string | null; name?: string | null }>>, lastCallMs?: number, idleMs = ASSISTANT_IDLE_MS): string {
  const idleMin = Math.round(idleMs / 60_000);
  const why = "meerCAD cannot tell the chats on one connection apart (Claude Desktop runs a single meerCAD connection for all of its chats), so it allows one open project per connection: with two, calls of one chat could land in the other's project.";
  const free = `It is freed when that chat calls close_project, after ${idleMin} minutes without a call, or when the user clicks Take over in its meerCAD tab.`;
  if ("opening" in block) return `Another chat on this meerCAD connection is opening a project right now. ${why} ${free} Tell the user, or try again later.`;
  const t = block.tab;
  const label = `"${t.name ?? t.project}" (id "${t.project}")`;
  const last = lastCallMs !== undefined ? ` (last call ${ago(lastCallMs)} ago)` : "";
  if (block.same)
    return `Project ${label} is already open over this meerCAD connection${last}. If this chat opened it, just go on: it is still open, pass project: "${t.project}" with your calls. If not, another chat is working on it right now: don't change it, tell the user. ${why} ${free}`;
  return `Another chat is already working on project ${label} over this meerCAD connection${last}, so no second project can be opened now. ${why} If ${label} is your own and you are done with it, call close_project with project: "${t.project}" first, then open again. Otherwise tell the user that another chat is busy in meerCAD and wait. ${free}`;
}

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
/**
 * Without staging, an export must fit one bridge message: base64 adds a third, so above this many
 * bytes it would pass the hub's 100 MiB and break the connection.
 */
export const INLINE_MAX = 72 * 1024 * 1024;
/** How long the app keeps staged files that nobody fetches. */
export const STAGE_KEEP_MS = 10 * 60_000;

/** An export's files: base64 by name, or (big ones) staged in the app under a token, with their sizes in bytes. */
export interface ExportedFiles {
  files: Record<string, string>;
  staged?: { token: string; sizes: Record<string, number> };
}

/**
 * How the app hands over an export of `total` bytes. `stages` says whether the server asked for
 * staging (`stage: true` in its request): a server from before staged_files only reads `files`, so
 * staged files would vanish and it would report writing nothing. Such a server gets the files
 * inline while they fit one message, and above that an error asking to restart it.
 */
export function exportTransport(total: number, stages: boolean): "inline" | "stage" | "too_big" {
  if (total <= STAGE_OVER) return "inline";
  if (stages) return "stage";
  return total <= INLINE_MAX ? "inline" : "too_big";
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
