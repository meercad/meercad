/**
 * The cards and overlays the 3D view shows over the model: measuring, the AI at work, the first build,
 * cleaning up a mesh, and the legends of the wall thickness, printability and deviation maps.
 */
import { formatMass, massOf, partMaterial } from "@meercad/model";
import type { Pick } from "@meercad/viewport";
import { Eraser, Layers, Printer, Ruler, ScanSearch, X } from "lucide-react";
import { DEVIATION_GRADIENT, hideDeviation, useDeviation } from "../../lib/deviation";
import { featureName, partName } from "../../lib/features";
import { t, tn } from "../../lib/i18n";
import { touchOnly } from "../../lib/keyboard";
import { materialName } from "../../lib/materials";
import { closeMeshRepair, importOf, runMeshRepair, useMeshRepair } from "../../lib/meshRepair";
import {
  hidePrintCheck,
  pickFaceToLay,
  PRINT_COLORS,
  printBestWayUp,
  setOverhangLimit,
  usePrintCheck,
} from "../../lib/printability";
import { setScanTolerance, useScanMeasure } from "../../lib/scanMeasure";
import { hasTerrain } from "../../lib/terrain";
import { hideThickness, setMinWall, THICKNESS_GRADIENT, useThickness } from "../../lib/thickness";
import { convertMmText } from "../../lib/units";
import { scheduleRebuild, useApp } from "../../store";
import { AiOrb, toolLabel } from "../AiOrb";

