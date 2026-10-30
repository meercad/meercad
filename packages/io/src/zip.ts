import { strToU8, zipSync } from "fflate";

/** A zip archive of the given files (name → contents), e.g. one export per variant. */
export function writeZip(files: Readonly<Record<string, Uint8Array | string>>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, typeof data === "string" ? strToU8(data) : data])));
}
