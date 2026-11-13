interface Deletable {
  delete(): void;
}

/** Owns OCCT objects created while computing one feature state; disposing frees them all. */
export class Arena {
  private items: Deletable[] = [];
  private disposed = false;
  /** Arenas whose objects this one's results use (see `adopt`). */
  private adopted: Arena[] = [];

  track<T extends Deletable>(obj: T): T {
    if (this.disposed) throw new Error("arena already disposed");

    this.items.push(obj);

    return obj;
  }

  dispose(): void {
    if (this.disposed) return;

    this.disposed = true;

    for (let i = this.items.length - 1; i >= 0; i--) {
      try {
        this.items[i]!.delete();
      } catch {
        // already deleted elsewhere; nothing to do
      }
    }

    this.items = [];
    for (const a of this.adopted) a.dispose();
    this.adopted = [];
  }

  /**
   * Takes over another arena: its objects now live as long as this one (a step that kept parts
   * of its earlier result, which that result's arena owns).
   */
  adopt(other: Arena): void {
    if (other !== this && !this.adopted.includes(other)) this.adopted.push(other);
  }

  /**
   * Frees the working objects of a finished step and keeps its shapes: the algorithms behind a cut
   * or a rounding hold many times the memory of their result, and a long design keeps every step's
   * state. Only shapes (TopoDS_…) are handed on between steps; everything else is the step's own.
   */
  trim(): void {
    if (this.disposed) return;

    const kept: Deletable[] = [];

    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]!;

      if (isShape(item)) {
        kept.push(item);
      } else {
        try {
          item.delete();
        } catch {
          // already deleted elsewhere; nothing to do
        }
      }
    }

    this.items = kept.reverse();
  }

  /** How many objects of each kind are held (diagnostics). */
  census(into: Map<string, number> = new Map()): Map<string, number> {
    for (const item of this.items) {
      const name = (item as object).constructor?.name ?? "?";
      into.set(name, (into.get(name) ?? 0) + 1);
    }

    return into;
  }

  get size(): number {
    return this.items.length;
  }
}

function isShape(item: Deletable): boolean {
  return ((item as object).constructor?.name ?? "").startsWith("TopoDS_");
}
