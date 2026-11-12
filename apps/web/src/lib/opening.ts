/**
 * Opening a project (or an example) from the overview can take seconds for a big design: the file
 * is read (in iCloud first fetched) and parsed. Tapping the card again meanwhile must not start a
 * second opening: each one showed its own "Opening …" bar, and each one that finished loaded the
 * design into the editor again, under the "Building the model" overlay of the one before.
 */

export interface OpenGuard {
  /**
   * Runs `open` for `key` unless an opening of `key` is running: then that one's promise. `current`
   * tells the opening whether it is still the one asked for last; an older one leaves the editor
   * to the newer.
   */
  run(key: string, open: (current: () => boolean) => Promise<void>): Promise<void>;
  /** Whether an opening of `key` is running. */
  busy(key: string): boolean;
}

export function openGuard(): OpenGuard {
  const running = new Map<string, { ticket: number; done: Promise<void> }>();
  let latest = 0;
  return {
    run(key, open) {
      const now = running.get(key);
      if (now) {
        // Tapped again: this one is again the one asked for last.
        latest = now.ticket;
        return now.done;
      }
      const ticket = ++latest;
      const entry = { ticket, done: Promise.resolve() };
      entry.done = (async () => {
        try {
          await open(() => latest === ticket);
        } finally {
          if (running.get(key) === entry) running.delete(key);
        }
      })();
      running.set(key, entry);
      return entry.done;
    },
    busy: (key) => running.has(key),
  };
}

/**
 * The tasks left once the editor shows a design: a task that only covers the way there ("Opening
 * …") ends then, since the editor shows its own progress ("Building the model").
 */
export function tasksOnEditor<T extends { untilEditor?: boolean }>(tasks: T[]): T[] {
  return tasks.some((x) => x.untilEditor) ? tasks.filter((x) => !x.untilEditor) : tasks;
}
