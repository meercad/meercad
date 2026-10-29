import Foundation
import simd

/// What LiDAR has seen inside a box, as a grid of small cubes, closed into a solid.
///
/// Every depth sample tells two things: there is a surface at the point, and the space between the
/// camera and the point is empty. Near the point each cube keeps a running average of its signed
/// distance to the surface (positive in front, negative behind), from all the views that saw it.
/// Cubes the rays only passed through are marked empty, cubes in the shadow behind a surface are
/// marked hidden. Hidden cubes no view ever saw empty count as material, so the result is always a
/// closed solid: the surfaces that were seen, with the space behind them filled. Cubes no ray came
/// near at all are empty. That works for any shape (curved, steps, walls, overhangs) and from any
/// direction.
///
/// The box has its own frame: x, y and z along `axes`, z up in the result. Coordinates of the box
/// run from 0 to `2 * half` (metres).
struct VoxelField {
    let origin: SIMD3<Float>
    let axes: simd_float3x3
    let half: SIMD3<Float>
    let voxel: Float
    let nx: Int, ny: Int, nz: Int
    /// How far around a surface the signed distance is kept (metres).
    let trunc: Float
    /// Everything below this height in the box counts as empty (cuts a slab off the bottom).
    var cutBelow: Float?
    /// Only a thin shell behind the seen surfaces is material (about `trunc` thick), not everything
    /// hidden behind them: for surfaces, where what lies behind can be far deeper than the part.
    var shellOnly = false
    /// Per cube, along how many of the three axes it lies between seen surfaces (see `limitToSeen`).
    private var enclosed: [UInt8]?
    private var tsdf: [Float]
    private var weight: [UInt8]
    private var free: [UInt8]
    private var behind: [UInt8]

    /// A box centred on `centre`, at most about `maxVoxels` cubes (finer for small boxes, never under 2 mm).
    init(centre: SIMD3<Float>, axes: simd_float3x3, half: SIMD3<Float>, maxVoxels: Float = 6_000_000) {
        origin = centre
        self.axes = axes
        self.half = half
        let volume = 8 * half.x * half.y * half.z
        voxel = max(0.002, cbrt(volume / maxVoxels))
        nx = Int((2 * half.x / voxel).rounded(.up))
        ny = Int((2 * half.y / voxel).rounded(.up))
        nz = Int((2 * half.z / voxel).rounded(.up))
        trunc = max(3 * voxel, 0.006)
        let count = nx * ny * nz
        tsdf = [Float](repeating: 0, count: count)
        weight = [UInt8](repeating: 0, count: count)
        free = [UInt8](repeating: 0, count: count)
        behind = [UInt8](repeating: 0, count: count)
    }

    /// A world point in grid units (cube centres at whole numbers).
    @inline(__always) func grid(_ p: SIMD3<Float>) -> SIMD3<Float> {
        (axes.transpose * (p - origin) + half) / voxel - 0.5
    }

