import Foundation
import simd

/// The height of a surface over a square patch, gathered from many LiDAR depth samples and closed
/// into a solid: the surface on top, material below it down to a flat base.
///
/// Coordinates are the patch's own: x and y along the surface, z out of it (towards the phone), in
/// metres. A surface that is seen from one side (a recess, a contour, a relief) is fully described by
/// its height over the patch; undercuts are not. Each cell keeps a handful of samples and uses their
/// median, so stray depth readings (edges, reflections) do not show.
struct SurfaceField {
    /// Half the patch's side, and the size of one cell (metres).
    let half: Float
    let cell: Float
    /// How far below and above the patch samples are kept (metres).
    let below: Float
    let above: Float
    let side: Int
    private static let keep = 24
    private var samples: [Float]
    private var counts: [UInt16]
    private var seen: [UInt32]
    private var rng = SystemRandomNumberGenerator()

    init(size: Float, cell: Float = 0.001, below: Float = 0.25, above: Float = 0.15) {
        half = size / 2
        self.cell = cell
        self.below = below
        self.above = above
        side = Int((size / cell).rounded())
        samples = [Float](repeating: 0, count: side * side * Self.keep)
        counts = [UInt16](repeating: 0, count: side * side)
        seen = [UInt32](repeating: 0, count: side * side)
    }

    /// Adds one sample in patch coordinates; samples outside the patch are ignored.
    mutating func add(_ p: SIMD3<Float>) {
        guard p.z > -below, p.z < above else { return }
        let i = Int(((p.x + half) / cell).rounded(.down)), j = Int(((p.y + half) / cell).rounded(.down))
        guard i >= 0, j >= 0, i < side, j < side else { return }
        let c = j * side + i
        seen[c] &+= 1
        let n = Int(counts[c])
        // Once full, a new sample replaces a random one, so every view of the cell has a say.
        if n < Self.keep {
            samples[c * Self.keep + n] = p.z
            counts[c] = UInt16(n + 1)
        } else {
            let r = Int(UInt32.random(in: 0..<seen[c], using: &rng))
            if r < Self.keep { samples[c * Self.keep + r] = p.z }
        }
    }

    /// Share of cells with enough samples to trust (0…1).
    var coverage: Double {
        Double(counts.lazy.filter { $0 >= 3 }.count) / Double(counts.count)
    }

