/**
 * The tool rail on the left of the viewport. Tools sit in a few groups that
 * open as a flyout; single tools are direct buttons. Every entry shows its shortcut.
 */
import {
  Box,
  Check,
  Circle,
  Crosshair,
  Dot,
  Hexagon,
  Import,
  Layers,
  Link2,
  ScanLine,
  Orbit,
  Mountain,
  MousePointer2,
  Move3d,
  Ruler,
  Scissors,
  Shapes,
  Slash,
  Spline,
  DraftingCompass,
  Square,
  SquareDashed,
  SquarePen,
  Waypoints,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";
import type { FeatureOp } from "@meercad/schema";
import { toggleJoints, useMotion } from "../lib/mechanism";
import { FEATURES } from "../lib/features";
import { keyFor, usePrefs, type Action } from "../lib/keymap";
import { toggleConstruction } from "../sketch/actions";
import { setTool, useSketchUi, type SketchTool } from "../sketch/state";
import { closeSketch, startFeature, toggleSide, useApp } from "../store";
import { useCompact, usePhoneSheets } from "../lib/layout";
import { importFile } from "./io";
import { Kbd } from "./Kbd";
import { showMenu } from "./Menu";
import { canScan, scanObject } from "../lib/scan";

/** Whether this device can scan objects (iPhone/iPad with LiDAR). */
function useCanScan(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => void canScan().then(setOk), []);
  return ok;
}

type Icon = LucideIcon | ComponentType<SVGProps<SVGSVGElement>>;

interface RailTool {
  id: string;
  icon: Icon;
  label: string;
  kbd?: string;
  hint?: string;
  active?: boolean;
  primary?: boolean;
  run: () => void;
}
interface RailGroup {
  id: string;
  icon: Icon;
  label: string;
  tools: RailTool[];
}
type RailEntry = RailTool | RailGroup | "sep";

const isGroup = (e: RailEntry): e is RailGroup => typeof e === "object" && "tools" in e;

const withKbd = (key: string | undefined) => (key ? { kbd: key } : {});

function feature(op: FeatureOp & Action, activeOp: string | undefined): RailTool {
  const m = FEATURES[op];
  return { id: op, icon: m.icon, label: m.label, hint: m.hint, active: activeOp === op, run: () => startFeature(op), ...withKbd(keyFor(op)) };
}

function sketchTool(tool: SketchTool, icon: Icon, label: string, current: SketchTool): RailTool {
  const kbd = tool === "select" ? "Esc" : keyFor(`sketch.${tool}`);
  return { id: tool, icon, label, active: current === tool, run: () => setTool(tool), ...withKbd(kbd) };
}

function useEntries(): RailEntry[] {
  const sketchId = useApp((s) => s.sketchId);
  const activeOp = useApp((s) => s.dialog?.feature.op);
  const measure = useApp((s) => s.measure.active);
  const joints = useMotion((s) => s.open);
  const ui = useSketchUi();
  usePrefs((s) => s.keys); // badges follow the shortcut preset
  const scan = useCanScan();

  if (sketchId) {
    const t = ui.tool;
    return [
      sketchTool("select", MousePointer2, "Select", t),
      sketchTool("line", Slash, "Line", t),
      {
        id: "rects",
        icon: Square,
        label: "Rectangle",
        tools: [sketchTool("rect", Square, "Corner rectangle", t), sketchTool("rect_center", SquareDashed, "Center rectangle", t)],
      },
      sketchTool("circle", Circle, "Circle", t),
      { id: "arcs", icon: Spline, label: "Arc", tools: [sketchTool("arc", Spline, "3-point arc", t), sketchTool("arc_center", DraftingCompass, "Center arc", t)] },
      { id: "shapes", icon: Shapes, label: "More", tools: [sketchTool("polygon", Hexagon, "Polygon", t), sketchTool("point", Dot, "Point", t)] },
      "sep",
      sketchTool("dimension", Ruler, "Dimension", t),
      sketchTool("trim", Scissors, "Trim", t),
      {
        id: "sketch-tools",
        icon: Wrench,
        label: "Tools",
        tools: [
          sketchTool("project", Waypoints, "Project model edges", t),
          { id: "construction", icon: Crosshair, label: "Construction geometry", ...withKbd(keyFor("sketch.construction")), active: ui.construction, run: toggleConstruction },
        ],
      },
      "sep",
      { id: "finish", icon: Check, label: "Finish", kbd: "↵", primary: true, run: closeSketch },
    ];
  }

  return [
    feature("sketch", activeOp),
    "sep",
    { id: "create", icon: Box, label: "Create", tools: [feature("extrude", activeOp), feature("revolve", activeOp), feature("loft", activeOp), feature("sweep", activeOp), feature("rib", activeOp), feature("gear", activeOp), feature("plane", activeOp)] },
    { id: "modify", icon: SquarePen, label: "Modify", tools: [feature("fillet", activeOp), feature("chamfer", activeOp), feature("shell", activeOp), feature("draft", activeOp), feature("hole", activeOp), feature("thread", activeOp), feature("split", activeOp), feature("boolean", activeOp)] },
    {
      id: "transform",
      icon: Move3d,
      label: "Transform",
      tools: [feature("transform", activeOp), feature("linear_pattern", activeOp), feature("circular_pattern", activeOp), feature("mirror", activeOp)],
    },
    "sep",
    {
      id: "joints",
      icon: Link2,
      label: "Joints",
      ...withKbd(keyFor("joints")),
      hint: "Joints: parts that turn or slide; drag them to try",
      active: joints,
      run: toggleJoints,
    },
    {
      id: "measure",
      icon: Ruler,
      label: "Measure",
      ...withKbd(keyFor("measure")),
      hint: "Distances, angles and radii",
      active: measure,
      run: () => useApp.setState((s) => ({ measure: { active: !s.measure.active, picks: [], result: null }, dialog: null })),
    },
    ...(scan
      ? [
          {
            id: "scan",
            icon: ScanLine,
            label: "Scan",
            tools: [
              { id: "scan-object", icon: Orbit, label: "Object (photos)", hint: "Walk all around an object; fine detail, takes a few minutes", run: () => void scanObject("object") },
              { id: "scan-lidar", icon: Box, label: "Object (LiDAR)", hint: "Sweep around an object with LiDAR; quick and coarser, reachable sides are enough", run: () => void scanObject("lidar") },
              { id: "scan-surface", icon: Mountain, label: "Surface (LiDAR)", hint: "Sweep over a surface, e.g. a recess a part must fit into", run: () => void scanObject("surface") },
            ],
          },
        ]
      : []),
    { id: "import", icon: Import, label: "Import", kbd: "Mod+O", hint: "STEP, STL, 3MF, OBJ, DXF or SVG", run: () => void importFile() },
  ];
}

