/**
 * Parameter expressions: `2 mm`, `wall * 10`, `max(w, d) / 2 + 1cm`.
 * Lengths are normalised to mm. Dimensional analysis is not done yet (Phase 1).
 */

import type { Expr } from "@leocad/schema";

// Lengths normalise to mm, angles to degrees.
const UNITS: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, deg: 1, rad: 180 / Math.PI };
const CONSTANTS: Record<string, number> = { pi: Math.PI };
const FUNCTIONS: Record<string, (...a: number[]) => number> = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  sqrt: Math.sqrt,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
};

export class ExprError extends Error {}

type Token = { kind: "num"; value: number } | { kind: "id"; value: string } | { kind: "op"; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/^(),]))/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new ExprError(`unexpected character "${src.slice(pos).trim()[0]}" in "${src}"`);
    if (m[1] !== undefined) tokens.push({ kind: "num", value: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ kind: "id", value: m[2] });
    else tokens.push({ kind: "op", value: m[3]! });
    pos = re.lastIndex;
  }
  return tokens;
}

/** Identifiers an expression refers to (excluding units, constants and functions). */
export function referencedNames(expr: Expr): string[] {
  if (typeof expr === "number") return [];
  const toks = tokenize(expr);
  const names = new Set<string>();
  toks.forEach((t, i) => {
    if (t.kind !== "id") return;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (prev?.kind === "num" && t.value in UNITS) return;
    if (next?.kind === "op" && next.value === "(" && t.value in FUNCTIONS) return;
    if (t.value in CONSTANTS) return;
    names.add(t.value);
  });
  return [...names];
}

export function evaluate(expr: Expr, scope: ReadonlyMap<string, number>): number {
  if (typeof expr === "number") {
    if (!Number.isFinite(expr)) throw new ExprError(`not a finite number: ${expr}`);
    return expr;
  }
  const toks = tokenize(expr);
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v: string) => {
    const t = toks[i];
    return t?.kind === "op" && t.value === v;
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`expected "${v}" in "${expr}"`);
    i++;
  };

  const parseSum = (): number => {
    let v = parseProduct();
    while (isOp("+") || isOp("-")) {
      const op = toks[i++]!.value;
      const r = parseProduct();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const parseProduct = (): number => {
    let v = parseUnary();
    while (isOp("*") || isOp("/")) {
      const op = toks[i++]!.value;
      const r = parseUnary();
      if (op === "/" && r === 0) throw new ExprError(`division by zero in "${expr}"`);
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const parseUnary = (): number => {
    if (isOp("-")) {
      i++;
      return -parseUnary();
    }
    if (isOp("+")) {
      i++;
      return parseUnary();
    }
    return parsePower();
  };
  const parsePower = (): number => {
    const base = parsePrimary();
    if (isOp("^")) {
      i++;
      return base ** parseUnary();
    }
    return base;
  };
  const parsePrimary = (): number => {
    const t = peek();
    if (!t) throw new ExprError(`unexpected end of "${expr}"`);
    i++;
    if (t.kind === "num") {
      const u = peek();
      if (u?.kind === "id" && u.value in UNITS) {
        i++;
        return t.value * UNITS[u.value]!;
      }
      return t.value;
    }
    if (t.kind === "op" && t.value === "(") {
      const v = parseSum();
      expect(")");
      return v;
    }
    if (t.kind === "id") {
      if (isOp("(")) {
        const fn = FUNCTIONS[t.value];
        if (!fn) throw new ExprError(`unknown function "${t.value}"`);
        i++;
        const args: number[] = [];
        if (!isOp(")")) {
          args.push(parseSum());
          while (isOp(",")) {
            i++;
            args.push(parseSum());
          }
        }
        expect(")");
        return fn(...args);
      }
      const v = scope.get(t.value) ?? CONSTANTS[t.value];
      if (v === undefined) throw new ExprError(`unknown parameter "${t.value}"`);
      return v;
    }
    throw new ExprError(`unexpected "${t.value}" in "${expr}"`);
  };

  if (toks.length === 0) throw new ExprError("empty expression");
  const value = parseSum();
  if (i < toks.length) throw new ExprError(`unexpected "${toks[i]!.value}" in "${expr}"`);
  if (!Number.isFinite(value)) throw new ExprError(`"${expr}" is not a finite number`);
  return value;
}

export interface ParamResolution {
  values: Map<string, number>;
  errors: Map<string, string>;
}

/** Evaluates all parameters in dependency order; cycles and bad references become per-parameter errors. */
export function resolveParams(params: Readonly<Record<string, Expr>>): ParamResolution {
  const values = new Map<string, number>();
  const errors = new Map<string, string>();
  const visiting = new Set<string>();

  const visit = (name: string): void => {
    if (values.has(name) || errors.has(name)) return;
    if (visiting.has(name)) {
      errors.set(name, `circular reference via "${name}"`);
      return;
    }
    const expr = params[name];
    if (expr === undefined) return;
    visiting.add(name);
    try {
      for (const dep of referencedNames(expr)) {
        visit(dep);
        const depError = errors.get(dep);
        if (depError) throw new ExprError(dep === name ? depError : `depends on "${dep}": ${depError}`);
      }
      values.set(name, evaluate(expr, values));
    } catch (e) {
      errors.set(name, e instanceof Error ? e.message : String(e));
    } finally {
      visiting.delete(name);
    }
  };

  for (const name of Object.keys(params)) visit(name);
  return { values, errors };
}

/** Rewrites references to parameter `from` as `to` in an expression. */
export function renameInExpr(expr: Expr, from: string, to: string): Expr {
  if (typeof expr === "number") return expr;
  return expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (m, offset: number) => {
    if (m !== from) return m;
    // A unit right after a number literal is not a parameter.
    const before = expr.slice(0, offset).trimEnd();
    return /[0-9.]$/.test(before) && m in UNITS ? m : to;
  });
}
