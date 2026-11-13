import { useEffect, useRef, useState } from "react";
import { evaluate } from "@meercad/model";
import type { Expr } from "@meercad/schema";
import { useApp, useDocUnit } from "../store";
import { inUnit, lengthExpr, lengthText } from "../lib/units";

const NUM = /^\s*-?\d+(\.\d+)?\s*$/;
const touchScreen = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
export const parseExpr = (s: string): Expr => (NUM.test(s) ? Number(s) : s.trim());

interface Props {
  value: Expr | undefined;
  onCommit: (expr: Expr) => void;
  /** Called on every arrow-key nudge and valid keystroke for live previews. */
  onLive?: (expr: Expr) => void;
  unit?: "mm" | "deg" | "";
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
  integer?: boolean;
  /** No evaluated value or unit beside the text (when it is shown elsewhere). */
  quiet?: boolean;
}

/**
 * Expression field: accepts numbers, units and parameter names; shows the evaluated value. Lengths
 * (`unit` "mm") are shown and typed in the design's unit.
 */
export function ExprInput({
  value,
  onCommit,
  onLive,
  unit = "mm",
  autoFocus,
  placeholder,
  className,
  integer,
  quiet,
}: Props) {
  const params = useApp((state) => state.output?.report.params);
  const du = useDocUnit();
  const length = unit === "mm";
  const shown = length ? lengthText(value, du) : value === undefined ? "" : String(value);
  const parse = (t: string): Expr => (length ? lengthExpr(t, du) : parseExpr(t));
  const [text, setText] = useState(shown);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setText(shown);
  }, [shown]);

  let computed: string | null = null;
  let error = false;

  if (text.trim()) {
    try {
      const v = evaluate(parse(text), new Map(Object.entries(params ?? {})));
      computed = NUM.test(text)
        ? null
        : `= ${length ? `${inUnit(v, du)} ${du}` : Math.round(v * 1000) / 1000}`;
    } catch {
      error = true;
    }
  }

  const commit = (t = text) => {
    if (!t.trim() || error) return setText(shown);
    if (t.trim() === shown) return;

    const expr = parse(t);
    if (expr !== value) onCommit(expr);
  };

  return (
    <div className="expr-wrap">
      <input
        ref={ref}
        className={`field expr ${error ? "invalid" : ""} ${quiet ? "quiet" : ""} ${className ?? ""}`}
        value={text}
        placeholder={placeholder}
        // On touch screens focusing pops up the keyboard (e.g. when a drag opens a dialog): tap to type.
        autoFocus={autoFocus && !touchScreen}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);

          if (onLive && event.target.value.trim()) {
            try {
              evaluate(parse(event.target.value), new Map(Object.entries(params ?? {})));
              onLive(parse(event.target.value));
            } catch {
              // incomplete expression while typing
            }
          }
        }}
        onBlur={() => commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            (event.target as HTMLInputElement).blur();
          }

          if (event.key === "Escape") {
            setText(shown);
            (event.target as HTMLInputElement).blur();
          }

          const match = /^\s*(-?\d+(?:\.\d+)?)\s*(mm|in|deg|°)?\s*$/.exec(text);

          if ((event.key === "ArrowUp" || event.key === "ArrowDown") && match) {
            event.preventDefault();

            // Inch values step in 1/8 in (Shift: 1 in, Alt: 1/64 in).
            const inch = length && du === "in" && (!match[2] || match[2] === "in");
            const base = integer
              ? 1
              : inch
                ? event.shiftKey
                  ? 1
                  : event.altKey
                    ? 1 / 64
                    : 1 / 8
                : event.shiftKey
                  ? 10
                  : event.altKey
                    ? 0.1
                    : 1;
            const step = base * (event.key === "ArrowUp" ? 1 : -1);
            const n = Math.round((parseFloat(match[1]!) + step) * 10000) / 10000;
            const next = match[2] ? `${n} ${match[2]}` : String(n);
            setText(next);

            const expr = parse(next);
            (onLive ?? onCommit)(expr);
          }
        }}
      />
      {quiet ? null : computed && !error ? (
        <span className="computed">{computed}</span>
      ) : unit && NUM.test(text) ? (
        <span className="computed">{unit === "deg" ? "°" : length ? du : unit}</span>
      ) : null}
    </div>
  );
}
