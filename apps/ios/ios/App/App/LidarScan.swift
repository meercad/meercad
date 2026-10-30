import ARKit
import Foundation
import RealityKit
import SwiftUI
import UIKit

/// Scanning with the LiDAR sensor into a `VoxelField`, two ways:
///
/// - **Object:** the user aims the crosshair at four corners around the object on the table (or
///   floor), then sets the height; the box stands on the table, sweeping around it (all sides or only
///   the reachable ones) builds the object, the table or floor is cut off. Anything from a screw to a
///   chair. The four corners need not make a rectangle: the box is the smallest rectangle along the
///   first edge (first to second corner) that holds all four.
/// - **Surface:** no box: a circle in the middle of the view is the brush; while a finger rests on
///   the screen, the depth inside the circle is recorded, like painting the surface, and letting go
///   moves on without recording (a recess, a contour, a dashboard, a mount on a wall). The frames are
///   kept; on Done the box is fitted around what was recorded, along the surface's main directions,
///   and they are added up in it. The result is the surface as a shell a few millimetres thick,
///   facing up.
///
/// While scanning, ARKit's mesh shows what was recorded, shaded and see-through: only where depth
/// was recorded, and for objects only inside the box (cut at its walls). Done closes the field into solids and writes them as STL in
/// millimetres (one file per separate piece).
@available(iOS 17, *)
@MainActor
final class LidarScanner: NSObject, ObservableObject, ARSessionDelegate {
    enum Mode: String { case object, surface }
    enum Phase: Equatable { case aiming, sizing, scanning, building }
    let mode: Mode
    @Published var phase = Phase.aiming
    /// Corners tapped so far (world, on the base plane).
    @Published var corners: [SIMD3<Float>] = []
    /// The box's height (objects), metres.
    @Published var height: Float = 0.2 { didSet { if phase == .sizing { updateBox() } } }
    /// Width and depth of the rectangle, metres (for the hint).
    @Published var footprint: SIMD2<Float> = .zero
    /// Surface: whether the record button is held.
    @Published var recording = false
    /// How many depth frames were recorded (Done needs a few).
    @Published var recorded = 0
    /// Distance to what is in the middle of the view (metres), nil without a reading.
    @Published var distance: Float?
    @Published var message: String?

    let arView = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
    private let queue = DispatchQueue(label: "dev.meercad.lidar-scan", qos: .userInitiated)
    private let store = FieldStore()
    private var marker: AnchorEntity?
    private var dots: AnchorEntity?
    /// The base plane, from the first tap: a point on it and its normal (up for objects).
    private var base: (point: SIMD3<Float>, normal: SIMD3<Float>, right: SIMD3<Float>)?
    /// The box, once the four corners are set.
    private var box: (centre: SIMD3<Float>, axes: simd_float3x3, half: SIMD3<Float>)?
    /// Rectangle in the base plane: origin corner, axes, size.
    private var rect: (origin: SIMD3<Float>, u: SIMD3<Float>, v: SIMD3<Float>, size: SIMD2<Float>)?
    /// Depth beyond this is ignored (metres): further for big boxes.
    private var maxRange: Float = 1.2
    private var busy = false
    private var lastPublish = Date.distantPast
    private var frames = 0
    /// The dot under the crosshair while setting corners.
    private var preview: ModelEntity?
    /// ARKit's mesh where depth was recorded, one entity per mesh anchor; anchors changed since the
    /// last redraw.
    private let seenRoot = AnchorEntity(world: .zero)
    private var seenParts: [UUID: ModelEntity] = [:]
    private var dirtyMeshes = Set<UUID>()
    private var lastMeshDraw = Date.distantPast
    /// Cells (2 cm) where depth was recorded.
    private var covered = Set<SIMD3<Int32>>()
    private nonisolated static let cell: Float = 0.02
    /// The brush's radius as a share of the view's width (surface scans).
    static let brush: CGFloat = 0.22
    private var started = Date()

    init(mode: Mode) {
        self.mode = mode
        super.init()
    }

