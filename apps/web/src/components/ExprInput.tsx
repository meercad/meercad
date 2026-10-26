import { useEffect, useRef, useState } from "react";
import { evaluate } from "@leocad/model";
import type { Expr } from "@leocad/schema";
import { useApp } from "../store";

const NUM = /^\s*-?\d+(\.\d+)?\s*$/;
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
}

/** Expression field: accepts numbers, units and parameter names; shows the evaluated value. */
export function ExprInput({ value, onCommit, onLive, unit = "mm", autoFocus, placeholder, className, integer }: Props) {
  const params = useApp((s) => s.output?.report.params);
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setText(value === undefined ? "" : String(value));
  }, [value]);

  let computed: string | null = null;
  let error = false;
  if (text.trim()) {
    try {
      const v = evaluate(parseExpr(text), new Map(Object.entries(params ?? {})));
      computed = NUM.test(text) ? null : `= ${Math.round(v * 1000) / 1000}`;
    } catch {
      error = true;
    }
  }

  const commit = (t = text) => {
    if (!t.trim() || error) return setText(value === undefined ? "" : String(value));
    const e = parseExpr(t);
    if (e !== value) onCommit(e);
  };

  return (
    <div className="expr-wrap">
      <input
        ref={ref}
        className={`field expr ${error ? "invalid" : ""} ${className ?? ""}`}
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          if (onLive && e.target.value.trim()) {
            try {
              evaluate(parseExpr(e.target.value), new Map(Object.entries(params ?? {})));
              onLive(parseExpr(e.target.value));
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
            setText(value === undefined ? "" : String(value));
            (e.target as HTMLInputElement).blur();
          }
          const m = /^\s*(-?\d+(?:\.\d+)?)\s*(mm|deg|°)?\s*$/.exec(text);
          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && m) {
            e.preventDefault();
            const step = (integer ? 1 : e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === "ArrowUp" ? 1 : -1);
            const n = Math.round((parseFloat(m[1]!) + step) * 1000) / 1000;
            const next = m[2] ? `${n} ${m[2]}` : String(n);
            setText(next);
            const ex = parseExpr(next);
            (onLive ?? onCommit)(ex);
          }
        }}
      />
      {computed && !error ? <span className="computed">{computed}</span> : unit && NUM.test(text) ? <span className="computed">{unit === "deg" ? "°" : unit}</span> : null}
    </div>
  );
}
