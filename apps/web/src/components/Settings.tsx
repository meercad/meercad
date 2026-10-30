/** Settings (⌘,): mouse navigation and shortcut presets, and where projects are stored. */
import { Cloud, FolderOpen, Grid3x3, HardDrive, Keyboard, Languages, Mouse, Ruler, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { langChoice, setLang, t, type LangChoice } from "../lib/i18n";
import { KEY_SCHEMES, MOUSE_SCHEMES, setPrefs, usePrefs } from "../lib/keymap";
import { iCloudFolder, nativeApp, storageKind } from "../lib/native";
import { desktop } from "../lib/persistence";
import { changeProjectsFolder, folderLabel, switchNativeStorage } from "../lib/storage";
import { Kbd } from "./Kbd";

export function Settings({ onShortcuts }: { onShortcuts: () => void }) {
  const [open, setOpen] = useState(false);
  const prefs = usePrefs();
  const [dir, setDir] = useState<string | null>(null);
  const [cloud, setCloud] = useState<{ dir: string | null; available: boolean } | null>(null);
  const [nativeKind, setNativeKind] = useState<"local" | "icloud" | null>(null);

  useEffect(() => {
    const toggle = () => setOpen((o) => !o);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        toggle();
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("meercad:settings", toggle);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("meercad:settings", toggle);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  useEffect(() => {
    if (open && desktop)
      void desktop.storage.status().then((s) => {
        setDir(s.dir);
        setCloud({ dir: s.iCloudDir, available: s.iCloudAvailable });
      });
    if (open && nativeApp) {
      void storageKind().then(setNativeKind);
      void iCloudFolder().then((d) => setCloud({ dir: d, available: !!d }));
    }
  }, [open]);

  if (!open) return null;
  const keyScheme = KEY_SCHEMES.find((s) => s.id === prefs.keys)!;
  return (
    <div className="modal-backdrop" onPointerDown={() => setOpen(false)}>
      <div className="modal settings" role="dialog" aria-label={t("Settings")} onPointerDown={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>{t("Settings")}</h2>
          <button className="icon-btn" onClick={() => setOpen(false)} title={t("Close (Esc)")}>
            <X />
          </button>
        </header>

        <section>
          <h3>
            <Languages /> {t("Language")}
          </h3>
          <div className="seg">
            {(
              [
                ["auto", t("Like the system")],
                ["en", "English"],
                ["de", "Deutsch"],
              ] as [LangChoice, string][]
            ).map(([id, label]) => (
              <button key={id} className={langChoice() === id ? "on" : ""} onClick={() => langChoice() !== id && setLang(id)} aria-pressed={langChoice() === id}>
                {label}
              </button>
            ))}
          </div>
          <p className="muted">{t("The app restarts in the chosen language; open projects stay as they are.")}</p>
        </section>

        <section>
          <h3>
            <Mouse /> {t("Mouse navigation")}
          </h3>
          <p className="muted">{t("Left click always selects. Pick the scheme your hands already know.")}</p>
          <div className="scheme-grid">
            {MOUSE_SCHEMES.map((m) => (
              <button key={m.id} className={`scheme ${prefs.mouse === m.id ? "on" : ""}`} onClick={() => setPrefs({ mouse: m.id })} aria-pressed={prefs.mouse === m.id}>
                <b>{m.label}</b>
                <span>
                  <em>{t("Rotate")}</em> {m.orbit}
                </span>
                <span>
                  <em>{t("Pan")}</em> {m.pan}
                </span>
                <span>
                  <em>{t("Zoom")}</em> {m.zoom}
                </span>
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={prefs.invertZoom} onChange={(e) => setPrefs({ invertZoom: e.target.checked })} />
            {t("Reverse zoom direction (scroll up zooms out)")}
          </label>
        </section>

        <section>
          <h3>
            <Keyboard /> {t("Keyboard shortcuts")}
          </h3>
          <div className="seg">
            {KEY_SCHEMES.map((k) => (
              <button key={k.id} className={prefs.keys === k.id ? "on" : ""} onClick={() => setPrefs({ keys: k.id })} aria-pressed={prefs.keys === k.id}>
                {k.label}
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={prefs.showKeys} onChange={(e) => setPrefs({ showKeys: e.target.checked })} />
            {t("Show shortcut badges on tools and menus")}
          </label>
          <p className="muted">
            {keyScheme.note} {t("Every badge in the app follows this choice.")}{" "}
            <button className="link" onClick={() => (setOpen(false), onShortcuts())}>
              {t("Show all shortcuts")} <Kbd k="?" />
            </button>
          </p>
        </section>

        <section>
          <h3>
            <Ruler /> {t("On the model")}
          </h3>
          <label className="check">
            <input type="checkbox" checked={prefs.showValues} onChange={(e) => setPrefs({ showValues: e.target.checked })} />
            {t("Show dimensions and sizes (diameters, distances, drag values)")}
          </label>
        </section>

        <section>
          <h3>
            <Ruler /> {t("Units")}
          </h3>
          <label className="check">
            {t("New designs in")}
            <select value={prefs.units} onChange={(e) => setPrefs({ units: e.target.value as "metric" | "imperial" })}>
              <option value="metric">{t("Metric (mm)")}</option>
              <option value="imperial">{t("Imperial (inches)")}</option>
            </select>
          </label>
          <p className="muted">{t("An open design switches in File → Millimetres / Inches. Switching never changes sizes, only how lengths are shown and typed.")}</p>
        </section>

        <section>
          <h3>
            <Grid3x3 /> {t("Sketching")}
          </h3>
          <label className="check">
            <input type="checkbox" checked={prefs.snapGrid} onChange={(e) => setPrefs({ snapGrid: e.target.checked })} />
            {t("Grid: show it and snap to it (its spacing follows the zoom; also for drag arrows)")}
          </label>
          <label className="check">
            <input type="checkbox" checked={prefs.snapGeometry} onChange={(e) => setPrefs({ snapGeometry: e.target.checked })} />
            {t("Magnet: snap to points, lines, model edges, circle centres, midpoints, crossings and alignments")}
          </label>
          <p className="muted">{t("Endpoints always snap so lines connect. Hold Alt (⌥) while drawing to place a point freely.")}</p>
        </section>

        {desktop ? (
          <section>
            <h3>
              <HardDrive /> {t("Projects folder")}
            </h3>
            <p className="muted">{t("Projects are plain .meercad files. Folders you create in meerCAD are real folders here.")}</p>
            {dir && cloud?.dir === dir ? (
              <p className="callout info">
                <Cloud /> {t("In iCloud Drive › meerCAD: the same projects on your iPhone and iPad.")}
              </p>
            ) : null}
            <div className="folder-row">
              <code title={dir ?? ""}>{dir ? folderLabel(dir, cloud?.dir ?? undefined) : "…"}</code>
              <button className="btn" onClick={() => void desktop!.projects.reveal()}>
                <FolderOpen /> {t("folder::Show")}
              </button>
              <button
                className="btn"
                onClick={async () => {
                  const d = await changeProjectsFolder();
                  if (d) setDir(d);
                }}
              >
                {cloud?.dir === dir ? t("Use my own folder…") : t("Change…")}
              </button>
            </div>
            {dir && cloud && cloud.dir !== dir ? (
              cloud.available ? (
                <>
                  <p className="callout warn">
                    <TriangleAlert /> {t("No sync: projects in this folder do not appear on your iPhone and iPad.")}
                  </p>
                  <button
                    className="btn primary"
                    onClick={async () => {
                      const d = await changeProjectsFolder(cloud.dir!);
                      if (d) setDir(d);
                    }}
                  >
                    <Cloud /> {t("Switch to iCloud")}
                  </button>
                </>
              ) : (
                <p className="muted">{t("To have your projects on iPhone and iPad too: open meerCAD there with iCloud Drive on. Then you can switch to iCloud here.")}</p>
              )
            ) : null}
          </section>
        ) : nativeApp && nativeKind ? (
          <section>
            <h3>
              {nativeKind === "icloud" ? <Cloud /> : <HardDrive />} {t("Where projects are saved")}
            </h3>
            {nativeKind === "icloud" ? (
              <>
                <p className="muted">{t("In iCloud Drive › meerCAD: on all your devices with this Apple ID, also on the Mac.")}</p>
                <button className="btn" onClick={async () => (await switchNativeStorage("local")) && setNativeKind("local")}>
                  {t("Keep on this device only…")}
                </button>
              </>
            ) : (
              <>
                <p className="muted">{t("On this device (Files › On My iPad › meerCAD). Your other devices do not see them.")}</p>
                {cloud?.available ? (
                  <button className="btn primary" onClick={async () => (await switchNativeStorage("icloud")) && setNativeKind("icloud")}>
                    <Cloud /> {t("Switch to iCloud")}
                  </button>
                ) : (
                  <p className="muted">{t("For the same projects on all your devices, sign in to iCloud and turn on iCloud Drive for meerCAD in the Settings app.")}</p>
                )}
              </>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
