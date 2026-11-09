/** Which window has which project open: a project is open in one window of the app only. */

/** A window as far as its project goes: its webContents id, the project it shows, and whose it is. */
export interface ProjectWindow {
  wc: number;
  project: string | null;
  /** The assistant whose window it is; null for the user's windows. */
  assistant: string | null;
  /** The assistant's session ended: the window is the user's now. */
  ended?: boolean;
}

/** The projects the windows other than `except` have open: id → the assistant's name, "" for one of the user's windows. */
export function openElsewhere(windows: ProjectWindow[], except: number): Record<string, string> {
  const open: Record<string, string> = {};
  // The user's windows first: an assistant's window with the same project wins (it is the one to show).
  for (const w of [...windows].sort((a, b) => Number(!!a.assistant) - Number(!!b.assistant))) if (w.project && w.wc !== except) open[w.project] = (!w.ended && w.assistant) || "";
  return open;
}

/** The window (other than `except`) that has a project open: an assistant's before one of the user's. */
export function holderOf<W extends ProjectWindow>(windows: W[], id: string, except: number): W | null {
  const others = windows.filter((w) => w.project === id && w.wc !== except);
  return others.find((w) => w.assistant !== null) ?? others[0] ?? null;
}
