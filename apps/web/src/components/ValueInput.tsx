/**
 * Value field for dimensions edited on the model: type a number or expression, pick an existing
 * variable from the list below, or turn the value into a new variable.
 */
import { Plus, Variable } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { evaluate } from "@meercad/model";
import type { Expr } from "@meercad/schema";
import { apply, useApp } from "../store";
import { parseExpr } from "./ExprInput";
import { GROUP_LABEL, GROUP_ORDER, variableGroup } from "../lib/variables";

export type ValueUnit = "mm" | "deg" | "";

const NUM = /^\s*-?\d+(\.\d+)?\s*$/;

/** A free variable name based on `base` (e.g. "fillet_radius", "fillet_radius2"). */
export function freeParamName(base: string): string {
  const params = useApp.getState().doc.params;
  const clean = base.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1") || "v";
  if (!(clean in params)) return clean;
  let i = 2;
  while (`${clean}${i}` in params) i++;
  return `${clean}${i}`;
}

/** Stores a number as a variable value, with its unit so the variable reads naturally. */
export const withUnit = (n: number, unit: ValueUnit): Expr => (unit === "mm" ? `${+n.toFixed(4)} mm` : unit === "deg" ? `${+n.toFixed(4)} deg` : +n.toFixed(4));

export function ValueInput({ value, unit = "mm", suggest, onDone }: { value: Expr; unit?: ValueUnit; suggest: string; onDone: (v: Expr | null) => void }) {
  const params = useApp((s) => s.doc.params);
  const auto = useApp((s) => s.doc.autoParams);
  const values = useApp((s) => s.output?.report.params) ?? {};
  const [text, setText] = useState(String(value));
  const [active, setActive] = useState(-1);
  const [naming, setNaming] = useState<string | null>(null);
  const done = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => list.current?.querySelector("button.active")?.scrollIntoView({ block: "nearest" }), [active]);
  const finish = (v: Expr | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  const scope = new Map(Object.entries(values));
  const current = (): number | null => {
    try {
      return evaluate(text.trim() ? parseExpr(text) : value, scope);
    } catch {
      return null;
    }
  };

  // Variables: filtered by name while typing letters, otherwise closest value first.
  const typed = text.trim();
  const byName = typed && !NUM.test(typed) && /^[A-Za-z_]\w*$/.test(typed);
  const target = current();
  const names = Object.keys(params)
    .filter((n) => (byName ? n.toLowerCase().includes(typed.toLowerCase()) : true))
    .sort((a, b) => (target === null || byName ? a.localeCompare(b) : Math.abs((values[a] ?? Infinity) - target) - Math.abs((values[b] ?? Infinity) - target)));
  // Grouped like the Variables panel: your own, calculated, automatic.
  const options = [
    ...GROUP_ORDER.flatMap((g) => names.filter((n) => variableGroup(n, params, auto) === g).map((n) => ({ kind: "param" as const, name: n, group: GROUP_LABEL[g] }))),
    { kind: "new" as const, name: "", group: "" },
  ];

  const createVariable = (name: string) => {
    const n = current();
    if (n === null || !/^[A-Za-z_]\w*$/.test(name) || name in params) return;
    if (apply({ type: "set_param", name, expr: NUM.test(typed) || !typed ? withUnit(n, unit) : parseExpr(typed), auto: true })) finish(name);
  };
  const pick = (i: number) => {
    const o = options[i];
    if (!o) return finish(typed ? parseExpr(typed) : null);
    if (o.kind === "param") return finish(o.name);
    setNaming(freeParamName(suggest));
  };

  if (naming !== null) {
    const taken = naming in params;
    const valid = /^[A-Za-z_]\w*$/.test(naming) && !taken;
    return (
      <div className="value-editor">
        <input
          autoFocus
          className={`value-input ${valid ? "" : "invalid"}`}
          value={naming}
          aria-label="Variable name"
          onFocus={(e) => e.target.select()}
          onChange={(e) => setNaming(e.target.value)}
          onBlur={() => finish(null)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && valid) createVariable(naming);
            if (e.key === "Escape") setNaming(null);
          }}
        />
        <div className="value-menu">
          <div className="value-menu-note">{taken ? `"${naming}" already exists` : `New variable = ${target === null ? text : withUnit(target, unit)} · Enter to create`}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="value-editor">
      <input
        autoFocus
        className="value-input"
        value={text}
        aria-label="Value"
        onFocus={(e) => e.target.select()}
        onChange={(e) => {
          setText(e.target.value);
          setActive(-1);
        }}
        onBlur={() => finish(typed ? parseExpr(text) : null)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(options.length - 1, a + 1)));
          if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(-1, a - 1)));
          if (e.key === "Enter") pick(active);
          if (e.key === "Escape") finish(null);
        }}
      />
      <div className="value-menu" onMouseDown={(e) => e.preventDefault()}>
        <div className="value-menu-list" ref={list}>
        {options.map((o, i) =>
          o.kind === "param" ? (
            <div key={o.name} className="value-menu-item">
            {i === 0 || options[i - 1]!.group !== o.group ? <div className="value-menu-group">{o.group}</div> : null}
            <button className={i === active ? "active" : ""} onClick={() => pick(i)} title={`Use the variable ${o.name}`}>
              <Variable />
              <span className="name">{o.name}</span>
              <span className="val">{values[o.name] !== undefined ? +values[o.name]!.toFixed(3) : "?"}</span>
            </button>
            </div>
          ) : (
            <button key="new" className={`new ${i === active ? "active" : ""}`} onClick={() => pick(i)}>
              <Plus />
              <span className="name">New variable…</span>
            </button>
          ),
        )}
        </div>
        {!names.length && byName ? <div className="value-menu-note">No variable matches "{typed}"</div> : null}
      </div>
    </div>
  );
}
