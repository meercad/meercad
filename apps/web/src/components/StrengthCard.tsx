/**
 * The card of the strength check and the topology (a beta function): which faces hold the part and
 * which are pushed, the force, how the part is printed; then the safety factor with the part
 * coloured, and the topology made from the part, which is kept up to date and shown with the part
 * as its shadow, or either of them alone.
 */
import { partMaterial, STRENGTH_SCALE, strengthOf } from "@meercad/model";
import { Anchor, ArrowDownToLine, FlaskConical, X } from "lucide-react";
import { partName } from "../lib/features";
import { t } from "../lib/i18n";
import { materialName } from "../lib/materials";
import { nativeApp } from "../lib/native";
import {
  checkNow,
  closeStrength,
  faceCounts,
  hasTopology,
  makeTopology,
  outOfDate,
  setStrength,
  setTopologyView,
  takeSelection,
  useStrength,
  type Detail,
  type StrengthSummary,
  type TopologyView,
} from "../lib/strength";
import { LOAD_DIRECTIONS, type LoadDirection } from "../lib/strengthFaces";
import { useApp } from "../store";

const directionLabel = (direction: LoadDirection) =>
  direction === "into" ? t("into the faces") : direction.replace("-", "−").toUpperCase();

const factor = (safety: number) => (Number.isFinite(safety) ? safety.toFixed(safety < 10 ? 1 : 0) : "∞");

function Result({ title, summary }: { title: string; summary: StrengthSummary }) {
  if (!summary.converged) {
    return (
      <p className="callout warn small">
        {t("The part is not held well enough to stand still: hold more faces.")}
      </p>
    );
  }

  return (
    <p className="small">
      <b className={summary.safety < 1 ? "strength-bad" : summary.safety < 2 ? "strength-low" : ""}>
        {title}: {t("safety factor {factor}", { factor: factor(summary.safety) })}
      </b>{" "}
      · {t("gives by {mm} mm at most", { mm: summary.deflection.toFixed(summary.deflection < 1 ? 2 : 1) })}
    </p>
  );
}

