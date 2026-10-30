import { Download, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { desktop } from "../lib/persistence";
import { toast } from "../store";
import { t } from "../lib/i18n";

type Update = { version: string; notes: string; changes?: string[]; page: string; canInstall: boolean };

/** What changed: commits since this build when known, else the "Changes" list of the release notes. */
function changeList(u: Update): string[] {
  if (u.changes?.length) return u.changes;
  const lines = u.notes.split("\n");
  const start = lines.findIndex((l) => /^###\s*Changes/i.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#/.test(l)) break;
    if (/^\s*[-*]\s+/.test(l)) out.push(l.replace(/^\s*[-*]\s+/, ""));
  }
  return out;
}


/** Shown when a newer meerCAD release exists; installs it in place (desktop app only). */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop) return;
    void desktop.info().then(({ version }) => {
      try {
        const before = localStorage.getItem("meercad.version");
        if (before && before !== version) toast(t("Updated to meerCAD {version}", { version }));
        localStorage.setItem("meercad.version", version);
      } catch {
        // no confirmation without storage
      }
    });
    const offs = [
      desktop.on("update-available", (u) => setUpdate(u)),
      desktop.on("update-progress", (p) => setProgress(p)),
      desktop.on("update-none", (v) => toast(t("meerCAD {version} is up to date", { version: v }))),
      desktop.on("update-error", (m) => {
        setProgress(null);
        toast(t("Update failed: {msg}", { msg: m }), "error");
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);
  if (!update || dismissed === update.version) return null;
  const changes = changeList(update);
  return (
    <div className="update-banner" role="status">
      <div className="row">
        <Sparkles size={16} style={{ color: "var(--accent)" }} />
        <b>{t("meerCAD {version} is available", { version: update.version })}</b>
        <span className="spacer" />
        {progress === null ? (
          <button className="icon-btn sm" onClick={() => setDismissed(update.version)} title={t("Later")}>
            <X />
          </button>
        ) : null}
      </div>
      {changes.length ? (
        <ul className="update-notes">
          {changes.slice(0, 6).map((c, i) => (
            <li key={i}>{c}</li>
          ))}
          {changes.length > 6 ? <li className="muted">{t("and {n} more", { n: changes.length - 6 })}</li> : null}
        </ul>
      ) : null}
      {!update.canInstall ? (
        <div className="muted update-hint">{t("To update in place, move meerCAD into your Applications folder and start it from there.")}</div>
      ) : null}
      {progress !== null ? (
        <div className="update-progress">
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
          <span>{progress < 1 ? t("Downloading… {pct}%", { pct: Math.round(progress * 100) }) : t("Installing and restarting…")}</span>
        </div>
      ) : (
        <div className="row update-actions">
          <button className="btn" onClick={() => window.open(update.page, "_blank")}>
            {t("Release page")}
          </button>
          <span className="update-main">
            <button className="btn" onClick={() => setDismissed(update.version)}>
              {t("Later")}
            </button>
            <button
              className="btn primary"
              onClick={() => {
                if (!update.canInstall) return window.open(update.page, "_blank");
                setProgress(0);
                void desktop?.updates.install();
              }}
            >
              <Download /> {update.canInstall ? t("Update now") : t("Download")}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
