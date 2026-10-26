/** First launch of the desktop app: pick where projects live before anything is saved. */
import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { desktop } from "../lib/persistence";
import { changeProjectsFolder } from "../lib/storage";
import { Logo } from "./TopBar";

export function FirstRun() {
  const [status, setStatus] = useState<{ dir: string; defaultDir: string; chosen: boolean } | null>(null);
  useEffect(() => {
    if (desktop) void desktop.storage.status().then(setStatus);
  }, []);
  if (!status || status.chosen) return null;

  const done = (dir: string | null) => dir && setStatus({ ...status, dir, chosen: true });
  return (
    <div className="modal-backdrop first-run">
      <div className="ask first-run-card" role="dialog" aria-label="Choose a projects folder">
        <Logo />
        <h3>Where should your projects live?</h3>
        <p>
          leocad saves every project as a .leocad file in a folder you choose, so your work stays yours even if you remove the app. Pick a folder you back up, or a synced one
          like iCloud Drive.
        </p>
        <code>{status.defaultDir}</code>
        <div className="ask-actions">
          <button className="btn" onClick={async () => done(await changeProjectsFolder())}>
            <FolderOpen /> Choose another folder…
          </button>
          <button className="btn primary" onClick={async () => done(await changeProjectsFolder(status.defaultDir, { askToMove: false }))}>
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}
