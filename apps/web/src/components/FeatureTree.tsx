import {
  Image as PictureIcon,
  ImageOff,
  ArrowDownToLine,
  LayoutGrid,
  ClipboardPaste,
  CopyPlus,
  Bot,
  Highlighter,
  ChevronRight,
  Eraser,
  Ghost,
  Palette,
  RotateCcw,
  Shapes,
  Wand2,
  Copy,
  Eye,
  EyeOff,
  FileDown,
  Folder,
  FolderPlus,
  Layers,
  Link2,
  Map as MapIcon,
  MapPin,
  Ruler,
  StickyNote,
  Pencil,
  Plus,
  Search,
  SkipBack,
  SkipForward,
  Trash,
  ShieldCheck,
  TriangleAlert,
  UserCheck,
  Weight,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { deleteBodies } from "../lib/deletion";
import { askConfirm, askText } from "./Ask";
import { checkInterference } from "../lib/interference";
import {
  evaluate,
  formatInertia,
  formatMass,
  massOf,
  massProperties,
  partMaterial,
  referencedNames,
} from "@meercad/model";
import { materialName } from "../lib/materials";
import { openMaterialPicker } from "./MaterialPicker";
import { type Expr, type Feature, type ReferenceModel } from "@meercad/schema";
import { FEATURES, featureName, partName } from "../lib/features";
import { PLANE_LABELS } from "../lib/topology";
import { apply, editFeature, openSketch, startSketch, toast, toggleSide, useApp } from "../store";
import { textureToggle } from "../lib/meshTexture";
import { ExprInput, parseExpr } from "./ExprInput";
import { FitRow } from "./FitRow";
import { freeParamName, withUnit, type ValueUnit } from "./ValueInput";
import { variableGroup } from "../lib/variables";
import { exportSketch, seeThroughDoc } from "./io";
import { showMenu } from "./Menu";
import { docUnit, fmtLen, fmtVolume, inUnit, isLengthParam } from "../lib/units";
import { meshBodyIds, meshHint } from "../lib/meshParts";
import { usePrefs } from "../lib/keymap";
import { partSize, tooBig } from "../lib/printBed";
import { PART_PALETTE, partColors } from "../lib/partColors";
import { terrainItems } from "../lib/terrain";
import { copyParts, hasClip, pasteParts, selectedParts, selectParts } from "../lib/clipboard";
import { cleanUpMenu } from "./TerrainTools";
import { startMarking, startScaling } from "../lib/terrainDraw";
import { convertMeshPart, rebuildMeshPart } from "../lib/meshConvert";
import { binForPart } from "../lib/partBin";
import { openMeshRepair } from "../lib/meshRepair";
import { lang, t, tn } from "../lib/i18n";

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

function SectionHead({
  open,
  onToggle,
  children,
  actions,
  sub,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  actions?: ReactNode;
  sub?: boolean;
}) {
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
      {/* Phone: a tap on the grip or a swipe down closes the sheet. */}
      <button
        className="sheet-grip"
        onClick={() => toggleSide(false)}
        onPointerDown={(event) => {
          const y0 = event.clientY;
          const el = event.currentTarget;
          el.setPointerCapture?.(event.pointerId);

          const move = (event: PointerEvent) => {
            if (event.clientY - y0 > 40) done(true);
          };

          const done = (close = false) => {
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
            el.removeEventListener("pointercancel", up);
            if (close) toggleSide(false);
          };

          const up = () => done();
          el.addEventListener("pointermove", move);
          el.addEventListener("pointerup", up);
          el.addEventListener("pointercancel", up);
        }}
        aria-label={t("Close")}
        title={t("Close")}
      >
        <i />
      </button>
      <div className="side-scroll">
        <FeatureList />
        <Bodies />
        <References />
        <Params />
      </div>
    </aside>
  );
}