    func start() {
        let config = ARWorldTrackingConfiguration()
        config.frameSemantics = [.sceneDepth]
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) { config.sceneReconstruction = .mesh }
        // The table under an object is found as a horizontal plane.
        config.planeDetection = [.horizontal]
        arView.session.delegate = self
        arView.session.run(config)
        arView.scene.addAnchor(seenRoot)
        if mode == .surface {
            maxRange = 1.2
            started = Date()
            phase = .scanning
        }
    }

    func stop() {
        arView.session.pause()
    }

    /// Sets a corner at a tap. The first finds the base plane (the table under it, or the tapped
    /// surface); the others land on that plane, wherever the finger points.
    func tap() {
        guard phase == .aiming, let frame = arView.session.currentFrame else { return }
        let point = crosshair
        let cam = frame.camera.transform
        let camPos = SIMD3<Float>(cam.columns.3.x, cam.columns.3.y, cam.columns.3.z)
        // The box's x follows the screen's right (the phone is held upright: that is the camera's -y).
        let screenRight = -SIMD3<Float>(cam.columns.1.x, cam.columns.1.y, cam.columns.1.z)
        if base != nil {
            guard let p = onBase(point) else {
                message = mode == .object ? L("Point at the table or floor for the corner.") : L("Point at the surface for the corner.")
                return
            }
            corners.append(p)
        } else {
            guard let hit = arView.raycast(from: point, allowing: .estimatedPlane, alignment: .any).first else {
                message = L("Nothing found there. Aim from a hand's width or two away and tap again.")
                return
            }
            let t = hit.worldTransform
            var at = SIMD3<Float>(t.columns.3.x, t.columns.3.y, t.columns.3.z)
            var n = simd_normalize(SIMD3<Float>(t.columns.1.x, t.columns.1.y, t.columns.1.z))
            if simd_dot(n, camPos - at) < 0 { n = -n }
            if mode == .object {
                guard let floor = floorHeight(below: at, normal: n, frame: frame) else {
                    message = L("The table is not found yet. Show the table (or floor) for a moment, then tap again.")
                    return
                }
                at.y = floor
                n = SIMD3<Float>(0, 1, 0)
            }
            base = (at, n, screenRight)
            corners = [at]
        }
        message = nil
        if corners.count == 4 { setBox() } else { showDots() }
    }

    /// The middle of the view, where the crosshair is.
    private var crosshair: CGPoint { CGPoint(x: arView.bounds.midX, y: arView.bounds.midY) }

    /// Where a screen point's ray meets the base plane, if it does.
    private func onBase(_ point: CGPoint) -> SIMD3<Float>? {
        guard let base, let ray = arView.ray(through: point) else { return nil }
        let along = simd_dot(ray.direction, base.normal)
        guard abs(along) > 1e-4 else { return nil }
        let t = simd_dot(base.point - ray.origin, base.normal) / along
        return t > 0 && t < 6 ? ray.origin + ray.direction * t : nil
    }

    /// Moves the dot under the crosshair (after the first corner, on the base plane).
    private func updatePreview() {
        guard phase == .aiming, base != nil, let p = onBase(crosshair) else {
            preview?.isEnabled = false
            return
        }
        if preview == nil {
            let e = ModelEntity(mesh: .generateSphere(radius: 0.006), materials: [UnlitMaterial(color: .white)])
            seenRoot.addChild(e)
            preview = e
        }
        preview?.position = p
        preview?.isEnabled = true
    }

    /// Takes back the last corner.
    func undoCorner() {
        guard phase == .aiming || phase == .sizing, !corners.isEmpty else { return }
        corners.removeLast()
        if corners.isEmpty { base = nil }
        marker?.removeFromParent()
        marker = nil
        box = nil
        phase = .aiming
        showDots()
    }

    /// The rectangle around the four corners, along the first edge, and the box on it.
    private func setBox() {
        guard let base, corners.count == 4 else { return }
        let n = base.normal
        let flat = { (p: SIMD3<Float>) in p - simd_dot(p - base.point, n) * n }
        let c = corners.map(flat)
        var u = c[1] - c[0]
        if simd_length(u) < 0.01 { u = base.right - simd_dot(base.right, n) * n }
        u = simd_normalize(u)
        let v = simd_cross(n, u)
        let us = c.map { simd_dot($0 - c[0], u) }, vs = c.map { simd_dot($0 - c[0], v) }
        let lo = SIMD2(us.min()!, vs.min()!), hi = SIMD2(us.max()!, vs.max()!)
        let size = simd_max(hi - lo, SIMD2(repeating: 0.02))
        guard max(size.x, size.y) <= 3 else {
            message = L("That is more than 3 m across. Tap the corners again, closer around the object.")
            corners = []
            self.base = nil
            showDots()
            return
        }
        rect = (c[0] + u * lo.x + v * lo.y, u, v, size)
        footprint = size
        // A useful first height: as tall as the rectangle is wide.
        height = min(1.5, max(0.05, (size.x + size.y) / 2))
        phase = .sizing
        updateBox()
    }

    /// The box from the rectangle and the height, shown as a wire frame.
    private func updateBox() {
        guard let rect, let base else { return }
        let n = base.normal
        let mid = rect.origin + rect.u * rect.size.x / 2 + rect.v * rect.size.y / 2
        let half = SIMD3<Float>(rect.size.x / 2, rect.size.y / 2, height / 2)
        // A few millimetres above the table; what is left of the table is cut off at the end.
        let centre = mid + n * (0.003 + height / 2)
        let axes = simd_float3x3(rect.u, rect.v, n)
        box = (centre, axes, half)
        dots?.removeFromParent()
        dots = nil
        showBox(centre: centre, axes: axes, half: half)
    }

    /// Starts collecting depth into the box.
    func startScan() {
        guard phase == .sizing, let box else { return }
        let (centre, axes, half) = box
        // Far enough to see the whole box from a step back, within what the sensor reaches.
        maxRange = min(3, max(1.2, 2 * simd_reduce_max(half) * 2 + 0.4))
        queue.async { [store] in
            store.field = VoxelField(centre: centre, axes: axes, half: half)
            store.debug = []
        }
        frames = 0
        started = Date()
        message = nil
        phase = .scanning
    }

    /// Small dots at the corners tapped so far, joined by lines.
    private func showDots() {
        dots?.removeFromParent()
        dots = nil
        guard !corners.isEmpty else { return }
        let anchor = AnchorEntity(world: .zero)
        let material = UnlitMaterial(color: .systemTeal)
        let dot = MeshResource.generateSphere(radius: 0.006)
        for (k, p) in corners.enumerated() {
            let e = ModelEntity(mesh: dot, materials: [material])
            e.position = p
            anchor.addChild(e)
            guard k > 0 else { continue }
            let a = corners[k - 1], d = p - a, len = simd_length(d)
            guard len > 1e-3 else { continue }
            let line = ModelEntity(mesh: .generateBox(size: [0.0015, 0.0015, len]), materials: [material])
            line.position = (a + p) / 2
            line.orientation = simd_quatf(from: [0, 0, 1], to: d / len)
            anchor.addChild(line)
        }
        arView.scene.addAnchor(anchor)
        dots = anchor
    }

    /// Height of the table (or floor) under a tapped point: the highest horizontal plane ARKit found
    /// just below it, or the point itself when the tap was on a flat, upward surface.
    private func floorHeight(below at: SIMD3<Float>, normal: SIMD3<Float>, frame: ARFrame) -> Float? {
        let planes = frame.anchors.compactMap { $0 as? ARPlaneAnchor }.filter { $0.alignment == .horizontal }
        let heights = planes.map { $0.transform.columns.3.y }.filter { $0 <= at.y + 0.01 && $0 > at.y - 0.6 }
        if let top = heights.max() { return top }
        return normal.y > 0.9 ? at.y : nil
    }

    func restart() {
        queue.sync { store.field = nil }
        marker?.removeFromParent()
        marker = nil
        dots?.removeFromParent()
        dots = nil
        corners = []
        base = nil
        box = nil
        rect = nil
        for e in seenParts.values { e.removeFromParent() }
        seenParts = [:]
        covered = []
        recorded = 0
        recording = false
        queue.sync { store.frames = []; store.pointCount = 0; store.debug = []; store.pointCells = []; store.covered = [] }
        phase = mode == .surface ? .scanning : .aiming
        started = Date()
    }

    /// Closes what was seen into solids and writes them; returns the result for the web app.
    func finish() async throws -> [String: Any] {
        phase = .building
        arView.session.pause()
        let mode = self.mode, frames = self.frames
        let seconds = Int(Date().timeIntervalSince(started))
        return try await withCheckedThrowingContinuation { done in
            queue.async { [store] in
                if mode == .surface {
                    do { store.field = try Self.surfaceField(store.frames) } catch { return done.resume(throwing: error) }
                    store.frames = []
                }
                guard var field = store.field else { return done.resume(throwing: ScanError.failed(L("Nothing was scanned."))) }
                let boxMm = [field.half.x, field.half.y, field.half.z].map { Int($0 * 2000) }
                switch mode {
                case .surface:
                    // The surface as a shell a few millimetres thick, however deep it reaches.
                    field.shellOnly = true
                case .object:
                    // The table or floor that came into the box.
                    if let floor = field.floorLayer() { field.cutBelow = floor }
                    // Unseen sides stay open instead of running out to the box's walls.
                    field.limitToSeen(floorClosed: true)
                }
                guard let (pieces, cell) = field.solids() else {
                    return done.resume(throwing: ScanError.failed(mode == .object
                        ? L("Too little was seen. Sweep slowly over everything inside the box, from several sides.")
                        : L("Too little was recorded. Hold the button and sweep slowly over the surface.")))
                }
                do {
                    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                    let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
                    let folder = docs.appendingPathComponent("Scans/\(stamp)-lidar-\(mode.rawValue)", isDirectory: true)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    var paths: [String] = [], triangles = 0, sizes: [[Double]] = []
                    for (k, piece) in pieces.enumerated() {
                        let stl = folder.appendingPathComponent(k == 0 ? "scan.stl" : "scan-\(k + 1).stl")
                        let (n, mm) = try MeshExport.writeSTL(piece, to: stl)
                        paths.append(stl.path)
                        triangles += n
                        sizes.append(mm)
                    }
                    // The raw points, for looking into a scan that came out wrong.
                    Self.writePLY(store.debug, to: folder.appendingPathComponent("points.ply"))
                    let log: [String: Any] = ["mode": "lidar-\(mode.rawValue)", "boxMm": boxMm, "voxelMm": field.voxel * 1000, "cellMm": cell * 1000,
                                              "frames": frames, "seen": field.seen, "seconds": seconds, "pieces": pieces.count, "triangles": triangles,
                                              "sizeMm": sizes, "machine": Self.machine(), "system": "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)"]
                    if let data = try? JSONSerialization.data(withJSONObject: log, options: [.prettyPrinted, .sortedKeys]) {
                        try? data.write(to: folder.appendingPathComponent("scan.json"))
                    }
                    done.resume(returning: ["path": paths[0], "paths": paths, "folder": folder.path, "triangles": triangles, "size": sizes[0], "photos": 0, "seconds": seconds])
                } catch {
                    done.resume(throwing: error)
                }
            }
        }
    }

    /// The box for a recorded surface: along its main directions (z out of the surface, towards the
    /// cameras), around the recorded points without the odd stray one, and the frames added up in it.
    private nonisolated static func surfaceField(_ frames: [RecordedFrame]) throws -> VoxelField {
        var sample: [SIMD3<Float>] = []
        var cameras = SIMD3<Float>.zero
        for f in frames {
            cameras += f.camera
            sample += stride(from: 0, to: f.points.count, by: 40).map { f.points[$0] }
        }
        guard frames.count >= 3, sample.count >= 200 else { throw ScanError.failed(L("Too little was recorded. Hold the button and sweep slowly over the surface.")) }
        cameras /= Float(frames.count)
        let mean = sample.reduce(.zero, +) / Float(sample.count)
        var cov = simd_float3x3()
        for p in sample {
            let d = p - mean
            cov += simd_float3x3(d * d.x, d * d.y, d * d.z)
        }
        let (values, vectors) = symmetricEigen(cov * (1 / Float(sample.count)))
        let order = [0, 1, 2].sorted { values[$0] > values[$1] }
        var n = vectors[order[2]]
        if simd_dot(n, cameras - mean) < 0 { n = -n }
        var u = vectors[order[0]]
        u = simd_normalize(u - simd_dot(u, n) * n)
        let axes = simd_float3x3(u, simd_cross(n, u), n)
        let local = sample.map { axes.transpose * ($0 - mean) }
        func range(_ k: Int, _ margin: Float) -> (Float, Float) {
            let xs = local.map { $0[k] }.sorted()
            return (xs[xs.count / 500] - margin, xs[xs.count - 1 - xs.count / 500] + margin)
        }
        let (x0, x1) = range(0, 0.005), (y0, y1) = range(1, 0.005), (z0, z1) = range(2, 0.01)
        let half = SIMD3<Float>(x1 - x0, y1 - y0, z1 - z0) / 2
        guard simd_reduce_max(half) <= 1.25 else { throw ScanError.failed(L("That is more than 2.5 m across. Record a smaller area.")) }
        let centre = mean + axes * SIMD3<Float>((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
        var field = VoxelField(centre: centre, axes: axes, half: half)
        for f in frames { field.integrate(camera: f.camera, points: f.points, carve: f.carve) }
        return field
    }

    /// Eigenvalues and eigenvectors of a symmetric 3×3 matrix (Jacobi rotations).
    private nonisolated static func symmetricEigen(_ m: simd_float3x3) -> (SIMD3<Float>, [SIMD3<Float>]) {
        var a = [[Double]](repeating: [0, 0, 0], count: 3)
        for i in 0..<3 { for j in 0..<3 { a[i][j] = Double(m[j][i]) } }
        var v: [[Double]] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
        for _ in 0..<50 {
            var p = 0, q = 1
            for (i, j) in [(0, 2), (1, 2)] where abs(a[i][j]) > abs(a[p][q]) { (p, q) = (i, j) }
            if abs(a[p][q]) < 1e-15 { break }
            let theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
            let t = (theta >= 0 ? 1 : -1) / (abs(theta) + (theta * theta + 1).squareRoot())
            let c = 1 / (t * t + 1).squareRoot(), s = t * c
            for k in 0..<3 {
                let akp = a[k][p], akq = a[k][q]
                a[k][p] = c * akp - s * akq
                a[k][q] = s * akp + c * akq
            }
            for k in 0..<3 {
                let apk = a[p][k], aqk = a[q][k]
                a[p][k] = c * apk - s * aqk
                a[q][k] = s * apk + c * aqk
            }
            for k in 0..<3 {
                let vkp = v[k][p], vkq = v[k][q]
                v[k][p] = c * vkp - s * vkq
                v[k][q] = s * vkp + c * vkq
            }
        }
        let values = SIMD3<Float>(Float(a[0][0]), Float(a[1][1]), Float(a[2][2]))
        let vectors = (0..<3).map { k in simd_normalize(SIMD3<Float>(Float(v[0][k]), Float(v[1][k]), Float(v[2][k]))) }
        return (values, vectors)
    }

    /// The box as a wire frame of thin bars.
    private func showBox(centre: SIMD3<Float>, axes: simd_float3x3, half: SIMD3<Float>) {
        marker?.removeFromParent()
        let anchor = AnchorEntity(world: simd_float4x4(SIMD4(axes.columns.0, 0), SIMD4(axes.columns.1, 0), SIMD4(axes.columns.2, 0), SIMD4(centre, 1)))
        let material = UnlitMaterial(color: .systemTeal)
        let bar: Float = 0.0015
        for a in 0..<3 {
            let b = (a + 1) % 3, c = (a + 2) % 3
            var dims = SIMD3<Float>(repeating: bar)
            dims[a] = 2 * half[a]
            let mesh = MeshResource.generateBox(size: dims)
            for sb: Float in [-1, 1] {
                for sc: Float in [-1, 1] {
                    var p = SIMD3<Float>.zero
                    p[b] = sb * half[b]
                    p[c] = sc * half[c]
                    let e = ModelEntity(mesh: mesh, materials: [material])
                    e.position = p
                    anchor.addChild(e)
                }
            }
        }
        arView.scene.addAnchor(anchor)
        marker = anchor
    }

    // MARK: Depth frames

    /// ARKit calls this on the main queue (no delegate queue is set).
    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        MainActor.assumeIsolated { take(frame) }
    }

    nonisolated func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        let ids = anchors.compactMap { ($0 as? ARMeshAnchor)?.identifier }
        MainActor.assumeIsolated { dirtyMeshes.formUnion(ids) }
    }

    nonisolated func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        let ids = anchors.compactMap { ($0 as? ARMeshAnchor)?.identifier }
        MainActor.assumeIsolated { dirtyMeshes.formUnion(ids) }
    }

    /// Redraws the changed parts of ARKit's mesh: only triangles where depth was recorded (inside
    /// the box for objects, cut at its walls), shaded and see-through.
    private func drawSeen(_ frame: ARFrame) {
        guard phase == .scanning, !covered.isEmpty, !dirtyMeshes.isEmpty, Date().timeIntervalSince(lastMeshDraw) > 0.4 else { return }
        lastMeshDraw = Date()
        let box = self.box ?? (centre: .zero, axes: matrix_identity_float3x3, half: SIMD3<Float>(repeating: 1e4))
        let toBox = box.axes.transpose, half = box.half
        let covered = self.covered
        let cellOf = { (p: SIMD3<Float>) in SIMD3<Int32>((p / Self.cell).rounded(.down)) }
        var material = PhysicallyBasedMaterial()
        material.baseColor = .init(tint: UIColor(red: 0.25, green: 0.8, blue: 0.85, alpha: 1))
        material.roughness = 0.5
        material.blending = .transparent(opacity: 0.75)
        for anchor in frame.anchors.compactMap({ $0 as? ARMeshAnchor }) where dirtyMeshes.contains(anchor.identifier) {
            let g = anchor.geometry
            let vs = g.vertices, faces = g.faces
            let m = anchor.transform
            var world = [SIMD3<Float>](repeating: .zero, count: vs.count)
            var hit = [Bool](repeating: false, count: vs.count)
            let vbase = vs.buffer.contents().advanced(by: vs.offset)
            for i in 0..<vs.count {
                let v = vbase.advanced(by: i * vs.stride).assumingMemoryBound(to: Float.self)
                let w = m * SIMD4<Float>(v[0], v[1], v[2], 1)
                world[i] = SIMD3<Float>(w.x, w.y, w.z)
                hit[i] = covered.contains(cellOf(world[i]))
            }
            var positions: [SIMD3<Float>] = [], normals: [SIMD3<Float>] = []
            let fbase = faces.buffer.contents()
            let wide = faces.bytesPerIndex == 4
            for f in 0..<faces.count {
                let idx = (0..<3).map { k -> Int in
                    let at = fbase.advanced(by: (f * 3 + k) * faces.bytesPerIndex)
                    return wide ? Int(at.assumingMemoryBound(to: UInt32.self).pointee) : Int(at.assumingMemoryBound(to: UInt16.self).pointee)
                }
                guard idx.contains(where: { hit[$0] }) else { continue }
                let tri = idx.map { toBox * (world[$0] - box.centre) }
                let lo = simd_min(tri[0], simd_min(tri[1], tri[2])), hi = simd_max(tri[0], simd_max(tri[1], tri[2]))
                if any(lo .> half) || any(hi .< -half) { continue }
                let poly = Self.clip(tri, half)
                guard poly.count >= 3 else { continue }
                let n = simd_cross(tri[1] - tri[0], tri[2] - tri[0])
                guard simd_length(n) > 1e-12 else { continue }
                let wn = box.axes * simd_normalize(n)
                for k in 1..<poly.count - 1 {
                    for p in [poly[0], poly[k], poly[k + 1]] {
                        positions.append(box.axes * p + box.centre)
                        normals.append(wn)
                    }
                }
            }
            seenParts[anchor.identifier]?.removeFromParent()
            seenParts[anchor.identifier] = nil
            guard !positions.isEmpty else { continue }
            var d = MeshDescriptor(name: "seen")
            d.positions = MeshBuffers.Positions(positions)
            d.normals = MeshBuffers.Normals(normals)
            d.primitives = .triangles((0..<UInt32(positions.count)).map { $0 })
            guard let mesh = try? MeshResource.generate(from: [d]) else { continue }
            let e = ModelEntity(mesh: mesh, materials: [material])
            seenRoot.addChild(e)
            seenParts[anchor.identifier] = e
        }
        dirtyMeshes = []
    }

    /// A polygon cut to the box -half…half (Sutherland–Hodgman, one wall at a time).
    private static func clip(_ poly: [SIMD3<Float>], _ half: SIMD3<Float>) -> [SIMD3<Float>] {
        var out = poly
        for axis in 0..<3 {
            for sign: Float in [1, -1] {
                let inside = { (p: SIMD3<Float>) in sign * p[axis] <= half[axis] }
                let input = out
                out = []
                guard !input.isEmpty else { return [] }
                for (i, p) in input.enumerated() {
                    let q = input[(i + 1) % input.count]
                    let pin = inside(p), qin = inside(q)
                    if pin { out.append(p) }
                    if pin != qin {
                        let t = (sign * half[axis] - p[axis]) / (q[axis] - p[axis])
                        out.append(p + (q - p) * t)
                    }
                }
            }
        }
        return out
    }

    private func take(_ frame: ARFrame) {
        updatePreview()
        drawSeen(frame)
        guard let depth = frame.sceneDepth else { return }
        distance = DepthSample.centre(of: depth)
        // A frame is copied only when the last one is done, so slow phones skip frames instead of lagging.
        guard phase == .scanning, mode == .object || recording, !busy else { return }
        // Surfaces: every second pixel each way is plenty, and keeps the stored frames small.
        guard var sample = DepthSample(frame: frame, depth: depth, maxRange: maxRange, step: mode == .surface ? 2 : 1) else { return }
        if mode == .surface {
            // Only inside the brush: depth pixels (normalised) to view points, kept within the circle.
            let size = arView.bounds.size
            let orientation = arView.window?.windowScene?.interfaceOrientation ?? .portrait
            sample.brush = (frame.displayTransform(for: orientation, viewportSize: size), size, Self.brush * size.width)
        }
        busy = true
        frames += 1
        let mode = self.mode, box = self.box
        queue.async { [store, weak self] in
            var points: [SIMD3<Float>] = [], carve: [Bool] = []
            points.reserveCapacity(sample.width * sample.height)
            carve.reserveCapacity(sample.width * sample.height)
            sample.points { p, c in
                points.append(p)
                carve.append(c)
            }
            var full = false
            switch mode {
            case .object:
                // Taken out while adding, so its arrays are not copied.
                if var f = store.field {
                    store.field = nil
                    f.integrate(camera: sample.position, points: points, carve: carve)
                    store.field = f
                }
            case .surface:
                if store.pointCount < 15_000_000 {
                    store.frames.append(RecordedFrame(camera: sample.position, points: points, carve: carve))
                    store.pointCount += points.count
                } else { full = true }
            }
            if store.debug.count < 300_000 { store.debug += stride(from: 0, to: points.count, by: 60).map { points[$0] } }
            // Where depth landed (inside the box for objects), with the cells around, for showing the
            // mesh there.
            var cells: [SIMD3<Int32>] = []
            let toBox = box?.axes.transpose
            for i in stride(from: 0, to: points.count, by: 5) {
                let p = points[i]
                if let box, let toBox {
                    let q = abs(toBox * (p - box.centre))
                    guard q.x <= box.half.x, q.y <= box.half.y, q.z <= box.half.z else { continue }
                }
                let c = SIMD3<Int32>((p / Self.cell).rounded(.down))
                guard store.pointCells.insert(c).inserted else { continue }
                for dx: Int32 in -1...1 { for dy: Int32 in -1...1 { for dz: Int32 in -1...1 {
                    let n = c &+ SIMD3(dx, dy, dz)
                    if store.covered.insert(n).inserted { cells.append(n) }
                } } }
            }
            Task { @MainActor in
                guard let self else { return }
                self.busy = false
                self.covered.formUnion(cells)
                if !cells.isEmpty, let ids = self.arView.session.currentFrame?.anchors.compactMap({ ($0 as? ARMeshAnchor)?.identifier }) {
                    self.dirtyMeshes.formUnion(ids)
                }
                if !full { self.recorded += 1 }
                if full, self.recording {
                    self.recording = false
                    self.message = L("That is as much as fits. Tap Done, or Start over.")
                }
            }
        }
    }

    private nonisolated static func writePLY(_ points: [SIMD3<Float>], to url: URL) {
        var data = Data("ply\nformat binary_little_endian 1.0\nelement vertex \(points.count)\nproperty float x\nproperty float y\nproperty float z\nend_header\n".utf8)
        points.withUnsafeBytes { raw in
            // SIMD3<Float> is padded to 16 bytes: write x, y, z of each.
            for i in 0..<points.count { data.append(raw.baseAddress!.advanced(by: i * 16).assumingMemoryBound(to: UInt8.self), count: 12) }
        }
        try? data.write(to: url)
    }

    private nonisolated static func machine() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }
}

