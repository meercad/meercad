/**
 * The card of the strength check and the topology suggestion (a beta function): which faces hold
 * the part and which are pushed, the force, how the part is printed; then the safety factor with
 * the part coloured, and the lighter suggestion.
 */
import { partMaterial, STRENGTH_SCALE, strengthOf } from "@meercad/model";
import { Anchor, ArrowDownToLine, FlaskConical, X } from "lucide-react";
import { partName } from "../lib/features";
import { t } from "../lib/i18n";
import { materialName } from "../lib/materials";
import {
  checkNow,
  closeStrength,
  setStrength,
  suggestNow,
  takeSelection,
  useStrength,
  type StrengthSummary,
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
  const selected = useApp(
    (app) => app.selection.filter((pick) => pick.kind === "face" && pick.bodyId === state.body).length,
  );
  if (!state.body) return null;

  const material = partMaterial(doc, state.body);
  const known = material && strengthOf(material);
  const busy = state.running !== null;
  const ready = state.holds.length > 0 && state.loads.length > 0 && state.newton > 0 && !busy;

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
        <span>{t("Faces held: {count}", { count: state.holds.length })}</span>
        <span className="spacer" />
        <button className="btn sm" disabled={!selected || busy} onClick={() => takeSelection("holds")}>
          {t("Use selected faces")}
        </button>
      </div>
      <div className="row strength-row">
        <ArrowDownToLine className="ficon" />
        <span>{t("Faces pushed: {count}", { count: state.loads.length })}</span>
        <span className="spacer" />
        <button className="btn sm" disabled={!selected || busy} onClick={() => takeSelection("loads")}>
          {t("Use selected faces")}
        </button>
      </div>
      {!selected && !(state.holds.length && state.loads.length) ? (
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
          disabled={busy}
          onChange={(event) =>
            Number(event.target.value) >= 0 && setStrength({ newton: Number(event.target.value) })
          }
        />
        <span className="muted">N</span>
        <select
          className="field"
          aria-label={t("Direction of the force")}
          value={state.direction}
          disabled={busy}
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
          disabled={busy}
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
        <button className="btn primary" disabled={!ready} onClick={() => void checkNow()}>
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
          min="15"
          max="90"
          step="5"
          aria-label={t("Share of material to keep, per cent")}
          value={Math.round(state.share * 100)}
          disabled={busy}
          onChange={(event) => {
            const percent = Number(event.target.value);

            if (percent >= 15 && percent <= 90) setStrength({ share: percent / 100 });
          }}
        />
        <span className="muted">%</span>
        <span className="spacer" />
        <button className="btn" disabled={!ready} onClick={() => void suggestNow()}>
          {t("Suggest lighter part")}
        </button>
      </label>
      {state.suggestion ? (
        <>
          <p className="small">
            {t("Suggestion {part}: {share} % of the material.", {
              part: partName(state.suggestion.part, doc.features),
              share: Math.round(state.suggestion.share * 100),
            })}
          </p>
          <Result title={t("Before")} summary={state.suggestion.before} />
          <Result title={t("Suggestion")} summary={state.suggestion.after} />
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
