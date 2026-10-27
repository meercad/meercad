import { Bot, Box, ChevronRight, Copy, Eye, EyeOff, FileDown, Folder, FolderPlus, Layers, Link2, Pencil, Plus, Search, SkipBack, SkipForward, Trash, UserCheck, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { deleteBodies } from "../lib/deletion";
import { askConfirm, askText } from "./Ask";
import { evaluate, referencedNames } from "@meercad/model";
import type { Feature } from "@meercad/schema";
import { FEATURES, featureName } from "../lib/features";
import { PLANE_LABELS } from "../lib/topology";
import { apply, editFeature, openSketch, startSketch, toast, useApp } from "../store";
import { ExprInput, parseExpr } from "./ExprInput";
import { freeParamName, withUnit, type ValueUnit } from "./ValueInput";
import { variableGroup } from "../lib/variables";
import { exportSketch } from "./io";
import { showMenu } from "./Menu";

const NONE: never[] = [];
const EMPTY: Record<string, never> = {};
const SECTIONS_KEY = "meercad.sections";

/** Open/closed state of a sidebar section, remembered across sessions. */
function useSection(id: string, defaultOpen = true): [boolean, () => void] {
  const read = () => {
    try {
      const v = (JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "{}") as Record<string, unknown>)[id];
      return typeof v === "boolean" ? v : defaultOpen;
    } catch {
      return defaultOpen;
    }
  };
  const [open, setOpen] = useState(read);
  const toggle = () =>
    setOpen((o) => {
      try {
        const all = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "{}") as Record<string, boolean>;
        all[id] = !o;
        localStorage.setItem(SECTIONS_KEY, JSON.stringify(all));
      } catch {
        // just not remembered
      }
      return !o;
    });
  return [open, toggle];
}

function SectionHead({ open, onToggle, children, actions, sub }: { open: boolean; onToggle: () => void; children: ReactNode; actions?: ReactNode; sub?: boolean }) {
  return (
    <div className={`section-head ${sub ? "sub" : ""}`}>
      <button className="section-toggle" onClick={onToggle} aria-expanded={open}>
        <ChevronRight className={open ? "open" : ""} />
        {children}
      </button>
      {actions ? <span className="section-actions">{actions}</span> : null}
    </div>
  );
}

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
  const [open, toggle] = useSection("features");
  const picked = useApp((s) => s.featureSelection);
  // Only a selection that still includes the active feature counts (it may have been changed elsewhere).
  const multi = picked.length > 1 && selected !== null && picked.includes(selected) ? picked : [];
  const select = (f: Feature, i: number, e: React.MouseEvent) => {
    const ids = doc.features.map((x) => x.id);
    let next = [f.id];
    if (e.metaKey || e.ctrlKey) {
      const base = multi.length ? multi : selected ? [selected] : [];
      next = base.includes(f.id) ? base.filter((x) => x !== f.id) : [...base, f.id];
    } else if (e.shiftKey && selected) {
      const a = ids.indexOf(selected);
      next = ids.slice(Math.min(a, i), Math.max(a, i) + 1);
    }
    useApp.setState({ selectedFeature: next.includes(f.id) ? f.id : (next.at(-1) ?? null), featureSelection: next });
  };
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
      <SectionHead
        open={open}
        onToggle={toggle}
        actions={
          doc.rollback ? (
            <button className="icon-btn sm" title="Roll forward to the end" onClick={() => apply({ type: "set_rollback", id: null })}>
              <SkipForward />
            </button>
          ) : null
        }
      >
        Features <span className="count">{doc.features.length}</span>
      </SectionHead>
      {open ? (
      <>
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
            selected === f.id || multi.includes(f.id) ? "selected" : "",
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
                onClick={(e) => select(f, i, e)}
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
      {multi.length > 1 ? <LinkBar ids={multi} /> : null}
      {!doc.features.length ? <div className="empty">Start with a sketch: pick a plane under Origin, or press S.</div> : null}
      </>
      ) : null}
    </>
  );
}

