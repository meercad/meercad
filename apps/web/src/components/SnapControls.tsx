/**
 * Snapping switches in the view bar: the magnet (snap to points, lines and model edges while
 * sketching) and the grid (shown and snapped to, or neither), labelled with its current spacing.
 */
import { Grid3x3, Magnet } from "lucide-react";
import { useEffect, useReducer } from "react";
import type { Viewport } from "@meercad/viewport";
import { formatStep } from "../lib/grid";
import { t } from "../lib/i18n";
import { setPrefs, usePrefs } from "../lib/keymap";
import { useApp, useDocUnit } from "../store";

export function SnapControls({ viewport }: { viewport: Viewport | null }) {
  const { snapGrid, snapGeometry } = usePrefs();
  const unit = useDocUnit();
  const sketchId = useApp((s) => s.sketchId);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => viewport?.onChange(tick), [viewport]);

  // The step the grid offers right now (it follows the zoom), in the sketch plane while sketching.
  const spacing = viewport && snapGrid ? viewport.gridSpacing : null;

  return (
    <div className="snap-controls">
      {sketchId ? (
        <button
          className={`icon-btn sm ${snapGeometry ? "active" : ""}`}
          aria-pressed={snapGeometry}
          title={
            snapGeometry
              ? t("Magnet on: snap to points, lines, circle centres and model edges")
              : t("Magnet off: snap to points, lines, circle centres and model edges")
          }
          onClick={() => setPrefs({ snapGeometry: !snapGeometry })}
        >
          <Magnet />
        </button>
      ) : null}
      <button
        className={`icon-btn sm grid-snap ${snapGrid ? "active" : ""}`}
        aria-pressed={snapGrid}
        title={
          snapGrid
            ? t("Grid on: shown and snapped to; its spacing follows the zoom (Alt places freely)")
            : t("Grid off: shown and snapped to; its spacing follows the zoom (Alt places freely)")
        }
        onClick={() => setPrefs({ snapGrid: !snapGrid })}
      >
        <Grid3x3 />
        {spacing ? <span>{formatStep(spacing, unit)}</span> : null}
      </button>
    </div>
  );
}