export function StrengthCard() {
  const state = useStrength();
  const doc = useApp((app) => app.doc);
  // Read again with every new result of the model: the faces are found by name on the part as it is.
  useApp((app) => app.output);

  const selection = useApp((app) => app.selection);
  const selected = selection.filter((pick) => pick.kind === "face" && pick.bodyId === state.body).length;
  if (!state.body || !state.open) return null;

  const material = partMaterial(doc, state.body);
  const known = material && strengthOf(material);
  const busy = state.running !== null;
  const faces = faceCounts();
  const linked = hasTopology();
  const ready = faces.holds > 0 && faces.loads > 0 && state.newton > 0;
  const views: [TopologyView, string][] = [
    ["both", t("Both")],
    ["original", t("Original")],
    ["topology", t("Topology")],
  ];

  return (
    <div className="deviation-card strength-card" role="group" aria-label={t("Strength")}>
      <div className="row">
        <FlaskConical className="ficon" />
        <b>{t("Strength of {part} (beta)", { part: partName(state.body, doc.features) })}</b>
        <span className="spacer" />
        <button className="icon-btn sm" title={t("Close")} onClick={closeStrength}>
          <X />
        </button>
      </div>
      <p className="muted small">
        {known
          ? t("Material: {material}, solid (100 % infill).", { material: materialName(material) })
          : t("No material with known strength on this part: calculated as PLA, solid (100 % infill).")}
      </p>
      <div className="row strength-row">
        <Anchor className="ficon" />
        <span>{t("Faces held: {count}", { count: faces.holds })}</span>
        <span className="spacer" />
        <button className="btn sm" disabled={!selected} onClick={() => takeSelection("holds")}>
          {t("Use selected faces")}
        </button>
      </div>
      <div className="row strength-row">
        <ArrowDownToLine className="ficon" />
        <span>{t("Faces pushed: {count}", { count: faces.loads })}</span>
        <span className="spacer" />
        <button className="btn sm" disabled={!selected} onClick={() => takeSelection("loads")}>
          {t("Use selected faces")}
        </button>
      </div>
      {!selected && !ready ? (
        <p className="muted small">
          {t("Select faces of the part in the model (Shift for several), then take them here.")}
        </p>
      ) : null}
      <label className="row strength-row">
        <span className="muted">{t("Force")}</span>
        <input
          className="field"
          type="number"
          min="0"
          step="10"
          aria-label={t("Force in newtons")}
          value={state.newton}
          onChange={(event) =>
            Number(event.target.value) >= 0 && setStrength({ newton: Number(event.target.value) })
          }
        />
        <span className="muted">N</span>
        <select
          className="field"
          aria-label={t("Direction of the force")}
          value={state.direction}
          onChange={(event) => setStrength({ direction: event.target.value as LoadDirection })}
        >
          {LOAD_DIRECTIONS.map((direction) => (
            <option key={direction} value={direction}>
              {directionLabel(direction)}
            </option>
          ))}
        </select>
      </label>
      <label className="row strength-row">
        <span className="muted">{t("Layers stacked along")}</span>
        <select
          className="field"
          aria-label={t("Layers stacked along")}
          value={state.up}
          onChange={(event) => setStrength({ up: Number(event.target.value) as 0 | 1 | 2 })}
        >
          {["X", "Y", "Z"].map((axis, index) => (
            <option key={axis} value={index}>
              {axis}
            </option>
          ))}
        </select>
      </label>
      <div className="row strength-row">
        <span className="spacer" />
        <button className="btn" disabled={!ready || busy} onClick={() => void checkNow()}>
          {t("Check strength")}
        </button>
      </div>
      {state.error ? (
        <p className="callout warn small">
          {state.error === "hold"
            ? t("No material found at the faces the part is held at.")
            : state.error === "load"
              ? t("No material found at the faces the part is pushed at.")
              : state.error === "gone"
                ? t("The part is not in the model any more.")
                : t("The calculation failed.")}
        </p>
      ) : null}
      {state.report ? (
        <>
          <div
            className="deviation-scale"
            style={{ background: `linear-gradient(90deg, ${STRENGTH_SCALE.join(",")})` }}
          />
          <div className="deviation-ticks">
            <span>0 %</span>
            <span>{t("share of the strength used")}</span>
            <span>100 %</span>
          </div>
          <Result title={t("This part")} summary={state.report} />
        </>
      ) : null}
      <hr />
      <label className="row strength-row">
        <span className="muted">{t("Keep material")}</span>
        <input
          className="field"
          type="number"
          min="5"
          max="90"
          step="5"
          aria-label={t("Share of material to keep, per cent")}
          value={Math.round(state.share * 100)}
          onChange={(event) => {
            const percent = Number(event.target.value);

            if (percent >= 5 && percent <= 90) setStrength({ share: percent / 100 });
          }}
        />
        <span className="muted">%</span>
        {/* The fine level needs several cores, which iPhone and iPad do not give the app. */}
        {nativeApp ? null : (
          <select
            className="field"
            aria-label={t("Detail of the topology")}
            value={state.detail}
            onChange={(event) => setStrength({ detail: event.target.value as Detail })}
          >
            <option value="fast">{t("Quick, 2 min")}</option>
            <option value="fine">{t("Fine, 5 min")}</option>
          </select>
        )}
      </label>
      <div className="row strength-row">
        <label className="check">
          <input
            type="checkbox"
            checked={state.auto}
            onChange={(event) => setStrength({ auto: event.target.checked })}
          />
          {t("Keep up to date")}
        </label>
        <span className="spacer" />
        <button
          className="btn primary"
          disabled={!ready || state.running === "topology"}
          onClick={() => void makeTopology()}
        >
          {linked ? t("Update topology") : t("Make topology")}
        </button>
      </div>
      {linked ? (
        <>
          <div className="seg" role="group" aria-label={t("Show")}>
            {views.map(([view, label]) => (
              <button
                key={view}
                className={state.view === view ? "on" : ""}
                aria-pressed={state.view === view}
                onClick={() => setTopologyView(view)}
              >
                {label}
              </button>
            ))}
          </div>
          {state.running === "topology" ? (
            <p className="muted small">{t("The topology is being made again…")}</p>
          ) : outOfDate() ? (
            <p className="callout warn small">
              {t("The part or the set-up has changed since the topology was made.")}
            </p>
          ) : null}
        </>
      ) : null}
      {state.result ? (
        <>
          <p className="small">
            {t("Topology: {share} % of the material.", { share: Math.round(state.result.share * 100) })}
          </p>
          <Result title={t("Original")} summary={state.result.before} />
          <Result title={t("Topology")} summary={state.result.after} />
        </>
      ) : null}
      <p className="muted small">
        {t(
          "An estimate on a coarse grid, not a verification: check a part that carries load yourself before relying on it.",
        )}
      </p>
    </div>
  );
}
