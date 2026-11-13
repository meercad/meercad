import { withoutRemovedFeatures, type Expr, type MeercadDocument } from "@meercad/schema";
import { resolveParams } from "./expr.js";
import { FIT_VAR, fitExpr } from "./fit.js";
import { hashString } from "./hash.js";
import { resolveFeature, type ResolvedFeature } from "./resolve.js";

/** A user-facing failure of one feature. `hint` suggests a fix (e.g. a smaller radius). */
export class FeatureError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export interface ExecResult<S> {
  state: S;
  warnings?: string[];
  /** Numbers about the result for the interface (e.g. what a bend comes to). */
  info?: Record<string, number>;
  /**
   * The state uses objects of the `earlier` state handed to `execute`: that state must not be disposed apart
   * from it.
   */
  keepsEarlier?: boolean;
}

/**
 * What one run of a step read of the state before it, and what it changed: lets the engine reuse
 * the step's result on another state where all it read is the same (a change further up the
 * timeline that did not touch this step's parts).
 */
export interface Footprint<S> {
  /**
   * The step's result on `prev` without running it, sharing the resources of the run it was noted
   * from; null when the step read something that differs in `prev`. A step that failed gives `prev`.
   */
  replay(prev: S): S | null;
}

/** What the rebuild engine needs from a geometry kernel. States must be treated as immutable. */
export interface KernelBackend<S> {
  initialState(): S;
  /**
   * Must leave `prev` untouched and release its own temporaries when it throws. With `note`, a
   * backend that can tell what the step read hands over its Footprint (also when the step fails).
   * `earlier`: the result this very step (same definition) had on another state, of which the
   * backend may keep what is still right (the parts a move did not have to move again); it then
   * says so with `keepsEarlier` and the new state owns the earlier one's resources.
   */
  execute(
    feature: ResolvedFeature,
    prev: S,
    note?: (footprint: Footprint<S>) => void,
    earlier?: S,
  ): ExecResult<S>;
  /** Releases resources owned by `state` (but not those it shares with earlier states). */
  dispose(state: S): void;
}

export type FeatureStatusKind = "ok" | "warning" | "error" | "suppressed" | "rolled_back";

export interface FeatureStatus {
  id: string;
  status: FeatureStatusKind;
  message?: string;
  hint?: string;
  /** Execution time in ms; 0 when taken from cache. */
  ms: number;
  cached: boolean;
  /** Numbers about the result for the interface (see ExecResult). */
  info?: Record<string, number>;
}

export interface RebuildResult<S> {
  state: S;
  features: FeatureStatus[];
  paramErrors: Record<string, string>;
  params: Record<string, number>;
  ms: number;
  /** Index of the first feature that had to be recomputed, or -1 if everything came from cache. */
  firstRecomputed: number;
}

interface CacheEntry<S> {
  key: string;
  /** Hash of the step alone (not of the steps before it). */
  own: string;
  state: S;
  /** The state the step was run on. */
  prev: S;
  status: FeatureStatus;
  footprint?: Footprint<S>;
}

/**
 * Incremental rebuild: feature i is recomputed only if hash(previous key, resolved feature) changed.
 * Failed features pass the previous state through so later features can still be evaluated.
 */
/** The document's parameters with the values of the variant in use put in. */
export function effectiveParams(
  doc: Pick<MeercadDocument, "params" | "variants" | "variant" | "fit">,
): Record<string, Expr> {
  // The design's fit is there by name (`fit`); an own variable of that name (from before) wins.
  const params = { [FIT_VAR]: fitExpr(doc), ...doc.params };
  const variant = doc.variant !== undefined ? doc.variants?.find((x) => x.name === doc.variant) : undefined;
  if (!variant) return params;

  return {
    ...params,
    ...Object.fromEntries(Object.entries(variant.params).filter(([k]) => k in doc.params)),
  };
}

export class RebuildEngine<S> {
  private cache: CacheEntry<S>[] = [];
  private readonly root: S;

  constructor(private readonly backend: KernelBackend<S>) {
    this.root = backend.initialState();
  }

  /** `onFeature` is told before each feature that has to be computed (not those taken from cache). */
  rebuild(
    doc: MeercadDocument,
    onFeature?: (index: number, total: number, id: string) => void,
  ): RebuildResult<S> {
    return this.run(doc, onFeature, null);
  }

  /**
   * Builds `doc` next to the cached one without changing the cache (a preview of a change): the
   * features the two share from the start come from the cache, only the rest are computed. The
   * caller must `release` the result when done with it; the cached states stay.
   */
  fork(
    doc: MeercadDocument,
    onFeature?: (index: number, total: number, id: string) => void,
  ): RebuildResult<S> & { release: () => void } {
    const own: { state: S; prev: S }[] = [];

    const release = () => {
      // Newest first, as in evictFrom.
      for (let j = own.length - 1; j >= 0; j--) {
        if (own[j]!.state !== own[j]!.prev) this.backend.dispose(own[j]!.state);
      }

      own.length = 0;
    };

    try {
      return { ...this.run(doc, onFeature, own), release };
    } catch (error) {
      release();

      throw error;
    }
  }