export function MeasureCard() {
  const m = useApp((state) => state.measure);
  const scan = useScanMeasure();

  return (
    <div className="measure-card">
      <div className="dialog-head">
        <Ruler className="ficon" />
        <h3>{t("Measure")}</h3>
        <button
          className="icon-btn sm"
          onClick={() => useApp.setState({ measure: { active: false, picks: [], result: null } })}
        >
          ×
        </button>
      </div>
      <div className="dialog-body">
        {m.result ? (
          <table>
            <tbody>
              {m.result.rows.map(([k, v]) => (
                <tr key={k}>
                  <td className="muted">{t(k)}</td>
                  <td>{convertMmText(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <span className="muted">
            {m.picks.length
              ? t("Measuring…")
              : touchOnly()
                ? t("Tap a face or an edge; a second tap adds another.")
                : t("Click a face or an edge. Shift-click to add a second one.")}
          </span>
        )}
        <PartMass picks={m.picks} />
        {scan.shapes.length ? (
          <label className="row" style={{ gap: 6, marginTop: 6 }}>
            <span className="muted">{t("Fit tolerance")}</span>
            <input
              className="field"
              type="number"
              step="0.05"
              min="0.01"
              style={{ width: 72 }}
              defaultValue={scan.tol}
              onChange={(event) => {
                const v = Number(event.target.value);
                if (Number.isFinite(v) && v > 0) setScanTolerance(v);
              }}
            />
            <span className="muted">mm</span>
          </label>
        ) : !m.result ? (
          <p className="muted small">
            {t(
              "On a scan or other mesh, a click fits the plane, cylinder, cone or sphere there; a second click measures between the two.",
            )}
          </p>
        ) : null}
        {hasTerrain() && !m.result ? (
          <p className="muted small">
            {touchOnly()
              ? t(
                  "On a terrain, a tap shows where the point is (with GPS when the photos had it); a second tap gives the distance, the height difference, the slope and the direction from north.",
                )
              : t(
                  "On a terrain, a click shows where the point is (with GPS when the photos had it); a second click gives the distance, the height difference, the slope and the direction from north.",
                )}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The measured part's volume and, with a material, its mass. */
function PartMass({ picks }: { picks: readonly Pick[] }) {
  const doc = useApp((state) => state.doc);
  const bodies = useApp((state) => state.output?.report.bodies);
  const id = picks.find((pick): pick is Extract<Pick, { bodyId: string }> => "bodyId" in pick)?.bodyId;
  const body = id ? bodies?.find((b) => b.id === id) : undefined;
  if (!body || !Number.isFinite(body.volume)) return null;

  const material = partMaterial(doc, body.id);

  return (
    <p className="small" style={{ margin: "8px 0 0" }}>
      <b>{partName(body.id, doc.features)}</b> · {t("{v} cm³", { v: (body.volume / 1000).toFixed(2) })}
      {material ? (
        ` · ${formatMass(massOf(body.volume, material))} ${materialName(material)}`
      ) : (
        <span className="muted"> · {t("no material, so no mass")}</span>
      )}
    </p>
  );
}

export function AiActivity() {
  const activity = useApp((state) => (state.aiLock ? null : state.aiActivity));
  const previewing = useApp((state) => !!state.proposalDoc);
  if (!activity && !previewing) return null;

  return (
    <div className="ai-activity">
      <AiOrb busy={!!activity} small />
      {activity ? (
        <span>
          <b>{activity.client}</b> · {toolLabel(activity.tool)}
        </span>
      ) : null}
      {previewing ? (
        <>
          <span className="muted">{t("Preview — not applied")}</span>
          <button
            className="btn"
            style={{ height: 22, padding: "0 8px" }}
            onClick={() => {
              useApp.setState({ proposalDoc: null });
              scheduleRebuild();
            }}
          >
            {t("Dismiss")}
          </button>
        </>
      ) : null}
    </div>
  );
}

/** Centered while the geometry engine starts or a project's model is computed for the first time. */
export function LoadingOverlay() {
  const kernelState = useApp((state) => state.kernel);
  const hasOutput = useApp((state) => !!state.output);
  const features = useApp((state) => state.doc.features.length);
  const progress = useApp((state) => state.buildProgress);
  const doc = useApp((state) => state.doc);
  const text = kernelState.error
    ? null
    : !kernelState.ready && !hasOutput
      ? t("Starting the geometry engine…")
      : !hasOutput && features
        ? tn(features, "Building the model · {n} feature", "Building the model · {n} features")
        : null;
  if (!text) return null;

  // Which step the first build is at, once the kernel reports it.
  const step =
    kernelState.ready && progress
      ? doc.features.find((feature) => feature.id === progress.feature)
      : undefined;

  return (
    <div className="loading-overlay" role="status" aria-live="polite">
      <div className="loading-card">
        <span className="spinner" aria-hidden />
        <span className="loading-text">
          {text}
          {progress && kernelState.ready ? (
            <>
              <span className="loading-step">
                {t("{feature} ({n} of {total})", {
                  feature: step ? featureName(step) : progress.feature,
                  n: progress.index + 1,
                  total: progress.total,
                })}
              </span>
              <span className="task-bar loading-bar">
                <span
                  className="task-fill"
                  style={{ width: `${Math.max(2, (progress.index / Math.max(1, progress.total)) * 100)}%` }}
                />
              </span>
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** Triangles in a binary STL import's file (from its header), 0 when unknown. */
function fileTriangles(body: string): number {
  const feature = importOf(body);
  if (!feature) return 0;

  const head = Uint8Array.from(atob(feature.data.slice(0, 112)), (c) => c.charCodeAt(0));

  return head.length >= 84 ? new DataView(head.buffer).getUint32(80, true) : 0;
}

/** Options for cleaning up a mesh part, and its triangle count now. */
export function MeshRepairCard() {
  const r = useMeshRepair();
  const features = useApp((state) => state.doc.features);
  const shown = useApp((state) =>
    r.body ? state.output?.meshes.find((mesh) => mesh.bodyId === r.body) : undefined,
  );
  // A mesh that failed to import (open) has no part: count the file's triangles instead.
  const triangles = shown ? shown.indices.length / 3 : r.body ? fileTriangles(r.body) : 0;
  if (!r.body) return null;

  const check = (key: "removePieces" | "fillHoles" | "reduce", label: string) => (
    <label className="row small" style={{ gap: 6 }}>
      <input
        type="checkbox"
        checked={r[key]}
        onChange={(event) => useMeshRepair.setState({ [key]: event.target.checked })}
      />
      <span>{label}</span>
    </label>
  );

  return (
    <div className="deviation-card" role="dialog">
      <div className="row">
        <Eraser className="ficon" />
        <b>{t("Clean up {part}", { part: partName(r.body, features) })}</b>
        <span className="spacer" />
        <button className="icon-btn sm" title={t("Close")} onClick={closeMeshRepair}>
          <X />
        </button>
      </div>
      {triangles ? (
        <p className="muted small">{tn(triangles, "one::{n} triangle", "{n} triangles")}</p>
      ) : null}
      {check("removePieces", t("Remove loose pieces (scan debris)"))}
      {check("fillHoles", t("Close holes"))}
      {check("reduce", t("Fewer triangles"))}
      {r.reduce ? (
        <label className="row small" style={{ gap: 6, paddingLeft: 22 }}>
          <span className="muted">{t("Surface moves at most")}</span>
          <input
            className="field"
            type="number"
            step="0.01"
            min="0.001"
            style={{ width: 64 }}
            defaultValue={r.tolerance}
            onChange={(event) => {
              const v = Number(event.target.value);
              if (Number.isFinite(v) && v > 0) useMeshRepair.setState({ tolerance: v });
            }}
          />
          <span className="muted">mm</span>
        </label>
      ) : null}
      <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
        <button className="btn" onClick={closeMeshRepair}>
          {t("Cancel")}
        </button>
        <button
          className="btn primary"
          disabled={!r.removePieces && !r.fillHoles && !r.reduce}
          onClick={() => void runMeshRepair()}
        >
          {t("Clean up")}
        </button>
      </div>
    </div>
  );
}

/** Scale, thinnest spot and the minimum wall of the thickness map. */
export function ThicknessLegend() {
  const { body, stats, error, minWall } = useThickness();
  const features = useApp((state) => state.doc.features);
  if (!body) return null;

  return (
    <div className="deviation-card" role="status">
      <div className="row">
        <Layers className="ficon" />
        <b>{t("Wall thickness of {part}", { part: partName(body, features) })}</b>
        <span className="spacer" />
        <button className="icon-btn sm" title={t("Close")} onClick={hideThickness}>
          <X />
        </button>
      </div>
      {error ? (
        <p className="muted small">{t("The part is not in the model any more.")}</p>
      ) : (
        <>
          <div className="deviation-scale" style={{ background: THICKNESS_GRADIENT }} />
          <div className="deviation-ticks">
            <span>{convertMmText(`${minWall} mm`)}</span>
            <span>{convertMmText(`${minWall * 2} mm`)}</span>
            <span>{convertMmText(`${minWall * 3} mm`)}</span>
          </div>
          <label className="row small" style={{ gap: 6 }}>
            <span className="muted">{t("Thinnest wall allowed")}</span>
            <input
              className="field"
              type="number"
              step="0.1"
              min="0.1"
              style={{ width: 64 }}
              defaultValue={minWall}
              onChange={(event) => {
                const v = Number(event.target.value);
                if (Number.isFinite(v) && v > 0) setMinWall(v);
              }}
            />
            <span className="muted">mm</span>
          </label>
          {stats ? (
            <p className="small">
              {Number.isFinite(stats.min)
                ? t("Thinnest: {min} · {share} % of the surface below {wall}", {
                    min: convertMmText(`${stats.min.toFixed(2)} mm`),
                    share: Math.round(stats.thin * 100),
                    wall: convertMmText(`${stats.minWall} mm`),
                  })
                : t("No wall could be measured: the mesh is open.")}
            </p>
          ) : (
            <p className="muted small">{t("Measuring the wall thickness")}</p>
          )}
          <p className="muted small">
            {t(
              "Red: thinner than allowed · green: three times as thick or more · grey: not measured (open mesh).",
            )}
          </p>
        </>
      )}
    </div>
  );
}

/** Colours, overhang limit, support estimate and the best way up of the printability map. */
export function PrintCheckCard() {
  const { body, stats, error, limit, picking } = usePrintCheck();
  const features = useApp((state) => state.doc.features);
  if (!body) return null;

  const cm2 = (mm2: number) => `${(mm2 / 100).toFixed(mm2 < 1000 ? 1 : 0)} cm²`;
  const cm3 = (mm3: number) => `${(mm3 / 1000).toFixed(mm3 < 10_000 ? 1 : 0)} cm³`;
  const swatch = (color: string, label: string) => (
    <span className="row small" style={{ gap: 4 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: "inline-block" }} />
      {label}
    </span>
  );

  return (
    <div className="deviation-card" role="status">
      <div className="row">
        <Printer className="ficon" />
        <b>{t("Printability of {part}", { part: partName(body, features) })}</b>
        <span className="spacer" />
        <button className="icon-btn sm" title={t("Close")} onClick={hidePrintCheck}>
          <X />
        </button>
      </div>
      {error ? (
        <p className="muted small">{t("The part is not in the model any more.")}</p>
      ) : (
        <>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            {swatch(PRINT_COLORS.overhang, t("Needs support"))}
            {swatch(PRINT_COLORS.ok, t("Prints without"))}
            {swatch(PRINT_COLORS.plate, t("On the plate"))}
          </div>
          <label className="row small" style={{ gap: 6 }}>
            <span className="muted">{t("Steepest overhang without support")}</span>
            <input
              className="field"
              type="number"
              step="5"
              min="0"
              max="89"
              style={{ width: 56 }}
              defaultValue={limit}
              onChange={(event) => {
                const v = Number(event.target.value);
                if (Number.isFinite(v) && v >= 0 && v < 90) setOverhangLimit(v);
              }}
            />
            <span className="muted">°</span>
          </label>
          {stats ? (
            <>
              <p className="small">
                {stats.overhangArea > 0.5
                  ? t("Overhang: {area} ({share} % of the surface) · support about {volume}", {
                      area: convertMmText(cm2(stats.overhangArea)),
                      share: Math.max(1, Math.round(stats.overhangShare * 100)),
                      volume: convertMmText(cm3(stats.supportVolume)),
                    })
                  : t("No overhangs: prints without support as it stands.")}
              </p>
              {stats.best ? (
                <p className="small">
                  {stats.best.supportVolume < 1
                    ? t("Turned another way up it prints without support.")
                    : t("Turned another way up: support about {volume}.", {
                        volume: convertMmText(cm3(stats.best.supportVolume)),
                      })}
                </p>
              ) : null}
              <div className="row" style={{ gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button className={`btn ${picking ? "primary" : ""}`} onClick={() => pickFaceToLay(!picking)}>
                  {t("Lay on a face…")}
                </button>
                {stats.best ? (
                  <button className="btn primary" onClick={() => printBestWayUp(body)}>
                    {t("Turn the best way up")}
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="muted small">{t("Checking printability")}</p>
          )}
        </>
      )}
    </div>
  );
}

/** Scale and numbers of the deviation map. */
export function DeviationLegend() {
  const { body, mesh, stats, error } = useDeviation();
  const features = useApp((state) => state.doc.features);
  if (!body || !mesh) return null;

  const mm = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)} mm`;

  return (
    <div className="deviation-card" role="status">
      <div className="row">
        <ScanSearch className="ficon" />
        <b>{t("Deviation from {mesh}", { mesh: partName(mesh, features) })}</b>
        <span className="spacer" />
        <button className="icon-btn sm" title={t("Close")} onClick={hideDeviation}>
          <X />
        </button>
      </div>
      {error || !stats ? (
        <p className="muted small">{t("The part or the mesh is not in the model any more.")}</p>
      ) : (
        <>
          <div className="deviation-scale" style={{ background: DEVIATION_GRADIENT }} />
          <div className="deviation-ticks">
            <span>{mm(-stats.range)}</span>
            <span>0</span>
            <span>{mm(stats.range)}</span>
          </div>
          <p className="muted small">{t("Blue: smaller than the mesh · red: bigger.")}</p>
          <p className="small">
            {t("{share} % within ±{tol} mm · from {min} to {max}", {
              share: Math.round(stats.within * 100),
              tol: stats.tolerance,
              min: mm(stats.min),
              max: mm(stats.max),
            })}
          </p>
          <p className="muted small">{t("Part {part}", { part: partName(body, features) })}</p>
        </>
      )}
    </div>
  );
}
