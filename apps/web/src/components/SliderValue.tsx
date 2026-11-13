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
function useNumber(expr: Expr | undefined, fallback: number): number {
  const params = useApp((state) => state.output?.report.params);
  if (expr === undefined) return fallback;
  if (typeof expr === "number") return expr;

  try {
    return evaluate(expr, new Map(Object.entries(params ?? {})));
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
  onChange: (expr: Expr | undefined) => void;
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
        onChange={(event) => onChange(Number(Number(event.target.value).toFixed(3)))}
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
