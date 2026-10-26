import { Keyboard, X } from "lucide-react";
import { FEATURES, TOOLBAR } from "../lib/features";
import { Kbd } from "./Kbd";

const SECTIONS: { title: string; rows: [string, string][] }[] = [
  { title: "Modeling", rows: [...TOOLBAR.filter((op) => FEATURES[op].shortcut).map((op) => [FEATURES[op].label, FEATURES[op].shortcut!] as [string, string]), ["Measure", "M"], ["Import file", "Mod+O"]] },
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
      ["Rotate", "right-drag"],
      ["Pan", "middle-drag / Shift+right-drag"],
      ["Zoom", "wheel"],
      ["Fit all", "Z"],
      ["Front / Back / Left / Right", "1 / 2 / 3 / 4"],
      ["Top / Bottom / Iso", "5 / 6 / 0"],
    ],
  },
  {
    title: "Sketch",
    rows: [
      ["Line / Rectangle / Center rectangle", "L / R / Shift+R"],
      ["Circle / Arc / Point", "C / A / P"],
      ["Dimension", "D"],
      ["Use model edges", "U"],
      ["Construction toggle", "X"],
      ["Horizontal / Vertical", "H / V"],
      ["Coincident / Tangent / Equal", "I / T / E"],
      ["Select all", "Mod+A"],
      ["Finish sketch", "Enter"],
    ],
  },
  {
    title: "General",
    rows: [
      ["Undo / Redo", "Mod+Z / Shift+Mod+Z"],
      ["Confirm dialog", "Enter"],
      ["Cancel / clear selection", "Esc"],
      ["Delete", "Del"],
      ["Show this help", "?"],
    ],
  },
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
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
