/** Choosing and switching the desktop projects folder. */
import { askConfirm } from "../components/Ask";
import { refreshProjects, toast } from "../store";
import { desktop } from "./persistence";

/**
 * Points the app at a new projects folder (picked with the system dialog unless given) and asks
 * whether the existing projects should move along. Resolves to the new folder, or null if cancelled.
 */
export async function changeProjectsFolder(dir?: string, opts: { askToMove?: boolean } = {}): Promise<string | null> {
  if (!desktop) return null;
  const target = dir ?? (await desktop.storage.choose());
  if (!target) return null;
  const status = await desktop.storage.status();
  const count = status.dir === target ? 0 : await desktop.storage.count();
  const move =
    count > 0 && (opts.askToMove ?? true)
      ? await askConfirm({
          title: `Move your ${count} project${count === 1 ? "" : "s"}?`,
          message: `They are currently in ${status.dir}. Moving keeps your folder structure; nothing in the new folder is overwritten.`,
          confirmLabel: "Move projects",
          cancelLabel: "Leave them",
        })
      : false;
  try {
    const r = await desktop.storage.set({ dir: target, move });
    await refreshProjects();
    toast(move ? `Moved ${r.moved} project${r.moved === 1 ? "" : "s"} to ${r.dir}${r.skipped ? ` (${r.skipped} already existed there and were left in place)` : ""}` : `Projects are now saved in ${r.dir}`);
    return r.dir;
  } catch (e) {
    toast(`Could not use that folder: ${e instanceof Error ? e.message : String(e)}`, "error");
    return null;
  }
}
