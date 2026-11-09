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
 * The overview makes a new picture: there is none, or it was written before the file was last
 * changed. A save writes the file first and its picture right after, so a current picture is never
 * older than its file.
 */
export function needsPicture(p: PictureMeta): boolean {
  if (!p.thumbnail) return true;
  return p.thumbnailAt !== undefined && p.thumbnailAt < p.updatedAt;
}
