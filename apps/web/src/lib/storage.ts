/** Choosing and switching where projects are stored: the desktop folder, iCloud Drive on the iPad and iPhone. */
import { askConfirm } from "../components/Ask";
import { refreshProjects, toast, useApp } from "../store";
import { switchStorage } from "./native";
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

/**
 * iPad and iPhone: moves all projects to iCloud Drive (or back onto the device) after asking, and
 * saves there from now on. Resolves to whether it switched.
 */
export async function switchNativeStorage(to: "local" | "icloud"): Promise<boolean> {
  const count = useApp.getState().projects.length;
  const ok = await askConfirm(
    to === "icloud"
      ? {
          title: t("Switch to iCloud?"),
          message: tn(count, "Your {n} project moves to iCloud Drive › meerCAD and is then on all your devices with this Apple ID, also on the Mac.", "Your {n} projects move to iCloud Drive › meerCAD and are then on all your devices with this Apple ID, also on the Mac."),
          confirmLabel: t("Switch to iCloud"),
        }
      : {
          title: t("Keep projects on this device only?"),
          message: t("Your projects move out of iCloud onto this device. They are then no longer on your other devices."),
          confirmLabel: t("Move to this device"),
        },
  );
  if (!ok) return false;
  try {
    const r = await switchStorage(to);
    await refreshProjects();
    const skipped = r.skipped ? ` ${tn(r.skipped, "({n} already existed there and was left in place)", "({n} already existed there and were left in place)")}` : "";
    toast((to === "icloud" ? tn(r.moved, "Moved {n} project to iCloud", "Moved {n} projects to iCloud") : tn(r.moved, "Moved {n} project to this device", "Moved {n} projects to this device")) + skipped);
    return true;
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "error");
    return false;
  }
}
