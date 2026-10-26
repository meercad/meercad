import { Box, Copy, Eye, EyeOff, Focus, Grid2x2, Layers, Pencil, Ruler, Scan, Trash } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { navigationFor, setPrefs, usePrefs } from "../lib/keymap";
import type { FeatureOp } from "@leocad/schema";
import { samePick, Viewport, type DisplayMode, type Pick, type PickKind, type PlaneView, type SceneData, type SketchView } from "@leocad/viewport";
import { FEATURES } from "../lib/features";
import { planeSpecForPick, PLANE_LABELS } from "../lib/topology";
import { SketchEditor } from "../sketch/SketchEditor";
import { commitDialog, dialogPick, editFeature, kernel, scheduleRebuild, setViewport, startFeature, startSketch, toast, useApp } from "../store";
import { pickKindsFor } from "./FeatureDialog";
import { toggleHidden } from "./FeatureTree";
import { showMenu } from "./Menu";
import { InlineValues } from "./InlineValues";
import { Manipulators } from "./Manipulators";
import { ViewCube } from "./ViewCube";

const ORIGIN_FRAMES: Record<string, PlaneView["frame"]> = {
  "origin.XY": { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
  "origin.XZ": { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] },
  "origin.YZ": { origin: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] },
};

const DEFAULT_KINDS = new Set<PickKind>(["edge", "face", "region", "sketch_curve", "plane"]);

