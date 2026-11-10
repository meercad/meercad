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
}

/** What the rebuild engine needs from a geometry kernel. States must be treated as immutable. */
export interface KernelBackend<S> {
  initialState(): S;
  /** Must leave `prev` untouched and release its own temporaries when it throws. */
  execute(feature: ResolvedFeature, prev: S): ExecResult<S>;
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
  state: S;
  status: FeatureStatus;
}

/**
 * Incremental rebuild: feature i is recomputed only if hash(previous key, resolved feature) changed.
 * Failed features pass the previous state through so later features can still be evaluated.
 */
/** The document's parameters with the values of the variant in use put in. */
export function effectiveParams(doc: Pick<MeercadDocument, "params" | "variants" | "variant" | "fit">): Record<string, Expr> {
  // The design's fit is there by name (`fit`); an own variable of that name (from before) wins.
  const params = { [FIT_VAR]: fitExpr(doc), ...doc.params };
  const v = doc.variant !== undefined ? doc.variants?.find((x) => x.name === doc.variant) : undefined;
  if (!v) return params;
  return { ...params, ...Object.fromEntries(Object.entries(v.params).filter(([k]) => k in doc.params)) };
}

export class RebuildEngine<S> {
  private cache: CacheEntry<S>[] = [];
  private readonly root: S;

  constructor(private readonly backend: KernelBackend<S>) {
    this.root = backend.initialState();
  }

  /** `onFeature` is told before each feature that has to be computed (not those taken from cache). */
  rebuild(doc: MeercadDocument, onFeature?: (index: number, total: number, id: string) => void): RebuildResult<S> {
    return this.run(doc, onFeature, null);
  }

  /**
   * Builds `doc` next to the cached one without changing the cache (a preview of a change): the
   * features the two share from the start come from the cache, only the rest are computed. The
   * caller must `release` the result when done with it; the cached states stay.
   */
  fork(doc: MeercadDocument, onFeature?: (index: number, total: number, id: string) => void): RebuildResult<S> & { release: () => void } {
    const own: { state: S; prev: S }[] = [];
    const release = () => {
      // Newest first, as in evictFrom.
      for (let j = own.length - 1; j >= 0; j--) if (own[j]!.state !== own[j]!.prev) this.backend.dispose(own[j]!.state);
      own.length = 0;
    };
    try {
      return { ...this.run(doc, onFeature, own), release };
    } catch (e) {
      release();
      throw e;
    }
  }

  /** `own`: a fork's states, kept apart from the cache (null: the cache is updated). */
  private run(doc: MeercadDocument, onFeature: ((index: number, total: number, id: string) => void) | undefined, own: { state: S; prev: S }[] | null): RebuildResult<S> {
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

    for (const f of doc.features) {
      if (rolledBack) {
        statuses.push({ id: f.id, status: "rolled_back", ms: 0, cached: false });
        continue;
      }
      let resolved: ResolvedFeature | null = null;
      let resolveError: string | null = null;
      if (!f.suppressed) {
        try {
          resolved = resolveFeature(f, values);
        } catch (e) {
          resolveError = e instanceof Error ? e.message : String(e);
        }
      }
      key = hashString(`${key}|${f.suppressed ? `S:${f.id}` : resolved ? JSON.stringify(resolved) : `E:${f.id}:${resolveError}`}`);

      const hit = firstRecomputed === -1 ? this.cache[i] : undefined;
      if (hit && hit.key === key) {
        state = hit.state;
        statuses.push({ ...hit.status, ms: 0, cached: true });
      } else {
        if (firstRecomputed === -1) {
          firstRecomputed = i;
          if (!own) this.evictFrom(i);
        }
        if (!f.suppressed && resolved) onFeature?.(i, doc.features.length, f.id);
        const tf = performance.now();
        let status: FeatureStatus;
        let next = state;
        if (f.suppressed) {
          status = { id: f.id, status: "suppressed", ms: 0, cached: false };
        } else if (!resolved) {
          status = { id: f.id, status: "error", message: resolveError ?? "unresolved", ms: 0, cached: false };
        } else {
          try {
            const r = this.backend.execute(resolved, state);
            next = r.state;
            status = r.warnings?.length
              ? { id: f.id, status: "warning", message: r.warnings.join("; "), ms: 0, cached: false }
              : { id: f.id, status: "ok", ms: 0, cached: false };
            if (r.info) status.info = r.info;
          } catch (e) {
            status = {
              id: f.id,
              status: "error",
              message: e instanceof Error ? e.message : String(e),
              ms: 0,
              cached: false,
            };
            if (e instanceof FeatureError && e.hint) status.hint = e.hint;
          }
        }
        status.ms = performance.now() - tf;
        if (own) own.push({ state: next, prev: state });
        else this.cache[i] = { key, state: next, status };
        state = next;
        statuses.push(status);
      }
      i++;
      if (doc.rollback === f.id) rolledBack = true;
    }

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
      const prev = j > 0 ? this.cache[j - 1]!.state : this.root;
      if (entry.state !== prev) this.backend.dispose(entry.state);
    }
    this.cache.length = Math.min(this.cache.length, index);
  }
}
