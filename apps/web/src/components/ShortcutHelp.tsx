import { Keyboard, X } from "lucide-react";
import { FEATURES, TOOLBAR } from "../lib/features";
import { keymapFor, MOUSE_SCHEMES, usePrefs, type Action, type Keymap } from "../lib/keymap";
import { Kbd } from "./Kbd";

/** "L / R / Shift+R" for several actions; unbound ones show as "–". */
const keys = (map: Keymap, ...actions: Action[]) => actions.map((a) => map[a][0] ?? "–").join(" / ");

function sections(map: Keymap, mouse: (typeof MOUSE_SCHEMES)[number]): { title: string; rows: [string, string][] }[] {
  return [
  {
    title: "Modeling",
    rows: [
      ...TOOLBAR.filter((op) => map[op as Action][0]).map((op) => [FEATURES[op].label, map[op as Action][0]!] as [string, string]),
      ["Measure", keys(map, "measure")],
      ["Command search", keys(map, "palette")],
      ["Import file", "Mod+O"],
    ],
  },
  {
    title: "Direct editing",
    rows: [
      ["Push / pull a face", "drag arrow"],
      ["Extrude a sketch region", "drag arrow"],
      ["Fillet selected edges", "drag arrow"],
      ["Edit feature under cursor", "double-click"],
      ["Context actions", "right-click"],
      ["Add to selection", "Shift+click"],
    ],
  },
  {
    title: "View",
    rows: [
      ["Rotate", mouse.orbit],
      ["Pan", mouse.pan],
      ["Zoom", mouse.zoom],
      ["Fit all", keys(map, "fit")],
      ["Look at hovered face", keys(map, "normal")],
      ["Iso / Front / Back", keys(map, "view.iso", "view.front", "view.back")],
      ["Top / Bottom", keys(map, "view.top", "view.bottom")],
      ["Right / Left", keys(map, "view.right", "view.left")],
    ],
  },
  {
    title: "Sketch",
    rows: [
      ["Sketch on hovered face", keys(map, "sketch")],
      ["Line / Rectangle / Center rectangle", keys(map, "sketch.line", "sketch.rect", "sketch.rect_center")],
      ["Circle / Arc / Polygon / Point", keys(map, "sketch.circle", "sketch.arc", "sketch.polygon", "sketch.point")],
      ["Trim / Dimension / Project edges", keys(map, "sketch.trim", "sketch.dimension", "sketch.project")],
      ["Construction toggle", keys(map, "sketch.construction")],
      ["Horizontal or vertical (nearest)", "Shift+V"],
      ["Coincident / Concentric", "Shift+N / Shift+C"],
      ["Parallel / Perpendicular", "Shift+A / Shift+P"],
      ["Tangent / Equal / Midpoint", "Shift+T / Shift+E / Shift+M"],
      ["Symmetric / Lock", "Shift+S / Shift+L"],
      ["Select all", "Mod+A"],
      ["Finish sketch", "Enter"],
    ],
  },
  {
    title: "General",
    rows: [
      ["Undo / Redo", "Mod+Z / Shift+Mod+Z"],
      ["Undo / Redo on the iPad", "2-finger tap or 3-finger swipe left / 3-finger tap or swipe right"],
      ["Confirm tool", "Enter / click empty space"],
      ["Cancel / clear selection", "Esc"],
      ["Delete", "Del"],
      ["Show this help", "?"],
      ["Settings", "Mod+,"],
    ],
  },
  ];
}

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const prefs = usePrefs();
  const SECTIONS = sections(keymapFor(prefs.keys), MOUSE_SCHEMES.find((m) => m.id === prefs.mouse)!);
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div className="dialog-head">
          <Keyboard className="ficon" />
          <h3>Keyboard & mouse</h3>
          <button className="icon-btn sm" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <div className="help-grid">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h4>{s.title}</h4>
              {s.rows.map(([label, k]) => (
                <div className="help-row" key={label}>
                  <span>{label}</span>
                  <span>
                    {k.split(" / ").map((part, i) => (
                      <span key={i}>
                        {i ? " " : ""}
                        {/[a-z]-?[a-z]|click|drag|wheel/i.test(part) && part.length > 3 && !part.startsWith("Mod") && !part.startsWith("Shift+R") ? <span className="muted">{part}</span> : <Kbd k={part} />}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