/** Numeric fields that several features of one kind can share through a variable. */
const LINKABLE: Partial<Record<Feature["op"], { field: string; label: string; unit: ValueUnit }[]>> = {
  extrude: [{ field: "distance", label: "distance", unit: "mm" }, { field: "distance2", label: "second distance", unit: "mm" }],
  revolve: [{ field: "angle", label: "angle", unit: "deg" }],
  fillet: [{ field: "radius", label: "radius", unit: "mm" }],
  chamfer: [{ field: "distance", label: "distance", unit: "mm" }],
  shell: [{ field: "thickness", label: "thickness", unit: "mm" }],
  plane: [{ field: "offset", label: "offset", unit: "mm" }],
  linear_pattern: [{ field: "count", label: "count", unit: "" }, { field: "spacing", label: "spacing", unit: "mm" }],
  circular_pattern: [{ field: "count", label: "count", unit: "" }, { field: "angle", label: "angle", unit: "deg" }],
  thread: [{ field: "pitch", label: "pitch", unit: "mm" }, { field: "length", label: "length", unit: "mm" }, { field: "clearance", label: "clearance", unit: "mm" }],
};

/** Offers to drive equal values of the picked features (same kind) from one new variable. */
function LinkBar({ ids }: { ids: string[] }) {
  const doc = useApp((s) => s.doc);
  const values = useApp((s) => s.output?.report.params) ?? EMPTY;
  const feats = ids.map((id) => doc.features.find((f) => f.id === id)).filter((f): f is Feature => !!f);
  const op = feats[0]?.op;
  if (!op || feats.some((f) => f.op !== op)) return <div className="link-bar muted">{feats.length} features picked · pick features of one kind to link their values</div>;
  const kind = `${FEATURES[op].label.toLowerCase()}s`;
  const scope = new Map(Object.entries(values));
  const rows = (LINKABLE[op] ?? []).flatMap(({ field, label, unit }) => {
    const exprs = feats.map((f) => (f as unknown as Record<string, unknown>)[field] as string | number | undefined);
    if (exprs.some((e) => e === undefined)) return [];
    let nums: number[];
    try {
      nums = exprs.map((e) => evaluate(e!, scope));
    } catch {
      return [];
    }
    const same = nums.every((n) => Math.abs(n - nums[0]!) < 1e-9);
    const linked = exprs.every((e) => e === exprs[0]) && typeof exprs[0] === "string" && exprs[0] in doc.params;
    return [{ field, label, unit, same, linked, expr: exprs[0]!, value: nums[0]! }];
  });
  const link = async (r: (typeof rows)[number]) => {
    const name = await askText({ title: `Link the ${r.label} of ${feats.length} ${kind}`, label: "Variable name", value: freeParamName(`${op}_${r.field}`), confirmLabel: "Create and link" });
    if (!name?.trim()) return;
    const n = name.trim();
    if (!/^[A-Za-z_]\w*$/.test(n) || n in doc.params) return toast(n in doc.params ? `"${n}" already exists` : "Use letters, digits and _ (not starting with a digit)", "error");
    // Keep a shared expression as written; plain numbers get their unit.
    const expr = typeof r.expr === "string" && exprs(feats, r.field).every((e) => e === r.expr) ? r.expr : withUnit(r.value, r.unit);
    if (apply({ type: "set_param", name: n, expr, auto: true }, ...feats.map((f) => ({ type: "edit_feature" as const, id: f.id, patch: { [r.field]: n } }))))
      toast(`${feats.length} ${kind} now share "${n}" — change it under Variables › Automatic`);
  };
  return (
    <div className="link-bar">
      <div className="link-bar-title">
        <Link2 /> {feats.length} {kind} picked
      </div>
      {rows.length ? (
        rows.map((r) =>
          r.linked ? (
            <div key={r.field} className="link-row muted">
              {r.label}: linked to <span className="mono">{String(r.expr)}</span>
            </div>
          ) : r.same ? (
            <button key={r.field} className="link-row" onClick={() => void link(r)}>
              Link {r.label} ({+r.value.toFixed(3)}
              {r.unit === "deg" ? "°" : r.unit === "mm" ? " mm" : ""}) with a variable…
            </button>
          ) : (
            <div key={r.field} className="link-row muted">
              {r.label}: values differ
            </div>
          ),
        )
      ) : (
        <div className="link-row muted">Nothing to link for {kind}</div>
      )}
    </div>
  );
}

const exprs = (feats: Feature[], field: string) => feats.map((f) => (f as unknown as Record<string, unknown>)[field]);

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