/// Holds the scanner's field for its processing queue (only that queue touches it).
final class FieldStore: @unchecked Sendable {
    var field: VoxelField?
    var debug: [SIMD3<Float>] = []
    /// Surface scans: the recorded frames, added up into a field on Done.
    var frames: [RecordedFrame] = []
    var pointCount = 0
    /// Cells (2 cm) with recorded depth, and those and their neighbours (where the mesh shows).
    var pointCells = Set<SIMD3<Int32>>()
    var covered = Set<SIMD3<Int32>>()
}

/// One recorded depth frame: where the camera was and what it saw (world, metres).
struct RecordedFrame: Sendable {
    let camera: SIMD3<Float>
    let points: [SIMD3<Float>]
    let carve: [Bool]
}

/// One LiDAR depth frame copied out of ARKit (frames must not be held), with what is needed to turn
/// its pixels into points in the world.
struct DepthSample: Sendable {
    let width: Int, height: Int
    let depth: [Float32]
    let confidence: [UInt8]
    let fx: Float, fy: Float, cx: Float, cy: Float
    let camera: simd_float4x4
    let maxRange: Float
    /// Every how many pixels a point is taken, each way.
    let step: Int
    /// Only pixels that show inside this circle on screen: normalised image to view transform, view
    /// size, radius in points.
    var brush: (CGAffineTransform, CGSize, CGFloat)?

