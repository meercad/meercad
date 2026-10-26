/** Messages between the MCP server (WebSocket server) and the opencad app (WebSocket client). */

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
  | "measure";

export interface BridgeRequest {
  id: number;
  method: BridgeMethod;
  params: Record<string, unknown>;
}

export type BridgeResponse = { id: number; result: unknown } | { id: number; error: string };

/** First message the app sends after connecting. */
export interface BridgeHello {
  hello: "opencad";
  version: string;
  project: string | null;
}
