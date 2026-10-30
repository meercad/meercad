import { Keyboard, X } from "lucide-react";
import { FEATURES, TOOLBAR } from "../lib/features";
import { keymapFor, MOUSE_SCHEMES, usePrefs, type Action, type Keymap } from "../lib/keymap";
import { Kbd } from "./Kbd";
import { t } from "../lib/i18n";

/** "L / R / Shift+R" for several actions; unbound ones show as "–". */
const keys = (map: Keymap, ...actions: Action[]) => actions.map((a) => map[a][0] ?? "–").join(" / ");

function sections(map: Keymap, mouse: (typeof MOUSE_SCHEMES)[number]): { title: string; rows: [string, string][] }[] {
  return [
  {
    title: t("Modeling"),
    rows: [
      ...TOOLBAR.filter((op) => map[op as Action][0]).map((op) => [FEATURES[op].label, map[op as Action][0]!] as [string, string]),
      [t("Measure"), keys(map, "measure")],
      [t("Joints"), keys(map, "joints")],
      [t("Command search"), keys(map, "palette")],
      [t("Import file"), "Mod+O"],
    ],
  },
  {
    title: t("Direct editing"),
    rows: [
      [t("Push / pull a face"), t("drag arrow")],
      [t("Extrude a sketch region"), t("drag arrow")],
      [t("Fillet selected edges"), t("drag arrow")],
      [t("Edit feature under cursor"), t("double-click")],
      [t("Context actions"), t("right-click")],
      [t("Add to selection"), t("Shift+click")],
    ],
  },
  {
    title: t("View"),
    rows: [
      [t("Rotate"), mouse.orbit],
      [t("Pan"), mouse.pan],
      [t("Zoom"), mouse.zoom],
      [t("Fit all"), keys(map, "fit")],
      [t("Look at hovered face"), keys(map, "normal")],
      [t("Iso / Front / Back"), keys(map, "view.iso", "view.front", "view.back")],
      [t("Top / Bottom"), keys(map, "view.top", "view.bottom")],
      [t("Right / Left"), keys(map, "view.right", "view.left")],
    ],
  },
  {
    title: t("Sketch"),
    rows: [
      [t("Sketch on hovered face"), keys(map, "sketch")],
      [t("Line / Rectangle / Center rectangle"), keys(map, "sketch.line", "sketch.rect", "sketch.rect_center")],
      [t("Circle / Arc / Polygon / Spline / Point"), keys(map, "sketch.circle", "sketch.arc", "sketch.polygon", "sketch.spline", "sketch.point")],
      [t("Trim / Dimension / Project edges"), keys(map, "sketch.trim", "sketch.dimension", "sketch.project")],
      [t("Round / Bevel a corner / Offset / Repeat"), keys(map, "sketch.fillet", "sketch.chamfer", "sketch.offset", "sketch.pattern")],
      [t("Construction toggle"), keys(map, "sketch.construction")],
      [t("Horizontal or vertical (nearest)"), "Shift+V"],
      [t("Coincident / Concentric"), "Shift+N / Shift+C"],
      [t("Parallel / Perpendicular"), "Shift+A / Shift+P"],
      [t("Tangent / Equal / Midpoint"), "Shift+T / Shift+E / Shift+M"],
      [t("Symmetric / Lock"), "Shift+S / Shift+L"],
      [t("Select all"), "Mod+A"],
      [t("Finish sketch"), "Enter"],
    ],
  },
  {
    title: t("General"),
    rows: [
      [t("Undo / Redo"), "Mod+Z / Shift+Mod+Z"],
      [t("Undo / Redo on iPhone and iPad"), t("2-finger tap or 3-finger swipe left / 3-finger tap or swipe right")],
      [t("Confirm tool"), t("Enter / click empty space")],
      [t("Cancel / clear selection"), "Esc"],
      [t("Delete"), "Del"],
      [t("Show this help"), "?"],
      [t("Settings"), "Mod+,"],
    ],
  },
  ];
}

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const prefs = usePrefs();
  const SECTIONS = sections(keymapFor(prefs.keys), MOUSE_SCHEMES.find((m) => m.id === prefs.mouse)!);
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label={t("Keyboard shortcuts")}>
        <div className="dialog-head">
          <Keyboard className="ficon" />
          <h3>{t("Keyboard & mouse")}</h3>
          <button className="icon-btn sm" onClick={onClose} aria-label={t("Close")}>
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
