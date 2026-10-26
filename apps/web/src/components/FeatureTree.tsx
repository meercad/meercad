import { Box, Copy, Eye, EyeOff, FileDown, Layers, Pencil, Plus, SkipBack, SkipForward, Trash, X } from "lucide-react";
import { useState } from "react";
import { deleteBodies } from "../lib/deletion";
import { askConfirm, askText } from "./Ask";
import { referencedNames } from "@leocad/model";
import type { Feature } from "@leocad/schema";
import { FEATURES, featureName } from "../lib/features";
import { PLANE_LABELS } from "../lib/topology";
import { apply, editFeature, openSketch, startSketch, toast, useApp } from "../store";
import { ExprInput, parseExpr } from "./ExprInput";
import { exportSketch } from "./io";
import { showMenu } from "./Menu";

const NONE: never[] = [];
const EMPTY: Record<string, never> = {};

export function SidePanel() {
  return (
    <aside className="side">
      <div className="side-scroll">
        <FeatureList />
        <Bodies />
        <Params />
      </div>
    </aside>
  );
}

function FeatureList() {
  const doc = useApp((s) => s.doc);
  const statuses = useApp((s) => s.output?.report.features);
  const previewing = useApp((s) => s.previewing);
  const dialog = useApp((s) => s.dialog);
  const sketchId = useApp((s) => s.sketchId);
  const selected = useApp((s) => s.selectedFeature);
  const hidden = useApp((s) => s.hidden);
  const [drag, setDrag] = useState<{ kind: "feature" | "rollback"; id: string } | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const status = new Map((previewing ? [] : statuses ?? []).map((f) => [f.id, f]));
  const rollbackIndex = doc.rollback ? doc.features.findIndex((f) => f.id === doc.rollback) : doc.features.length - 1;

  const onDrop = (index: number) => {
    if (!drag) return;
    if (drag.kind === "rollback") apply({ type: "set_rollback", id: index === 0 ? null : index >= doc.features.length ? null : doc.features[index - 1]!.id });
    else {
      const from = doc.features.findIndex((f) => f.id === drag.id);
      if (from !== index && from + 1 !== index) apply({ type: "move_feature", id: drag.id, after: index === 0 ? null : doc.features[index - 1]!.id });
    }
    setDrag(null);
    setDropAt(null);
  };
  if (doc.rollback === null && dropAt === null) void 0;

  const menu = (f: Feature, x: number, y: number) =>
    showMenu(x, y, [
      { label: "Edit", icon: <Pencil />, kbd: "↵", onClick: () => editFeature(f.id) },
      {
        label: "Rename",
        icon: <Pencil />,
        onClick: async () => {
          const name = await askText({ title: "Rename feature", label: "Name", value: featureName(f) });
          if (name !== null) apply({ type: "edit_feature", id: f.id, patch: { name: name.trim() || null } });
        },
      },
      { label: f.suppressed ? "Unsuppress" : "Suppress", icon: f.suppressed ? <Eye /> : <EyeOff />, onClick: () => apply({ type: "edit_feature", id: f.id, patch: { suppressed: f.suppressed ? null : true } }) },
      { label: "Roll back to here", icon: <SkipBack />, onClick: () => apply({ type: "set_rollback", id: f.id }) },
      ...(f.op === "sketch"
        ? [
            { label: hidden.has(f.id) ? "Show sketch" : "Hide sketch", icon: hidden.has(f.id) ? <Eye /> : <EyeOff />, onClick: () => toggleHidden(f.id) },
            { label: "Export DXF", icon: <FileDown />, onClick: () => exportSketch(f.id, "dxf") },
            { label: "Export SVG", icon: <FileDown />, onClick: () => exportSketch(f.id, "svg") },
          ]
        : []),
      "sep",
      { label: "Delete", icon: <Trash />, danger: true, kbd: "⌫", onClick: () => void deleteFeature(f) },
    ]);

  return (
    <>
      <div className="section-head">
        Features
        {doc.rollback ? (
          <button className="icon-btn sm" title="Roll forward to the end" onClick={() => apply({ type: "set_rollback", id: null })}>
            <SkipForward />
          </button>
        ) : null}
      </div>
      <ul className="tree">
        <li className="tree-item dim" title="Origin planes">
          <Layers className="ficon" />
          <span className="tree-label">Origin</span>
          <span className="actions">
            {Object.entries(PLANE_LABELS).map(([ref, label]) => (
              <button key={ref} className="icon-btn sm" title={`New sketch on ${label}`} onClick={() => startSketch({ ref })} style={{ fontSize: 10.5, width: "auto" }}>
                {label}
              </button>
            ))}
          </span>
        </li>
        {doc.features.map((f, i) => {
          const st = status.get(f.id);
          const Icon = FEATURES[f.op].icon;
          const rolledBack = i > rollbackIndex;
          const cls = [
            "tree-item",
            selected === f.id ? "selected" : "",
            dialog?.feature.id === f.id || sketchId === f.id ? "editing" : "",
            f.suppressed || rolledBack ? "dim" : "",
            st?.status === "error" ? "err" : st?.status === "warning" ? "warn" : "",
            dropAt === i ? "drop-before" : "",
          ].join(" ");
          return (
            <li key={f.id} onDragOver={(e) => (e.preventDefault(), setDropAt(i))} onDrop={() => onDrop(i)}>
              <div
                className={cls}
                draggable
                onDragStart={() => setDrag({ kind: "feature", id: f.id })}
                onDragEnd={() => (setDrag(null), setDropAt(null))}
                onClick={() => useApp.setState({ selectedFeature: f.id })}
                onDoubleClick={() => editFeature(f.id)}
                onContextMenu={(e) => (e.preventDefault(), menu(f, e.clientX, e.clientY))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") editFeature(f.id);
                  if (e.key === "Delete" || e.key === "Backspace") void deleteFeature(f);
                }}
                tabIndex={0}
                title={st?.message ?? `${FEATURES[f.op].label}${st && !st.cached ? ` · ${st.ms.toFixed(1)} ms` : ""}`}
              >
                <Icon className="ficon" />
                <span className="tree-label">{featureName(f)}</span>
                <span className="actions">
                  {f.op === "sketch" ? (
                    <button className="icon-btn sm" title={hidden.has(f.id) ? "Show" : "Hide"} onClick={(e) => (e.stopPropagation(), toggleHidden(f.id))}>
                      {hidden.has(f.id) ? <EyeOff /> : <Eye />}
                    </button>
                  ) : null}
                  <button className="icon-btn sm" title="Edit" onClick={(e) => (e.stopPropagation(), f.op === "sketch" ? openSketch(f.id) : editFeature(f.id))}>
                    <Pencil />
                  </button>
                </span>
              </div>
              {st?.message && (st.status === "error" || st.status === "warning") ? (
                <div className={`tree-msg ${st.status === "warning" ? "warn" : ""}`}>
                  {st.message}
                  {st.hint ? <span className="hint">→ {st.hint}</span> : null}
                </div>
              ) : null}
              {i === rollbackIndex ? (
                <div
                  className="rollback-bar"
                  draggable
                  title="Drag to roll back the model"
                  onDragStart={() => setDrag({ kind: "rollback", id: "" })}
                  onDragEnd={() => (setDrag(null), setDropAt(null))}
                >
                  {doc.rollback ? <span>Rolled back</span> : null}
                </div>
              ) : null}
            </li>
          );
        })}
        <li onDragOver={(e) => (e.preventDefault(), setDropAt(doc.features.length))} onDrop={() => onDrop(doc.features.length)} style={{ height: 24 }} className={dropAt === doc.features.length ? "tree-item drop-before" : ""} />
      </ul>
      {!doc.features.length ? <div className="empty">Start with a sketch: pick a plane under Origin, or press S.</div> : null}
    </>
  );
}