export function ViewportView() {
  const host = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState<Viewport | null>(null);
  const output = useApp((s) => s.output);
  const hidden = useApp((s) => s.hidden);
  const showPlanes = useApp((s) => s.showPlanes);
  const showSketches = useApp((s) => s.showSketches);
  const showValues = usePrefs((s) => s.showValues);
  const sketchId = useApp((s) => s.sketchId);
  const dialog = useApp((s) => s.dialog);
  const selection = useApp((s) => s.selection);
  const measure = useApp((s) => s.measure);
  const pickingPlane = useApp((s) => s.pickingSketchPlane);
  const doc = useApp((s) => s.doc);
  const kernelState = useApp((s) => s.kernel);
  const previewing = useApp((s) => s.previewing);
  const [ortho, setOrtho] = useState(false);
  const [mode, setMode] = useState<DisplayMode>("shaded_edges");
  // Grid contrast follows the light/dark theme.
  useEffect(() => {
    if (!vp) return;
    const apply = () => {
      const t = document.documentElement.dataset["theme"];
      vp.setDark(t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
    };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", apply);
    };
  }, [vp]);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number; filter: "all" | "face" | "edge" } | null>(null);
  const boxRef = useRef(box);
  boxRef.current = box;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const v = new Viewport(host.current!);
    setVp(v);
    setViewport(v);
    const applyNav = () => v.setNavigation(navigationFor(usePrefs.getState().mouse), usePrefs.getState().invertZoom);
    applyNav();
    const offPrefs = usePrefs.subscribe(applyNav);
    return () => {
      offPrefs();
      setViewport(null);
      v.dispose();
    };
  }, []);

  // Scene
  const scene = useMemo<SceneData | null>(() => {
    if (!output) return null;
    const r = output.report;
    let size = 60;
    for (const b of r.bodies) size = Math.max(size, ...b.bbox.max.map(Math.abs), ...b.bbox.min.map(Math.abs));
    const consumed = new Set(doc.features.flatMap((f) => (f.op === "extrude" || f.op === "revolve") && "sketch" in f.profile ? [f.profile.sketch] : []));
    const sketches: SketchView[] = r.sketches
      .filter((s) => !hidden.has(s.id) && (s.id === sketchId || !consumed.has(s.id) || dialog?.feature.op === "extrude" || dialog?.feature.op === "revolve" || hiddenOverride(s.id)))
      .map((s) => ({ id: s.id, frame: s.frame, curves: s.curves, regions: s.regions.map((g) => ({ key: g.key, polygons: g.polygons })) }));
    const planes: PlaneView[] = [
      ...Object.entries(ORIGIN_FRAMES).map(([id, frame]) => ({ id, label: PLANE_LABELS[id]!, frame, size: size * 0.6 })),
      ...r.planes.map((p) => ({ id: p.id, label: p.id, frame: p.frame, size: size * 0.6 })),
    ];
    return { bodies: output.meshes, sketches, planes, references: output.references, hiddenBodies: hidden, editingSketch: sketchId };
  }, [output, hidden, sketchId, doc.features, dialog?.feature.op]);

  useEffect(() => {
    if (vp && scene) vp.setScene(scene);
  }, [vp, scene]);
  const hasBodies = !!output?.report.bodies.length;
  useEffect(() => vp?.setPlanesVisible(showPlanes || !hasBodies || pickingPlane || dialog?.field === "plane" || dialog?.field === "base"), [vp, showPlanes, hasBodies, pickingPlane, dialog?.field]);
  useEffect(() => vp?.setSketchesVisible(showSketches), [vp, showSketches]);
  useEffect(() => {
    if (!vp) return;
    vp.setSelection(measure.active ? measure.picks : selection);
  }, [vp, selection, measure]);
  useEffect(() => {
    setBusy(true);
    const t = setTimeout(() => setBusy(false), 150);
    return () => clearTimeout(t);
  }, [output]);

  const kinds = (): ReadonlySet<PickKind> => {
    const s = useApp.getState();
    if (s.pickingSketchPlane) return new Set(["plane", "face"]);
    if (s.measure.active) return new Set(["face", "edge"]);
    if (s.dialog) return pickKindsFor(s.dialog);
    return DEFAULT_KINDS;
  };

  // Pointer handling (sketch mode is handled by the sketch editor)
  useEffect(() => {
    if (!vp) return;
    const el = vp.canvas;
    let down: { x: number; y: number; button: number; empty: boolean } | null = null;
    let filter: "all" | "face" | "edge" = "all";
    const onKey = (e: KeyboardEvent) => {
      if (!boxRef.current) return;
      const k = e.key.toLowerCase();
      // While box-selecting, F = faces only, E = edges only, Tab cycles.
      if (k === "f" || k === "e" || k === "tab") {
        e.preventDefault();
        e.stopImmediatePropagation();
        filter = k === "f" ? "face" : k === "e" ? "edge" : filter === "all" ? "face" : filter === "face" ? "edge" : "all";
        setBox((b) => (b ? { ...b, filter } : b));
      }
    };
    window.addEventListener("keydown", onKey, true);
    const onMove = (e: PointerEvent) => {
      if (useApp.getState().sketchId) return;
      const d = down;
      if (d && d.button === 0 && d.empty && e.buttons === 1 && !useApp.getState().dialog && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) {
        const r = el.getBoundingClientRect();
        setBox({ x0: d.x - r.left, y0: d.y - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top, filter });
        return;
      }
      if (e.buttons) return;
      vp.setHover(vp.pick(e.clientX, e.clientY, kinds()));
    };
    const onDown = (e: PointerEvent) => {
      filter = "all";
      down = { x: e.clientX, y: e.clientY, button: e.button, empty: e.button === 0 && !vp.pick(e.clientX, e.clientY, kinds()) };
    };
    const onUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      const b = boxRef.current;
      if (b) {
        setBox(null);
        const r = el.getBoundingClientRect();
        const enclosed = b.x1 >= b.x0;
        const ks = new Set<"face" | "edge">(b.filter === "all" ? ["face", "edge"] : [b.filter]);
        const picks = vp.boxSelect(b.x0 + r.left, b.y0 + r.top, b.x1 + r.left, b.y1 + r.top, enclosed, ks);
        const cur = useApp.getState().selection;
        useApp.setState({ selection: e.shiftKey ? [...cur, ...picks.filter((p) => !cur.some((c) => samePick(c, p)))] : picks, selectedFeature: null });
        return;
      }
      if (!d || useApp.getState().sketchId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      const pick = vp.pick(e.clientX, e.clientY, kinds());
      if (d.button === 2) return contextMenu(pick, e.clientX, e.clientY);
      if (d.button === 0) onClick(pick, e.shiftKey || e.metaKey || e.ctrlKey);
    };
    const onDbl = (e: MouseEvent) => {
      if (useApp.getState().sketchId || useApp.getState().dialog) return;
      const pick = vp.pick(e.clientX, e.clientY, DEFAULT_KINDS);
      // Double-clicking a face selects its whole part; other entities open their feature.
      if (pick?.kind === "face") {
        const m = useApp.getState().output?.meshes.find((x) => x.bodyId === pick.bodyId);
        if (m) {
          const faces = m.faceTags.map((tags, face) => ({ kind: "face" as const, bodyId: m.bodyId, face, tags, point: pick.point, normal: null }));
          useApp.setState({ selection: faces, selectedFeature: null });
        }
        return;
      }
      const fid = pick ? featureOfPick(pick) : null;
      if (fid) editFeature(fid);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("dblclick", onDbl);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("dblclick", onDbl);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [vp]);

  const onClick = (pick: Pick | null, additive: boolean) => {
    const s = useApp.getState();
    if (s.pickingSketchPlane) {
      if (!pick) return;
      const spec = planeSpecForPick(pick, s.output?.meshes ?? []);
      if (spec) startSketch(spec);
      else toast("Pick a plane or a flat face", "error");
      return;
    }
    if (s.measure.active) {
      if (!pick || (pick.kind !== "face" && pick.kind !== "edge")) return useApp.setState({ measure: { active: true, picks: [], result: null } });
      const picks = s.measure.picks.length >= 2 || !additive && s.measure.picks.length >= 2 ? [pick] : [...s.measure.picks.filter((p) => !samePick(p, pick)), pick].slice(-2);
      useApp.setState({ measure: { active: true, picks, result: null } });
      const ref = (p: Pick) => (p.kind === "face" ? { bodyId: p.bodyId, kind: "face" as const, index: p.face } : p.kind === "edge" ? { bodyId: p.bodyId, kind: "edge" as const, index: p.edge } : null);
      const [a, b] = picks.map(ref);
      if (a)
        void kernel.measure(a, b ?? undefined).then(
          (result) => useApp.setState((st) => ({ measure: { ...st.measure, result } })),
          (e: Error) => toast(e.message, "error"),
        );
      return;
    }
    if (s.dialog) {
      if (pick && s.dialog.field) dialogPick?.(pick, additive);
      // Clicking empty space accepts the tool unless a selection field is waiting.
      else if (!pick && !s.dialog.field) commitDialog();
      return;
    }
    if (!pick) return useApp.setState({ selection: [], selectedFeature: null });
    const i = s.selection.findIndex((x) => samePick(x, pick));
    const selection = additive ? (i >= 0 ? s.selection.filter((_, j) => j !== i) : [...s.selection, pick]) : [pick];
    useApp.setState({ selection, selectedFeature: featureOfPick(pick) });
  };

  const contextMenu = (pick: Pick | null, x: number, y: number) => {
    const s = useApp.getState();
    if (s.dialog || s.sketchId) return;
    if (pick && !s.selection.some((p) => samePick(p, pick))) useApp.setState({ selection: [pick] });
    const start = (op: FeatureOp) => () => startFeature(op);
    const fid = pick ? featureOfPick(pick) : null;
    const item = (op: FeatureOp, label?: string) => {
      const Icon = FEATURES[op].icon;
      return { label: label ?? FEATURES[op].label, icon: <Icon />, kbd: FEATURES[op].shortcut, onClick: start(op) };
    };
    const common = [
      ...(fid ? [{ label: `Edit ${fid}`, icon: <Pencil />, onClick: () => editFeature(fid) }] : []),
      { label: "Measure", icon: <Ruler />, kbd: "Shift+M", onClick: () => useApp.setState({ measure: { active: true, picks: pick && (pick.kind === "face" || pick.kind === "edge") ? [pick] : [], result: null } }) },
    ];
    if (!pick)
      return showMenu(x, y, [
        { label: "Fit view", icon: <Focus />, kbd: "Z", onClick: () => vp?.fit() },
        { label: s.showPlanes ? "Hide planes" : "Show planes", icon: <Layers />, onClick: () => useApp.setState({ showPlanes: !s.showPlanes }) },
        { label: "Show all parts", icon: <Eye />, onClick: () => useApp.setState({ hidden: new Set() }) },
      ]);
    if (pick.kind === "face")
      return showMenu(x, y, [
        ...(pick.normal ? [{ label: "New sketch on face", icon: <Pencil />, kbd: "S", onClick: () => startSketch(planeSpecForPick(pick, s.output?.meshes ?? []) ?? undefined) }] : []),
        item("fillet", "Fillet face edges"),
        item("chamfer", "Chamfer face edges"),
        item("shell", "Shell (remove this face)"),
        "sep",
        { label: `Hide part ${pick.bodyId}`, icon: <EyeOff />, onClick: () => toggleHidden(pick.bodyId) },
        { label: "Mirror part", icon: <Copy />, onClick: () => (useApp.setState({ selection: [] }), startFeature("mirror")) },
        ...common,
      ]);
    if (pick.kind === "edge") return showMenu(x, y, [item("fillet"), item("chamfer"), "sep", ...common]);
    if (pick.kind === "region" || pick.kind === "sketch_curve")
      return showMenu(x, y, [
        item("extrude"),
        item("revolve"),
        "sep",
        { label: `Edit sketch ${pick.sketchId}`, icon: <Pencil />, onClick: () => editFeature(pick.sketchId) },
        { label: "Hide sketch", icon: <EyeOff />, onClick: () => toggleHidden(pick.sketchId) },
      ]);
    if (pick.kind === "plane")
      return showMenu(x, y, [
        { label: `New sketch on ${PLANE_LABELS[pick.planeId] ?? pick.planeId}`, icon: <Pencil />, onClick: () => startSketch({ ref: pick.planeId }) },
        item("plane", "Offset plane"),
        ...(pick.planeId.startsWith("origin.") ? [] : [{ label: "Delete plane", icon: <Trash />, danger: true, onClick: () => editFeature(pick.planeId) }]),
      ]);
  };

  const featureOfPick = (p: Pick): string | null => {
    const docNow = useApp.getState().doc;
    if (p.kind === "region" || p.kind === "sketch_curve") return p.sketchId;
    if (p.kind === "plane") return p.planeId.startsWith("origin.") ? null : p.planeId;
    if (p.kind === "face") {
      // The latest feature that tagged this face is the most specific owner.
      const ids = p.tags.map((t) => t.split(/[.@[]/)[0]!);
      for (let i = docNow.features.length - 1; i >= 0; i--) if (ids.includes(docNow.features[i]!.id)) return docNow.features[i]!.id;
    }
    if (p.kind === "edge" || p.kind === "face") return docNow.features.find((f) => f.id === p.bodyId)?.id ?? null;
    return null;
  };

  const hint = pickingPlane
    ? "Click a plane or a flat face to sketch on — Esc to cancel"
    : measure.active
      ? "Measure: click a face or edge, then a second one"
      : dialog?.field
        ? null
        : null;

  return (
    <div className={`view ${dialog?.field || pickingPlane || measure.active ? "picking" : ""}`} ref={host}>
      {vp ? <ViewCube viewport={vp} /> : null}
      {vp ? <Manipulators viewport={vp} /> : null}
      {vp ? <InlineValues viewport={vp} /> : null}
      {vp && sketchId ? <SketchEditor viewport={vp} sketchId={sketchId} /> : null}
      {hint ? <div className="hint-banner">{hint}</div> : null}
      <AiActivity />
      {box ? (
        <div
          className={`select-box ${box.x1 >= box.x0 ? "enclosed" : "crossing"}`}
          style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }}
        >
          <span>{box.filter === "all" ? "Faces + edges" : box.filter === "face" ? "Faces" : "Edges"} · {box.x1 >= box.x0 ? "inside" : "touching"} · F/E/Tab</span>
        </div>
      ) : null}
      {measure.active ? <MeasureCard /> : null}
      <div className="status-pill" title={kernelState.error ?? ""}>
        <span className={`dot ${!kernelState.ready || busy ? "busy" : ""}`} style={kernelState.error ? { background: "var(--err)" } : undefined} />
        {kernelState.error ?? (!kernelState.ready ? kernelState.info : output ? `${output.report.bodies.length} part${output.report.bodies.length === 1 ? "" : "s"} · rebuild ${output.report.rebuildMs.toFixed(0)} ms${previewing ? " · preview" : ""}` : "Ready")}
      </div>
      <div className="view-controls">
        <button className="icon-btn sm" title="Fit all (Z)" onClick={() => vp?.fit()}>
          <Scan />
        </button>
        <button
          className={`icon-btn sm ${ortho ? "active" : ""}`}
          title={ortho ? "Orthographic (click for perspective)" : "Perspective (click for orthographic)"}
          onClick={() => {
            vp?.setProjection(ortho ? "perspective" : "orthographic");
            setOrtho(!ortho);
          }}
        >
          <Box />
        </button>
        <button
          className="icon-btn sm mode-btn"
          title="Display mode"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const modes: [DisplayMode, string][] = [
              ["shaded_edges", "Shaded with edges"],
              ["shaded", "Shaded"],
              ["hidden_line", "Hidden lines removed"],
              ["xray", "X-ray"],
              ["wireframe", "Wireframe"],
            ];
            showMenu(r.left, r.top - 200, modes.map(([m, label]) => ({ label: `${vp?.mode === m ? "✓ " : "   "}${label}`, onClick: () => (vp?.setDisplayMode(m), setMode(m)) })));
          }}
        >
          <Box /> {MODE_LABEL[mode]}
        </button>
        <button className={`icon-btn sm ${showPlanes ? "active" : ""}`} title="Planes" onClick={() => useApp.setState({ showPlanes: !showPlanes })}>
          <Layers />
        </button>
        <button className={`icon-btn sm ${showSketches ? "active" : ""}`} title="Sketches" onClick={() => useApp.setState({ showSketches: !showSketches })}>
          <Grid2x2 />
        </button>
        <button className={`icon-btn sm ${showValues ? "active" : ""}`} title={`${showValues ? "Hide" : "Show"} dimensions on the model`} onClick={() => setPrefs({ showValues: !showValues })}>
          <Ruler />
        </button>
      </div>
    </div>
  );
}