  /** `own`: a fork's states, kept apart from the cache (null: the cache is updated). */
  private run(
    doc: MeercadDocument,
    onFeature: ((index: number, total: number, id: string) => void) | undefined,
    own: { state: S; prev: S }[] | null,
  ): RebuildResult<S> {
    const t0 = performance.now();
    // A file from an earlier version may hold steps this one no longer has: they are left out.
    doc = withoutRemovedFeatures(doc).doc;

    const { values, errors } = resolveParams(effectiveParams(doc));
    const statuses: FeatureStatus[] = [];
    let state = this.root;
    let key = "root";
    let firstRecomputed = -1;
    let rolledBack = false;
    let i = 0;
    // From the first changed step on, the earlier entries by step id: a later step whose own
    // definition is unchanged and that read nothing that changed takes its result from there.
    let stale: Map<string, CacheEntry<S>> | null = null;
    const adopted = new Set<CacheEntry<S>>();

    for (const feature of doc.features) {
      if (rolledBack) {
        statuses.push({ id: feature.id, status: "rolled_back", ms: 0, cached: false });
        continue;
      }

      const off = feature.suppressed;
      let resolved: ResolvedFeature | null = null;
      let resolveError: string | null = null;

      if (!off) {
        try {
          resolved = resolveFeature(feature, values);
        } catch (error) {
          resolveError = error instanceof Error ? error.message : String(error);
        }
      }

      const def = off
        ? `S:${feature.id}`
        : resolved
          ? JSON.stringify(resolved)
          : `E:${feature.id}:${resolveError}`;
      key = hashString(`${key}|${def}`);

      const self = hashString(def);

      const hit = firstRecomputed === -1 ? this.cache[i] : undefined;

      if (!(hit && hit.key === key) && firstRecomputed === -1) {
        firstRecomputed = i;
        stale = new Map(this.cache.slice(i).map((e) => [e.status.id, e]));
        // A fork leaves the cache as it is and only looks at its entries.
        if (!own) this.cache.length = i;
      }

      const old = stale?.get(feature.id);
      const replayed =
        old && old.own === self && old.footprint && !adopted.has(old) ? old.footprint.replay(state) : null;

      if (hit && hit.key === key) {
        state = hit.state;
        statuses.push({ ...hit.status, ms: 0, cached: true });
      } else if (replayed && old) {
        // Unchanged step on unchanged parts: its earlier result, laid on the new state.
        // The result's resources stay the earlier entry's: a fork has nothing of its own to release here.
        adopted.add(old);

        if (!own) {
          this.cache[i] = {
            key,
            own: self,
            state: replayed,
            prev: state,
            status: old.status,
            footprint: old.footprint!,
          };
        }

        statuses.push({ ...old.status, ms: 0, cached: true });
        state = replayed;
      } else {
        if (!off && resolved) onFeature?.(i, doc.features.length, feature.id);

        const tf = performance.now();
        let status: FeatureStatus;
        let next = state;
        let footprint: Footprint<S> | undefined;

        if (off) {
          status = { id: feature.id, status: "suppressed", ms: 0, cached: false };
        } else if (!resolved) {
          status = {
            id: feature.id,
            status: "error",
            message: resolveError ?? "unresolved",
            ms: 0,
            cached: false,
          };
        } else {
          try {
            // Not for a fork: its states are released on their own, the cache's must stay.
            const earlier =
              !own && old && old.own === self && !adopted.has(old) && old.state !== old.prev
                ? old.state
                : undefined;
            const r = this.backend.execute(resolved, state, (fp) => (footprint = fp), earlier);
            if (r.keepsEarlier && old) adopted.add(old);

            next = r.state;
            status = r.warnings?.length
              ? { id: feature.id, status: "warning", message: r.warnings.join("; "), ms: 0, cached: false }
              : { id: feature.id, status: "ok", ms: 0, cached: false };
            if (r.info) status.info = r.info;
          } catch (error) {
            status = {
              id: feature.id,
              status: "error",
              message: error instanceof Error ? error.message : String(error),
              ms: 0,
              cached: false,
            };
            if (error instanceof FeatureError && error.hint) status.hint = error.hint;
          }
        }

        status.ms = performance.now() - tf;

        if (own) {
          own.push({ state: next, prev: state });
        } else {
          this.cache[i] = {
            key,
            own: self,
            state: next,
            prev: state,
            status,
            ...(footprint ? { footprint } : {}),
          };
        }

        state = next;
        statuses.push(status);
      }

      i++;
      if (doc.rollback === feature.id) rolledBack = true;
    }

    // Earlier results nobody took over: newest first, as later states may use what earlier ones made.
    if (stale && !own) {
      for (const e of [...stale.values()].reverse()) {
        if (!adopted.has(e) && e.state !== e.prev) this.backend.dispose(e.state);
      }
    }
    // Entries past the end (steps deleted at the end of the timeline, or rolled back) stay as they
    // were when nothing changed before them; after a change they belong to the stale ones above.

    return {
      state,
      features: statuses,
      paramErrors: Object.fromEntries(errors),
      params: Object.fromEntries(values),
      ms: performance.now() - t0,
      firstRecomputed,
    };
  }

  /** Drops all cached states (e.g. before disposing the kernel). */
  clear(): void {
    this.evictFrom(0);
  }

  private evictFrom(index: number): void {
    // Dispose newest first: later states may reference objects created by earlier ones, never the reverse.
    for (let j = this.cache.length - 1; j >= index; j--) {
      const entry = this.cache[j]!;
      if (entry.state !== entry.prev) this.backend.dispose(entry.state);
    }

    this.cache.length = Math.min(this.cache.length, index);
  }
}
