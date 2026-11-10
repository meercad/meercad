/**
 * Versions: named states of the design, saved in the file. Each can be looked at in the viewport
 * (a preview, the design untouched), restored (the design as it is now is saved first if no
 * version holds it), renamed, deleted or saved as a file of its own (a backup outside the app);
 * "From file…" brings such a file (or a whole project file's versions) back in as versions.
 */
import { Download, Eye, FileUp, History, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { applyOp, designOf, versionChanges } from "@meercad/model";
import type { Version } from "@meercad/schema";
import { apply, currentDoc, scheduleRebuild, toast, useApp } from "../store";
import { t, tn } from "../lib/i18n";
import { importVersionFile, saveVersionFile } from "./io";

/** Opens the versions dialog (from menus and the command palette). */
export const openVersions = () => window.dispatchEvent(new Event("meercad:versions"));

/** How the design now differs from a version: "2 new steps · 1 step changed", or "Same as now". */
function changesText(v: Version): string {
  const c = versionChanges(v.state, currentDoc());
  const parts = [
    c.added.length ? tn(c.added.length, "{n} new step", "{n} new steps") : null,
    c.changed.length ? tn(c.changed.length, "{n} step changed", "{n} steps changed") : null,
    c.removed.length ? tn(c.removed.length, "{n} step removed", "{n} steps removed") : null,
    c.other ? t("variables or parts changed") : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("Same as now");
}

const nextName = (versions: readonly Version[]) => {
  for (let n = versions.length + 1; ; n++) {
    const name = t("Version {n}", { n });
    if (!versions.some((v) => v.name === name)) return name;
  }
};

export function VersionsDialog() {
  const [open, setOpen] = useState(false);
  const versions = useApp((s) => s.doc.versions) ?? [];
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ name: string; to: string } | null>(null);

  useEffect(() => {
    const show = () => {
      setName("");
      setEditing(null);
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("meercad:versions", show);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("meercad:versions", show);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  if (!open) return null;

  const save = () => {
    const n = name.trim() || nextName(versions);
    if (apply({ type: "save_version", name: n })) {
      setName("");
      toast(t("Saved as “{name}”", { name: n }));
    }
  };
  const preview = (v: Version) => {
    try {
      useApp.setState({ proposalDoc: designOf(applyOp(currentDoc(), { type: "restore_version", name: v.name })) });
      scheduleRebuild();
      setOpen(false);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const restore = (v: Version) => {
    // Nothing gets lost: the design as it is now is kept as a version unless one holds it already.
    const doc = currentDoc();
    const kept = (doc.versions ?? []).some((x) => {
      const c = versionChanges(x.state, doc);
      return !c.added.length && !c.changed.length && !c.removed.length && !c.other;
    });
    const before = t("Before “{name}”", { name: v.name });
    const ops = [...(kept ? [] : [{ type: "save_version" as const, name: (doc.versions ?? []).some((x) => x.name === before) ? `${before} ${new Date().toLocaleTimeString()}` : before }]), { type: "restore_version" as const, name: v.name }];
    if (apply(...ops)) {
      useApp.setState({ proposalDoc: null });
      toast(kept ? t("Restored “{name}”", { name: v.name }) : t("Restored “{name}”; the design before is kept as a version", { name: v.name }));
    }
  };
  const fromFile = async () => {
    const names = await importVersionFile();
    if (names.length === 1) toast(t("Brought in as version “{name}”", { name: names[0]! }));
    else if (names.length) toast(tn(names.length, "Brought in {n} version", "Brought in {n} versions"));
  };
  const rename = () => {
    if (!editing) return;
    const to = editing.to.trim();
    if (to && to !== editing.name) apply({ type: "rename_version", name: editing.name, to });
    setEditing(null);
  };

  return (
    <div className="modal-backdrop" onPointerDown={() => setOpen(false)}>
      <div className="modal settings versions-dialog" role="dialog" aria-label={t("Versions")} onPointerDown={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>{t("Versions")}</h2>
          <button className="icon-btn" onClick={() => setOpen(false)} title={t("Close (Esc)")}>
            <X />
          </button>
        </header>
        <p className="muted small">{t("Save the design as it is now under a name, to come back to it later. Versions are kept in the project file.")}</p>
        <p className="muted small">{t("To keep one somewhere else as well, save it as a file of its own; From file… brings such a file back in as a version.")}</p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input className="field" style={{ flex: 1, minWidth: 160 }} value={name} placeholder={nextName(versions)} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
          <button className="btn primary" onClick={save}>
            <History /> {t("Save version")}
          </button>
          <button className="btn" onClick={() => void fromFile()} title={t("Bring a saved .meercad file in as a version")}>
            <FileUp /> {t("From file…")}
          </button>
        </div>
        {versions.length ? (
          <ul className="version-list">
            {[...versions].reverse().map((v) => (
              <li key={v.name}>
                <div className="version-main">
                  {editing?.name === v.name ? (
                    <input className="field" autoFocus value={editing.to} onChange={(e) => setEditing({ ...editing, to: e.target.value })} onBlur={rename} onKeyDown={(e) => (e.key === "Enter" ? rename() : e.key === "Escape" && (e.stopPropagation(), setEditing(null)))} />
                  ) : (
                    <b>{v.name}</b>
                  )}
                  <span className="muted small">
                    {new Date(v.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · {changesText(v)}
                  </span>
                </div>
                <div className="version-actions">
                  <button className="icon-btn" title={t("Look at it (the design stays as it is)")} onClick={() => preview(v)}>
                    <Eye />
                  </button>
                  <button className="icon-btn" title={t("Restore")} onClick={() => restore(v)}>
                    <RotateCcw />
                  </button>
                  <button className="icon-btn" title={t("Save as a file…")} onClick={() => saveVersionFile(v.name)}>
                    <Download />
                  </button>
                  <button className="icon-btn" title={t("Rename")} onClick={() => setEditing({ name: v.name, to: v.name })}>
                    <Pencil />
                  </button>
                  <button className="icon-btn" title={t("Delete")} onClick={() => apply({ type: "delete_version", name: v.name })}>
                    <Trash2 />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t("No versions yet.")}</p>
        )}
      </div>
    </div>
  );
}