    var position: SIMD3<Float> { SIMD3(camera.columns.3.x, camera.columns.3.y, camera.columns.3.z) }

    init?(frame: ARFrame, depth data: ARDepthData, maxRange: Float, step: Int = 1) {
        self.maxRange = maxRange
        self.step = step
        let map = data.depthMap
        guard let conf = data.confidenceMap else { return nil }
        width = CVPixelBufferGetWidth(map)
        height = CVPixelBufferGetHeight(map)
        depth = Self.copy(map, as: Float32.self, width: width, height: height)
        confidence = Self.copy(conf, as: UInt8.self, width: width, height: height)
        let k = frame.camera.intrinsics, res = frame.camera.imageResolution
        let sx = Float(width) / Float(res.width), sy = Float(height) / Float(res.height)
        fx = k[0][0] * sx
        fy = k[1][1] * sy
        cx = k[2][0] * sx
        cy = k[2][1] * sy
        camera = frame.camera.transform
    }

    /// Depth at the middle of a frame, if the sensor trusts it.
    static func centre(of data: ARDepthData) -> Float? {
        let map = data.depthMap
        guard let conf = data.confidenceMap else { return nil }
        let w = CVPixelBufferGetWidth(map), h = CVPixelBufferGetHeight(map)
        CVPixelBufferLockBaseAddress(map, .readOnly)
        CVPixelBufferLockBaseAddress(conf, .readOnly)
        defer {
            CVPixelBufferUnlockBaseAddress(map, .readOnly)
            CVPixelBufferUnlockBaseAddress(conf, .readOnly)
        }
        guard let d = CVPixelBufferGetBaseAddress(map), let c = CVPixelBufferGetBaseAddress(conf) else { return nil }
        let depth = d.advanced(by: (h / 2) * CVPixelBufferGetBytesPerRow(map)).assumingMemoryBound(to: Float32.self)[w / 2]
        let trust = c.advanced(by: (h / 2) * CVPixelBufferGetBytesPerRow(conf)).assumingMemoryBound(to: UInt8.self)[w / 2]
        return trust >= 1 ? depth : nil
    }

