/** Heat-set insert sizes for assistants planning holes and bosses (no app needed). */
import { INSERT_SIZES, insertDims, insertLengths } from "@meercad/model";

const r = (v: number) => +v.toFixed(2);

/**
 * Per size (or one size): the lengths it comes in, the hole to melt it into, its outside, the
 * thinnest wall around it, and what that means for a boss (its smallest outside diameter) and for
 * the closest centre distance to an edge or to the next insert.
 */
export function insertSizes(a: { size?: string | undefined }) {
  const sizes = a.size ? [a.size] : INSERT_SIZES;

  if (a.size && !INSERT_SIZES.includes(a.size)) {
    throw new Error(`unknown insert size "${a.size}": use one of ${INSERT_SIZES.join(", ")}`);
  }

  return {
    inserts: sizes.map((size) => {
      const d = insertDims(size)!;

      return {
        size,
        lengths: insertLengths(size),
        hole: d.hole,
        outer: d.outer,
        minWall: d.wall,
        holeDepth: insertLengths(size).map((l) => r(l + 1)),
        minBossDiameter: r(d.hole + 2 * d.wall),
        minEdgeDistance: r(d.hole / 2 + d.wall),
        minSpacing: r(d.hole + d.wall),
      };
    }),
    notes:
      'Sizes as the common makers recommend for knurled brass inserts in printed plastic (hole straight, 1 mm deeper than the insert). In a model use a hole feature with kind "insert", size, length (one of lengths, default the first) and withInserts:true to add the inserts as parts for the parts list; the rebuild warns where the wall is thinner than minWall. Check the data of the inserts you buy.',
  };
}
