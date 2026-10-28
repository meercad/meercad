/** Settings (⌘,): mouse navigation and shortcut presets, and where projects are stored. */
import { FolderOpen, Grid3x3, HardDrive, Keyboard, Mouse, Ruler, X } from "lucide-react";
import { useEffect, useState } from "react";
import { KEY_SCHEMES, MOUSE_SCHEMES, setPrefs, usePrefs } from "../lib/keymap";
import { desktop } from "../lib/persistence";
import { changeProjectsFolder } from "../lib/storage";
import { Kbd } from "./Kbd";

export function Settings({ onShortcuts }: { onShortcuts: () => void }) {
  const [open, setOpen] = useState(false);
  const prefs = usePrefs();
  const [dir, setDir] = useState<string | null>(null);

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
    if (open && desktop) void desktop.storage.status().then((s) => setDir(s.dir));
  }, [open]);

  if (!open) return null;
  const keyScheme = KEY_SCHEMES.find((s) => s.id === prefs.keys)!;
  return (
    <div className="modal-backdrop" onPointerDown={() => setOpen(false)}>
      <div className="modal settings" role="dialog" aria-label="Settings" onPointerDown={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={() => setOpen(false)} title="Close (Esc)">
            <X />
          </button>
        </header>

        <section>
          <h3>
            <Mouse /> Mouse navigation
          </h3>
          <p className="muted">Left click always selects. Pick the scheme your hands already know.</p>
          <div className="scheme-grid">
            {MOUSE_SCHEMES.map((m) => (
              <button key={m.id} className={`scheme ${prefs.mouse === m.id ? "on" : ""}`} onClick={() => setPrefs({ mouse: m.id })} aria-pressed={prefs.mouse === m.id}>
                <b>{m.label}</b>
                <span>
                  <em>Rotate</em> {m.orbit}
                </span>
                <span>
                  <em>Pan</em> {m.pan}
                </span>
                <span>
                  <em>Zoom</em> {m.zoom}
                </span>
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={prefs.invertZoom} onChange={(e) => setPrefs({ invertZoom: e.target.checked })} />
            Reverse zoom direction (scroll up zooms out)
          </label>
        </section>

        <section>
          <h3>
            <Keyboard /> Keyboard shortcuts
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
            Show shortcut badges on tools and menus
          </label>
          <p className="muted">
            {keyScheme.note} Every badge in the app follows this choice.{" "}
            <button className="link" onClick={() => (setOpen(false), onShortcuts())}>
              Show all shortcuts <Kbd k="?" />
            </button>
          </p>
        </section>

        <section>
          <h3>
            <Ruler /> On the model
          </h3>
          <label className="check">
            <input type="checkbox" checked={prefs.showValues} onChange={(e) => setPrefs({ showValues: e.target.checked })} />
            Show dimensions and sizes (diameters, distances, drag values)
          </label>
        </section>

        <section>
          <h3>
            <Ruler /> Units
          </h3>
          <label className="check">
            New designs in
            <select value={prefs.units} onChange={(e) => setPrefs({ units: e.target.value as "metric" | "imperial" })}>
              <option value="metric">Metric (mm)</option>
              <option value="imperial">Imperial (inches)</option>
            </select>
          </label>
          <p className="muted">An open design switches in File → Millimetres / Inches. Switching never changes sizes, only how lengths are shown and typed.</p>
        </section>

        <section>
          <h3>
            <Grid3x3 /> Sketching
          </h3>
          <label className="check">
            <input type="checkbox" checked={prefs.snapGrid} onChange={(e) => setPrefs({ snapGrid: e.target.checked })} />
            Grid: show it and snap to it (its spacing follows the zoom; also for drag arrows)
          </label>
          <label className="check">
            <input type="checkbox" checked={prefs.snapGeometry} onChange={(e) => setPrefs({ snapGeometry: e.target.checked })} />
            Magnet: snap to points, lines, model edges, circle centres, midpoints, crossings and alignments
          </label>
          <p className="muted">Endpoints always snap so lines connect. Hold Alt (⌥) while drawing to place a point freely.</p>
        </section>

        {desktop ? (
          <section>
            <h3>
              <HardDrive /> Projects folder
            </h3>
            <p className="muted">Projects are plain .meercad files. Folders you create in meerCAD are real folders here.</p>
            <div className="folder-row">
              <code title={dir ?? ""}>{dir ?? "…"}</code>
              <button className="btn" onClick={() => void desktop!.projects.reveal()}>
                <FolderOpen /> Show
              </button>
              <button
                className="btn"
                onClick={async () => {
                  const d = await changeProjectsFolder();
                  if (d) setDir(d);
                }}
              >
                Change…
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
