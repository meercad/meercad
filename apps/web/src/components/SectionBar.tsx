/**
 * The section view's bar: the plane square to X, Y or Z or laid on a face, the other side kept, and
 * where it cuts (a slider here, or the arrow on the plane in the view). Big targets, no keys needed,
 * so it works the same with a mouse and with a finger. Only the view: the model is not changed.
 */
import { evaluate } from "@meercad/model";
import { offsetForShown, offsetRange, shownValue, type Viewport } from "@meercad/viewport";
import { ArrowLeftRight, MousePointerClick, X } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../lib/i18n";
import { touchOnly } from "../lib/keyboard";
import { fmtLen } from "../lib/units";
import {
  closeSection,
  flipViewSection,
  moveViewSection,
  pickSectionFace,
  sectionOnAxis,
  useViewSection,
} from "../lib/viewSection";
import { useApp } from "../store";
import { InlineInput } from "./InlineValues";
import "./section-bar.css";

/** Keeps the viewport's section in step with the bar, and the bar with the arrow dragged in the view. */
export function useSectionSync(viewport: Viewport | null): void {
  const section = useViewSection((s) => s.section);

  useEffect(() => {
    if (!viewport) return;

    viewport.onSectionChange = (next) => useViewSection.setState({ section: next });

    return () => {
      viewport.onSectionChange = null;
      viewport.setSection(null);
    };
  }, [viewport]);

  useEffect(() => {
    if (viewport && viewport.sectionView !== section) viewport.setSection(section);
  }, [viewport, section]);

  // Another project (or tab) opens with its parts whole.
  const project = useApp((state) => state.project?.id);
  useEffect(() => closeSection, [project]);
}

export function SectionBar({ viewport, lower }: { viewport: Viewport; lower?: boolean }) {
  const { section, axis, start, flipped, picking } = useViewSection();
  const [typing, setTyping] = useState(false);
  if (!section) return null;

  const shown = +shownValue(section, axis, start, flipped).toFixed(4);

  const typed = (expr: Parameters<typeof evaluate>[0] | null) => {
    setTyping(false);
    if (expr === null) return;

    try {
      const params = new Map(Object.entries(useApp.getState().output?.report.params ?? {}));
      moveViewSection(offsetForShown(evaluate(expr, params), section, axis, start, flipped));
    } catch {
      // Not a value: the plane stays where it is.
    }
  };

  const box = viewport.modelBox();
  const [lo, hi] = box ? offsetRange(box, section.normal) : [section.offset - 1, section.offset + 1];
  const step = Math.max((hi - lo) / 500, 1e-3);

  return (
    <div className={`section-bar ${lower ? "lower" : ""}`} role="toolbar" aria-label={t("Section view")}>
      {(["x", "y", "z"] as const).map((a) => (
        <button
          key={a}
          className={`icon-btn axis ${axis === a ? "active" : ""}`}
          title={t("Cut square to {axis}", { axis: a.toUpperCase() })}
          aria-pressed={axis === a}
          onClick={() => sectionOnAxis(viewport, a)}
        >
          {a.toUpperCase()}
        </button>
      ))}
      <button
        className={`icon-btn ${picking || axis === "face" ? "active" : ""}`}
        title={
          touchOnly()
            ? t("Tap a flat face to lay the plane on it")
            : t("Click a flat face to lay the plane on it")
        }
        aria-pressed={picking}
        onClick={() => pickSectionFace(!picking)}
      >
        <MousePointerClick />
        <span>{t("On a face")}</span>
      </button>
      <button className="icon-btn" title={t("Keep the other side")} onClick={flipViewSection}>
        <ArrowLeftRight />
        <span>{t("Flip")}</span>
      </button>
      <span className="bar-sep" aria-hidden />
      <input
        type="range"
        aria-label={t("Where the plane cuts")}
        min={lo}
        max={hi}
        step={step}
        value={Math.min(hi, Math.max(lo, section.offset))}
        onChange={(event) => moveViewSection(Number(event.currentTarget.value))}
      />
      <span className="section-value">
        {typing ? (
          <InlineInput value={shown} length onDone={typed} />
        ) : (
          <button title={t("Click to type a value")} onClick={() => setTyping(true)}>
            {axis === "face"
              ? t("{depth} deep", { depth: fmtLen(shown) })
              : `${axis.toUpperCase()} ${fmtLen(shown)}`}
          </button>
        )}
      </span>
      <span className="bar-sep" aria-hidden />
      <button className="icon-btn" title={t("End the section view")} onClick={closeSection}>
        <X />
      </button>
      {picking ? (
        <div className="section-hint" role="status">
          {touchOnly() ? t("Tap a flat face") : t("Click a flat face")}
        </div>
      ) : null}
    </div>
  );
}