    /// World points of the trusted pixels: high confidence, in range, and not on a depth edge (where
    /// the sensor blends near and far into points in mid-air). The flag marks every third pixel in
    /// each direction, which also clears the space in front of its point.
    func points(_ use: (SIMD3<Float>, Bool) -> Void) {
        let high = UInt8(ARConfidenceLevel.high.rawValue)
        let carveEvery = 3 * step
        // The brush in normalised image coordinates: view = t(image) * size.
        let t = brush?.0 ?? .identity
        let size = brush.map { SIMD2<Float>(Float($0.1.width), Float($0.1.height)) } ?? .zero
        let r2 = brush.map { Float($0.2 * $0.2) } ?? 0
        let (ta, tb, tc, td, tx, ty) = (Float(t.a), Float(t.b), Float(t.c), Float(t.d), Float(t.tx), Float(t.ty))
        for v in stride(from: 0, to: height - 1, by: step) {
            for u in stride(from: 0, to: width - 1, by: step) {
                if brush != nil {
                    let x = (Float(u) + 0.5) / Float(width), y = (Float(v) + 0.5) / Float(height)
                    let vx = (ta * x + tc * y + tx - 0.5) * size.x, vy = (tb * x + td * y + ty - 0.5) * size.y
                    guard vx * vx + vy * vy <= r2 else { continue }
                }
                let i = v * width + u
                let d = depth[i]
                guard confidence[i] == high, d > 0.08, d < maxRange else { continue }
                guard abs(depth[i + 1] - d) < 0.02 * d, abs(depth[i + width] - d) < 0.02 * d else { continue }
                let p = SIMD4<Float>((Float(u) + 0.5 - cx) * d / fx, -(Float(v) + 0.5 - cy) * d / fy, -d, 1)
                let w = camera * p
                use(SIMD3(w.x, w.y, w.z), u % carveEvery == 0 && v % carveEvery == 0)
            }
        }
    }

