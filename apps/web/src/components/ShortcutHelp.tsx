import { Keyboard, X } from "lucide-react";
import { FEATURES, TOOLBAR } from "../lib/features";
import { keymapFor, MOUSE_SCHEMES, usePrefs, type Action, type Keymap } from "../lib/keymap";
import { Kbd } from "./Kbd";
import { t } from "../lib/i18n";
import { hasPack } from "../lib/premium";

/** A key binding ("Shift+R", "Mod+Num1", "Escape", "?"), as opposed to a described gesture. */
const isBinding = (part: string) => /^((Mod|Shift|Alt)\+)*([^\s]|Enter|Escape|Esc|Delete|Del|Backspace|Space|Home|Tab|F\d{1,2}|Num\d)$/.test(part);

/** "L / R / Shift+R" for several actions; unbound ones show as "–". */
const keys = (map: Keymap, ...actions: Action[]) => actions.map((a) => map[a][0] ?? "–").join(" / ");

function sections(map: Keymap, mouse: (typeof MOUSE_SCHEMES)[number]): { title: string; rows: [string, string][] }[] {
  return [
  {
    title: t("Modeling"),
    rows: [
      ...TOOLBAR.filter((op) => map[op as Action][0] && ((op !== "gear" && op !== "spring") || hasPack("mechanics"))).map((op) => [FEATURES[op].label, map[op as Action][0]!] as [string, string]),
      [t("Measure"), keys(map, "measure")],
      ...(hasPack("mechanics") ? [[t("Joints"), keys(map, "joints")] as [string, string]] : []),
      [t("Command search"), keys(map, "palette")],
      ...(map.repeat[0] ? [[t("Repeat last command"), keys(map, "repeat")] as [string, string]] : []),
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
      [mouse.rightClick === "confirm" ? t("Finish the tool (else context actions)") : t("Context actions"), t("right-click")],
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
      ...(map.hide[0] ? [[t("Hide selected / show all"), keys(map, "hide", "unhide_all")] as [string, string]] : []),
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
      [t("Horizontal or vertical (nearest)"), keys(map, "constraint.hv")],
      [t("Coincident / Concentric"), keys(map, "constraint.coincident", "constraint.concentric")],
      [t("Parallel / Perpendicular"), keys(map, "constraint.parallel", "constraint.perpendicular")],
      [t("Tangent / Equal / Midpoint"), keys(map, "constraint.tangent", "constraint.equal", "constraint.midpoint")],
      [t("Symmetric / Lock"), keys(map, "constraint.symmetric", "constraint.fix")],
      [t("Select all"), keys(map, "select_all")],
      [t("Finish sketch"), keys(map, "confirm")],
      ...(mouse.rightClick === "confirm" ? [[t("End the line, then the tool, then the sketch"), t("right-click")] as [string, string]] : []),
    ],
  },
  {
    title: t("General"),
    rows: [
      [t("Undo / Redo"), "Mod+Z / Shift+Mod+Z"],
      [t("Undo / Redo on iPhone and iPad"), t("2-finger tap or 3-finger swipe left / 3-finger tap or swipe right")],
      [t("Confirm tool"), `${keys(map, "confirm")} / ${mouse.rightClick === "confirm" ? t("right-click") : t("click empty space")}`],
      [t("Cancel / clear selection"), keys(map, "cancel")],
      [t("Delete"), map.delete.join(" / ")],
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
                        {isBinding(part) ? <Kbd k={part} /> : <span className="muted">{part}</span>}
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
