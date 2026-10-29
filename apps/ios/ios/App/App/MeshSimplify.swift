import Foundation
import simd

/// Fewer triangles for a closed mesh, where it matters least: edges are collapsed in order of how
/// far the surface would move (quadric error), flat areas first. A collapse is skipped when it would
/// tear the mesh open, fold a triangle over, or move the surface more than `maxError`, so the result
/// stays closed and keeps its edges.
enum MeshSimplify {
    struct Mesh {
        var points: [SIMD3<Float>]
        var faces: [SIMD3<Int32>]
    }

    static func run(_ mesh: inout Mesh, target: Int, maxError: Float) {
        var points = mesh.points
        var faces = mesh.faces
        var alive = [Bool](repeating: true, count: faces.count)
        var live = faces.count
        // Faces around each point.
        var around = [[Int32]](repeating: [], count: points.count)
        for (f, t) in faces.enumerated() {
            for v in [t.x, t.y, t.z] { around[Int(v)].append(Int32(f)) }
        }
        var quadric = [simd_double4x4](repeating: simd_double4x4(), count: points.count)
        for t in faces {
            let q = plane(points[Int(t.x)], points[Int(t.y)], points[Int(t.z)])
            for v in [t.x, t.y, t.z] { quadric[Int(v)] += q }
        }
        let limit = Double(maxError) * Double(maxError)

        func cost(_ q: simd_double4x4, _ p: SIMD3<Float>) -> Double {
            let v = SIMD4<Double>(Double(p.x), Double(p.y), Double(p.z), 1)
            return max(0, simd_dot(v, q * v))
        }
        func neighbours(_ v: Int) -> Set<Int32> {
            var s = Set<Int32>()
            for f in around[v] where alive[Int(f)] {
                let t = faces[Int(f)]
                for w in [t.x, t.y, t.z] where Int(w) != v { s.insert(w) }
            }
            return s
        }

        while live > target {
            // Every edge once, cheapest first.
            var edges: [(cost: Double, a: Int32, b: Int32, to: SIMD3<Float>)] = []
            edges.reserveCapacity(live * 3 / 2)
            for (f, t) in faces.enumerated() where alive[f] {
                for (a, b) in [(t.x, t.y), (t.y, t.z), (t.z, t.x)] where a < b {
                    let q = quadric[Int(a)] + quadric[Int(b)]
                    let pa = points[Int(a)], pb = points[Int(b)], pm = (pa + pb) / 2
                    let options = [(cost(q, pa), pa), (cost(q, pb), pb), (cost(q, pm), pm)]
                    let best = options.min { $0.0 < $1.0 }!
                    if best.0 <= limit { edges.append((best.0, a, b, best.1)) }
                }
            }
            if edges.isEmpty { break }
            edges.sort { $0.cost < $1.cost }
            var touched = [Bool](repeating: false, count: points.count)
            var collapsed = 0
            for e in edges {
                if live <= target { break }
                let a = Int(e.a), b = Int(e.b)
                guard !touched[a], !touched[b] else { continue }
                // Link condition: the two ends may share only the two points across the edge,
                // otherwise collapsing pinches the surface.
                let na = neighbours(a), nb = neighbours(b)
                guard na.contains(e.b) else { continue }
                let shared = na.intersection(nb)
                let across = around[a].filter { alive[Int($0)] && Self.has(faces[Int($0)], e.b) }
                guard across.count == 2, shared.count == 2 else { continue }
                // No triangle may flip or collapse.
                var ok = true
                for f in around[a] + around[b] where alive[Int(f)] {
                    let t = faces[Int(f)]
                    if Self.has(t, e.a) && Self.has(t, e.b) { continue }
                    let before = normal(points[Int(t.x)], points[Int(t.y)], points[Int(t.z)])
                    let moved = [t.x, t.y, t.z].map { Int($0) == a || Int($0) == b ? e.to : points[Int($0)] }
                    let after = normal(moved[0], moved[1], moved[2])
                    if simd_length(after) < 1e-12 || simd_dot(simd_normalize(before), simd_normalize(after)) < 0.3 {
                        ok = false
                        break
                    }
                }
                guard ok else { continue }
                // b goes into a.
                for f in across {
                    alive[Int(f)] = false
                    live -= 1
                }
                for f in around[b] where alive[Int(f)] {
                    var t = faces[Int(f)]
                    if t.x == e.b { t.x = e.a }
                    if t.y == e.b { t.y = e.a }
                    if t.z == e.b { t.z = e.a }
                    faces[Int(f)] = t
                    around[a].append(f)
                }
                around[b] = []
                around[a] = around[a].filter { alive[Int($0)] }
                points[a] = e.to
                quadric[a] += quadric[b]
                for v in na.union(nb) { touched[Int(v)] = true }
                touched[a] = true
                touched[b] = true
                collapsed += 1
            }
            if collapsed == 0 { break }
        }

        // Compact: only living faces and the points they use.
        var remap = [Int32](repeating: -1, count: points.count)
        var outPoints: [SIMD3<Float>] = []
        var outFaces: [SIMD3<Int32>] = []
        for (f, t) in faces.enumerated() where alive[f] {
            var n = SIMD3<Int32>()
            for k in 0..<3 {
                let v = Int(t[k])
                if remap[v] < 0 {
                    remap[v] = Int32(outPoints.count)
                    outPoints.append(points[v])
                }
                n[k] = remap[v]
            }
            outFaces.append(n)
        }
        mesh = Mesh(points: outPoints, faces: outFaces)
    }

    private static func has(_ t: SIMD3<Int32>, _ v: Int32) -> Bool { t.x == v || t.y == v || t.z == v }

    private static func normal(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ c: SIMD3<Float>) -> SIMD3<Double> {
        let n = simd_cross(b - a, c - a)
        return SIMD3<Double>(Double(n.x), Double(n.y), Double(n.z))
    }

    /// The plane of a triangle as an error quadric (squared distance to it).
    private static func plane(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ c: SIMD3<Float>) -> simd_double4x4 {
        let n = normal(a, b, c)
        let len = simd_length(n)
        guard len > 0 else { return simd_double4x4() }
        let u = n / len
        let d = -simd_dot(u, SIMD3<Double>(Double(a.x), Double(a.y), Double(a.z)))
        let p = SIMD4<Double>(u.x, u.y, u.z, d)
        return simd_double4x4(p * p.x, p * p.y, p * p.z, p * p.w)
    }
}
