/** First launch of the desktop app: pick where projects live before anything is saved. */
import { Cloud, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { desktop } from "../lib/persistence";
import { changeProjectsFolder, folderLabel } from "../lib/storage";
import { Logo } from "./TopBar";
import { t } from "../lib/i18n";

export function FirstRun() {
  const [status, setStatus] = useState<{
    dir: string;
    defaultDir: string;
    chosen: boolean;
    iCloudDir: string;
    iCloudAvailable: boolean;
  } | null>(null);
  useEffect(() => {
    if (desktop) void desktop.storage.status().then(setStatus);
  }, []);
  if (!status || status.chosen) return null;

  const done = (dir: string | null) => dir && setStatus({ ...status, dir, chosen: true });

  return (
    <div className="modal-backdrop first-run">
      <div className="ask first-run-card" role="dialog" aria-label={t("Choose a projects folder")}>
        <Logo />
        <h3>{t("Where should your projects live?")}</h3>
        <p>
          {t(
            "meerCAD saves every project as a .meercad file in a folder you choose, so your work stays yours even if you remove the app. Pick a folder you back up, or a synced one like iCloud Drive.",
          )}
        </p>
        <code title={status.defaultDir}>{folderLabel(status.defaultDir)}</code>
        {status.iCloudAvailable ? (
          <button
            className="btn primary first-run-cloud"
            onClick={async () => done(await changeProjectsFolder(status.iCloudDir, { askToMove: false }))}
          >
            <Cloud /> {t("Use iCloud Drive (same projects on iPhone and iPad)")}
          </button>
        ) : null}
        <div className="ask-actions">
          <button className="btn" onClick={async () => done(await changeProjectsFolder())}>
            <FolderOpen /> {t("Choose another folder…")}
          </button>
          <button
            className={`btn ${status.iCloudAvailable ? "" : "primary"}`}
            onClick={async () => done(await changeProjectsFolder(status.defaultDir, { askToMove: false }))}
          >
            {t("Use this folder")}
          </button>
        </div>
      </div>
    </div>
  );
}
