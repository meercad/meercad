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
 * The overview makes a new picture: there is none, it shows nothing (`blank`, see blankPixels), or
 * it was written before the file was last changed. A save writes the file first and its picture
 * right after, so a current picture is never older than its file.
 */
export function needsPicture(p: PictureMeta, blank = false): boolean {
  if (!p.thumbnail || blank) return true;
  return p.thumbnailAt !== undefined && p.thumbnailAt < p.updatedAt;
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
