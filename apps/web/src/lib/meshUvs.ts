/** Texture coordinates of a mesh part's shown triangles, from the coordinates of its file's corners. */

/**
 * Coordinates for every vertex of a part's mesh, or null when the part does not show the file's
 * triangles one to one (cut, combined, or the coordinates do not fit the file). `fileUvs` has two
 * per triangle corner in file order; a mesh with `source.flipped` shows corners 0, 2, 1.
 */
export function meshUvs(mesh: { source?: { flipped: boolean }; positions: Float32Array }, fileUvs: Float32Array): Float32Array | null {
  const corners = mesh.positions.length / 3;
  if (!mesh.source || fileUvs.length !== corners * 2) return null;
  const order = mesh.source.flipped ? [0, 2, 1] : [0, 1, 2];
  const out = new Float32Array(corners * 2);
  for (let v = 0; v < corners; v += 3)
    for (let k = 0; k < 3; k++) {
      const from = (v + order[k]!) * 2;
      out[(v + k) * 2] = fileUvs[from]!;
      out[(v + k) * 2 + 1] = fileUvs[from + 1]!;
    }
  return out;
}
