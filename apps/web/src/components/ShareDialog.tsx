/**
 * Sharing a design: the .meercad file with its whole feature history, so whoever opens it can
 * change every step. It goes out through the system's sharing (AirDrop, Messages, Mail …): the
 * share menu on the Mac, the share sheet on the iPhone and iPad. Saved versions only go along when
 * asked for.
 */
import { Share, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { MeercadDocument } from "@meercad/schema";
import { currentDoc, toast, useApp } from "../store";
import { sharedDoc } from "../lib/sharedDoc";
import { nativeApp, shareFile } from "../lib/native";
import { desktop } from "../lib/persistence";
import { t, tn } from "../lib/i18n";
import { baseName } from "./io";

/** Opens the share dialog for the open design (from menus and the command palette). */
export const openShare = () => window.dispatchEvent(new Event("meercad:share"));

const fileSize = (bytes: number) => (bytes < 1024 * 1024 ? t("{n} kB", { n: Math.max(1, Math.round(bytes / 1024)) }) : t("{n} MB", { n: (bytes / 1024 / 1024).toFixed(1) }));

/** The file shared for a design: its JSON, pretty printed like a saved project. */
export function shareText(doc: MeercadDocument, versions: boolean): string {
  return JSON.stringify(sharedDoc(doc, { versions }), null, 2);
}

/** Hands the file to the system's sharing; on an old desktop app without it, a save dialog. */
async function share(name: string, text: string): Promise<void> {
  if (nativeApp) return shareFile(name, text);
  if (desktop?.shareFile) return desktop.shareFile({ name, data: text });
  const path = await desktop?.saveFile({ name, data: text, filters: [{ name: t("meerCAD part"), extensions: ["meercad"] }] });
  if (path) toast(t("Saved {path}", { path }));
}

export function ShareDialog() {
  const [open, setOpen] = useState(false);
  const [withVersions, setWithVersions] = useState(false);
  const [busy, setBusy] = useState(false);
  const doc = useApp((s) => s.doc);
  const project = useApp((s) => s.project);

  useEffect(() => {
    const show = () => {
      if (!useApp.getState().project) return;
      setWithVersions(false);
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("meercad:share", show);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("meercad:share", show);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  if (!open || !project) return null;

  const versions = doc.versions?.length ?? 0;
  const text = shareText(doc, withVersions);
  const name = `${baseName()}.meercad`;
  const go = async () => {
    setBusy(true);
    try {
      // The design as it is now, edits of the last moment included.
      await share(name, shareText(currentDoc(), withVersions));
      setOpen(false);
    } catch (e) {
      toast(t("Could not share {name}: {error}", { name, error: (e as Error).message }), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onPointerDown={() => setOpen(false)}>
      <div className="modal settings share-dialog" role="dialog" aria-label={t("Share design")} onPointerDown={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>{t("Share design")}</h2>
          <button className="icon-btn" onClick={() => setOpen(false)} title={t("Close (Esc)")}>
            <X />
          </button>
        </header>
        <p>
          <b>{name}</b> <span className="muted small">· {fileSize(new TextEncoder().encode(text).length)}</span>
        </p>
        <p className="muted">{t("The design goes along with every step of its history: whoever opens it in meerCAD can change all of it, just like you. It does not change your own copy.")}</p>
        {versions ? (
          <label className="check">
            <input type="checkbox" checked={withVersions} onChange={(e) => setWithVersions(e.target.checked)} />
            <span>{tn(versions, "Include the saved version", "Include the {n} saved versions")}</span>
          </label>
        ) : null}
        <div className="row share-actions">
          <button className="btn" onClick={() => setOpen(false)}>
            {t("Cancel")}
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void go()}>
            <Share /> {t("Share…")}
          </button>
        </div>
      </div>
    </div>
  );
}
