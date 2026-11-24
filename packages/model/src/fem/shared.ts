/**
 * Several threads for the heavy part of the strength calculation: applying the stiffness cube by
 * cube. All threads see one block of shared memory. The thread that calculates (the lead) lays its
 * arrays into that block and describes a job in its first numbers; helper threads sleep on those
 * numbers, wake for each job, do their share of it and report back. Without helpers everything
 * runs on the lead alone, with ordinary arrays.
 *
 * Cubes that share a node may not be worked on by two threads at once (both add to that node). So
 * a job has four parts: the rows of cubes (along x) with even y and even z, then odd y and even z,
 * and so on. Rows of one part share no node, and every thread simply takes the next row nobody has
 * taken yet, so a faster core does more of them and none waits long for another.
 */

/** Places of the numbers at the start of the shared memory (as 32-bit integers). */
const GENERATION = 0;
const DONE = 1;
const STOP = 2;
const READY = 3;
/** The job: which helpers take part (a bit each), then where its arrays lie (in bytes) and what to do. */
const TAKING_PART = 4;
const BRICK = 5;
const NODES = 6;
const SCALE = 7;
const SLABS = 8;
const PART = 9;
const INPUT = 10;
const OUTPUT = 11;
const LENGTH = 12;
const CUBES = 13;
const ROWS_Y = 14;
const ROWS_Z = 15;
/** The next row of the current part nobody has taken yet (counted in rows of that part). */
const NEXT = 16;
/** After this many waits of a second each without a report, a helper is taken as gone. */
const SILENT_WAITS = 10;
/** Bytes kept for those numbers; arrays are laid out after them. */
const HEADER = 256;

/**
 * The forces of some cubes for given movements, added to `output`: for the carrying cubes
 * `from…to`, each with its eight nodes in `nodes` and its stiffness in `scale`.
 */
export function applyRange(
  brick: Float64Array,
  nodes: Int32Array,
  scale: Float64Array,
  from: number,
  to: number,
  input: Float64Array,
  output: Float64Array,
): void {
  const local = new Float64Array(24);

  for (let i = from; i < to; i++) {
    const k = i;

    for (let c = 0; c < 8; c++) {
      const node = nodes[k * 8 + c]! * 3;

      local[c * 3] = input[node]!;
      local[c * 3 + 1] = input[node + 1]!;
      local[c * 3 + 2] = input[node + 2]!;
    }

    for (let row = 0; row < 24; row++) {
      let sum = 0;

      for (let column = 0; column < 24; column++) sum += brick[row * 24 + column]! * local[column]!;

      output[nodes[k * 8 + Math.floor(row / 3)]! * 3 + (row % 3)]! += scale[k]! * sum;
    }
  }
}

/** How many bits of a number are set. */
export const bitCount = (mask: number): number => {
  let count = 0;

  for (let bit = 0; bit < 31; bit++) count += (mask >> bit) & 1;

  return count;
};

/** Works on rows of the current part of the job in the shared memory until none is left. */
function work(memory: SharedArrayBuffer, control: Int32Array): void {
  const length = control[LENGTH]!;
  const cubes = control[CUBES]!;
  const ny = control[ROWS_Y]!;
  const nz = control[ROWS_Z]!;
  const oddY = control[PART]! & 1;
  const oddZ = control[PART]! >> 1;
  // The rows of this part: every second one along y and along z.
  const alongY = Math.ceil((ny - oddY) / 2);
  const rows = alongY * Math.ceil((nz - oddZ) / 2);
  const starts = new Int32Array(memory, control[SLABS]!, ny * nz + 1);
  const brick = new Float64Array(memory, control[BRICK]!, 576);
  const nodes = new Int32Array(memory, control[NODES]!, cubes * 8);
  const scale = new Float64Array(memory, control[SCALE]!, cubes);
  const input = new Float64Array(memory, control[INPUT]!, length);
  const output = new Float64Array(memory, control[OUTPUT]!, length);

  for (;;) {
    const taken = Atomics.add(control, NEXT, 1);

    if (taken >= rows) return;

    const row = oddY + 2 * (taken % alongY) + ny * (oddZ + 2 * Math.floor(taken / alongY));

    applyRange(brick, nodes, scale, starts[row]!, starts[row + 1]!, input, output);
  }
}

/**
 * One turn of a helper thread (number 0 to 29): if a new job is there and this helper takes part,
 * it does its share and reports. Returns the job it has now seen.
 */
export function helperTurn(memory: SharedArrayBuffer, helper: number, seen: number): number {
  const control = new Int32Array(memory, 0, HEADER / 4);
  const generation = Atomics.load(control, GENERATION);

  if (generation === seen) return seen;

  const takingPart = Atomics.load(control, TAKING_PART);

  if ((takingPart >> helper) & 1) {
    work(memory, control);
    Atomics.add(control, DONE, 1);
    Atomics.notify(control, DONE);
  }

  return generation;
}

