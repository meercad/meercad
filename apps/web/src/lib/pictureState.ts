/**
 * When a project's picture in the overview may be taken, and when a saved one is out of date.
 *
 * The picture is taken from the editor's 3D view. While a rebuild is still running that view shows
 * the state before the change (or nothing at all right after opening), so a picture taken then shows
 * an old or empty model. Such a picture is not taken: the project is saved without one, and its old
 * picture, now older than the file, is made again in the overview. A rebuild that ends later takes
 * the picture after all.
 */
import type { MeercadDocument } from "@meercad/schema";

/** What the editor's view shows right now. */
export interface ViewState {
  /** The document whose final rebuild (not a dialog's preview) the view shows; null before the first one. */
  shown: MeercadDocument | null;
  /** The document as it is now (a change replaces the object). */
  current: MeercadDocument;
  /** A dialog's or an assistant's preview is on screen instead of the document. */
  previewing: boolean;
}

/** The view pictures exactly the document as saved now. */
export function viewIsCurrent(v: ViewState): boolean {
  return v.shown !== null && v.shown === v.current && !v.previewing;
}

/** A project as the overview lists it. */
export interface PictureMeta {
  updatedAt: number;
  thumbnail?: string;
  /** When the picture was written; unknown for stores that do not say. */
  thumbnailAt?: number;
}

/**
 * Whether a picture's pixels (RGBA) show nothing at all. Such pictures were saved before
 * 2026-11-09 while the view was still empty, and copying the app's data to the RC gave them a new
 * date, so their age alone does not show that they are wrong.
 */
export function blankPixels(rgba: ArrayLike<number>): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) return false;
  return true;
}

/**
 * The overview makes a new picture: there is none, it shows nothing (`blank`, see blankPixels), it
 * was written before the file was last changed, or before `lookSince` (when this app first drew
 * parts in their current colours, see lookSince). A save writes the file first and its picture right
 * after, so a current picture is never older than its file.
 */
export function needsPicture(p: PictureMeta, blank = false, lookSince = 0): boolean {
  if (!p.thumbnail || blank) return true;
  return p.thumbnailAt !== undefined && (p.thumbnailAt < p.updatedAt || p.thumbnailAt < lookSince);
}

/** What lookSince remembers: the look's version and when this app first drew it. */
export interface LookMark {
  version: number;
  since: number;
}

/**
 * When this app first drew parts in look `version` (see LOOK_VERSION in the viewport): pictures
 * written before then show the old colours and are made again. `stored` is the mark kept from
 * before; the mark to keep is returned with the time (a new one when the look changed).
 */
export function lookSince(stored: LookMark | null, version: number, now: number): LookMark {
  return stored && stored.version === version ? stored : { version, since: now };
}

/**
 * The overview's background pictures, one run at a time: the user's projects first, then the
 * examples. Some examples take longer than the time limit to build in the background kernel (coil,
 * springs), and while they went first a project's picture could wait minutes, or never come when
 * the overview was left before. A call during a run asks for one more run after it, so a project
 * added or changed meanwhile still gets its picture.
 */
export function pictureRunner(steps: { projects: () => Promise<void>; examples: () => Promise<void> }): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  const run = async (): Promise<void> => {
    do {
      again = false;
      await steps.projects();
      await steps.examples();
    } while (again);
  };
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = run().finally(() => (running = null));
    return running;
  };
}

/**
 * Designs with more steps than this are not built in the background on the iPad and iPhone: the
 * kernel keeps about 1 MB per step of a big design (docs/REBUILD.md), and the page has room for one
 * such kernel only, the editor's.
 */
export const BIG_STEPS = 300;
/**
 * Files bigger than this are not even read for that on the iPad and iPhone: reading the robot's
 * 40 MB file alone took the page past a GB for a moment.
 */
export const BIG_FILE_BYTES = 8 * 2 ** 20;

/**
 * Whether the overview may build `doc` in its background kernel now. Where there is room for one
 * kernel only (`oneKernel`: iPad and iPhone), not while a project is open in the editor, and not a
 * big design (BIG_STEPS), which gets its picture when it is opened.
 */
export function backgroundBuildAllowed(doc: Pick<MeercadDocument, "features">, at: { oneKernel: boolean; editorOpen: boolean }): boolean {
  if (!at.oneKernel) return true;
  return !at.editorOpen && doc.features.length <= BIG_STEPS;
}

/**
 * The kinds of kernel: OCCT built with threads (parallel meshing and booleans), without, and without
 * but with its memory taken at once ("kernel-reserve", see reserveHeap in the kernel).
 */
export type KernelKind = "kernel" | "kernel-threads" | "kernel-reserve";

/**
 * Which kernel the editor builds a design of `steps` steps in. On the iPad and iPhone a big design
 * (BIG_STEPS) is built without threads and in memory taken at once: each thread keeps memory of its
 * own (the robot design, 1062 steps, took 1.9 to 2.3 GB with threads against 1.1 GB without, for
 * 30 % more time), and a memory that grows is copied there. Either way the page outgrew what the
 * iPhone allows it and was loaded again, over and over.
 */
export function kernelKindFor(steps: number, at: { mobile: boolean; threads: boolean }): KernelKind {
  if (at.mobile && steps > BIG_STEPS) return "kernel-reserve";
  return at.threads ? "kernel-threads" : at.mobile ? "kernel-reserve" : "kernel";
}
