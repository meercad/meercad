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
  onCommit: (e: Expr) => void;
  /** Called on every arrow-key nudge and valid keystroke for live previews. */
  onLive?: (e: Expr) => void;
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
  const params = useApp((s) => s.output?.report.params);
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

    const e = parse(t);
    if (e !== value) onCommit(e);
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
        onChange={(e) => {
          setText(e.target.value);

          if (onLive && e.target.value.trim()) {
            try {
              evaluate(parse(e.target.value), new Map(Object.entries(params ?? {})));
              onLive(parse(e.target.value));
            } catch {
              // incomplete expression while typing
            }
          }
        }}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          }

          if (e.key === "Escape") {
            setText(shown);
            (e.target as HTMLInputElement).blur();
          }

          const m = /^\s*(-?\d+(?:\.\d+)?)\s*(mm|in|deg|°)?\s*$/.exec(text);

          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && m) {
            e.preventDefault();

            // Inch values step in 1/8 in (Shift: 1 in, Alt: 1/64 in).
            const inch = length && du === "in" && (!m[2] || m[2] === "in");
            const base = integer
              ? 1
              : inch
                ? e.shiftKey
                  ? 1
                  : e.altKey
                    ? 1 / 64
                    : 1 / 8
                : e.shiftKey
                  ? 10
                  : e.altKey
                    ? 0.1
                    : 1;
            const step = base * (e.key === "ArrowUp" ? 1 : -1);
            const n = Math.round((parseFloat(m[1]!) + step) * 10000) / 10000;
            const next = m[2] ? `${n} ${m[2]}` : String(n);
            setText(next);

            const ex = parse(next);
            (onLive ?? onCommit)(ex);
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
