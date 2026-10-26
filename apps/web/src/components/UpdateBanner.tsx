import { Download, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { desktop } from "../lib/persistence";
import { toast } from "../store";

type Update = { version: string; notes: string; page: string; canInstall: boolean };

/** Shown when a newer leocad release exists; installs it in place (desktop app only). */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop) return;
    const offs = [
      desktop.on("update-available", (u) => setUpdate(u)),
      desktop.on("update-progress", (p) => setProgress(p)),
      desktop.on("update-none", (v) => toast(`leocad ${v} is up to date`)),
      desktop.on("update-error", (m) => {
        setProgress(null);
        toast(`Update failed: ${m}`, "error");
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);
  if (!update || dismissed === update.version) return null;
  const notes = update.notes.split("\n").filter((l) => l.trim() && !l.startsWith("#")).slice(0, 3);
  return (
    <div className="update-banner" role="status">
      <div className="row">
        <Sparkles size={16} style={{ color: "var(--accent)" }} />
        <b>leocad {update.version} is available</b>
        <span className="spacer" />
        {progress === null ? (
          <button className="icon-btn sm" onClick={() => setDismissed(update.version)} title="Later">
            <X />
          </button>
        ) : null}
      </div>
      {notes.length ? <div className="muted update-notes">{notes.map((n, i) => <div key={i}>{n.replace(/^[-*]\s*/, "• ").replace(/\*\*/g, "")}</div>)}</div> : null}
      {progress !== null ? (
        <div className="update-progress">
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
          <span>{progress < 1 ? `Downloading… ${Math.round(progress * 100)}%` : "Installing and restarting…"}</span>
        </div>
      ) : (
        <div className="row">
          <button className="btn" onClick={() => window.open(update.page, "_blank")}>
            What's new
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => setDismissed(update.version)}>
            Later
          </button>
          <button
            className="btn primary"
            onClick={() => {
              if (!update.canInstall) return window.open(update.page, "_blank");
              setProgress(0);
              void desktop?.updates.install();
            }}
          >
            <Download /> {update.canInstall ? "Update now" : "Download"}
          </button>
        </div>
      )}
    </div>
  );
}
