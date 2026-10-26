import {
  Check,
  Hexagon,
  Keyboard,
  Scissors,
  Circle,
  CircleDot,
  Crosshair,
  Dot,
  Equal,
  Lock,
  MousePointer2,
  Ruler,
  Slash,
  Spline,
  Square,
  SquareDashed,
  Upload,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { FEATURES, TOOLBAR } from "../lib/features";
import { applyConstraint, CONSTRAINT_TOOLS, toggleConstruction } from "../sketch/actions";
import { setTool, useSketchUi, type SketchTool } from "../sketch/state";
import { closeSketch, startFeature, useApp } from "../store";
import { importFile } from "./io";
import { Kbd } from "./Kbd";

function Tool({ icon: Icon, label, onClick, active, disabled, title, primary, kbd }: { icon: LucideIcon | ComponentType<SVGProps<SVGSVGElement>>; label: string; onClick: () => void; active?: boolean; disabled?: boolean; title?: string; primary?: boolean; kbd?: string }) {
  return (
    <button className={`tool ${active ? "active" : ""} ${primary ? "primary" : ""}`} onClick={onClick} disabled={disabled} title={title ?? label}>
      <Icon />
      <span>{label}</span>
      {kbd ? <Kbd k={kbd} /> : null}
    </button>
  );
}

const SKETCH_TOOLS: { tool: SketchTool; icon: LucideIcon; label: string; key: string }[] = [
  { tool: "select", icon: MousePointer2, label: "Select", key: "Esc" },
  { tool: "line", icon: Slash, label: "Line", key: "L" },
  { tool: "rect", icon: Square, label: "Rectangle", key: "R" },
  { tool: "rect_center", icon: SquareDashed, label: "Center rect", key: "⇧R" },
  { tool: "circle", icon: Circle, label: "Circle", key: "C" },
  { tool: "arc", icon: Spline, label: "Arc", key: "A" },
  { tool: "polygon", icon: Hexagon, label: "Polygon", key: "G" },
  { tool: "point", icon: Dot, label: "Point", key: "P" },
  { tool: "trim", icon: Scissors, label: "Trim", key: "T" },
  { tool: "dimension", icon: Ruler, label: "Dimension", key: "D" },
  { tool: "project", icon: Waypoints, label: "Use edges", key: "U" },
];

export function Toolbar() {
  const sketchId = useApp((s) => s.sketchId);
  const dialog = useApp((s) => s.dialog);
  const measure = useApp((s) => s.measure.active);
  const ui = useSketchUi();

  if (sketchId) {
    return (
      <div className="toolbar">
        {SKETCH_TOOLS.map((t) => (
          <Tool key={t.tool} icon={t.icon} label={t.label} title={`${t.label} (${t.key})`} kbd={t.key} active={ui.tool === t.tool} onClick={() => setTool(t.tool)} />
        ))}
        <Tool icon={Crosshair} label="Construction" title="Toggle construction geometry (X)" kbd="X" active={ui.construction} onClick={toggleConstruction} />
        <div className="sep" />
        {CONSTRAINT_TOOLS.map((c) => (
          <Tool key={c.type} icon={c.icon} label={c.label} title={`${c.label}${c.key ? ` (${c.key})` : ""} — ${c.hint}`} {...(c.key ? { kbd: c.key } : {})} onClick={() => applyConstraint(c.type)} />
        ))}
        <div className="spacer" />
        <Tool icon={Check} label="Finish" title="Finish sketch (Enter)" kbd="↵" primary onClick={closeSketch} />
      </div>
    );
  }

  const groups: ReactNode[] = [];
  TOOLBAR.forEach((op, i) => {
    const m = FEATURES[op];
    if (i === 1 || i === 3 || i === 6 || i === 9) groups.push(<div className="sep" key={`s${i}`} />);
    groups.push(
      <Tool key={op} icon={m.icon} label={m.label} title={`${m.label}${m.shortcut ? ` (${m.shortcut})` : ""} — ${m.hint}`} {...(m.shortcut ? { kbd: m.shortcut } : {})} active={dialog?.feature.op === op} onClick={() => startFeature(op)} />,
    );
  });
  return (
    <div className="toolbar">
      {groups}
      <div className="sep" />
      <Tool icon={Ruler} label="Measure" title="Measure (M)" kbd="M" active={measure} onClick={() => useApp.setState((s) => ({ measure: { active: !s.measure.active, picks: [], result: null }, dialog: null }))} />
      <Tool icon={Upload} label="Import" title="Import STEP, STL, DXF or SVG (⌘O)" kbd="Mod+O" onClick={() => importFile()} />
      <div className="spacer" />
      <Tool icon={Keyboard} label="Shortcuts" title="Keyboard shortcuts (?)" kbd="?" onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }))} />
    </div>
  );
}

export const CONSTRAINT_ICONS = { Equal, Lock, CircleDot };