    /// Adds one depth frame: the camera position and the points it saw (world, metres). `carve` says
    /// which points also clear the space up to them (a subset is enough, and much faster).
    mutating func integrate(camera: SIMD3<Float>, points: [SIMD3<Float>], carve: [Bool]) {
        // Locals only below: the arrays are borrowed for writing.
        let origin = self.origin, toBox = axes.transpose, half = self.half, voxel = self.voxel
        let toGrid = { (p: SIMD3<Float>) in (toBox * (p - origin) + half) / voxel - 0.5 }
        let c = toGrid(camera)
        let tv = trunc / voxel
        let nx = self.nx, ny = self.ny, nz = self.nz
        let lo = SIMD3<Float>(repeating: -0.5), hi = SIMD3<Float>(Float(nx) - 0.5, Float(ny) - 0.5, Float(nz) - 0.5)
        tsdf.withUnsafeMutableBufferPointer { tsdf in
            weight.withUnsafeMutableBufferPointer { weight in
                free.withUnsafeMutableBufferPointer { free in
                  behind.withUnsafeMutableBufferPointer { behind in
                    for (n, point) in points.enumerated() {
                        let p = toGrid(point)
                        let d = p - c
                        let len = simd_length(d)
                        guard len > 1e-4 else { continue }
                        let dir = d / len
                        // Where the ray is inside the box.
                        let inv = 1 / dir
                        let t0 = (lo - c) * inv, t1 = (hi - c) * inv
                        let enter = max(0, simd_reduce_max(simd_min(t0, t1)))
                        let exit = simd_reduce_min(simd_max(t0, t1))
                        guard exit > enter else { continue }
                        // Around the surface: signed distance, averaged over views.
                        var last = -1
                        var t = max(enter, len - tv)
                        let end = min(exit, len + tv)
                        while t <= end {
                            let q = c + dir * t
                            let i = Int(q.x.rounded()), j = Int(q.y.rounded()), k = Int(q.z.rounded())
                            t += 0.5
                            guard i >= 0, j >= 0, k >= 0, i < nx, j < ny, k < nz else { continue }
                            let idx = (k * ny + j) * nx + i
                            guard idx != last else { continue }
                            last = idx
                            let centre = SIMD3<Float>(Float(i), Float(j), Float(k))
                            let sdf = max(-1, min(1, simd_dot(p - centre, dir) / tv))
                            let w = Float(weight[idx])
                            tsdf[idx] = (tsdf[idx] * w + sdf) / (w + 1)
                            if weight[idx] < 60 { weight[idx] += 1 }
                        }
                        // In front of it: empty; behind it, to the box's edge: hidden.
                        guard carve[n] else { continue }
                        t = enter
                        let stop = min(exit, len - tv)
                        while t < stop {
                            let q = c + dir * t
                            let i = Int(q.x.rounded()), j = Int(q.y.rounded()), k = Int(q.z.rounded())
                            t += 1
                            guard i >= 0, j >= 0, k >= 0, i < nx, j < ny, k < nz else { continue }
                            let idx = (k * ny + j) * nx + i
                            if free[idx] < 255 { free[idx] += 1 }
                        }
                        t = max(enter, len + tv)
                        while t < exit {
                            let q = c + dir * t
                            let i = Int(q.x.rounded()), j = Int(q.y.rounded()), k = Int(q.z.rounded())
                            t += 1
                            guard i >= 0, j >= 0, k >= 0, i < nx, j < ny, k < nz else { continue }
                            let idx = (k * ny + j) * nx + i
                            if behind[idx] < 255 { behind[idx] += 1 }
                        }
                    }
                  }
                }
            }
        }
    }

    /// Share of the box that was seen, as surface or as empty space (0…1).
    var seen: Double {
        var n = 0
        for i in 0..<weight.count where weight[i] > 0 || free[i] >= 2 || behind[i] > 0 { n += 1 }
        return Double(n) / Double(weight.count)
    }

    /// Positive outside the solid (empty), negative inside (material, or hidden behind a surface).
    @inline(__always) private func value(_ i: Int, _ j: Int, _ k: Int) -> Float {
        guard i >= 0, j >= 0, k >= 0, i < nx, j < ny, k < nz else { return 1 }
        if let cut = cutBelow, (Float(k) + 0.5) * voxel < cut { return 1 }
        let idx = (k * ny + j) * nx + i
        if weight[idx] > 0 { return tsdf[idx] }
        if shellOnly { return 1 }
        // Seen empty from somewhere beats hidden from elsewhere; untouched space is empty.
        if free[idx] >= 2 { return 1 }
        guard behind[idx] > 0 else { return 1 }
        if let enclosed, enclosed[idx] < 2 { return 1 }
        return -1
    }

    /// Hidden space counts as material only where seen surfaces close it in: between two of them along
    /// at least two of the three axes (the floor counts as one from below when `floorClosed`). Without
    /// this, a side never looked at would be filled out to the box's wall.
    mutating func limitToSeen(floorClosed: Bool) {
        var count = [UInt8](repeating: 0, count: nx * ny * nz)
        let nx = self.nx, ny = self.ny, nz = self.nz
        weight.withUnsafeBufferPointer { weight in
            tsdf.withUnsafeBufferPointer { tsdf in
                count.withUnsafeMutableBufferPointer { count in
                    let surface = { (idx: Int) in weight[idx] >= 2 && abs(tsdf[idx]) < 0.5 }
                    // One line of cubes: `n` long, `stride` apart from `start`.
                    func line(_ start: Int, _ stride: Int, _ n: Int, closedBelow: Bool) {
                        var first = closedBelow ? 0 : -1, last = -1
                        for t in 0..<n where surface(start + t * stride) {
                            if first < 0 { first = t }
                            last = t
                        }
                        guard first >= 0, last > first else { return }
                        for t in first...last { count[start + t * stride] += 1 }
                    }
                    for k in 0..<nz { for j in 0..<ny { line((k * ny + j) * nx, 1, nx, closedBelow: false) } }
                    for k in 0..<nz { for i in 0..<nx { line(k * ny * nx + i, nx, ny, closedBelow: false) } }
                    for j in 0..<ny { for i in 0..<nx { line(j * nx + i, nx * ny, nz, closedBelow: floorClosed) } }
                }
            }
        }
        enclosed = count
    }

