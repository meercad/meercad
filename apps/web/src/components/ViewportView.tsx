import { Box, Copy, Eye, EyeOff, Focus, Grid2x2, Layers, Pencil, Ruler, Scan, Trash } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FeatureOp } from "@opencad/schema";
import { samePick, Viewport, type Pick, type PickKind, type PlaneView, type SceneData, type SketchView } from "@opencad/viewport";
import { FEATURES } from "../lib/features";
import { planeSpecForPick, PLANE_LABELS } from "../lib/topology";
import { SketchEditor } from "../sketch/SketchEditor";
import { dialogPick, editFeature, kernel, setViewport, startFeature, startSketch, toast, useApp } from "../store";
import { pickKindsFor } from "./FeatureDialog";
import { toggleHidden } from "./FeatureTree";
import { showMenu } from "./Menu";
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
  const sketchId = useApp((s) => s.sketchId);
  const dialog = useApp((s) => s.dialog);
  const selection = useApp((s) => s.selection);
  const measure = useApp((s) => s.measure);
  const pickingPlane = useApp((s) => s.pickingSketchPlane);
  const doc = useApp((s) => s.doc);
  const kernelState = useApp((s) => s.kernel);
  const previewing = useApp((s) => s.previewing);
  const [ortho, setOrtho] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const v = new Viewport(host.current!);
    setVp(v);
    setViewport(v);
    return () => {
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
    let down: { x: number; y: number; button: number } | null = null;
    const onMove = (e: PointerEvent) => {
      if (useApp.getState().sketchId || e.buttons) return;
      vp.setHover(vp.pick(e.clientX, e.clientY, kinds()));
    };
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY, button: e.button });
    const onUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || useApp.getState().sketchId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      const pick = vp.pick(e.clientX, e.clientY, kinds());
      if (d.button === 2) return contextMenu(pick, e.clientX, e.clientY);
      if (d.button === 0) onClick(pick, e.shiftKey || e.metaKey || e.ctrlKey);
    };
    const onDbl = (e: MouseEvent) => {
      if (useApp.getState().sketchId || useApp.getState().dialog) return;
      const pick = vp.pick(e.clientX, e.clientY, DEFAULT_KINDS);
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
      { label: "Measure", icon: <Ruler />, kbd: "M", onClick: () => useApp.setState({ measure: { active: true, picks: pick && (pick.kind === "face" || pick.kind === "edge") ? [pick] : [], result: null } }) },
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
      {vp && sketchId ? <SketchEditor viewport={vp} sketchId={sketchId} /> : null}
      {hint ? <div className="hint-banner">{hint}</div> : null}
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
        <button className={`icon-btn sm ${showPlanes ? "active" : ""}`} title="Planes" onClick={() => useApp.setState({ showPlanes: !showPlanes })}>
          <Layers />
        </button>
        <button className={`icon-btn sm ${showSketches ? "active" : ""}`} title="Sketches" onClick={() => useApp.setState({ showSketches: !showSketches })}>
          <Grid2x2 />
        </button>
      </div>
    </div>
  );
}

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