/** Parts list: drag to reorder, drop onto a folder to group; order and folders are saved in the file. */
function Bodies() {
  const bodies = useApp((s) => s.output?.report.bodies) ?? NONE;
  const doc = useApp((s) => s.doc);
  const hidden = useApp((s) => s.hidden);
  const [open, toggle] = useSection("parts");
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
  if (!bodies.length) return null;
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} cm³` : `${n.toFixed(0)} mm³`);
  const ids = bodies.map((b) => b.id);
  const order = [...(doc.partOrder ?? []).filter((id) => ids.includes(id)), ...ids.filter((id) => !(doc.partOrder ?? []).includes(id))];
  const groups = (doc.partGroups ?? []).map((g) => ({ ...g, parts: order.filter((id) => g.parts.includes(id)) }));
  const grouped = new Set(groups.flatMap((g) => g.parts));
  const save = (partOrder: string[], partGroups: { name: string; parts: string[] }[]) => {
    const next = { ...doc, partOrder, partGroups } as typeof doc;
    if (!partGroups.length) delete next.partGroups;
    apply({ type: "replace", doc: next });
  };
  // Move `id` before `before` (a part) or into a folder (`group:<name>`), or to the end when null.
  const move = (id: string, target: string | null) => {
    if (target === id) return;
    const without = order.filter((x) => x !== id);
    let gs = (doc.partGroups ?? []).map((g) => ({ ...g, parts: g.parts.filter((x) => x !== id) }));
    let nextOrder = [...without, id];
    if (target?.startsWith("group:")) {
      const name = target.slice(6);
      gs = gs.map((g) => (g.name === name ? { ...g, parts: [...g.parts, id] } : g));
    } else if (target) {
      nextOrder = [...without.slice(0, without.indexOf(target)), id, ...without.slice(without.indexOf(target))];
      const g = gs.find((x) => x.parts.includes(target));
      if (g) g.parts.push(id);
    }
    save(nextOrder, gs);
  };
  const newGroup = async (with_?: string) => {
    const taken = new Set(groups.map((g) => g.name));
    let n = 1;
    while (taken.has(`Group ${n}`)) n++;
    const name = await askText({ title: "New group", label: "Name", value: `Group ${n}`, confirmLabel: "Create" });
    if (!name?.trim() || taken.has(name.trim())) return;
    const gs = (doc.partGroups ?? []).map((g) => ({ ...g, parts: g.parts.filter((x) => x !== with_) }));
    save(order, [...gs, { name: name.trim(), parts: with_ ? [with_] : [] }]);
  };
  const renameGroup = async (name: string) => {
    const to = await askText({ title: "Rename group", label: "Name", value: name });
    if (!to?.trim() || to.trim() === name || groups.some((g) => g.name === to.trim())) return;
    save(order, (doc.partGroups ?? []).map((g) => (g.name === name ? { ...g, name: to.trim() } : g)));
  };
  const setHidden = (list: string[], hide: boolean) =>
    useApp.setState((st) => {
      const h = new Set(st.hidden);
      for (const id of list) if (hide) h.add(id);
      else h.delete(id);
      return { hidden: h };
    });
  const dropProps = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      setOver(target ?? "end");
    },
    onDragLeave: () => setOver(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (drag) move(drag, target);
      setDrag(null);
      setOver(null);
    },
  });
  const part = (id: string, nested: boolean) => {
    const b = bodies.find((x) => x.id === id)!;
    return (
      <li
        key={id}
        className={`tree-item ${hidden.has(id) ? "dim" : ""} ${nested ? "nested" : ""} ${over === id ? "drop-before" : ""}`}
        title={`${b.faces} faces · ${b.bbox.max.map((v, i) => (v - b.bbox.min[i]!).toFixed(1)).join(" × ")} mm — drag to reorder or onto a group`}
        draggable
        onDragStart={() => setDrag(id)}
        onDragEnd={() => (setDrag(null), setOver(null))}
        onContextMenu={(e) => {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, [
            { label: "New group with this part", icon: <FolderPlus />, onClick: () => void newGroup(id) },
            ...groups.filter((g) => !g.parts.includes(id)).map((g) => ({ label: `Move to ${g.name}`, icon: <Folder />, onClick: () => move(id, `group:${g.name}`) })),
            ...(grouped.has(id) ? [{ label: "Take out of group", icon: <X />, onClick: () => save(order, (doc.partGroups ?? []).map((g) => ({ ...g, parts: g.parts.filter((x) => x !== id) }))) }] : []),
            "sep" as const,
            { label: hidden.has(id) ? "Show" : "Hide", icon: hidden.has(id) ? <Eye /> : <EyeOff />, onClick: () => toggleHidden(id) },
            { label: "Delete part", icon: <Trash />, danger: true, onClick: () => deleteBodies([id]) },
          ]);
        }}
        {...dropProps(id)}
      >
        <Box className="ficon" />
        <span className="tree-label">
          {id} <span className="muted">· {fmt(b.volume)}</span>
        </span>
        <span className="actions" style={{ display: "flex" }}>
          <button className="icon-btn sm" title={hidden.has(id) ? "Show" : "Hide"} onClick={() => toggleHidden(id)}>
            {hidden.has(id) ? <EyeOff /> : <Eye />}
          </button>
          <button className="icon-btn sm" title="Delete part" onClick={() => deleteBodies([id])}>
            <Trash />
          </button>
        </span>
      </li>
    );
  };
  return (
    <>
      <SectionHead
        open={open}
        onToggle={toggle}
        actions={
          <button className="icon-btn sm" title="New group" onClick={() => void newGroup()}>
            <FolderPlus />
          </button>
        }
      >
        Parts <span className="count">{bodies.length}</span>
      </SectionHead>
      {open ? (
        <ul className="tree" {...dropProps(null)}>
          {groups.map((g) => {
            const closed = closedGroups.has(g.name);
            const allHidden = g.parts.length > 0 && g.parts.every((id) => hidden.has(id));
            return (
              <li key={`group:${g.name}`}>
                <div
                  className={`tree-item group-row ${over === `group:${g.name}` ? "drop-into" : ""}`}
                  onClick={() => setClosedGroups((c) => (c.has(g.name) ? new Set([...c].filter((x) => x !== g.name)) : new Set([...c, g.name])))}
                  onDoubleClick={() => void renameGroup(g.name)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    showMenu(e.clientX, e.clientY, [
                      { label: "Rename", icon: <Pencil />, onClick: () => void renameGroup(g.name) },
                      { label: allHidden ? "Show all" : "Hide all", icon: allHidden ? <Eye /> : <EyeOff />, onClick: () => setHidden(g.parts, !allHidden) },
                      "sep",
                      { label: "Ungroup", icon: <X />, onClick: () => save(order, (doc.partGroups ?? []).filter((x) => x.name !== g.name)) },
                    ]);
                  }}
                  {...dropProps(`group:${g.name}`)}
                  title="Click to fold · double-click to rename · drop parts here"
                >
                  <ChevronRight className={`ficon chev ${closed ? "" : "open"}`} />
                  <Folder className="ficon" />
                  <span className="tree-label">
                    {g.name} <span className="muted">· {g.parts.length}</span>
                  </span>
                  <span className="actions" style={{ display: "flex" }}>
                    <button className="icon-btn sm" title={allHidden ? "Show all" : "Hide all"} onClick={(e) => (e.stopPropagation(), setHidden(g.parts, !allHidden))}>
                      {allHidden ? <EyeOff /> : <Eye />}
                    </button>
                  </span>
                </div>
                {!closed ? <ul className="tree">{g.parts.length ? g.parts.map((id) => part(id, true)) : <li className="tree-item nested dim">Drop parts here</li>}</ul> : null}
              </li>
            );
          })}
          {order.filter((id) => !grouped.has(id)).map((id) => part(id, false))}
          <li className={`drop-end ${over === "end" ? "drop-before" : ""}`} />
        </ul>
      ) : null}
    </>
  );
}

function Params() {
  const params = useApp((s) => s.doc.params);
  const auto = useApp((s) => s.doc.autoParams) ?? NONE;
  const doc = useApp((s) => s.doc);
  const values = useApp((s) => s.output?.report.params) ?? EMPTY;
  const errors = useApp((s) => s.output?.report.paramErrors) ?? EMPTY;
  const [adding, setAdding] = useState<{ name: string; expr: string } | null>(null);
  const [open, toggle] = useSection("variables");
  const [ownOpen, toggleOwn] = useSection("variables.own");
  const [autoOpen, toggleAuto] = useSection("variables.auto", false);
  const [calcOpen, toggleCalc] = useSection("variables.calc", false);
  const [query, setQuery] = useState("");
  const used = (name: string) => JSON.stringify(doc.features).match(new RegExp(`\\b${name}\\b`)) || Object.values(params).some((e) => referencedNames(e).includes(name));
  const q = query.trim().toLowerCase();
  const matches = (n: string) => !q || n.toLowerCase().includes(q) || String(params[n]).toLowerCase().includes(q);
  const groupOf = (n: string) => variableGroup(n, params, auto);
  const own = Object.keys(params).filter((n) => groupOf(n) === "own" && matches(n));
  const calculated = Object.keys(params).filter((n) => groupOf(n) === "calculated");
  const automatic = Object.keys(params).filter((n) => groupOf(n) === "auto");
  const total = Object.keys(params).length;

  const row = (name: string, isAuto: boolean) => (
    <div
      className={`param-row ${isAuto ? "auto" : ""}`}
      key={name}
      onContextMenu={(e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          isAuto
            ? { label: "Move to my variables", icon: <UserCheck />, onClick: () => apply({ type: "set_param", name, expr: params[name]!, auto: false }) }
            : { label: "Move to automatic", icon: <Bot />, onClick: () => apply({ type: "set_param", name, expr: params[name]!, auto: true }) },
        ]);
      }}
    >
      <input
        className="field name-input"
        defaultValue={name}
        key={`${name}-n`}
        onBlur={(e) => {
          const to = e.target.value.trim();
          // Renaming a variable makes it yours.
          if (to && to !== name && !apply({ type: "rename_param", name, to }, ...(isAuto ? [{ type: "set_param" as const, name: to, expr: params[name]!, auto: false }] : []))) e.target.value = name;
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      <ExprInput value={params[name]} unit="" onCommit={(v) => apply({ type: "set_param", name, expr: v })} />
      <span className="val" title={errors[name] ?? ""} style={errors[name] ? { color: "var(--err)" } : undefined}>
        {errors[name] ? "error" : values[name] !== undefined ? +values[name]!.toFixed(3) : ""}
      </span>
      {isAuto ? (
        <button className="icon-btn sm" title="Move to my variables" onClick={() => apply({ type: "set_param", name, expr: params[name]!, auto: false })}>
          <UserCheck />
        </button>
      ) : null}
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
  );

  return (
    <>
      <SectionHead
        open={open}
        onToggle={toggle}
        actions={
          <button className="icon-btn sm" title="Add variable" onClick={() => (open || toggle(), setAdding({ name: suggestName(params), expr: "10 mm" }))}>
            <Plus />
          </button>
        }
      >
        Variables <span className="count">{total}</span>
      </SectionHead>
      {open ? (
        <div className="params">
          {total > 4 ? (
            <div className="param-search">
              <Search />
              <input className="field" placeholder="Search variables" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} aria-label="Search variables" />
              {query ? (
                <button className="icon-btn sm" title="Clear" onClick={() => setQuery("")}>
                  <X />
                </button>
              ) : null}
            </div>
          ) : null}
          <SectionHead open={ownOpen || !!q} onToggle={toggleOwn} sub>
            Your variables <span className="count">{own.length}</span>
          </SectionHead>
          {ownOpen || q ? own.map((n) => row(n, false)) : null}
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
          {!own.length && !adding && (ownOpen || q) ? <div className="empty" style={{ padding: "2px 4px" }}>{q ? "No match" : <>Named values like <span className="mono">wall = 2 mm</span> can drive any dimension.</>}</div> : null}
          {calculated.length ? (
            <>
              <SectionHead open={calcOpen || !!q} onToggle={toggleCalc} sub>
                <span title="Formulas of other variables; they follow automatically">Calculated</span> <span className="count">{calculated.filter(matches).length}</span>
              </SectionHead>
              {calcOpen || q ? calculated.filter(matches).map((n) => row(n, auto.includes(n))) : null}
              {(calcOpen || q) && !calculated.some(matches) ? <div className="empty" style={{ padding: "2px 4px" }}>No match</div> : null}
            </>
          ) : null}
          {automatic.length ? (
            <>
              <SectionHead open={autoOpen || !!q} onToggle={toggleAuto} sub>
                <span title="Created by meerCAD (linking, new variable from a value) or by an assistant">Automatic</span> <span className="count">{automatic.filter(matches).length}</span>
              </SectionHead>
              {autoOpen || q ? automatic.filter(matches).map((n) => row(n, true)) : null}
              {(autoOpen || q) && !automatic.some(matches) ? <div className="empty" style={{ padding: "2px 4px" }}>No match</div> : null}
            </>
          ) : null}
        </div>
      ) : null}
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
