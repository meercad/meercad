/**
 * A project's picture, kept next to its file ("Bracket.meercad" → ".Bracket.meercad-preview"), so
 * that it travels with the project through iCloud: another Mac, iPad or iPhone takes it as it is
 * instead of building the model again, as long as the file is still the one that was pictured.
 *
 * Which file was pictured is told by its size and SHA-256 (of the bytes on disk), which every
 * device works out the same way; the look (LOOK_VERSION) says in which colours. A file changed
 * since, a picture of an older look or one that cannot be read is not taken: the picture is then
 * made again, as before. The pictures in the app's own data stay as they were (the one shown, also
 * for projects that have no such file, from older versions or other apps).
 *
 * The Mac app writes the same format (apps/desktop/src/main.ts, `sharedPicture`).
 */

/** The file next to a project's file, by the project file's name ("Bracket.meercad"). */
export const sidecarName = (projectFileName: string) =>
  `.${projectFileName.replace(/\.meercad$/, "")}.meercad-preview`;

export interface SharedPicture {
  /** The project file's size in bytes when it was pictured. */
  size: number;
  /** Its SHA-256 then, as hex. */
  sha256: string;
  /** The look the picture shows (LOOK_VERSION). */
  look: number;
  /** The picture, a PNG data URL. */
  thumbnail: string;
}

const PNG = "data:image/png;base64,";

export function formatSidecar(p: SharedPicture): string {
  return JSON.stringify({
    v: 1,
    size: p.size,
    sha256: p.sha256,
    look: p.look,
    png: p.thumbnail.slice(PNG.length),
  });
}

/** The picture in a sidecar's text, or null if it is not one this version reads. */
export function parseSidecar(text: string): SharedPicture | null {
  try {
    const o = JSON.parse(text) as {
      v?: unknown;
      size?: unknown;
      sha256?: unknown;
      look?: unknown;
      png?: unknown;
    };

    if (
      o.v !== 1 ||
      typeof o.size !== "number" ||
      typeof o.sha256 !== "string" ||
      typeof o.look !== "number" ||
      typeof o.png !== "string" ||
      !o.png
    ) {
      return null;
    }

    return { size: o.size, sha256: o.sha256, look: o.look, thumbnail: PNG + o.png };
  } catch {
    return null;
  }
}

/** SHA-256 of `bytes` as hex; null where the page has no Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;

  const d = new Uint8Array(await subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  let s = "";
  for (const b of d) s += b.toString(16).padStart(2, "0");

  return s;
}

/** Whether a sidecar's picture shows the project file as it is now (its look is checked by the overview). */
export function sidecarShows(p: SharedPicture, file: { size: number; sha256: string }): boolean {
  return p.size === file.size && p.sha256 === file.sha256;
}