/** What a helper thread runs: it says it is ready, then sleeps and works until told to stop. */
export function helperLoop(memory: SharedArrayBuffer, helper: number): void {
  const control = new Int32Array(memory, 0, HEADER / 4);
  let seen = Atomics.load(control, GENERATION);

  Atomics.or(control, READY, 1 << helper);

  while (!Atomics.load(control, STOP)) {
    Atomics.wait(control, GENERATION, seen, 1000);
    seen = helperTurn(memory, helper, seen);
  }
}

/** The lead's side: the shared memory with what is laid out in it, and the jobs given to the helpers. */
export class SharedWork {
  readonly memory: SharedArrayBuffer;
  private readonly control: Int32Array;
  private readonly waiting: (control: Int32Array, done: number) => unknown;
  private next = HEADER;

  /**
   * `waiting`: what the lead does while helpers are still at a job, given how many have reported
   * (by default it sleeps until the next one reports).
   */
  constructor(
    bytes: number,
    waiting = (control: Int32Array, done: number): unknown => Atomics.wait(control, DONE, done, 1000),
  ) {
    this.memory = new SharedArrayBuffer(bytes);
    this.control = new Int32Array(this.memory, 0, HEADER / 4);
    this.waiting = waiting;
  }

  /** Forgets everything laid out: the memory is free for the next calculation. */
  reset(): void {
    this.next = HEADER;
  }

  /** Room for `length` numbers of eight bytes each in the shared memory; null when it is full. */
  private room(length: number): number | null {
    const at = this.next;

    if (at + length * 8 > this.memory.byteLength) return null;

    this.next = at + length * 8;

    return at;
  }

  /** A list of `length` zeros in the shared memory, or an ordinary one when the memory is full. */
  floats(length: number): Float64Array {
    const at = this.room(length);

    return at === null ? new Float64Array(length) : new Float64Array(this.memory, at, length).fill(0);
  }

  /** The same for whole numbers (each takes eight bytes, so everything stays aligned). */
  integers(length: number): Int32Array {
    const at = this.room(length);

    return at === null ? new Int32Array(length) : new Int32Array(this.memory, at, length).fill(0);
  }

  /** Whether a list lies in the shared memory. */
  holds(list: Float64Array | Int32Array): boolean {
    return list.buffer === this.memory;
  }

  /** How many helpers are ready right now. */
  get helpers(): number {
    return bitCount(this.ready);
  }

  /** The helpers that are ready right now, a bit each. */
  get ready(): number {
    return Atomics.load(this.control, READY);
  }

  /**
   * The forces of all cubes for the movements `input`, added to `output`, worked out by the lead and
   * the helpers `takingPart` together. `rows` says where each row of cubes (along x; `ny` rows to a
   * layer, `nz` layers) starts, and where the last one ends; every list must lie in the shared memory.
   */
  apply(
    brick: Float64Array,
    nodes: Int32Array,
    scale: Float64Array,
    rows: Int32Array,
    ny: number,
    nz: number,
    takingPart: number,
    input: Float64Array,
    output: Float64Array,
  ): void {
    const control = this.control;
    const helpers = bitCount(takingPart);

    control[TAKING_PART] = takingPart;
    control[BRICK] = brick.byteOffset;
    control[NODES] = nodes.byteOffset;
    control[SCALE] = scale.byteOffset;
    control[SLABS] = rows.byteOffset;
    control[ROWS_Y] = ny;
    control[ROWS_Z] = nz;
    control[INPUT] = input.byteOffset;
    control[OUTPUT] = output.byteOffset;
    control[LENGTH] = input.length;
    control[CUBES] = scale.length;

    for (let part = 0; part < 4; part++) {
      control[PART] = part;
      Atomics.store(control, NEXT, 0);
      Atomics.store(control, DONE, 0);
      Atomics.add(control, GENERATION, 1);
      Atomics.notify(control, GENERATION);
      work(this.memory, control);

      let silent = 0;

      for (let done = Atomics.load(control, DONE); done < helpers; done = Atomics.load(control, DONE)) {
        // A helper that has gone (its thread ended) would be waited for for ever.
        if (this.waiting(control, done) === "timed-out" && ++silent >= SILENT_WAITS) {
          throw new Error("a helper thread of the strength calculation does not answer");
        }
      }
    }
  }

  /** Sends the helpers home. */
  stop(): void {
    Atomics.store(this.control, STOP, 1);
    Atomics.notify(this.control, GENERATION);
  }
}

let shared: SharedWork | null = null;

/** Sets (or, with null, takes away) the shared memory the strength calculation works in. */
export function useSharedWork(work: SharedWork | null): void {
  shared = work;
}

export const sharedWork = (): SharedWork | null => shared;

/** A list of `length` zeros: in the shared memory when there is one, so helpers can work on it. */
export const floats = (length: number): Float64Array => shared?.floats(length) ?? new Float64Array(length);