function FeatureList() {
  const doc = useApp((state) => state.doc);
  const statuses = useApp((state) => state.output?.report.features);
  const previewing = useApp((state) => state.previewing);
  const dialog = useApp((state) => state.dialog);
  const sketchId = useApp((state) => state.sketchId);
  const selected = useApp((state) => state.selectedFeature);
  const hidden = useApp((state) => state.hidden);
  const [drag, setDrag] = useState<{ kind: "feature" | "rollback"; id: string } | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [open, toggle] = useSection("features");
  const picked = useApp((state) => state.featureSelection);
  // Only a selection that still includes the active feature counts (it may have been changed elsewhere).
  const multi = picked.length > 1 && selected !== null && picked.includes(selected) ? picked : [];

  const select = (feature: Feature, i: number, event: React.MouseEvent) => {
    const ids = doc.features.map((x) => x.id);
    let next = [feature.id];

    if (event.metaKey || event.ctrlKey) {
      const base = multi.length ? multi : selected ? [selected] : [];
      next = base.includes(feature.id) ? base.filter((x) => x !== feature.id) : [...base, feature.id];
    } else if (event.shiftKey && selected) {
      const a = ids.indexOf(selected);
      next = ids.slice(Math.min(a, i), Math.max(a, i) + 1);
    }

    useApp.setState({
      selectedFeature: next.includes(feature.id) ? feature.id : (next.at(-1) ?? null),
      featureSelection: next,
    });
  };

  const status = new Map((previewing ? [] : (statuses ?? [])).map((status) => [status.id, status]));
  const rollbackIndex = doc.rollback
    ? doc.features.findIndex((feature) => feature.id === doc.rollback)
    : doc.features.length - 1;

  const onDrop = (index: number) => {
    if (!drag) return;

    if (drag.kind === "rollback") {
      apply({
        type: "set_rollback",
        id: index === 0 ? null : index >= doc.features.length ? null : doc.features[index - 1]!.id,
      });
    } else {
      const from = doc.features.findIndex((feature) => feature.id === drag.id);

      if (from !== index && from + 1 !== index) {
        apply({ type: "move_feature", id: drag.id, after: index === 0 ? null : doc.features[index - 1]!.id });
      }
    }

    setDrag(null);
    setDropAt(null);
  };

  if (doc.rollback === null && dropAt === null) void 0;

  const menu = (feature: Feature, x: number, y: number) =>
    showMenu(x, y, [
      { label: t("Edit"), icon: <Pencil />, kbd: "↵", onClick: () => editFeature(feature.id) },
      {
        label: t("Rename"),
        icon: <Pencil />,
        onClick: async () => {
          const name = await askText({
            title: t("Rename feature"),
            label: t("Name"),
            value: featureName(feature),
          });

          if (name !== null) {
            apply({ type: "edit_feature", id: feature.id, patch: { name: name.trim() || null } });
          }
        },
      },
      {
        label: feature.suppressed ? t("Unsuppress") : t("Suppress"),
        icon: feature.suppressed ? <Eye /> : <EyeOff />,
        onClick: () =>
          apply({
            type: "edit_feature",
            id: feature.id,
            patch: { suppressed: feature.suppressed ? null : true },
          }),
      },
      {
        label: t("Roll back to here"),
        icon: <SkipBack />,
        onClick: () => apply({ type: "set_rollback", id: feature.id }),
      },
      ...(feature.op === "sketch"
        ? [
            {
              label: hidden.has(feature.id) ? t("Show sketch") : t("Hide sketch"),
              icon: hidden.has(feature.id) ? <Eye /> : <EyeOff />,
              onClick: () => toggleHidden(feature.id),
            },
            { label: t("Export DXF"), icon: <FileDown />, onClick: () => exportSketch(feature.id, "dxf") },
            { label: t("Export SVG"), icon: <FileDown />, onClick: () => exportSketch(feature.id, "svg") },
          ]
        : []),
      // Also for a mesh that failed to import (a scan with holes): cleaning it up can close them.
      ...(feature.op === "import" && feature.format === "stl"
        ? [{ label: t("Clean up mesh…"), icon: <Eraser />, onClick: () => openMeshRepair(feature.id) }]
        : []),
      "sep",
      {
        label: t("Delete"),
        icon: <Trash />,
        danger: true,
        kbd: "⌫",
        onClick: () => void deleteFeature(feature),
      },
    ]);

  return (
    <>
      <SectionHead
        open={open}
        onToggle={toggle}
        actions={
          doc.rollback ? (
            <button
              className="icon-btn sm"
              title={t("Roll forward to the end")}
              onClick={() => apply({ type: "set_rollback", id: null })}
            >
              <SkipForward />
            </button>
          ) : null
        }
      >
        {t("Features")} <span className="count">{doc.features.length}</span>
      </SectionHead>
      {open ? (
        <>
          <ul className="tree">
            <li className="tree-item dim" title={t("Origin planes")}>
              <Layers className="ficon" />
              <span className="tree-label">{t("Origin")}</span>
              <span className="actions">
                {Object.entries(PLANE_LABELS).map(([ref, label]) => (
                  <button
                    key={ref}
                    className="icon-btn sm"
                    title={t("New sketch on {plane}", { plane: label })}
                    onClick={() => startSketch({ ref })}
                    style={{ fontSize: 10.5, width: "auto" }}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </li>
            {doc.features.map((feature, i) => {
              const st = status.get(feature.id);
              const Icon = FEATURES[feature.op].icon;
              const rolledBack = i > rollbackIndex;
              const cls = [
                "tree-item",
                selected === feature.id || multi.includes(feature.id) ? "selected" : "",
                dialog?.feature.id === feature.id || sketchId === feature.id ? "editing" : "",
                feature.suppressed || rolledBack ? "dim" : "",
                st?.status === "error" ? "err" : st?.status === "warning" ? "warn" : "",
                dropAt === i ? "drop-before" : "",
              ].join(" ");

              return (
                <li
                  key={feature.id}
                  onDragOver={(event) => (event.preventDefault(), setDropAt(i))}
                  onDrop={() => onDrop(i)}
                >
                  <div
                    className={cls}
                    draggable
                    onDragStart={() => setDrag({ kind: "feature", id: feature.id })}
                    onDragEnd={() => (setDrag(null), setDropAt(null))}
                    onClick={(event) => select(feature, i, event)}
                    onDoubleClick={() => editFeature(feature.id)}
                    onContextMenu={(event) => (
                      event.preventDefault(),
                      menu(feature, event.clientX, event.clientY)
                    )}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") editFeature(feature.id);
                      if (event.key === "Delete" || event.key === "Backspace") void deleteFeature(feature);
                    }}
                    tabIndex={0}
                    title={
                      st?.message ??
                      `${FEATURES[feature.op].label}${st && !st.cached ? ` · ${st.ms.toFixed(1)} ms` : ""}`
                    }
                  >
                    <Icon className="ficon" />
                    <span className="tree-label">{featureName(feature)}</span>
                    <span className="actions">
                      {feature.op === "sketch" ? (
                        <button
                          className="icon-btn sm"
                          title={hidden.has(feature.id) ? t("Show") : t("Hide")}
                          onClick={(event) => (event.stopPropagation(), toggleHidden(feature.id))}
                        >
                          {hidden.has(feature.id) ? <EyeOff /> : <Eye />}
                        </button>
                      ) : null}
                      <button
                        className="icon-btn sm"
                        title={t("Edit")}
                        onClick={(event) => (
                          event.stopPropagation(),
                          feature.op === "sketch" ? openSketch(feature.id) : editFeature(feature.id)
                        )}
                      >
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
                      title={t("Drag to roll back the model")}
                      onDragStart={() => setDrag({ kind: "rollback", id: "" })}
                      onDragEnd={() => (setDrag(null), setDropAt(null))}
                    >
                      {doc.rollback ? <span>{t("Rolled back")}</span> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
            <li
              onDragOver={(event) => (event.preventDefault(), setDropAt(doc.features.length))}
              onDrop={() => onDrop(doc.features.length)}
              style={{ height: 24 }}
              className={dropAt === doc.features.length ? "tree-item drop-before" : ""}
            />
          </ul>
          {multi.length > 1 ? <LinkBar ids={multi} /> : null}
          {!doc.features.length ? (
            <div className="empty">{t("Start with a sketch: pick a plane under Origin, or press S.")}</div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** Numeric fields that several features of one kind can share through a variable. */
const LINKABLE: Partial<Record<Feature["op"], { field: string; label: string; unit: ValueUnit }[]>> = {
  extrude: [
    { field: "distance", label: t("link::distance"), unit: "mm" },
    { field: "distance2", label: t("link::second distance"), unit: "mm" },
  ],
  revolve: [{ field: "angle", label: t("link::angle"), unit: "deg" }],
  fillet: [{ field: "radius", label: t("link::radius"), unit: "mm" }],
  chamfer: [{ field: "distance", label: t("link::distance"), unit: "mm" }],
  shell: [{ field: "thickness", label: t("link::thickness"), unit: "mm" }],
  plane: [{ field: "offset", label: t("link::offset"), unit: "mm" }],
  linear_pattern: [
    { field: "count", label: t("link::count"), unit: "" },
    { field: "spacing", label: t("link::spacing"), unit: "mm" },
  ],
  circular_pattern: [
    { field: "count", label: t("link::count"), unit: "" },
    { field: "angle", label: t("link::angle"), unit: "deg" },
  ],
  gear: [
    { field: "module", label: t("link::module"), unit: "mm" },
    { field: "teeth", label: t("link::teeth"), unit: "" },
    { field: "width", label: t("link::width"), unit: "mm" },
  ],
  thread: [
    { field: "pitch", label: t("link::pitch"), unit: "mm" },
    { field: "length", label: t("link::length"), unit: "mm" },
    { field: "clearance", label: t("link::clearance"), unit: "mm" },
  ],
};

/** Offers to drive equal values of the picked features (same kind) from one new variable. */
function LinkBar({ ids }: { ids: string[] }) {
  const doc = useApp((state) => state.doc);
  const values = useApp((state) => state.output?.report.params) ?? EMPTY;
  const feats = ids
    .map((id) => doc.features.find((feature) => feature.id === id))
    .filter((feature): feature is Feature => !!feature);
  const op = feats[0]?.op;

  if (!op || feats.some((feature) => feature.op !== op)) {
    return (
      <div className="link-bar muted">
        {t("{n} features picked · pick features of one kind to link their values", { n: feats.length })}
      </div>
    );
  }

  // German has no rule for the plural of a feature name, so it writes "3 × Extrudieren".
  const kind = lang === "de" ? FEATURES[op].label : `${FEATURES[op].label.toLowerCase()}s`;
  const scope = new Map(Object.entries(values));
  const rows = (LINKABLE[op] ?? []).flatMap(({ field, label, unit }) => {
    const exprs = feats.map(
      (feature) => (feature as unknown as Record<string, unknown>)[field] as string | number | undefined,
    );
    if (exprs.some((e) => e === undefined)) return [];

    let nums: number[];

    try {
      nums = exprs.map((e) => evaluate(e!, scope));
    } catch {
      return [];
    }

    const same = nums.every((n) => Math.abs(n - nums[0]!) < 1e-9);
    const linked =
      exprs.every((e) => e === exprs[0]) && typeof exprs[0] === "string" && exprs[0] in doc.params;

    return [{ field, label, unit, same, linked, expr: exprs[0]!, value: nums[0]! }];
  });

  const link = async (r: (typeof rows)[number]) => {
    const name = await askText({
      title: t("Link the {what} of {n} {kind}", { what: r.label, n: feats.length, kind }),
      label: t("Variable name"),
      value: freeParamName(`${op}_${r.field}`),
      confirmLabel: t("Create and link"),
    });
    if (!name?.trim()) return;

    const n = name.trim();

    if (!/^[A-Za-z_]\w*$/.test(n) || n in doc.params) {
      return toast(
        n in doc.params
          ? t('"{name}" already exists', { name: n })
          : t("Use letters, digits and _ (not starting with a digit)"),
        "error",
      );
    }

    // Keep a shared expression as written; plain numbers get their unit.
    const expr =
      typeof r.expr === "string" && exprs(feats, r.field).every((e) => e === r.expr)
        ? r.expr
        : withUnit(r.value, r.unit);

    if (
      apply(
        { type: "set_param", name: n, expr, auto: true },
        ...feats.map((feature) => ({
          type: "edit_feature" as const,
          id: feature.id,
          patch: { [r.field]: n },
        })),
      )
    ) {
      toast(
        t('{n} {kind} now share "{name}" — change it under Variables › Automatic', {
          n: feats.length,
          kind,
          name: n,
        }),
      );
    }
  };

  return (
    <div className="link-bar">
      <div className="link-bar-title">
        <Link2 /> {t("{n} {kind} picked", { n: feats.length, kind })}
      </div>
      {rows.length ? (
        rows.map((r) =>
          r.linked ? (
            <div key={r.field} className="link-row muted">
              {t("{what}: linked to", { what: r.label })} <span className="mono">{String(r.expr)}</span>
            </div>
          ) : r.same ? (
            <button key={r.field} className="link-row" onClick={() => void link(r)}>
              {t("Link {what} ({value}) with a variable…", {
                what: r.label,
                value:
                  r.unit === "mm" ? fmtLen(r.value) : `${+r.value.toFixed(3)}${r.unit === "deg" ? "°" : ""}`,
              })}
            </button>
          ) : (
            <div key={r.field} className="link-row muted">
              {t("{what}: values differ", { what: r.label })}
            </div>
          ),
        )
      ) : (
        <div className="link-row muted">{t("Nothing to link for {kind}", { kind })}</div>
      )}
    </div>
  );
}

const exprs = (feats: Feature[], field: string) =>
  feats.map((feature) => (feature as unknown as Record<string, unknown>)[field]);

/** Draws a part see-through as a reference, or solid again (saved in the design). */
export function toggleSeeThrough(id: string): void {
  const doc = useApp.getState().doc;
  apply({ type: "replace", doc: seeThroughDoc(doc, [id], !doc.seeThrough?.includes(id)) });
}

export function toggleHidden(id: string): void {
  useApp.setState((state) => {
    const hidden = new Set(state.hidden);
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);

    return { hidden };
  });
}

export async function deleteFeature(feature: Feature): Promise<void> {
  const doc = useApp.getState().doc;
  const dependents = doc.features.filter(
    (g) =>
      g !== feature &&
      JSON.stringify(g).includes(`"${feature.id}`) &&
      doc.features.indexOf(g) > doc.features.indexOf(feature),
  );

  if (
    dependents.length &&
    !(await askConfirm({
      title: t("Delete {name}?", { name: featureName(feature) }),
      message: t("It is used by {names}. Those will be deleted too.", {
        names: dependents.map(featureName).join(", "),
      }),
      confirmLabel: t("Delete {n} features", { n: dependents.length + 1 }),
      danger: true,
    }))
  ) {
    return;
  }

  const ops = [...dependents]
    .reverse()
    .map((feature) => ({ type: "delete_feature" as const, id: feature.id }));

  if (apply(...ops, { type: "delete_feature", id: feature.id })) {
    toast(t("Deleted {name}", { name: featureName(feature) }));
  }
}

/** Parts list: drag to reorder, drop onto a folder to group; order and folders are saved in the file. */
function Bodies() {
  const bodies = useApp((state) => state.output?.report.bodies) ?? NONE;
  const doc = useApp((state) => state.doc);
  const hidden = useApp((state) => state.hidden);
  // Parts selected as a whole (in the view or here) stand out in the list.
  const selection = useApp((state) => state.selection);
  const picked = new Set(selectedParts(selection));
  const [open, toggle] = useSection("parts");
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
  const colorParts = usePrefs((prefs) => prefs.colorParts);
  const printBed = usePrefs((prefs) => prefs.printBed);
  if (!bodies.length) return null;

  const oversize = new Set(tooBig(bodies, printBed).map((b) => b.id));
  const fmt = (n: number) => fmtVolume(n);
  const ids = bodies.map((b) => b.id);
  const order = [
    ...(doc.partOrder ?? []).filter((id) => ids.includes(id)),
    ...ids.filter((id) => !(doc.partOrder ?? []).includes(id)),
  ];
  const groups = (doc.partGroups ?? []).map((g) => ({
    ...g,
    parts: order.filter((id) => g.parts.includes(id)),
  }));
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
      nextOrder = [
        ...without.slice(0, without.indexOf(target)),
        id,
        ...without.slice(without.indexOf(target)),
      ];

      const g = gs.find((x) => x.parts.includes(target));
      if (g) g.parts.push(id);
    }

    save(nextOrder, gs);
  };

  const newGroup = async (with_?: string) => {
    const taken = new Set(groups.map((g) => g.name));
    let n = 1;
    while (taken.has(t("Group {n}", { n }))) n++;

    const name = await askText({
      title: t("New group"),
      label: t("Name"),
      value: t("Group {n}", { n }),
      confirmLabel: t("Create"),
    });
    if (!name?.trim() || taken.has(name.trim())) return;

    const gs = (doc.partGroups ?? []).map((g) => ({ ...g, parts: g.parts.filter((x) => x !== with_) }));
    save(order, [...gs, { name: name.trim(), parts: with_ ? [with_] : [] }]);
  };

  const renameGroup = async (name: string) => {
    const to = await askText({ title: t("Rename group"), label: t("Name"), value: name });
    if (!to?.trim() || to.trim() === name || groups.some((g) => g.name === to.trim())) return;

    save(
      order,
      (doc.partGroups ?? []).map((g) => (g.name === name ? { ...g, name: to.trim() } : g)),
    );
  };

  const setHidden = (list: string[], hide: boolean) =>
    useApp.setState((state) => {
      const h = new Set(state.hidden);

      for (const id of list) {
        if (hide) h.add(id);
        else h.delete(id);
      }

      return { hidden: h };
    });
  const dropProps = (target: string | null) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!drag) return;

      event.preventDefault();
      event.stopPropagation();
      setOver(target ?? "end");
    },
    onDragLeave: () => setOver(null),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (drag) move(drag, target);

      setDrag(null);
      setOver(null);
    },
  });
  const meshParts = meshBodyIds(doc.features, useApp.getState().output?.meshes ?? []);
  const colors = partColors(doc, ids, colorParts);

  const setColor = (id: string, hex: string | null) => {
    const picked = { ...(doc.partColors ?? {}) };
    if (hex) picked[id] = hex;
    else delete picked[id];

    const next = { ...doc, partColors: picked } as typeof doc;
    if (!Object.keys(picked).length) delete next.partColors;

    apply({ type: "replace", doc: next });
  };

  /** The material picker, for the selected parts when this one is among them. */
  const pickMaterial = (id: string) =>
    openMaterialPicker(selectedParts().includes(id) ? selectedParts() : [id]);

  const massText = (id: string, volume: number) => {
    const material = partMaterial(doc, id);

    return material && Number.isFinite(volume)
      ? ` · ${formatMass(massOf(volume, material))} ${materialName(material)}`
      : "";
  };

  // The browser's own colour picker (works with mouse and touch alike).
  const pickColor = (id: string) => {
    const input = document.createElement("input");
    input.type = "color";
    input.value = colors.get(id) ?? PART_PALETTE[0];
    input.addEventListener("change", () => setColor(id, input.value));
    input.click();
  };

  const part = (id: string, nested: boolean) => {
    const b = bodies.find((x) => x.id === id)!;
    const big = oversize.has(id);

    return (
      <li
        key={id}
        className={`tree-item ${hidden.has(id) ? "dim" : ""} ${nested ? "nested" : ""} ${over === id ? "drop-before" : ""} ${picked.has(id) ? "selected" : ""}`}
        ref={picked.has(id) ? (element) => element?.scrollIntoView({ block: "nearest" }) : undefined}
        onClick={(event) => selectParts([id], event.shiftKey || event.metaKey || event.ctrlKey)}
        title={t("{faces} faces · {size} — drag to reorder or onto a group", {
          faces: b.faces,
          size: `${b.bbox.max.map((v, i) => inUnit(v - b.bbox.min[i]!)).join(" × ")} ${docUnit()}`,
        })}
        draggable
        onDragStart={() => setDrag(id)}
        onDragEnd={() => (setDrag(null), setOver(null))}
        onContextMenu={(event) => {
          event.preventDefault();
          showMenu(event.clientX, event.clientY, [
            { label: t("New group with this part"), icon: <FolderPlus />, onClick: () => void newGroup(id) },
            ...groups
              .filter((g) => !g.parts.includes(id))
              .map((g) => ({
                label: t("Move to {group}", { group: g.name }),
                icon: <Folder />,
                onClick: () => move(id, `group:${g.name}`),
              })),
            ...(grouped.has(id)
              ? [
                  {
                    label: t("Take out of group"),
                    icon: <X />,
                    onClick: () =>
                      save(
                        order,
                        (doc.partGroups ?? []).map((g) => ({ ...g, parts: g.parts.filter((x) => x !== id) })),
                      ),
                  },
                ]
              : []),
            "sep" as const,
            {
              label: t("Copy"),
              icon: <Copy />,
              kbd: "Mod+C",
              onClick: () => copyParts(selectedParts().includes(id) ? selectedParts() : [id]),
            },
            {
              label: t("Duplicate"),
              icon: <CopyPlus />,
              kbd: "Mod+D",
              onClick: () => (
                copyParts(selectedParts().includes(id) ? selectedParts() : [id]),
                void pasteParts()
              ),
            },
            ...(hasClip()
              ? [
                  {
                    label: t("Paste"),
                    icon: <ClipboardPaste />,
                    kbd: "Mod+V",
                    onClick: () => void pasteParts(),
                  },
                ]
              : []),
            "sep" as const,
            {
              label: hidden.has(id) ? t("Show") : t("Hide"),
              icon: hidden.has(id) ? <Eye /> : <EyeOff />,
              onClick: () => toggleHidden(id),
            },
            {
              label: doc.seeThrough?.includes(id) ? t("Show solid") : t("Show see-through"),
              icon: <Ghost />,
              onClick: () => toggleSeeThrough(id),
            },
            ...(() => {
              const sw = textureToggle(id);

              return sw
                ? [{ label: sw.label, icon: sw.shown ? <ImageOff /> : <PictureIcon />, onClick: sw.onClick }]
                : [];
            })(),
            ...terrainItems(id, { set: <ArrowDownToLine />, place: <MapPin /> }),
            { label: t("Gridfinity bin for this part"), icon: <LayoutGrid />, onClick: () => binForPart(id) },
            ...(meshParts.has(id)
              ? [
                  {
                    label: t("Convert to editable body"),
                    icon: <Shapes />,
                    onClick: () => convertMeshPart(id),
                  },
                  {
                    label: t("Rebuild with features"),
                    icon: <Wand2 />,
                    onClick: () => void rebuildMeshPart(id),
                  },
                  ...(doc.features.some((feature) => feature.id === id && feature.op === "import")
                    ? [{ label: t("Clean up mesh…"), icon: <Eraser />, onClick: () => openMeshRepair(id) }]
                    : []),
                ]
              : []),
            { label: t("Colour…"), icon: <Palette />, onClick: () => pickColor(id) },
            { label: t("Material…"), icon: <Weight />, onClick: () => pickMaterial(id) },
            ...(doc.partColors?.[id]
              ? [{ label: t("Reset colour"), icon: <RotateCcw />, onClick: () => setColor(id, null) }]
              : []),
            "sep" as const,
            { label: t("Delete part"), icon: <Trash />, danger: true, onClick: () => deleteBodies([id]) },
          ]);
        }}
        {...dropProps(id)}
      >
        <button
          className="part-swatch"
          title={t("Colour and material")}
          style={{ background: colors.get(id) ?? PART_PALETTE[0] }}
          onClick={(event) => {
            event.stopPropagation();

            // Colour, material and going back to the automatic colour, in one place (mouse and touch).
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
            const material = partMaterial(doc, id);
            showMenu(rect.left, rect.bottom + 4, [
              {
                label: material ? t("Material: {name}…", { name: materialName(material) }) : t("Material…"),
                icon: <Weight />,
                onClick: () => pickMaterial(id),
              },
              { label: t("Colour…"), icon: <Palette />, onClick: () => pickColor(id) },
              ...(doc.partColors?.[id]
                ? [{ label: t("Reset colour"), icon: <RotateCcw />, onClick: () => setColor(id, null) }]
                : []),
            ]);
          }}
        />
        <span className="tree-label">
          {big ? (
            <button
              className="too-big"
              title={t("Too big for the print bed")}
              aria-label={t("Too big for the print bed")}
              onClick={(event) => {
                event.stopPropagation();

                const size = partSize(b.bbox)
                  .map((v) => inUnit(v))
                  .join(" × ");
                const bed = printBed!.map((v) => inUnit(v)).join(" × ");
                toast(
                  t(
                    "{part} is {size} {unit}, larger than the print bed ({bed} {unit}). Split it into pieces that fit (Shift+K), with pins or a dovetail.",
                    { part: partName(id, doc.features), size, bed, unit: docUnit() },
                  ),
                );
              }}
            >
              <TriangleAlert />
            </button>
          ) : null}
          {partName(id, doc.features)}{" "}
          {Number.isFinite(b.volume) ? <span className="muted">· {fmt(b.volume)}</span> : null}
          {Number.isFinite(b.volume) ? (
            // The material (or the offer to pick one) opens the picker.
            // A span, not a button: a button is cut off whole when the name does not fit.
            <span
              className="link-btn muted"
              role="button"
              tabIndex={0}
              title={t("Material…")}
              onClick={(event) => (event.stopPropagation(), pickMaterial(id))}
              onKeyDown={(event) =>
                (event.key === "Enter" || event.key === " ") &&
                (event.preventDefault(), event.stopPropagation(), pickMaterial(id))
              }
            >
              {partMaterial(doc, id) ? massText(id, b.volume) : ` · ${t("No material")}`}
            </span>
          ) : null}
          {meshParts.has(id) ? (
            <span className="part-badge" title={meshHint()}>
              {t("Mesh")}
            </span>
          ) : null}
        </span>
        <span className="actions" style={{ display: "flex" }}>
          <button
            className="icon-btn sm"
            title={hidden.has(id) ? t("Show") : t("Hide")}
            onClick={() => toggleHidden(id)}
          >
            {hidden.has(id) ? <EyeOff /> : <Eye />}
          </button>
          <button className="icon-btn sm" title={t("Delete part")} onClick={() => deleteBodies([id])}>
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
          <>
            {bodies.length > 1 ? (
              <button
                className="icon-btn sm"
                title={t("Check whether parts overlap")}
                onClick={() => void checkInterference()}
              >
                <ShieldCheck />
              </button>
            ) : null}
            <button className="icon-btn sm" title={t("New group")} onClick={() => void newGroup()}>
              <FolderPlus />
            </button>
          </>
        }
      >
        {t("Parts")} <span className="count">{bodies.length}</span>
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
                  onClick={() =>
                    setClosedGroups((c) =>
                      c.has(g.name) ? new Set([...c].filter((x) => x !== g.name)) : new Set([...c, g.name]),
                    )
                  }
                  onDoubleClick={() => void renameGroup(g.name)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    showMenu(event.clientX, event.clientY, [
                      { label: t("Rename"), icon: <Pencil />, onClick: () => void renameGroup(g.name) },
                      {
                        label: allHidden ? t("Show all") : t("Hide all"),
                        icon: allHidden ? <Eye /> : <EyeOff />,
                        onClick: () => setHidden(g.parts, !allHidden),
                      },
                      "sep",
                      {
                        label: t("Ungroup"),
                        icon: <X />,
                        onClick: () =>
                          save(
                            order,
                            (doc.partGroups ?? []).filter((x) => x.name !== g.name),
                          ),
                      },
                    ]);
                  }}
                  {...dropProps(`group:${g.name}`)}
                  title={t("Click to fold · double-click to rename · drop parts here")}
                >
                  <ChevronRight className={`ficon chev ${closed ? "" : "open"}`} />
                  <Folder className="ficon" />
                  <span className="tree-label">
                    {g.name} <span className="muted">· {g.parts.length}</span>
                  </span>
                  <span className="actions" style={{ display: "flex" }}>
                    <button
                      className="icon-btn sm"
                      title={allHidden ? t("Show all") : t("Hide all")}
                      onClick={(event) => (event.stopPropagation(), setHidden(g.parts, !allHidden))}
                    >
                      {allHidden ? <EyeOff /> : <Eye />}
                    </button>
                  </span>
                </div>
                {!closed ? (
                  <ul className="tree">
                    {g.parts.length ? (
                      g.parts.map((id) => part(id, true))
                    ) : (
                      <li className="tree-item nested dim">{t("Drop parts here")}</li>
                    )}
                  </ul>
                ) : null}
              </li>
            );
          })}
          {order.filter((id) => !grouped.has(id)).map((id) => part(id, false))}
          <li className={`drop-end ${over === "end" ? "drop-before" : ""}`} />
          {(() => {
            // Total mass and centre of gravity once parts have materials.
            if (!doc.partMaterials) return null;

            const total = massProperties(
              bodies.map((b) => ({
                volume: b.volume,
                ...(b.centroid ? { centroid: b.centroid } : {}),
                ...(b.inertia ? { inertia: b.inertia } : {}),
                ...(partMaterial(doc, b.id) ? { material: partMaterial(doc, b.id)! } : {}),
              })),
            );
            if (!total.mass) return null;

            const c = total.center?.map((v) => v.toFixed(1)).join(", ");
            const I = total.inertia;
            const products = I
              ? t("Products of inertia: Ixy {xy}, Ixz {xz}, Iyz {yz}", {
                  xy: formatInertia(I[3]),
                  xz: formatInertia(I[4]),
                  yz: formatInertia(I[5]),
                })
              : "";

            return (
              <li
                className="tree-item dim mass-total"
                title={[
                  total.missing
                    ? tn(
                        total.missing,
                        "{n} part without a material is not counted",
                        "{n} parts without a material are not counted",
                      )
                    : t("Solid material (100 % infill)"),
                  products,
                ]
                  .filter(Boolean)
                  .join("\n")}
              >
                <Weight className="ficon" />
                <span className="tree-label">
                  {formatMass(total.mass)}{" "}
                  {c ? <span className="muted">· {t("centre of gravity ({c})", { c })}</span> : null}
                  {total.missing ? (
                    <span className="muted"> · {t("{n} without material", { n: total.missing })}</span>
                  ) : null}
                  {I ? (
                    <span className="muted mass-inertia">
                      {t("Inertia about it: Ixx {xx} · Iyy {yy} · Izz {zz}", {
                        xx: formatInertia(I[0]),
                        yy: formatInertia(I[1]),
                        zz: formatInertia(I[2]),
                      })}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })()}
        </ul>
      ) : null}
    </>
  );
}

