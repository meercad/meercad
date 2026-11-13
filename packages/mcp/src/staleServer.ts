/**
 * An MCP server runs as long as its client's session: when meerCAD is updated meanwhile, the
 * running server keeps the old code and the old tool list, so the assistant does not see tools
 * the app has since got (close_project, for one) and may tell the user they do not exist. The
 * server notices its own file changed and says so with every answer.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export const STALE_NOTE =
  "Note: meerCAD was updated after this MCP server started, so this session still runs the old server: tools added since are missing from your tool list (e.g. close_project). Before telling the user something is not possible, ask them to restart this MCP connection (or the assistant app) to get the current tools.";

export interface FileProbe {
  /** A cheap stamp of the file (its modification time); throws if it is gone. */
  stamp: (path: string) => number;
  /** The file's contents' hash, read only when the stamp moved. */
  hash: (path: string) => string;
}

const nodeProbe: FileProbe = {
  stamp: (p) => statSync(p).mtimeMs,
  hash: (p) => createHash("sha1").update(readFileSync(p)).digest("hex"),
};

/**
 * Tells whether the file at `path` differs from when this was made. A new stamp with the same
 * contents (the same build installed again) is not a change; a file that went away is.
 */
export function staleCheck(path: string, probe: FileProbe = nodeProbe): () => boolean {
  let stamp: number;
  let hash: string;

  try {
    stamp = probe.stamp(path);
    hash = probe.hash(path);
  } catch {
    return () => false;
  }

  let stale = false;

  return () => {
    if (stale) return true;

    try {
      const now = probe.stamp(path);
      if (now === stamp) return false;

      stamp = now;
      stale = probe.hash(path) !== hash;
    } catch {
      stale = true;
    }

    return stale;
  };
}
