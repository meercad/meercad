import type { Footprint } from "@meercad/model";
import type { ModelState } from "./state.js";

/**
 * Reuse of a step's result when what it read is unchanged (see Footprint in model/rebuild.ts).
 *
 * While a step runs it sees the model through read logs: every map of the state (parts, sketches,
 * planes, …) notes which entries the step looked up, and that it looked at all of them when it went
 * through a map (finding faces by tag, for one). Copies the step makes of a map (`copyMap`) note the
 * same. Afterwards the difference between the state before and after is the step's change. On a
 * later rebuild where an earlier step changed, the step is not run again if every entry it read is
 * still the very same object: its change is laid on the new state as it is.
 *
 * Only the maps of the state carry the model, and parts are never changed once made (a step makes
 * a new part instead), so object identity of what was read is a safe test.
 */

/** Diagnostics (tests/bench): told why a step's earlier result could not be taken over. */
export const replayTrace: { miss: ((why: string) => void) | null } = { miss: null };

const miss = (why: string): null => {
  replayTrace.miss?.(why);

  return null;
};

/** The maps of a state: every field except the arena. Checked against ModelState at compile time. */
const MAP_FIELDS = [
  "bodies",
  "sketches",
  "planes",
  "tools",
  "references",
  "gears",
  "grids",
  "walls",
  "textures",
] as const;
type MapField = (typeof MAP_FIELDS)[number];
type Exact =
  Exclude<keyof ModelState, "arena"> extends MapField
    ? MapField extends Exclude<keyof ModelState, "arena">
      ? true
      : never
    : never;

const _exact: Exact = true;
void _exact;

const EMPTY: ReadonlyMap<unknown, unknown> = new Map();

/** What a step read of one map: entries by key (undefined: was not there), or all of it. */
class Reads {
  readonly keys = new Map<unknown, { value: unknown; had: boolean }>();
  all = false;
  /** Questions put to the whole map (see `ask`), each with its answer then. */
  readonly questions: Question[] = [];
  read(key: unknown, value: unknown, had: boolean): void {
    if (!this.all && !this.keys.has(key)) this.keys.set(key, { value, had });
  }
}

/**
 * A question a step put to a whole map (which parts carry this face name, which parts reach into
 * this box): on another state the step's result still holds if the answer is the same there.
 */
interface Question {
  fn: (m: ReadonlyMap<unknown, unknown>) => unknown;
  /**
   * What the step itself had set or deleted in its copy of the map when it asked (none: the state's own map).
   */
  own: [key: unknown, has: boolean, value: unknown][];
  answer: Answer;
}
type Answer = { value: unknown } | { error: string };

function answerOf(fn: () => unknown): Answer {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error) };
  }
}

/**
 * Equal answers: plain data compared by value, anything else (parts, shapes) by being the very same object.
 */
