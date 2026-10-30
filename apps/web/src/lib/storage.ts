/** Choosing and switching the desktop projects folder. */
import { askConfirm } from "../components/Ask";
import { refreshProjects, toast } from "../store";
import { desktop } from "./persistence";
import { t, tn } from "./i18n";

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
          title: tn(count, "Move your {n} project?", "Move your {n} projects?"),
          message: t("They are currently in {dir}. Moving keeps your folder structure; nothing in the new folder is overwritten.", { dir: status.dir }),
          confirmLabel: t("Move projects"),
          cancelLabel: t("Leave them"),
        })
      : false;
  try {
    const r = await desktop.storage.set({ dir: target, move });
    await refreshProjects();
    const skipped = r.skipped ? ` ${tn(r.skipped, "({n} already existed there and was left in place)", "({n} already existed there and were left in place)")}` : "";
    toast(move ? tn(r.moved, "Moved {n} project to {dir}", "Moved {n} projects to {dir}", { dir: r.dir }) + skipped : t("Projects are now saved in {dir}", { dir: r.dir }));
    return r.dir;
  } catch (e) {
    toast(t("Could not use that folder: {msg}", { msg: e instanceof Error ? e.message : String(e) }), "error");
    return null;
  }
}