export function toggleHidden(id: string): void {
  useApp.setState((s) => {
    const hidden = new Set(s.hidden);
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
    return { hidden };
  });
}

export async function deleteFeature(f: Feature): Promise<void> {
  const doc = useApp.getState().doc;
  const dependents = doc.features.filter((g) => g !== f && JSON.stringify(g).includes(`"${f.id}`) && doc.features.indexOf(g) > doc.features.indexOf(f));
  if (dependents.length && !(await askConfirm({ title: `Delete ${featureName(f)}?`, message: `It is used by ${dependents.map(featureName).join(", ")}. Those will be deleted too.`, confirmLabel: `Delete ${dependents.length + 1} features`, danger: true }))) return;
  const ops = [...dependents].reverse().map((g) => ({ type: "delete_feature" as const, id: g.id }));
  if (apply(...ops, { type: "delete_feature", id: f.id })) toast(`Deleted ${featureName(f)}`);
}

function Bodies() {
  const bodies = useApp((s) => s.output?.report.bodies) ?? NONE;
  const hidden = useApp((s) => s.hidden);
  if (!bodies.length) return null;
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} cm³` : `${n.toFixed(0)} mm³`);
  return (
    <>
      <div className="section-head">Parts ({bodies.length})</div>
      <ul className="tree">
        {bodies.map((b) => (
          <li key={b.id} className={`tree-item ${hidden.has(b.id) ? "dim" : ""}`} title={`${b.faces} faces · ${b.bbox.max.map((v, i) => (v - b.bbox.min[i]!).toFixed(1)).join(" × ")} mm`}>
            <Box className="ficon" />
            <span className="tree-label">
              {b.id} <span className="muted">· {fmt(b.volume)}</span>
            </span>
            <span className="actions" style={{ display: "flex" }}>
              <button className="icon-btn sm" title={hidden.has(b.id) ? "Show" : "Hide"} onClick={() => toggleHidden(b.id)}>
                {hidden.has(b.id) ? <EyeOff /> : <Eye />}
              </button>
              <button className="icon-btn sm" title="Delete part" onClick={() => deleteBodies([b.id])}>
                <Trash />
              </button>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Params() {
  const params = useApp((s) => s.doc.params);
  const doc = useApp((s) => s.doc);
  const values = useApp((s) => s.output?.report.params) ?? EMPTY;
  const errors = useApp((s) => s.output?.report.paramErrors) ?? EMPTY;
  const [adding, setAdding] = useState<{ name: string; expr: string } | null>(null);
  const used = (name: string) => JSON.stringify(doc.features).match(new RegExp(`\\b${name}\\b`)) || Object.values(params).some((e) => referencedNames(e).includes(name));

  return (
    <>
      <div className="section-head">
        Variables
        <button className="icon-btn sm" title="Add variable" onClick={() => setAdding({ name: suggestName(params), expr: "10 mm" })}>
          <Plus />
        </button>
      </div>
      <div className="params">
        {Object.entries(params).map(([name, expr]) => (
          <div className="param-row" key={name}>
            <input
              className="field name-input"
              defaultValue={name}
              key={`${name}-n`}
              onBlur={(e) => {
                const to = e.target.value.trim();
                if (to && to !== name && !apply({ type: "rename_param", name, to })) e.target.value = name;
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
            <ExprInput value={expr} unit="" onCommit={(v) => apply({ type: "set_param", name, expr: v })} />
            <span className="val" title={errors[name] ?? ""} style={errors[name] ? { color: "var(--err)" } : undefined}>
              {errors[name] ? "error" : values[name] !== undefined ? +values[name]!.toFixed(3) : ""}
            </span>
            <button
              className="icon-btn sm"
              title={used(name) ? "Still in use" : "Delete"}
              onClick={async () => {
                if (used(name) && !(await askConfirm({ title: `Delete variable "${name}"?`, message: "It is still used by features or other variables; those will show an error until you fix them.", confirmLabel: "Delete", danger: true }))) return;
                apply({ type: "set_param", name, expr: null });
              }}
            >
              <X />
            </button>
          </div>
        ))}
        {adding ? (
          <div className="param-row">
            <input className="field name-input" autoFocus value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
            <input
              className="field expr"
              value={adding.expr}
              onChange={(e) => setAdding({ ...adding, expr: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && apply({ type: "set_param", name: adding.name.trim(), expr: parseExpr(adding.expr) })) setAdding(null);
                if (e.key === "Escape") setAdding(null);
              }}
            />
            <button className="icon-btn sm" title="Add" onClick={() => apply({ type: "set_param", name: adding.name.trim(), expr: parseExpr(adding.expr) }) && setAdding(null)}>
              <Plus />
            </button>
            <button className="icon-btn sm" onClick={() => setAdding(null)}>
              <X />
            </button>
          </div>
        ) : null}
        {!Object.keys(params).length && !adding ? <div className="empty" style={{ padding: "2px 4px" }}>Named values like <span className="mono">wall = 2 mm</span> can drive any dimension.</div> : null}
      </div>
    </>
  );
}

function suggestName(params: Record<string, unknown>): string {
  for (const n of ["width", "height", "depth", "wall", "radius", "hole"]) if (!(n in params)) return n;
  let i = 1;
  while (`v${i}` in params) i++;
  return `v${i}`;
}

export const ICONS = { Copy };
