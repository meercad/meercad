/**
 * Tool calls that take longer than a client waits. Some clients give up on a tool call after about
 * 80 s and then restart the MCP server; the restarted server has a new session, so the app hands
 * the old session's tab (and with it the project) back to the user, and the next call finds no
 * project. Opening or checking a big design (Mini v4) takes longer than that, so the assistant got
 * into a loop: open, time out, lose the tab, open again.
 *
 * A call therefore answers within `answerWithinMs`: if the app is not done by then, the answer
 * says the work goes on, and the call keeps running. The same call again (same tool, same
 * arguments) waits for that run instead of starting another one, and gets its result once it is
 * there. A finished result nobody fetched is kept for `keepMs`.
 */
export interface Patience {
  /** Runs `run` under `key`, or joins the run under `key` that is still going (or just finished). */
  run<R>(key: string, run: () => Promise<R>, stillWorking: (sinceMs: number) => R): Promise<R>;
  /** Keys with a run going on or a result waiting (for tests). */
  readonly size: number;
}

type Entry = { started: number; result: Promise<unknown>; done: boolean; expire?: ReturnType<typeof setTimeout> };

export function createPatience(o: { answerWithinMs: number; keepMs: number; now?: () => number }): Patience {
  const now = o.now ?? Date.now;
  /** Runs that outlived their answer: only these are joined, a call answered in time leaves nothing behind. */
  const late = new Map<string, Entry>();

  const wait = async <R>(key: string, e: Entry, stillWorking: (sinceMs: number) => R): Promise<R> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"late">((r) => {
      timer = setTimeout(() => r("late"), o.answerWithinMs);
      timer.unref?.();
    });
    try {
      const first = await Promise.race([e.result.then(() => "done" as const, () => "done" as const), deadline]);
      if (first === "late") {
        if (!late.has(key)) {
          late.set(key, e);
          // Once it is done, its result waits a while for the call that fetches it.
          void e.result
            .catch(() => undefined)
            .finally(() => {
              e.done = true;
              e.expire = setTimeout(() => late.get(key) === e && late.delete(key), o.keepMs);
              e.expire.unref?.();
            });
        }
        return stillWorking(now() - e.started);
      }
      // Fetched: a later identical call is a new one.
      if (late.get(key) === e) {
        late.delete(key);
        clearTimeout(e.expire);
      }
      return (await e.result) as R;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    run<R>(key: string, run: () => Promise<R>, stillWorking: (sinceMs: number) => R): Promise<R> {
      const going = late.get(key);
      if (going) return wait(key, going, stillWorking);
      const e: Entry = { started: now(), result: run(), done: false };
      // An unfetched failure must not become an unhandled rejection.
      e.result.catch(() => undefined);
      return wait(key, e, stillWorking);
    },
    get size() {
      return late.size;
    },
  };
}

/** The key of a tool call: its name and its arguments, independent of key order. */
export function callKey(tool: string, args: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;
  return `${tool} ${JSON.stringify(sorted(args ?? {}))}`;
}
