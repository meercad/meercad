/**
 * Lengths in the design's unit. The model keeps millimetres (a bare number is always mm), so an
 * inch design converts for display and stores what is typed with its unit ("2 in").
 */
import type { Expr, LengthUnit } from "@meercad/schema";

export const MM_PER: Record<LengthUnit, number> = { mm: 1, in: 25.4 };

let source: () => LengthUnit = () => "mm";
/** Where the open design's unit comes from (set once by the store). */
export function setUnitSource(fn: () => LengthUnit): void {
  source = fn;
}
export const docUnit = (): LengthUnit => source();

/** Millimetres in the unit, rounded for display (inches get one more digit). */
export function inUnit(mm: number, u: LengthUnit = docUnit()): number {
  const d = u === "in" ? 4 : 3;
  return +(mm / MM_PER[u]).toFixed(d);
}

/** "12.5 mm" / "0.4921 in". */
export function fmtLen(mm: number, u: LengthUnit = docUnit()): string {
  return `${inUnit(mm, u)} ${u}`;
}

/** "0.4921 in³" style volumes. */
export function fmtVolume(mm3: number, u: LengthUnit = docUnit()): string {
  if (u === "in") return `${+(mm3 / 25.4 ** 3).toFixed(mm3 / 25.4 ** 3 >= 10 ? 1 : 3)} in³`;
  return mm3 >= 1000 ? `${(mm3 / 1000).toFixed(1)} cm³` : `${mm3.toFixed(0)} mm³`;
}

/** A length value as it is edited: a bare (mm) number in the design's unit, an expression as written. */
export function lengthText(e: Expr | undefined, u: LengthUnit = docUnit()): string {
  if (e === undefined) return "";
  return typeof e === "number" ? String(inUnit(e, u)) : String(e);
}

const NUM = /^\s*-?\d+(\.\d+)?\s*$/;

/** What a typed length means: a plain number is in the design's unit (stored as "2 in" in an inch design). */
export function lengthExpr(text: string, u: LengthUnit = docUnit()): Expr {
  if (!NUM.test(text)) return text.trim();
  const n = Number(text);
  return u === "mm" ? n : `${n} ${u}`;
}

/** A length in mm written as a value for the design: a number in mm designs, "x in" otherwise. */
export function lengthValue(mm: number, u: LengthUnit = docUnit()): Expr {
  return u === "mm" ? +mm.toFixed(4) : `${inUnit(mm, u)} in`;
}

/** Whether an expression carries a length unit (used to tell lengths from counts and angles). */
export const hasLengthUnit = (e: Expr): boolean => typeof e === "string" && /\d\s*(mm|cm|m|in|ft)\b/.test(e);

/** Rewrites "12.5 mm", "40 mm²", "8 mm³" in a text into the unit (for kernel-made texts such as measurements). */
export function convertMmText(text: string, u: LengthUnit = docUnit()): string {
  if (u === "mm") return text;
  return text.replace(/(-?\d+(?:\.\d+)?)\s*mm(²|³)?/g, (_, n: string, pow?: string) => {
    const p = pow === "²" ? 2 : pow === "³" ? 3 : 1;
    const v = Number(n) / MM_PER[u] ** p;
    return `${+v.toFixed(p === 1 ? 4 : 3)} ${u}${pow ?? ""}`;
  });
}

/**
 * Whether a variable holds a length: its expression has a length unit or uses another length
 * variable. A plain number is not taken for one (it may be a count).
 */
export function isLengthParam(name: string, params: Record<string, Expr>, seen = new Set<string>()): boolean {
  const e = params[name];
  if (e === undefined || seen.has(name)) return false;
  seen.add(name);
  if (typeof e === "number") return false;
  if (hasLengthUnit(e)) return true;
  return Object.keys(params).some((n) => n !== name && new RegExp(`\\b${n}\\b`).test(e) && isLengthParam(n, params, seen));
}