export function Toolbar() {
  const compact = useCompact();
  // Phone: import is in the "⋯" menu and finishing a sketch in its header bar.
  const entries = useEntries().filter((e) => !(compact && typeof e === "object" && (e.id === "import" || e.id === "finish")));
  const [open, setOpen] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const closeTimer = useRef<number>(0);
  const rail = useRef<HTMLDivElement>(null);
  const sideOpen = useApp((s) => s.sideOpen);
  const sketching = useApp((s) => !!s.sketchId);
  const constraints = usePhoneSheets((s) => s.constraints);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!rail.current?.contains(e.target as Node)) setOpen(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  // Any tool started by shortcut closes an open flyout.
  const entryKey = entries.map((e) => (typeof e === "object" ? e.id : e)).join();
  useEffect(() => setOpen(null), [entryKey]);

  const hover = (id: string | null) => {
    window.clearTimeout(closeTimer.current);
    if (pinned && id === null) return;
    if (id === null) closeTimer.current = window.setTimeout(() => setOpen(null), 220);
    else setOpen(id);
  };
  const run = (t: RailTool) => {
    setOpen(null);
    setPinned(false);
    t.run();
  };

  // Phone: the bar scrolls sideways; mark which ends hide more tools, for the fades there.
  const [more, setMore] = useState<"left" | "right" | "both" | undefined>();
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !compact) return setMore(undefined);
    const update = () => {
      const left = el.scrollLeft > 4;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
      setMore(left && right ? "both" : left ? "left" : right ? "right" : undefined);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [compact, entryKey]);

  return (
    <nav className="toolbar rail" ref={rail} aria-label="Tools" onPointerLeave={() => hover(null)} data-more={more}>
      <div className="rail-items" ref={scroller}>
      {/* Phone: the panels that have no room on screen open from the bar. */}
      {compact ? (
        sketching ? (
          <button className={`tool ${constraints ? "active" : ""}`} onClick={() => usePhoneSheets.setState({ constraints: !constraints })}>
            <Link2 />
            <span>Constrain</span>
          </button>
        ) : (
          <button className={`tool ${sideOpen ? "active" : ""}`} onClick={() => toggleSide()}>
            <Layers />
            <span>Parts</span>
          </button>
        )
      ) : null}
      {compact ? <div className="sep" /> : null}
      {entries.map((e, i) => {
        if (e === "sep") return <div className="sep" key={`sep${i}`} />;
        if (!isGroup(e)) {
          return (
            <button
              key={e.id}
              className={`tool ${e.active ? "active" : ""} ${e.primary ? "primary" : ""}`}
              title={`${e.label}${e.hint ? ` — ${e.hint}` : ""}`}
              onPointerEnter={() => hover(null)}
              onClick={() => run(e)}
            >
              <e.icon />
              <span>{e.label}</span>
              {e.kbd ? <Kbd k={e.kbd} /> : null}
            </button>
          );
        }
        const active = e.tools.find((t) => t.active);
        const GroupIcon = active?.icon ?? e.icon;
        return (
          <div className="rail-group" key={e.id} onPointerEnter={() => !compact && hover(e.id)}>
            <button
              className={`tool group ${active ? "active" : ""} ${open === e.id ? "open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={open === e.id}
              onClick={(ev) => {
                // Phone: the group opens as a menu above the bar (the bar scrolls sideways and would clip a flyout).
                if (compact) {
                  const r = ev.currentTarget.getBoundingClientRect();
                  return showMenu(r.left, r.top - 8, e.tools.map((t) => ({ label: t.label, icon: <t.icon />, onClick: () => run(t) })), { above: true });
                }
                setPinned(open !== e.id || !pinned);
                setOpen(open === e.id && pinned ? null : e.id);
              }}
            >
              <GroupIcon />
              <span>{e.label}</span>
              <i className="rail-more" />
            </button>
            {open === e.id ? (
              <div className="rail-flyout" role="menu" aria-label={e.label}>
                <div className="rail-flyout-title">{e.label}</div>
                {e.tools.map((t) => (
                  <button key={t.id} role="menuitem" className={t.active ? "active" : ""} onClick={() => run(t)} title={t.hint ?? t.label}>
                    <t.icon />
                    <span className="rail-flyout-label">
                      {t.label}
                      {t.hint ? <small>{t.hint}</small> : null}
                    </span>
                    {t.kbd ? <Kbd k={t.kbd} /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      </div>
    </nav>
  );
}
