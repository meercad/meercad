/**
 * A size as a slider with its typed value next to it (touch: drag the slider, no keyboard needed),
 * as the lithophane dialog uses it.
 */
import type { Expr } from "@meercad/schema";
import { evaluate } from "@meercad/model";
import { setDraftTextures, useApp } from "../store";
import { ExprInput } from "./ExprInput";
import "./slider-value.css";

/** A value as a number, or `fallback` when it is an expression that does not work out. */
function useNumber(e: Expr | undefined, fallback: number): number {
  const params = useApp((s) => s.output?.report.params);
  if (e === undefined) return fallback;
  if (typeof e === "number") return e;

  try {
    return evaluate(e, new Map(Object.entries(params ?? {})));
  } catch {
    return fallback;
  }
}

/**
 * A slider for touch and mouse plus the typed value; while the slider moves, pictures on parts preview
 * coarse.
 */
export function SliderValue({
  value,
  fallback,
  min,
  max,
  step,
  unit,
  onChange,
  placeholder,
}: {
  value: Expr | undefined;
  fallback: number;
  min: number;
  max: number;
  step: number;
  unit: "mm" | "deg" | "";
  onChange: (v: Expr | undefined) => void;
  placeholder?: string;
}) {
  const n = useNumber(value, fallback);
  const end = () => setDraftTextures(false);

  return (
    <div className="slider-value">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, n))}
        onPointerDown={() => setDraftTextures(true)}
        onPointerUp={end}
        onPointerCancel={end}
        onBlur={end}
        onChange={(e) => onChange(Number(Number(e.target.value).toFixed(3)))}
      />
      <div className="slider-value-text">
        <ExprInput
          value={value}
          unit={unit}
          placeholder={placeholder}
          onCommit={onChange}
          onLive={onChange}
        />
      </div>
    </div>
  );
}