function sameAnswer(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => sameAnswer(v, b[i]));
  }

  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) {
    return false;
  }

  const ka = Object.keys(a),
    kb = Object.keys(b);

  return (
    ka.length === kb.length &&
    ka.every(
      (k) => k in b && sameAnswer((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
}

/**
 * Puts a question to a whole map of the state (or a step's copy of it) and notes the answer, instead
 * of noting that the step looked at every entry: a step that finds its parts by a face's name or by
 * where its tool reaches is then not run again just because some other part changed. `fn` must
 * depend on nothing but the map it is given (and what it closes over must stay valid for as long
 * as the step's result is kept: numbers and names, no kernel objects of the running step).
 * Parts in the answer count by identity, so name the parts an answer is about in it.
 */
export function ask<K, V, T>(map: ReadonlyMap<K, V>, fn: (m: ReadonlyMap<K, V>) => T): T {
  let reads: Reads | null = null;
  let plain: ReadonlyMap<K, V> = map;
  let own: Question["own"] = [];

  if (map instanceof ReadLog) {
    reads = map.reads;
    plain = map.raw;
  } else if (map instanceof TrackedCopy && map.reads) {
    reads = map.reads;
    plain = map.plain();
    own = map.written();
  }

  if (!reads || reads.all) return fn(plain);

  const answer = answerOf(() => fn(plain));
  reads.questions.push({ fn: fn as Question["fn"], own, answer });
  if ("error" in answer) return fn(plain);

  return answer.value as T;
}

/** A map of the state before the step, noting what is read. */
class ReadLog<K, V> implements ReadonlyMap<K, V> {
  constructor(
    readonly raw: ReadonlyMap<K, V>,
    readonly reads: Reads,
  ) {}

  get(key: K): V | undefined {
    const v = this.raw.get(key);
    this.reads.read(key, v, this.raw.has(key));

    return v;
  }

  has(key: K): boolean {
    this.reads.read(key, this.raw.get(key), this.raw.has(key));

    return this.raw.has(key);
  }

  get size(): number {
    this.reads.all = true;

    return this.raw.size;
  }

  forEach(fn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.reads.all = true;
    this.raw.forEach((v, k) => fn.call(thisArg, v, k, this));
  }

  entries(): MapIterator<[K, V]> {
    this.reads.all = true;

    return this.raw.entries();
  }

  keys(): MapIterator<K> {
    this.reads.all = true;

    return this.raw.keys();
  }

  values(): MapIterator<V> {
    this.reads.all = true;

    return this.raw.values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}

/**
 * A step's own copy of a map of the state: entries it has not set or deleted itself are still
 * the state's, so reading them is noted like reading the state.
 */
class TrackedCopy<K, V> extends Map<K, V> {
  private own = new Set<K>();
  reads: Reads | null = null;
  override get(key: K): V | undefined {
    const v = super.get(key);
    if (this.reads && !this.own.has(key)) this.reads.read(key, v, super.has(key));

    return v;
  }

  override has(key: K): boolean {
    if (this.reads && !this.own.has(key)) this.reads.read(key, super.get(key), super.has(key));

    return super.has(key);
  }

  override set(key: K, value: V): this {
    // The constructor fills the copy before `own` exists: those entries are the state's.
    this.own?.add(key);

    return super.set(key, value);
  }

  override delete(key: K): boolean {
    this.own.add(key);

    return super.delete(key);
  }

  override clear(): void {
    if (this.reads) this.reads.all = true;

    super.clear();
  }

  override get size(): number {
    if (this.reads) this.reads.all = true;

    return super.size;
  }

  override forEach(fn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    if (this.reads) this.reads.all = true;

    super.forEach(fn, thisArg);
  }

  override entries(): MapIterator<[K, V]> {
    if (this.reads) this.reads.all = true;

    return super.entries();
  }

  override keys(): MapIterator<K> {
    if (this.reads) this.reads.all = true;

    return super.keys();
  }

  override values(): MapIterator<V> {
    if (this.reads) this.reads.all = true;

    return super.values();
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  /** The entries as a plain map (reading it is not noted). */
  plain(): Map<K, V> {
    return new Map(Map.prototype.entries.call(this) as MapIterator<[K, V]>);
  }

  /** What the step set or deleted in this copy so far. */
  written(): [K, boolean, V | undefined][] {
    return [...this.own].map((k) => [
      k,
      Map.prototype.has.call(this, k),
      Map.prototype.get.call(this, k) as V | undefined,
    ]);
  }

  /** A copy that still notes reads of the entries that came from the state. */
  copy(): TrackedCopy<K, V> {
    const c = new TrackedCopy<K, V>(Map.prototype.entries.call(this) as MapIterator<[K, V]>);
    c.reads = this.reads;
    c.own = new Set(this.own);

    return c;
  }

  /** From now on a plain map (the step is done). */
  detach(): void {
    this.reads = null;
  }
}

/**
 * A copy of one of the state's maps for a step to change (instead of `new Map(prev.x)`, which would
 * count as reading every entry).
 */
export function copyMap<K, V>(m: ReadonlyMap<K, V> | undefined): Map<K, V> {
  if (m instanceof ReadLog) {
    const copy = new TrackedCopy<K, V>(Map.prototype.entries.call(m.raw as Map<K, V>));
    copy.reads = m.reads;

    return copy;
  }

  if (m instanceof TrackedCopy && m.reads) return m.copy();

  return new Map(m ?? []);
}

/** The state as a step sees it while being tracked, and what it read once it is done. */
export function trackState(prev: ModelState): {
  view: ModelState;
  finish(next: ModelState | null): Footprint<ModelState> | null;
} {
  // A field this module does not know about would be read unnoticed: no reuse then.
  if (Object.keys(prev).some((k) => k !== "arena" && !(MAP_FIELDS as readonly string[]).includes(k))) {
    return { view: prev, finish: () => null };
  }

  const reads = new Map<MapField, Reads>();
  const view: Record<string, unknown> = { ...prev };

  for (const f of MAP_FIELDS) {
    const r = new Reads();
    reads.set(f, r);
    // An absent map (older states) reads as empty, so a step that looked for something in it is
    // run again once the map has entries.
    view[f] = new ReadLog(prev[f] ?? EMPTY, r);
  }

  const copies: TrackedCopy<unknown, unknown>[] = [];

  const realCopy = (v: unknown) => {
    if (v instanceof ReadLog) return v.raw;

    if (v instanceof TrackedCopy) {
      copies.push(v);
      v.detach();
    }

    return v;
  };

  return {
    view: view as unknown as ModelState,
    finish(next) {
      // Copies made during the step are plain maps from now on; the state gets no read logs.
      const change: Change = new Map();

      if (next) {
        const plain = next as unknown as Record<string, unknown>;

        if (Object.keys(plain).some((k) => k !== "arena" && !(MAP_FIELDS as readonly string[]).includes(k))) {
          return null;
        }

        for (const f of MAP_FIELDS) {
          const before = prev[f] as ReadonlyMap<unknown, unknown> | undefined;
          const after = realCopy(plain[f]) as ReadonlyMap<unknown, unknown> | undefined;

          if (after === undefined || (after === EMPTY && before === undefined)) {
            if (before !== undefined) change.set(f, "absent");

            delete plain[f];
            continue;
          }

          plain[f] = after;
          if (after === before) continue;

          const set = new Map<unknown, unknown>();
          const deleted: unknown[] = [];
          Map.prototype.forEach.call(after, (v: unknown, k: unknown) => {
            if (!before || before.get(k) !== v || !before.has(k)) set.set(k, v);
          });
          before?.forEach((_, k) => {
            if (!Map.prototype.has.call(after, k)) deleted.push(k);
          });
          if (set.size || deleted.length || before === undefined) change.set(f, { set, deleted });
        }
      }

      // The maps a step went through as a whole are kept to compare with; nothing else of the
      // state before is held on to (it would keep every earlier part and its mesh alive).
      const whole = new Map<MapField, ReadonlyMap<unknown, unknown>>();
      for (const [f, r] of reads) if (r.all) whole.set(f, prev[f] ?? EMPTY);

      return footprint(reads, whole, change, next?.arena ?? null);
    },
  };
}

type Change = Map<MapField, { set: Map<unknown, unknown>; deleted: unknown[] } | "absent">;

/** `arena`: the objects of the step's result; null for a step that failed. */
function footprint(
  reads: Map<MapField, Reads>,
  whole: Map<MapField, ReadonlyMap<unknown, unknown>>,
  change: Change,
  arena: ModelState["arena"] | null,
): Footprint<ModelState> {
  return {
    replay(state: ModelState): ModelState | null {
      for (const [f, r] of reads) {
        const m: ReadonlyMap<unknown, unknown> = state[f] ?? EMPTY;

        if (r.all) {
          const was = whole.get(f)!;

          if (
            m !== was &&
            (m.size !== was.size || [...m].some(([k, v]) => was.get(k) !== v || !was.has(k)))
          ) {
            return miss(`all ${f}`);
          }
        } else {
          for (const [k, { value, had }] of r.keys) {
            if (m.get(k) !== value || m.has(k) !== had) return miss(`${f} ${String(k)}`);
          }
        }

        for (const q of r.questions) {
          let asked: ReadonlyMap<unknown, unknown> = m;

          if (q.own.length) {
            const over = new Map(m);
            for (const [k, has, v] of q.own) has ? over.set(k, v) : over.delete(k);
            asked = over;
          }

          const now = answerOf(() => q.fn(asked));
          if ("error" in now !== "error" in q.answer) return miss(`question ${f}`);

          if (
            "error" in now
              ? now.error !== (q.answer as { error: string }).error
              : !sameAnswer(now.value, (q.answer as { value: unknown }).value)
          ) {
            return miss(`question ${f}`);
          }
        }
      }

      // A step that failed leaves the state as it was.
      if (!arena) return state;

      const out: Record<string, unknown> = { ...state, arena };

      for (const [f, c] of change) {
        if (c === "absent") {
          delete out[f];
          continue;
        }

        const m = new Map(state[f] ?? EMPTY);
        for (const k of c.deleted) m.delete(k);
        for (const [k, v] of c.set) m.set(k, v);
        out[f] = m;
      }

      return out as unknown as ModelState;
    },
  };
}
