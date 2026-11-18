/**
 * The sketch editor's HTML: value chips and constraint labels over the sketch, the typed-value
 * fields at the cursor, the constraint palette and the panel with the sketch's state and tool options.
 */
import { followChipDrag } from "../../lib/chipDrag";
import { useEffect, useState, type MutableRefObject } from "react";
import type { Expr, SketchConstraint, SketchFeature } from "@meercad/schema";
import type { SolvedSketch } from "@meercad/sketch";
import { ValueInput } from "../../components/ValueInput";
import { InlineInput } from "../../components/InlineValues";
import { Kbd } from "../../components/Kbd";
import { featureName } from "../../lib/features";
import { t, tn } from "../../lib/i18n";
import { keyFor } from "../../lib/keymap";
import { docUnit } from "../../lib/units";
import { closeSketch } from "../../store";
import { sureTap } from "../../lib/gestures";
import { usePhoneSheets } from "../../lib/layout";
import { Link2 } from "lucide-react";
import { applyConstraint, CONSTRAINT_TOOLS } from "../actions";
import { setSketchSelection, useSketchUi, type SketchSel, type SketchTool } from "../state";
import type { ValueOf } from "./entry";
import type { Label } from "./labels";
import { ANGLE_FIELD, EDIT_TOOLS, ENTRY_FIELDS, isAngleField, POINT_TOOLS } from "./tools";
import type { Entry, QuickDim } from "./types";

/** "Done" in the phone header: answers the first tap, also while the sketch is still rebuilding. */
const doneTap = sureTap(closeSketch);

/** The new shape's size and angle as chips; tapping one lets the value be typed as a dimension. */
export function QuickChips({
  quick,
  shapeId,
  typing,
  setTyping,
  onSet,
}: {
  quick: QuickDim[];
  shapeId: string | undefined;
  typing: string | null;
  setTyping: (key: string | null) => void;
  onSet: (make: QuickDim["make"], expr: Expr) => void;
}) {
  return (
    <>
      {quick.map((q) => (
        <div
          key={`${shapeId}.${q.key}`}
          className={`value-chip quick-dim ${q.key}`}
          data-x={q.at[0]}
          data-y={q.at[1]}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {typing === q.key ? (
            <InlineInput
              value={q.value}
              length={q.length}
              onDone={(expr) => {
                setTyping(null);
                if (expr !== null) onSet(q.make, expr);
              }}
            />
          ) : (
            <button onClick={() => setTyping(q.key)} title={t("Tap to set this value exactly")}>
              {q.text}
            </button>
          )}
        </div>
      ))}
    </>
  );
}

/** Dimension values and constraint glyphs; a double-clicked dimension turns into a field. */
export function ConstraintLabels({
  sketch,
  labels,
  editing,
  setEditing,
  selection,
  conflicting,
  tool,
  onEdited,
  onMoved,
}: {
  sketch: SketchFeature;
  labels: Label[];
  editing: string | null;
  setEditing: (id: string | null) => void;
  selection: SketchSel[];
  conflicting: Set<string>;
  tool: SketchTool;
  onEdited: (constraints: SketchConstraint[]) => void;
  /** A dimension's value dragged to a spot on the screen. */
  onMoved?: (id: string, clientX: number, clientY: number) => void;
}) {
  return (
    <>
      {labels.map((l) =>
        l.id === editing ? (
          <div key={l.id} className="sketch-label sel" data-x={l.at[0]} data-y={l.at[1]}>
            <ValueInput
              value={
                (sketch.constraints.find((constraint) => constraint.id === l.id) as { value: Expr }).value
              }
              unit={
                ["angle", "arc_angle"].includes(
                  sketch.constraints.find((constraint) => constraint.id === l.id)?.type ?? "",
                )
                  ? "deg"
                  : "mm"
              }
              suggest={sketch.constraints.find((constraint) => constraint.id === l.id)?.type ?? "dimension"}
              onDone={(expr) => {
                setEditing(null);
                if (expr === null) return;

                const constraints = sketch.constraints.map((constraint) =>
                  constraint.id === l.id ? ({ ...constraint, value: expr } as SketchConstraint) : constraint,
                );
                onEdited(constraints);
              }}
            />
          </div>
        ) : (
          <div
            key={l.id}
            data-x={l.at[0]}
            data-y={l.at[1]}
            className={`${l.dimension ? "sketch-label" : "glyph"} ${selection.some((sel) => sel.kind === "constraint" && sel.id === l.id) ? "sel" : ""} ${conflicting.has(l.id) ? "conflict" : ""}`}
            title={l.title}
            // While drawing, a click on a dimension or symbol means the spot below it (a midpoint, a
            // centre).
            style={POINT_TOOLS.has(tool) ? { pointerEvents: "none" } : undefined}
            onPointerDown={(event) => {
              event.stopPropagation();
              // A dimension's value can be dragged out of the way; a short press stays a click.
              if (l.dimension && onMoved) followChipDrag(event, (x, y) => onMoved(l.id, x, y));
            }}
            onClick={(event) => {
              const sel: SketchSel = { kind: "constraint", id: l.id };
              const cur = useSketchUi.getState().selection;
              setSketchSelection(event.shiftKey ? [...cur, sel] : [sel]);
            }}
            onDoubleClick={() => l.dimension && setEditing(l.id)}
          >
            {l.text}
          </div>
        ),
      )}
    </>
  );
}