/** Models shown with the design but not built into it (an area from drone photos). */
function References() {
  const refs = useApp((state) => state.doc.references);
  const [open, toggle] = useSection("references");
  if (!refs?.length) return null;

  const set = (reference: ReferenceModel, patch: Partial<ReferenceModel>) =>
    apply({ type: "set_reference", reference: { ...reference, ...patch } });

  const rename = async (reference: ReferenceModel) => {
    const name = (await askText({ title: t("Rename"), label: t("Name"), value: reference.name }))?.trim();
    if (name) set(reference, { name });
  };

  return (
    <>
      <SectionHead open={open} onToggle={toggle}>
        {t("Surroundings")} <span className="count">{refs.length}</span>
      </SectionHead>
      {open ? (
        <ul className="tree">
          {refs.map((reference) => (
            <li
              key={reference.id}
              className={`tree-item ${reference.hidden ? "dim" : ""}`}
              title={
                reference.geo
                  ? t("Placed by GPS at {lat}, {lon}", {
                      lat: reference.geo.lat.toFixed(6),
                      lon: reference.geo.lon.toFixed(6),
                    })
                  : undefined
              }
              onContextMenu={(event) => {
                event.preventDefault();
                showMenu(event.clientX, event.clientY, [
                  {
                    label: t("Mark a line"),
                    icon: <Pencil />,
                    onClick: () => startMarking("line", reference.id),
                  },
                  {
                    label: t("Mark an area"),
                    icon: <Shapes />,
                    onClick: () => startMarking("area", reference.id),
                  },
                  {
                    label: t("Highlighter"),
                    icon: <Highlighter />,
                    onClick: () => startMarking("stroke", reference.id),
                  },
                  {
                    label: t("Pin a note"),
                    icon: <StickyNote />,
                    onClick: () => startMarking("note", reference.id),
                  },
                  {
                    label: t("Set a stake-out point"),
                    icon: <MapPin />,
                    onClick: () => startMarking("point", reference.id),
                  },
                  {
                    label: t("Correct the scale…"),
                    icon: <Ruler />,
                    onClick: () => startScaling(reference.id),
                  },
                  {
                    label: t("Clean up…"),
                    icon: <Eraser />,
                    onClick: () => cleanUpMenu(reference.id, event.clientX, event.clientY),
                  },
                  "sep" as const,
                  { label: t("Rename…"), icon: <Pencil />, onClick: () => void rename(reference) },
                  {
                    label: reference.hidden ? t("Show") : t("Hide"),
                    icon: reference.hidden ? <Eye /> : <EyeOff />,
                    onClick: () => set(reference, { hidden: !reference.hidden || undefined }),
                  },
                  "sep" as const,
                  {
                    label: t("Delete"),
                    icon: <Trash />,
                    danger: true,
                    onClick: () => apply({ type: "delete_reference", id: reference.id }),
                  },
                ]);
              }}
            >
              <MapIcon className="ficon" />
              <span className="tree-label">
                {reference.name}{" "}
                {reference.marks?.length ? (
                  <span className="muted">· {tn(reference.marks.length, "{n} mark", "{n} marks")}</span>
                ) : null}
              </span>
              <span className="actions" style={{ display: "flex" }}>
                <button
                  className="icon-btn sm"
                  title={reference.hidden ? t("Show") : t("Hide")}
                  onClick={() => set(reference, { hidden: !reference.hidden || undefined })}
                >
                  {reference.hidden ? <EyeOff /> : <Eye />}
                </button>
                <button
                  className="icon-btn sm"
                  title={t("Delete")}
                  onClick={() => apply({ type: "delete_reference", id: reference.id })}
                >
                  <Trash />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function Params() {
  const params = useApp((state) => state.doc.params);
  const auto = useApp((state) => state.doc.autoParams) ?? NONE;
  const doc = useApp((state) => state.doc);
  const values = useApp((state) => state.output?.report.params) ?? EMPTY;
  const unit = useApp((state) => state.doc.units ?? "mm");
  const errors = useApp((state) => state.output?.report.paramErrors) ?? EMPTY;
  const [adding, setAdding] = useState<{ name: string; expr: string } | null>(null);
  const [open, toggle] = useSection("variables");
  const [ownOpen, toggleOwn] = useSection("variables.own");
  const [autoOpen, toggleAuto] = useSection("variables.auto", false);
  const [calcOpen, toggleCalc] = useSection("variables.calc", false);
  const [variantsOpen, toggleVariants] = useSection("variables.variants");
  const variants = doc.variants ?? [];
  const active = variants.find((variant) => variant.name === doc.variant);
  const [query, setQuery] = useState("");
  const used = (name: string) =>
    JSON.stringify(doc.features).match(new RegExp(`\\b${name}\\b`)) ||
    Object.values(params).some((expr) => referencedNames(expr).includes(name));
  const q = query.trim().toLowerCase();
  const matches = (n: string) =>
    !q || n.toLowerCase().includes(q) || String(params[n]).toLowerCase().includes(q);
  const groupOf = (n: string) => variableGroup(n, params, auto);
  const own = Object.keys(params).filter((n) => groupOf(n) === "own" && matches(n));
  const calculated = Object.keys(params).filter((n) => groupOf(n) === "calculated");
  const automatic = Object.keys(params).filter((n) => groupOf(n) === "auto");
  const total = Object.keys(params).length;

  // With a variant in use, its values show and are edited in place of the plain ones.
  const fromVariant = (name: string) => !!active && name in active.params;
  const shown = (name: string) => (fromVariant(name) ? active!.params[name]! : params[name]!);
  const setValue = (name: string, expr: Expr) =>
    fromVariant(name)
      ? apply({ type: "set_variant", name: active!.name, params: { ...active!.params, [name]: expr } })
      : apply({ type: "set_param", name, expr: expr });

  const addVariant = async () => {
    const name = await askText({
      title: t("New variant"),
      label: t("Name"),
      value: t("Variant {n}", { n: variants.length + 1 }),
      confirmLabel: t("Add"),
    });
    if (!name?.trim()) return;

    // It starts from the values now shown, of every variable that is not a formula of others.
    const values = Object.fromEntries(
      Object.keys(params)
        .filter((n) => groupOf(n) !== "calculated")
        .map((n) => [n, shown(n)]),
    );
    apply(
      { type: "set_variant", name: name.trim(), params: values },
      { type: "use_variant", name: name.trim() },
    );
  };

  const variantMenu = (name: string, x: number, y: number) => {
    const variant = variants.find((x) => x.name === name)!;
    showMenu(x, y, [
      {
        label: t("Rename…"),
        icon: <Pencil />,
        onClick: async () => {
          const to = await askText({
            title: t("Rename variant"),
            label: t("Name"),
            value: name,
            confirmLabel: t("Rename"),
          });

          if (to?.trim() && to.trim() !== name) {
            apply({ type: "set_variant", name, params: variant.params, rename: to.trim() });
          }
        },
      },
      {
        label: t("Delete"),
        icon: <Trash />,
        danger: true,
        onClick: () => apply({ type: "delete_variant", name }),
      },
    ]);
  };

  const row = (name: string, isAuto: boolean) => (
    <div
      className={`param-row ${isAuto ? "auto" : ""} ${fromVariant(name) ? "in-variant" : ""}`}
      title={fromVariant(name) ? t("Value of variant {name}", { name: active!.name }) : undefined}
      key={name}
      onContextMenu={(event) => {
        event.preventDefault();
        showMenu(event.clientX, event.clientY, [
          isAuto
            ? {
                label: t("Move to my variables"),
                icon: <UserCheck />,
                onClick: () => apply({ type: "set_param", name, expr: params[name]!, auto: false }),
              }
            : {
                label: t("Move to automatic"),
                icon: <Bot />,
                onClick: () => apply({ type: "set_param", name, expr: params[name]!, auto: true }),
              },
        ]);
      }}
    >
      <input
        className="field name-input"
        defaultValue={name}
        title={name}
        key={`${name}-n`}
        onBlur={(event) => {
          const to = event.target.value.trim();

          // Renaming a variable makes it yours.
          if (
            to &&
            to !== name &&
            !apply(
              { type: "rename_param", name, to },
              ...(isAuto ? [{ type: "set_param" as const, name: to, expr: params[name]!, auto: false }] : []),
            )
          ) {
            event.target.value = name;
          }
        }}
        onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
      />
      {/* A length variable in an inch design shows its result and takes plain numbers in inches. */}
      <ExprInput
        key={`${name}-${active?.name ?? ""}`}
        value={shown(name)}
        unit={unit === "in" && isLengthParam(name, params) ? "mm" : ""}
        quiet
        onCommit={(expr) => setValue(name, expr)}
      />
      <span
        className="val"
        title={errors[name] ?? (unit === "in" && isLengthParam(name, params) ? t("in inches") : "")}
        style={errors[name] ? { color: "var(--err)" } : undefined}
      >
        {errors[name]
          ? t("error")
          : values[name] === undefined
            ? ""
            : unit === "in" && isLengthParam(name, params)
              ? inUnit(values[name]!, "in")
              : +values[name]!.toFixed(3)}
      </span>
      {isAuto ? (
        <button
          className="icon-btn sm"
          title={t("Move to my variables")}
          onClick={() => apply({ type: "set_param", name, expr: params[name]!, auto: false })}
        >
          <UserCheck />
        </button>
      ) : null}
      <button
        className="icon-btn sm"
        title={used(name) ? t("Still in use") : t("Delete")}
        onClick={async () => {
          if (
            used(name) &&
            !(await askConfirm({
              title: t('Delete variable "{name}"?', { name }),
              message: t(
                "It is still used by features or other variables; those will show an error until you fix them.",
              ),
              confirmLabel: t("Delete"),
              danger: true,
            }))
          ) {
            return;
          }

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
          <button
            className="icon-btn sm"
            title={t("Add variable")}
            onClick={() => (
              open || toggle(),
              setAdding({ name: suggestName(params), expr: docUnit() === "in" ? "0.5 in" : "10 mm" })
            )}
          >
            <Plus />
          </button>
        }
      >
        {t("Variables")} <span className="count">{total}</span>
      </SectionHead>
      {open ? (
        <div className="params">
          {total > 4 ? (
            <div className="param-search">
              <Search />
              <input
                className="field"
                placeholder={t("Search variables")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.key === "Escape" && setQuery("")}
                aria-label={t("Search variables")}
              />
              {query ? (
                <button className="icon-btn sm" title={t("Clear")} onClick={() => setQuery("")}>
                  <X />
                </button>
              ) : null}
            </div>
          ) : null}
          {total ? (
            <>
              <SectionHead
                open={variantsOpen}
                onToggle={toggleVariants}
                sub
                actions={
                  <button className="icon-btn sm" title={t("Add variant")} onClick={() => void addVariant()}>
                    <Plus />
                  </button>
                }
              >
                <span title={t("Named sets of values, e.g. one holder for three pipe sizes")}>
                  {t("Variants")}
                </span>{" "}
                <span className="count">{variants.length}</span>
              </SectionHead>
              {variantsOpen ? (
                variants.length ? (
                  <div className="variant-chips" role="radiogroup" aria-label={t("Variants")}>
                    <button
                      role="radio"
                      aria-checked={!active}
                      className={`variant-chip ${!active ? "on" : ""}`}
                      onClick={() => active && apply({ type: "use_variant", name: null })}
                    >
                      {t("Plain values")}
                    </button>
                    {variants.map((variant) => (
                      <button
                        key={variant.name}
                        role="radio"
                        aria-checked={active?.name === variant.name}
                        className={`variant-chip ${active?.name === variant.name ? "on" : ""}`}
                        onClick={() =>
                          active?.name !== variant.name && apply({ type: "use_variant", name: variant.name })
                        }
                        onDoubleClick={(event) => variantMenu(variant.name, event.clientX, event.clientY)}
                        onContextMenu={(event) => (
                          event.preventDefault(),
                          variantMenu(variant.name, event.clientX, event.clientY)
                        )}
                      >
                        {variant.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="empty" style={{ padding: "2px 4px" }}>
                    {t("Save the values as a variant to switch between sizes of the same part.")}
                  </div>
                )
              ) : null}
            </>
          ) : null}
          {!q ? <FitRow /> : null}
          <SectionHead open={ownOpen || !!q} onToggle={toggleOwn} sub>
            {t("Your variables")} <span className="count">{own.length}</span>
          </SectionHead>
          {ownOpen || q ? own.map((n) => row(n, false)) : null}
          {adding ? (
            <div className="param-row">
              <input
                className="field name-input"
                autoFocus
                value={adding.name}
                onChange={(event) => setAdding({ ...adding, name: event.target.value })}
              />
              <input
                className="field expr"
                value={adding.expr}
                onChange={(event) => setAdding({ ...adding, expr: event.target.value })}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    apply({ type: "set_param", name: adding.name.trim(), expr: parseExpr(adding.expr) })
                  ) {
                    setAdding(null);
                  }

                  if (event.key === "Escape") setAdding(null);
                }}
              />
              <button
                className="icon-btn sm"
                title={t("Add")}
                onClick={() =>
                  apply({ type: "set_param", name: adding.name.trim(), expr: parseExpr(adding.expr) }) &&
                  setAdding(null)
                }
              >
                <Plus />
              </button>
              <button className="icon-btn sm" onClick={() => setAdding(null)}>
                <X />
              </button>
            </div>
          ) : null}
          {!own.length && !adding && (ownOpen || q) ? (
            <div className="empty" style={{ padding: "2px 4px" }}>
              {q ? (
                t("No match")
              ) : (
                <>
                  {t("Named values like")} <span className="mono">wall = 2 mm</span>{" "}
                  {t("can drive any dimension.")}
                </>
              )}
            </div>
          ) : null}
          {calculated.length ? (
            <>
              <SectionHead open={calcOpen || !!q} onToggle={toggleCalc} sub>
                <span title={t("Formulas of other variables; they follow automatically")}>
                  {t("Calculated")}
                </span>{" "}
                <span className="count">{calculated.filter(matches).length}</span>
              </SectionHead>
              {calcOpen || q ? calculated.filter(matches).map((n) => row(n, auto.includes(n))) : null}
              {(calcOpen || q) && !calculated.some(matches) ? (
                <div className="empty" style={{ padding: "2px 4px" }}>
                  {t("No match")}
                </div>
              ) : null}
            </>
          ) : null}
          {automatic.length ? (
            <>
              <SectionHead open={autoOpen || !!q} onToggle={toggleAuto} sub>
                <span title={t("Created by meerCAD (linking, new variable from a value) or by an assistant")}>
                  {t("Automatic")}
                </span>{" "}
                <span className="count">{automatic.filter(matches).length}</span>
              </SectionHead>
              {autoOpen || q ? automatic.filter(matches).map((n) => row(n, true)) : null}
              {(autoOpen || q) && !automatic.some(matches) ? (
                <div className="empty" style={{ padding: "2px 4px" }}>
                  {t("No match")}
                </div>
              ) : null}
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