    private static func copy<T>(_ buffer: CVPixelBuffer, as: T.Type, width: Int, height: Int) -> [T] {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let row = CVPixelBufferGetBytesPerRow(buffer)
        let base = CVPixelBufferGetBaseAddress(buffer)!
        var out: [T] = []
        out.reserveCapacity(width * height)
        for y in 0..<height {
            let line = base.advanced(by: y * row).assumingMemoryBound(to: T.self)
            out.append(contentsOf: UnsafeBufferPointer(start: line, count: width))
        }
        return out
    }
}

// MARK: - View

@available(iOS 17, *)
struct LidarScanView: View {
    @StateObject var scanner: LidarScanner
    let done: (Result<[String: Any], Error>) -> Void
    @State private var finished = false

    var body: some View {
        ZStack {
            ARContainer(view: scanner.arView)
                .ignoresSafeArea()
                .onTapGesture { if scanner.mode == .object { scanner.tap() } }
                .simultaneousGesture(DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        if scanner.mode == .surface, scanner.phase == .scanning, !scanner.recording {
                            scanner.message = nil
                            scanner.recording = true
                        }
                    }
                    .onEnded { _ in scanner.recording = false }, including: scanner.mode == .surface ? .all : .none)
            if scanner.mode == .surface && scanner.phase == .scanning {
                GeometryReader { g in
                    Circle()
                        .stroke(scanner.recording ? Color.red : Color.white, lineWidth: scanner.recording ? 4 : 2)
                        .frame(width: 2 * LidarScanner.brush * g.size.width, height: 2 * LidarScanner.brush * g.size.width)
                        .position(x: g.size.width / 2, y: g.size.height / 2)
                        .shadow(radius: 2)
                }
                .ignoresSafeArea()
                .allowsHitTesting(false)
            }
            if scanner.phase == .aiming {
                Image(systemName: "plus").font(.system(size: 28, weight: .light)).foregroundStyle(.white).shadow(radius: 2).allowsHitTesting(false)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).ignoresSafeArea()
            }
            VStack(spacing: 12) {
                HStack {
                    Button(L("Cancel"), action: cancel).buttonStyle(.bordered)
                    Spacer()
                }
                Spacer()
                bottom
            }
            .padding()
        }
        .onAppear { scanner.start() }
        .onDisappear { scanner.stop() }
    }

    @ViewBuilder private var bottom: some View {
        switch scanner.phase {
        case .aiming:
            if let m = scanner.message { hint(m) }
            hint(cornerHint)
            HStack {
                if !scanner.corners.isEmpty {
                    Button(L("Undo corner")) { scanner.undoCorner() }.buttonStyle(.bordered)
                }
                Button(L("Set corner")) { scanner.tap() }.buttonStyle(.borderedProminent).controlSize(.large)
            }
        case .sizing:
            if let m = scanner.message { hint(m) }
            hint(L("{w} × {d} cm, height {h} cm. Set the height so the whole object fits.", ["w": cm(scanner.footprint.x), "d": cm(scanner.footprint.y), "h": cm(scanner.height)]))
            HStack {
                Text(L("Height")).font(.callout)
                Slider(value: $scanner.height, in: 0.02...1.5)
            }
            .padding(10)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
            HStack {
                Button(L("Undo corner")) { scanner.undoCorner() }.buttonStyle(.bordered)
                Button(L("Start scanning")) { scanner.startScan() }.buttonStyle(.borderedProminent).controlSize(.large)
            }
        case .scanning:
            if let m = scanner.message { hint(m) }
            if scanner.mode == .object {
                hint(distanceHint + "\n" + L("Go slowly all the way round the object, from above and from low at the sides, until the teal surface covers it everywhere (half a minute or more). Sides left out stay open."))
                HStack {
                    Button(L("Start over")) { scanner.restart() }.buttonStyle(.bordered)
                    Button(L("Done"), action: finish).buttonStyle(.borderedProminent).controlSize(.large).disabled(scanner.recorded < 10)
                }
            } else {
                hint(distanceHint + "\n" + (scanner.recording
                    ? L("Paint slowly over the surface with the circle, also at a slant into corners and recesses.")
                    : L("Keep a finger on the screen to record what is inside the circle, like painting. Let go to move on.")))
                HStack {
                    Button(L("Start over")) { scanner.restart() }.buttonStyle(.bordered).disabled(scanner.recording)
                    Button(L("Done"), action: finish).buttonStyle(.borderedProminent).controlSize(.large).disabled(scanner.recorded < 10 || scanner.recording)
                }
            }
        case .building:
            ProgressView(L("Building the part…")).padding().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var cornerHint: String {
        let n = scanner.corners.count
        if n == 0 { return L("Put the object on a table or the floor. Aim the cross at four corners on the table (or floor) around the object and tap for each.") }
        return L("Corner {n} of 4: aim the cross on the table (or floor) around the object and tap.", ["n": n + 1])
    }

    private func cm(_ m: Float) -> String { "\(Int((m * 100).rounded()))" }

    private var distanceHint: String {
        guard let d = scanner.distance else { return L("Point the phone at it.") }
        let cm = Int((d * 100).rounded())
        if d < 0.15 { return L("{cm} cm away: a bit further back.", ["cm": cm]) }
        if d > 0.6 { return L("{cm} cm away: closer gives more detail.", ["cm": cm]) }
        return L("{cm} cm away: good.", ["cm": cm])
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(.callout).multilineTextAlignment(.center).foregroundStyle(.primary).padding(10)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private func cancel() {
        guard !finished else { return }
        finished = true
        done(.failure(ScanError.cancelled))
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        Task {
            do { done(.success(try await scanner.finish())) } catch { done(.failure(error)) }
        }
    }
}

private struct ARContainer: UIViewRepresentable {
    let view: ARView
    func makeUIView(context: Context) -> ARView { view }
    func updateUIView(_ uiView: ARView, context: Context) {}
}
