interface Deletable {
  delete(): void;
}

/** Owns OCCT objects created while computing one feature state; disposing frees them all. */
export class Arena {
  private items: Deletable[] = [];
  private disposed = false;

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
  }

  get size(): number {
    return this.items.length;
  }
}
