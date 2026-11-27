/**
 * A deep copy of a document or a part of one (plain objects, arrays, numbers, strings, booleans,
 * null). Its strings are the very strings of the original: `structuredClone` writes every string
 * anew, and a design with imported files holds their contents as strings of many megabytes. Each
 * change to the design copies the document for the undo history, so a design with 60 MB of imports
 * took 60 MB more with every step until the app ran out of memory (2026-11-27).
 */
export function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => cloneJson(item)) as T;

  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) copy[key] = cloneJson((value as Record<string, unknown>)[key]);

    return copy as T;
  }

  return value;
}