/** The fields for exact values while drawing, at the cursor. */
export function DrawEntry({
  tool,
  entry,
  setEntry,
  inputs,
  at,
  valueOf,
  onPlace,
}: {
  tool: SketchTool;
  entry: Entry;
  setEntry: (entry: Entry | null) => void;
  inputs: MutableRefObject<(HTMLInputElement | null)[]>;
  at: { x: number; y: number };
  valueOf: ValueOf;
  onPlace: () => void;
}) {
  const labels = ENTRY_FIELDS[tool]!;

  return (
    <div
      className="draw-entry"
      style={{ left: at.x, top: at.y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {labels.map((label, i) => (
        <label
          key={label}
          className={
            valueOf(entry.fields[i], isAngleField(tool, i)) === null && entry.fields[i]?.trim() ? "bad" : ""
          }
        >
          <span>{label}</span>
          <input
            ref={(element) => {
              inputs.current[i] = element;
            }}
            value={entry.fields[i] ?? ""}
            placeholder={i === 0 ? "" : t("auto")}
            onFocus={() => entry.active !== i && setEntry({ ...entry, active: i })}
            onChange={(event) =>
              setEntry({
                ...entry,
                fields: entry.fields.map((f, j) => (j === i ? event.target.value : f)),
              })
            }
            onKeyDown={(event) => {
              event.stopPropagation();

              if (event.key === "Enter") {
                onPlace();
              } else if (event.key === "Escape") {
                setEntry(null);
              } else if (event.key === "Tab") {
                event.preventDefault();

                const n = labels.length;
                setEntry({ ...entry, active: (i + (event.shiftKey ? n - 1 : 1)) % n });
              }
            }}
          />
          {label === ANGLE_FIELD ? null : <em>{docUnit()}</em>}
        </label>
      ))}
      <small>{t("Enter to place · Tab next · Esc back to the mouse")}</small>
    </div>
  );
}

/** The constraint buttons; on a phone a sheet opened from the tool bar. */
export function ConstraintPalette({ open }: { open: boolean }) {
  return (
    <div className={`constraint-palette ${open ? "open" : ""}`}>
      <div className="palette-title">{t("Constraints")}</div>
      {CONSTRAINT_TOOLS.map((c) => (
        <button key={c.type} onClick={() => applyConstraint(c.type)} title={`${c.label} — ${c.hint}`}>
          <c.icon />
          <span>{c.label}</span>
          {keyFor(`constraint.${c.type}`) ? <Kbd k={keyFor(`constraint.${c.type}`)!} /> : null}
        </button>
      ))}
    </div>
  );
}

/** The panel with the sketch's name and state, the tool's hint and the tool's options. */
export function SketchHud({
  sketch,
  diag,
  tool,
  hint,
  sectionCount,
  onRepeat,
  onTraceAll,
}: {
  sketch: SketchFeature;
  diag: SolvedSketch["diagnostics"] | undefined;
  tool: SketchTool;
  hint: string;
  sectionCount: number;
  onRepeat: () => void;
  onTraceAll: () => void;
}) {
  return (
    <div className="sketch-hud">
      <div className="card2">
        <div className="row" style={{ gap: 10 }}>
          <b>{featureName(sketch)}</b>
          <DofBadge diag={diag} empty={!sketch.entities.length} />
          <PhoneConstrain />
          {/* Phone: finishing sits up here, where iOS puts "Done", not at the end of the scrolling bar. */}
          <button className="btn primary phone-only sketch-done" {...doneTap}>
            {t("Done")}
          </button>
        </div>
        {diag?.message ? (
          <div className="muted" style={{ marginTop: 4, color: "var(--err)" }}>
            {diag.message}
          </div>
        ) : null}
        <div className="muted" style={{ marginTop: 4, maxWidth: 280 }}>
          {hint}
        </div>
        {tool === "pattern" ? <PatternPanel onRepeat={onRepeat} /> : null}
        {tool === "section" ? <SectionPanel count={sectionCount} onTraceAll={onTraceAll} /> : null}
        {EDIT_TOOLS.has(tool) && tool !== "trim" ? <EditSizeField tool={tool} /> : null}
      </div>
    </div>
  );
}

/** Phone: the constraints sheet opens from the header, beside "Done" (the bottom bar has no room). */
function PhoneConstrain() {
  const open = usePhoneSheets((s) => s.constraints);

  return (
    <button
      className={`btn phone-only sketch-constrain ${open ? "active" : ""}`}
      aria-pressed={open}
      onClick={() => usePhoneSheets.setState({ constraints: !open })}
    >
      <Link2 />
      {t("Constrain")}
    </button>
  );
}

/** How far the sketch is defined: solving, over-constrained, fully defined or the degrees of freedom left. */
function DofBadge({ diag, empty }: { diag: SolvedSketch["diagnostics"] | undefined; empty: boolean }) {
  // A new sketch has nothing to define yet: "fully defined" there reads as a mistake.
  if (empty) {
    return (
      <span className="dof">
        <i />
        {t("sketch::Empty")}
      </span>
    );
  }

  return (
    <span className={`dof ${diag && !diag.ok ? "bad" : diag?.dof === 0 ? "full" : ""}`}>
      <i />
      {!diag
        ? t("Solving…")
        : !diag.ok
          ? t("Over-constrained")
          : diag.dof === 0
            ? t("Fully defined")
            : tn(diag.dof, "one::{n} DOF left", "{n} DOF left")}
    </span>
  );
}

/** The pattern tool's settings: a row or round the origin, count and step, and the button that repeats. */
function PatternPanel({ onRepeat }: { onRepeat: () => void }) {
  const ui = useSketchUi();

  return (
    <div className="col" style={{ gap: 6, marginTop: 6 }}>
      <div className="segmented">
        {(["linear", "circular"] as const).map((k) => (
          <button
            key={k}
            className={ui.pattern.kind === k ? "on" : ""}
            onClick={() => useSketchUi.setState({ pattern: { ...ui.pattern, kind: k } })}
          >
            {k === "linear" ? t("Row") : t("Round the origin")}
          </button>
        ))}
      </div>
      <div className="row" style={{ gap: 6 }}>
        {(
          [
            ["count", t("Count")],
            ...(ui.pattern.kind === "linear"
              ? [
                  ["dx", t("Step x")],
                  ["dy", t("Step y")],
                ]
              : [["angle", t("Angle")]]),
          ] as ["count" | "dx" | "dy" | "angle", string][]
        ).map(([k, label]) => (
          <label key={k} className="col" style={{ gap: 2 }}>
            <span className="muted small">{label}</span>
            <input
              className="field"
              type="number"
              style={{ width: 64 }}
              value={ui.pattern[k]}
              onChange={(event) => {
                const v = Number(event.target.value);

                if (Number.isFinite(v)) {
                  useSketchUi.setState({
                    pattern: { ...ui.pattern, [k]: k === "count" ? Math.max(2, Math.round(v)) : v },
                  });
                }
              }}
            />
          </label>
        ))}
      </div>
      <button
        className="btn primary"
        disabled={!ui.selection.some((x) => x.kind === "curve")}
        onClick={onRepeat}
      >
        {t("Repeat selection")}
      </button>
    </div>
  );
}

/** The section tool's tolerance and the button that traces every section. */
function SectionPanel({ count, onTraceAll }: { count: number; onTraceAll: () => void }) {
  const traceTol = useSketchUi((state) => state.traceTol);

  return (
    <div className="col" style={{ gap: 6, marginTop: 6 }}>
      <label className="row" style={{ gap: 6 }}>
        <span className="muted">{t("Tolerance")}</span>
        <input
          className="field"
          type="number"
          step="0.05"
          min="0.01"
          style={{ width: 80 }}
          value={traceTol}
          onChange={(event) => {
            const v = Number(event.target.value);
            if (Number.isFinite(v) && v > 0) useSketchUi.setState({ traceTol: v });
          }}
        />
        <span className="muted">mm</span>
      </label>
      <button className="btn primary" disabled={!count} onClick={onTraceAll}>
        {t("Trace all ({n})", { n: count })}
      </button>
    </div>
  );
}

/** The fillet radius, chamfer distance or offset. */
function EditSizeField({ tool }: { tool: SketchTool }) {
  const editSize = useSketchUi((state) => state.editSize);

  return (
    <label className="row" style={{ gap: 6, marginTop: 6 }}>
      <span className="muted">
        {tool === "fillet" ? t("Radius") : tool === "chamfer" ? t("Distance") : t("Offset")}
      </span>
      <SizeInput value={editSize} onChange={(size) => useSketchUi.setState({ editSize: size })} />
      <span className="muted">mm</span>
    </label>
  );
}

/**
 * The corner and offset tools' size. It keeps what is typed as text, so a field cleared to type
 * anew or a lone "-" on the way to a negative offset stay as they are; numbers go out as typed.
 */
function SizeInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText((cur) => (Number(cur) === value && cur.trim() ? cur : String(value)));
  }, [value]);

  return (
    <input
      className="field"
      type="text"
      inputMode="decimal"
      style={{ width: 80 }}
      value={text}
      onChange={(event) => {
        setText(event.target.value);

        const v = Number(event.target.value.replace(",", "."));
        if (event.target.value.trim() && Number.isFinite(v)) onChange(v);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}