const MODE_LABEL: Record<DisplayMode, string> = { shaded_edges: "Shaded", shaded: "Shaded (no edges)", hidden_line: "Hidden line", xray: "X-ray", wireframe: "Wireframe" };

function hiddenOverride(_id: string): boolean {
  return false;
}

function MeasureCard() {
  const m = useApp((s) => s.measure);
  return (
    <div className="measure-card">
      <div className="dialog-head">
        <Ruler className="ficon" />
        <h3>Measure</h3>
        <button className="icon-btn sm" onClick={() => useApp.setState({ measure: { active: false, picks: [], result: null } })}>
          ×
        </button>
      </div>
      <div className="dialog-body">
        {m.result ? (
          <table>
            <tbody>
              {m.result.rows.map(([k, v]) => (
                <tr key={k}>
                  <td className="muted">{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <span className="muted">{m.picks.length ? "Measuring…" : "Click a face or an edge. Shift-click to add a second one."}</span>
        )}
      </div>
    </div>
  );
}

function AiActivity() {
  const activity = useApp((s) => s.aiActivity);
  const previewing = useApp((s) => !!s.proposalDoc);
  if (!activity && !previewing) return null;
  return (
    <div className="ai-activity">
      <span className="pulse" />
      {activity ? (
        <span>
          <b>{activity.client}</b> · {activity.tool.replace(/_/g, " ")}
        </span>
      ) : null}
      {previewing ? (
        <>
          <span className="muted">Preview — not applied</span>
          <button
            className="btn"
            style={{ height: 22, padding: "0 8px" }}
            onClick={() => {
              useApp.setState({ proposalDoc: null });
              scheduleRebuild();
            }}
          >
            Dismiss
          </button>
        </>
      ) : null}
    </div>
  );
}
