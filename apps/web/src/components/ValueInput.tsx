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
import { docUnit, inUnit, lengthExpr, lengthText, lengthValue } from "../lib/units";
import { t } from "../lib/i18n";

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

/** Stores a number (mm for lengths) as a variable value, with its unit so the variable reads naturally. */
export const withUnit = (n: number, unit: ValueUnit): Expr => {
  if (unit === "mm") return docUnit() === "mm" ? `${+n.toFixed(4)} mm` : lengthValue(n);

  return unit === "deg" ? `${+n.toFixed(4)} deg` : +n.toFixed(4);
};

/** What typed text means for a value of this unit (plain numbers are in the design's unit for lengths). */
export const parseValue = (t: string, unit: ValueUnit): Expr =>
  unit === "mm" ? lengthExpr(t) : parseExpr(t);

export function ValueInput({
  value,
  unit = "mm",
  suggest,
  onDone,
}: {
  value: Expr;
  unit?: ValueUnit;
  suggest: string;
  onDone: (expr: Expr | null) => void;
}) {
  const params = useApp((state) => state.doc.params);
  const auto = useApp((state) => state.doc.autoParams);
  const values = useApp((state) => state.output?.report.params) ?? {};
  const initial = unit === "mm" ? lengthText(value) : String(value);
  const [text, setText] = useState(initial);
  const [active, setActive] = useState(-1);
  const [naming, setNaming] = useState<string | null>(null);
  const done = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  useEffect(
    () => list.current?.querySelector("button.active")?.scrollIntoView({ block: "nearest" }),
    [active],
  );

  const finish = (expr: Expr | null) => {
    if (done.current) return;

    done.current = true;
    onDone(expr);
  };

  const scope = new Map(Object.entries(values));

  const current = (): number | null => {
    try {
      return evaluate(text.trim() ? parseValue(text, unit) : value, scope);
    } catch {
      return null;
    }
  };

  // Variables: filtered by name while typing letters, otherwise closest value first.
  const typed = text.trim();
  // Left as shown: no change (the shown value may be rounded, e.g. converted to inches).
  const typedValue = (): Expr | null => (!typed || typed === initial.trim() ? null : parseValue(typed, unit));
  const byName = typed && !NUM.test(typed) && /^[A-Za-z_]\w*$/.test(typed);
  const target = current();
  const names = Object.keys(params)
    .filter((n) => (byName ? n.toLowerCase().includes(typed.toLowerCase()) : true))
    .sort((a, b) =>
      target === null || byName
        ? a.localeCompare(b)
        : Math.abs((values[a] ?? Infinity) - target) - Math.abs((values[b] ?? Infinity) - target),
    );
  // Grouped like the Variables panel: your own, calculated, automatic.
  const options = [
    ...GROUP_ORDER.flatMap((g) =>
      names
        .filter((n) => variableGroup(n, params, auto) === g)
        .map((n) => ({ kind: "param" as const, name: n, group: GROUP_LABEL[g] })),
    ),
    { kind: "new" as const, name: "", group: "" },
  ];

  const createVariable = (name: string) => {
    const n = current();
    if (n === null || !/^[A-Za-z_]\w*$/.test(name) || name in params) return;

    if (
      apply({
        type: "set_param",
        name,
        expr: NUM.test(typed) || !typed ? withUnit(n, unit) : parseValue(typed, unit),
        auto: true,
      })
    ) {
      finish(name);
    }
  };

  const pick = (i: number) => {
    const o = options[i];
    if (!o) return finish(typedValue());
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
          aria-label={t("Variable name")}
          onFocus={(event) => event.target.select()}
          onChange={(event) => setNaming(event.target.value)}
          onBlur={() => finish(null)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && valid) createVariable(naming);
            if (event.key === "Escape") setNaming(null);
          }}
        />
        <div className="value-menu">
          <div className="value-menu-note">
            {taken
              ? t('"{name}" already exists', { name: naming })
              : t("New variable = {value} · Enter to create", {
                  value: target === null ? text : withUnit(target, unit),
                })}
          </div>
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
        aria-label={t("Value")}
        onFocus={(event) => event.target.select()}
        onChange={(event) => {
          setText(event.target.value);
          setActive(-1);
        }}
        onBlur={() => finish(typedValue())}
        onKeyDown={(event) => {
          event.stopPropagation();

          if (event.key === "ArrowDown") {
            (event.preventDefault(), setActive((a) => Math.min(options.length - 1, a + 1)));
          }

          if (event.key === "ArrowUp") (event.preventDefault(), setActive((a) => Math.max(-1, a - 1)));
          if (event.key === "Enter") pick(active);
          if (event.key === "Escape") finish(null);
        }}
      />
      <div className="value-menu" onMouseDown={(event) => event.preventDefault()}>
        <div className="value-menu-list" ref={list}>
          {options.map((o, i) =>
            o.kind === "param" ? (
              <div key={o.name} className="value-menu-item">
                {i === 0 || options[i - 1]!.group !== o.group ? (
                  <div className="value-menu-group">{o.group}</div>
                ) : null}
                <button
                  className={i === active ? "active" : ""}
                  onClick={() => pick(i)}
                  title={t("Use the variable {name}", { name: o.name })}
                >
                  <Variable />
                  <span className="name">{o.name}</span>
                  <span className="val">
                    {values[o.name] !== undefined
                      ? unit === "mm"
                        ? inUnit(values[o.name]!)
                        : +values[o.name]!.toFixed(3)
                      : "?"}
                  </span>
                </button>
              </div>
            ) : (
              <button key="new" className={`new ${i === active ? "active" : ""}`} onClick={() => pick(i)}>
                <Plus />
                <span className="name">{t("New variable…")}</span>
              </button>
            ),
          )}
        </div>
        {!names.length && byName ? (
          <div className="value-menu-note">{t('No variable matches "{text}"', { text: typed })}</div>
        ) : null}
      </div>
    </div>
  );
}