    /// A small picture of the patch for the screen: grey where nothing was seen yet, coloured by height
    /// where it was (RGBA, `size` × `size`, row 0 at the top = far edge of the patch).
    func preview(size: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: size * size * 4)
        let step = max(1, side / size)
        for y in 0..<size {
            for x in 0..<size {
                let i = min(side - 1, x * side / size), j = min(side - 1, (size - 1 - y) * side / size)
                var n = 0, sum: Float = 0
                for dj in 0..<step where j + dj < side {
                    for di in 0..<step where i + di < side {
                        let c = (j + dj) * side + i + di
                        let k = Int(counts[c])
                        guard k >= 3 else { continue }
                        n += 1
                        sum += samples[c * Self.keep]
                    }
                }
                let o = (y * size + x) * 4
                if n == 0 {
                    out[o] = 70; out[o + 1] = 70; out[o + 2] = 80; out[o + 3] = 140
                } else {
                    // Low = blue, high = yellow over ±5 cm.
                    let t = max(0, min(1, (sum / Float(n)) / 0.1 + 0.5))
                    out[o] = UInt8(40 + 215 * t); out[o + 1] = UInt8(120 + 100 * t); out[o + 2] = UInt8(230 - 190 * t); out[o + 3] = 230
                }
            }
        }
        return out
    }

    /// The scanned part of the patch as a closed solid, as triangle corners in millimetres with z up:
    /// centred on the scanned area, the base `base` below the lowest point and at z = 0.
    /// Gaps inside the scanned area are filled from their neighbours; the grid is coarsened to at most
    /// `maxSide` cells per side so the part stays light to work with.
    func solid(maxSide: Int = 128, base: Float = 0.003) -> [SIMD3<Float>]? {
        // Median height per trusted cell.
        var height = [Float](repeating: .nan, count: side * side)
        var lo = (side, side), hi = (-1, -1)
        for c in 0..<side * side where counts[c] >= 3 {
            let n = Int(counts[c])
            var v = Array(samples[c * Self.keep..<c * Self.keep + n])
            v.sort()
            height[c] = v[n / 2]
            let i = c % side, j = c / side
            lo = (min(lo.0, i), min(lo.1, j))
            hi = (max(hi.0, i), max(hi.1, j))
        }
        guard hi.0 - lo.0 >= 2, hi.1 - lo.1 >= 2 else { return nil }

        // Coarse grid over the scanned rectangle; each coarse cell takes the median of its fine cells.
        let w = hi.0 - lo.0 + 1, h = hi.1 - lo.1 + 1
        let factor = max(1, Int((Double(max(w, h)) / Double(maxSide)).rounded(.up)))
        let cw = (w + factor - 1) / factor, ch = (h + factor - 1) / factor
        var grid = [Float](repeating: .nan, count: cw * ch)
        for gj in 0..<ch {
            for gi in 0..<cw {
                var v: [Float] = []
                for j in lo.1 + gj * factor..<min(lo.1 + (gj + 1) * factor, hi.1 + 1) {
                    for i in lo.0 + gi * factor..<min(lo.0 + (gi + 1) * factor, hi.0 + 1) where !height[j * side + i].isNaN {
                        v.append(height[j * side + i])
                    }
                }
                if !v.isEmpty {
                    v.sort()
                    grid[gj * cw + gi] = v[v.count / 2]
                }
            }
        }
        Self.fillGaps(&grid, cw, ch)
        grid = Self.median3(grid, cw, ch)
        let step = cell * Float(factor)
        let minZ = grid.min() ?? 0
        let floor = minZ - base
        // Patch coordinates of coarse cell centres, then centred on the scanned area.
        let x0 = -half + (Float(lo.0) + Float(factor) / 2) * cell, y0 = -half + (Float(lo.1) + Float(factor) / 2) * cell
        let cx = x0 + step * Float(cw - 1) / 2, cy = y0 + step * Float(ch - 1) / 2
        let top = { (i: Int, j: Int) in SIMD3<Float>(x0 + step * Float(i) - cx, y0 + step * Float(j) - cy, grid[j * cw + i] - floor) * 1000 }
        let bottom = { (i: Int, j: Int) in SIMD3<Float>(x0 + step * Float(i) - cx, y0 + step * Float(j) - cy, 0) * 1000 }
        return Self.close(cw, ch, top: top, bottom: bottom)
    }

    /// Cells nobody saw take the average of their seen neighbours, growing in from the edges of gaps.
    static func fillGaps(_ g: inout [Float], _ w: Int, _ h: Int) {
        var missing = g.indices.filter { g[$0].isNaN }
        while !missing.isEmpty {
            var next: [Int] = []
            var filled: [(Int, Float)] = []
            for c in missing {
                let i = c % w, j = c / w
                var sum: Float = 0, n: Float = 0
                for (di, dj) in [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)] {
                    let a = i + di, b = j + dj
                    guard a >= 0, b >= 0, a < w, b < h, !g[b * w + a].isNaN else { continue }
                    sum += g[b * w + a]
                    n += 1
                }
                if n > 0 { filled.append((c, sum / n)) } else { next.append(c) }
            }
            if filled.isEmpty { return }
            for (c, v) in filled { g[c] = v }
            missing = next
        }
    }

    /// Each cell becomes the median of itself and its neighbours: calms the remaining noise and keeps
    /// steps (the edge of a recess) sharp.
    static func median3(_ g: [Float], _ w: Int, _ h: Int) -> [Float] {
        var out = g
        var v: [Float] = []
        v.reserveCapacity(9)
        for j in 0..<h {
            for i in 0..<w {
                v.removeAll(keepingCapacity: true)
                for b in max(0, j - 1)...min(h - 1, j + 1) {
                    for a in max(0, i - 1)...min(w - 1, i + 1) { v.append(g[b * w + a]) }
                }
                v.sort()
                out[j * w + i] = v[v.count / 2]
            }
        }
        return out
    }

    /// A height grid as a closed, outward-facing triangle mesh: top surface, four walls and a base.
    static func close(_ w: Int, _ h: Int, top: (Int, Int) -> SIMD3<Float>, bottom: (Int, Int) -> SIMD3<Float>) -> [SIMD3<Float>] {
        var out: [SIMD3<Float>] = []
        out.reserveCapacity((w - 1) * (h - 1) * 6 + (w + h) * 24)
        for j in 0..<h - 1 {
            for i in 0..<w - 1 {
                let a = top(i, j), b = top(i + 1, j), c = top(i + 1, j + 1), d = top(i, j + 1)
                out += [a, b, c, a, c, d]
            }
        }
        // The rim, counter-clockwise seen from above: walls face out, the base is a fan facing down.
        var rim: [(Int, Int)] = []
        for i in 0..<w - 1 { rim.append((i, 0)) }
        for j in 0..<h - 1 { rim.append((w - 1, j)) }
        for i in stride(from: w - 1, to: 0, by: -1) { rim.append((i, h - 1)) }
        for j in stride(from: h - 1, to: 0, by: -1) { rim.append((0, j)) }
        let centre = rim.reduce(SIMD3<Float>.zero) { $0 + bottom($1.0, $1.1) } / Float(rim.count)
        for k in 0..<rim.count {
            let (i0, j0) = rim[k], (i1, j1) = rim[(k + 1) % rim.count]
            let t0 = top(i0, j0), t1 = top(i1, j1), b0 = bottom(i0, j0), b1 = bottom(i1, j1)
            out += [b0, b1, t1, b0, t1, t0]
            out += [centre, b1, b0]
        }
        return out
    }
}