    /// Height in the box (metres) just above the table or floor, if some of it came into the bottom of
    /// the box: the highest layer in the lowest few centimetres where surface spreads over a large
    /// share of the box (an object's foot covers far less).
    func floorLayer() -> Float? {
        let needed = nx * ny / 6
        var top: Int?
        for k in 0..<min(nz, Int((0.04 / voxel).rounded(.up))) {
            var n = 0
            for idx in k * nx * ny..<(k + 1) * nx * ny where weight[idx] >= 2 && abs(tsdf[idx]) < 0.5 { n += 1 }
            if n >= needed { top = k }
        }
        return top.map { Float($0 + 2) * voxel }
    }

    /// The solids as triangle corners in millimetres, in the box's frame with z up: centred in x and y,
    /// the lowest point at z = 0, simplified to at most `budget` triangles in all (flat parts get few,
    /// curved parts and edges keep theirs). One list per separate piece (two objects in the box are two
    /// parts); crumbs of noise are dropped.
    func solids(budget: Int = 25_000) -> (pieces: [[SIMD3<Float>]], cell: Float)? {
        // One pass of [1 2 1] smoothing in each direction calms the noise and rounds off the steps of
        // hidden space; then the field is sampled every `f` cubes (1 unless the mesh gets huge).
        var field = [Float](repeating: 1, count: (nx + 2) * (ny + 2) * (nz + 2))
        let sx = nx + 2, sy = ny + 2, sz = nz + 2
        for k in 0..<sz {
            for j in 0..<sy {
                for i in 0..<sx { field[(k * sy + j) * sx + i] = value(i - 1, j - 1, k - 1) }
            }
        }
        Self.blur(&field, sx, sy, sz)
        for f in 1...8 {
            let mx = (sx + f - 1) / f + 1, my = (sy + f - 1) / f + 1, mz = (sz + f - 1) / f + 1
            var g = [Float](repeating: 1, count: mx * my * mz)
            for k in 1..<mz - 1 {
                for j in 1..<my - 1 {
                    for i in 1..<mx - 1 {
                        // The outermost layer stays empty, so the solid is closed.
                        let a = min(sx - 1, i * f), b = min(sy - 1, j * f), c = min(sz - 1, k * f)
                        g[(k * my + j) * mx + i] = field[(c * sy + b) * sx + a]
                    }
                }
            }
            // Sample (i, j, k) sits at field index i*f = grid index i*f - 1, box coordinate (i*f - 0.5) * voxel.
            let voxel = self.voxel
            guard var mesh = Self.tetrahedra(g, mx, my, mz, limit: 1_500_000, place: { ($0 * Float(f) - 0.5) * voxel }) else { continue }
            guard !mesh.faces.isEmpty else { return nil }
            // Simplify within a fraction of a cube, then further if still over budget.
            MeshSimplify.run(&mesh, target: budget, maxError: voxel * 0.25)
            if mesh.faces.count > budget { MeshSimplify.run(&mesh, target: budget, maxError: .greatestFiniteMagnitude) }
            let pieces = Self.pieces(mesh).filter { $0.count >= max(100, mesh.faces.count / 100) }
            guard !pieces.isEmpty else { return nil }
            var lo = SIMD3<Float>(repeating: .greatestFiniteMagnitude), hi = -lo
            for piece in pieces {
                for t in piece {
                    for v in [t.x, t.y, t.z] {
                        lo = simd_min(lo, mesh.points[Int(v)])
                        hi = simd_max(hi, mesh.points[Int(v)])
                    }
                }
            }
            let shift = SIMD3<Float>((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z)
            let out = pieces.map { piece in piece.flatMap { t in [t.x, t.y, t.z].map { (mesh.points[Int($0)] - shift) * 1000 } } }
            return (out, voxel * Float(f))
        }
        return nil
    }

    /// The faces of each connected piece of a mesh, largest first.
    static func pieces(_ mesh: MeshSimplify.Mesh) -> [[SIMD3<Int32>]] {
        var parent = Array(0..<mesh.points.count)
        func find(_ x: Int) -> Int {
            var x = x
            while parent[x] != x {
                parent[x] = parent[parent[x]]
                x = parent[x]
            }
            return x
        }
        for t in mesh.faces {
            let a = find(Int(t.x)), b = find(Int(t.y))
            parent[b] = a
            parent[find(Int(t.z))] = a
        }
        var groups: [Int: [SIMD3<Int32>]] = [:]
        for t in mesh.faces { groups[find(Int(t.x)), default: []].append(t) }
        return groups.values.sorted { $0.count > $1.count }
    }

    static func blur(_ g: inout [Float], _ sx: Int, _ sy: Int, _ sz: Int) {
        var tmp = g
        let strides = [1, sx, sx * sy], sizes = [sx, sy, sz]
        for axis in 0..<3 {
            let s = strides[axis], n = sizes[axis]
            for idx in 0..<g.count {
                let pos = (idx / s) % n
                guard pos > 0, pos < n - 1 else { tmp[idx] = g[idx]; continue }
                tmp[idx] = (g[idx - s] + 2 * g[idx] + g[idx + s]) / 4
            }
            swap(&g, &tmp)
        }
    }

    /// Marching tetrahedra: every cube of the sample grid splits into six tetrahedra around its main
    /// diagonal (the same way in every cube, so neighbours share faces). Each tetrahedron cut by the
    /// surface gives one or two triangles; corners on a shared edge are the same point, so the mesh
    /// is closed. Triangles face outwards. Nil if the mesh would exceed `limit` triangles.
    static func tetrahedra(_ g: [Float], _ mx: Int, _ my: Int, _ mz: Int, limit: Int, place: (SIMD3<Float>) -> SIMD3<Float>) -> MeshSimplify.Mesh? {
        let cube: [SIMD3<Int>] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
        let tets = [[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]]
        var ids: [Int: Int32] = [:]
        var points: [SIMD3<Float>] = []
        var faces: [SIMD3<Int32>] = []
        let index = { (p: SIMD3<Int>) in (p.z * my + p.y) * mx + p.x }
        let at = { (p: SIMD3<Int>) -> Float in
            let v = g[index(p)]
            return abs(v) < 1e-4 ? 1e-4 : v
        }
        // The surface point on the edge between two corners, the same for every tetrahedron using it.
        func edge(_ a: SIMD3<Int>, _ b: SIMD3<Int>) -> Int32 {
            let ia = index(a), ib = index(b)
            let key = min(ia, ib) * (mx * my * mz) + max(ia, ib)
            if let id = ids[key] { return id }
            let va = at(a), vb = at(b)
            let t = max(0.01, min(0.99, va / (va - vb)))
            points.append(place(SIMD3<Float>(a) + (SIMD3<Float>(b) - SIMD3<Float>(a)) * t))
            let id = Int32(points.count - 1)
            ids[key] = id
            return id
        }
        func emit(_ a: Int32, _ b: Int32, _ c: Int32, outward: SIMD3<Float>) {
            let pa = points[Int(a)], pb = points[Int(b)], pc = points[Int(c)]
            faces.append(simd_dot(simd_cross(pb - pa, pc - pa), outward) < 0 ? SIMD3(a, c, b) : SIMD3(a, b, c))
        }
        for k in 0..<mz - 1 {
            for j in 0..<my - 1 {
                for i in 0..<mx - 1 {
                    let base = SIMD3<Int>(i, j, k)
                    var any = false, all = true
                    for c in cube {
                        let neg = at(base &+ c) < 0
                        any = any || neg
                        all = all && neg
                    }
                    guard any, !all else { continue }
                    for tet in tets {
                        let p = tet.map { base &+ cube[$0] }
                        let inside = p.filter { at($0) < 0 }, outside = p.filter { at($0) >= 0 }
                        guard !inside.isEmpty, !outside.isEmpty else { continue }
                        let ci = inside.reduce(SIMD3<Float>.zero) { $0 + SIMD3<Float>($1) } / Float(inside.count)
                        let co = outside.reduce(SIMD3<Float>.zero) { $0 + SIMD3<Float>($1) } / Float(outside.count)
                        let outward = co - ci
                        if inside.count == 1 || outside.count == 1 {
                            let (lone, rest) = inside.count == 1 ? (inside[0], outside) : (outside[0], inside)
                            emit(edge(lone, rest[0]), edge(lone, rest[1]), edge(lone, rest[2]), outward: outward)
                        } else {
                            let a = edge(inside[0], outside[0]), b = edge(inside[0], outside[1])
                            let c = edge(inside[1], outside[1]), d = edge(inside[1], outside[0])
                            emit(a, b, c, outward: outward)
                            emit(a, c, d, outward: outward)
                        }
                    }
                    if faces.count > limit { return nil }
                }
            }
        }
        // The outward hint comes from grid indices; `place` keeps orientation (it only scales and shifts).
        return MeshSimplify.Mesh(points: points, faces: faces)
    }
}
