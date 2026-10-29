import ARKit
import Foundation
import RealityKit
import SwiftUI
import UIKit

/// Scanning with the LiDAR sensor into a `VoxelField`, two ways:
///
/// - **Object:** a box stands on the table where the user taps the object; sweeping around it (all
///   sides or only the reachable ones) builds the object, the table is cut off. Faster and coarser
///   than the photo scan, and needs no walk all the way round.
/// - **Surface:** a box is centred where the user taps a surface, for parts that must fit onto or into
///   something one cannot walk around (a recess, a contour, a mount on a wall). The result is the
///   surface with material behind it, facing up.
///
/// While scanning, the box shows as a wire frame and ARKit's own mesh shows what the sensor has seen.
/// Every LiDAR depth frame adds its high-confidence points; Done closes the field into solids and
/// writes them as STL in millimetres (one file per separate piece).
@available(iOS 17, *)
@MainActor
final class LidarScanner: NSObject, ObservableObject, ARSessionDelegate {
    enum Mode: String { case object, surface }
    enum Phase: Equatable { case aiming, scanning, building }
    let mode: Mode
    @Published var phase = Phase.aiming
    @Published var size: Float = 0.2
    @Published var seen: Double = 0
    /// Distance to what is in the middle of the view (metres), nil without a reading.
    @Published var distance: Float?
    @Published var message: String?

    let arView = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
    private let queue = DispatchQueue(label: "dev.meercad.lidar-scan", qos: .userInitiated)
    private let store = FieldStore()
    private var marker: AnchorEntity?
    private var busy = false
    private var lastPublish = Date.distantPast
    private var frames = 0
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
    }

    func stop() {
        arView.session.pause()
    }

    /// Places the box at a tap: on the table under the tapped object, or centred on the tapped surface.
    func place(at point: CGPoint) {
        guard phase == .aiming, let frame = arView.session.currentFrame else { return }
        guard let hit = arView.raycast(from: point, allowing: .estimatedPlane, alignment: .any).first else {
            message = "Nothing found there. Aim from a hand's width or two away and tap again."
            return
        }
        let t = hit.worldTransform
        let at = SIMD3<Float>(t.columns.3.x, t.columns.3.y, t.columns.3.z)
        var n = simd_normalize(SIMD3<Float>(t.columns.1.x, t.columns.1.y, t.columns.1.z))
        let cam = frame.camera.transform
        let camPos = SIMD3<Float>(cam.columns.3.x, cam.columns.3.y, cam.columns.3.z)
        if simd_dot(n, camPos - at) < 0 { n = -n }
        // The box's x follows the screen's right (the phone is held upright: that is the camera's -y).
        let screenRight = -SIMD3<Float>(cam.columns.1.x, cam.columns.1.y, cam.columns.1.z)
        let half = SIMD3<Float>(repeating: size / 2)
        let centre: SIMD3<Float>
        let axes: simd_float3x3
        switch mode {
        case .surface:
            var u = screenRight - simd_dot(screenRight, n) * n
            if simd_length(u) < 1e-3 { u = simd_cross(SIMD3<Float>(0, 1, 0), n) }
            u = simd_normalize(u)
            axes = simd_float3x3(u, simd_cross(n, u), n)
            centre = at
        case .object:
            guard let floor = floorHeight(below: at, normal: n, frame: frame) else {
                message = "The table is not found yet. Show the table around the object for a moment, then tap the object again."
                return
            }
            let up = SIMD3<Float>(0, 1, 0)
            var u = SIMD3<Float>(screenRight.x, 0, screenRight.z)
            if simd_length(u) < 1e-3 { u = SIMD3<Float>(1, 0, 0) }
            u = simd_normalize(u)
            axes = simd_float3x3(u, simd_cross(up, u), up)
            // A few millimetres above the table, so the table itself stays out.
            centre = SIMD3<Float>(at.x, floor + 0.003 + size / 2, at.z)
        }
        showBox(centre: centre, axes: axes, half: half)
        queue.async { [store] in
            store.field = VoxelField(centre: centre, axes: axes, half: half)
            store.debug = []
        }
        arView.debugOptions.insert(.showSceneUnderstanding)
        frames = 0
        started = Date()
        message = nil
        phase = .scanning
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
        arView.debugOptions.remove(.showSceneUnderstanding)
        seen = 0
        phase = .aiming
    }

    /// Closes what was seen into solids and writes them; returns the result for the web app.
    func finish() async throws -> [String: Any] {
        phase = .building
        arView.session.pause()
        let mode = self.mode, size = self.size, frames = self.frames
        let seconds = Int(Date().timeIntervalSince(started))
        return try await withCheckedThrowingContinuation { done in
            queue.async { [store] in
                guard var field = store.field else { return done.resume(throwing: ScanError.failed("Nothing was scanned.")) }
                // Under a surface, keep only a few millimetres of the unseen material.
                if mode == .surface, let low = field.lowestSurface() { field.cutBelow = max(0, low - 0.005) }
                guard let (pieces, cell) = field.solids() else {
                    return done.resume(throwing: ScanError.failed("Too little was seen. Sweep slowly over everything inside the box, from several sides."))
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
                    let log: [String: Any] = ["mode": "lidar-\(mode.rawValue)", "boxMm": Int(size * 1000), "voxelMm": field.voxel * 1000, "cellMm": cell * 1000,
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

    private func take(_ frame: ARFrame) {
        guard let depth = frame.sceneDepth else { return }
        distance = DepthSample.centre(of: depth)
        // A frame is copied only when the last one is done, so slow phones skip frames instead of lagging.
        guard phase == .scanning, !busy, let sample = DepthSample(frame: frame, depth: depth) else { return }
        busy = true
        frames += 1
        let publish = Date().timeIntervalSince(lastPublish) > 0.5
        if publish { lastPublish = Date() }
        queue.async { [store, weak self] in
            var points: [SIMD3<Float>] = [], carve: [Bool] = []
            points.reserveCapacity(sample.width * sample.height)
            carve.reserveCapacity(sample.width * sample.height)
            sample.points { p, c in
                points.append(p)
                carve.append(c)
            }
            // Taken out while adding, so its arrays are not copied.
            if var f = store.field {
                store.field = nil
                f.integrate(camera: sample.position, points: points, carve: carve)
                store.field = f
            }
            if store.debug.count < 300_000 { store.debug += stride(from: 0, to: points.count, by: 60).map { points[$0] } }
            let seen = publish ? store.field?.seen : nil
            Task { @MainActor in
                guard let self else { return }
                self.busy = false
                if let seen { self.seen = seen }
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
}

/// One LiDAR depth frame copied out of ARKit (frames must not be held), with what is needed to turn
/// its pixels into points in the world.
struct DepthSample: Sendable {
    let width: Int, height: Int
    let depth: [Float32]
    let confidence: [UInt8]
    let fx: Float, fy: Float, cx: Float, cy: Float
    let camera: simd_float4x4

    var position: SIMD3<Float> { SIMD3(camera.columns.3.x, camera.columns.3.y, camera.columns.3.z) }

    init?(frame: ARFrame, depth data: ARDepthData) {
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
        for v in 0..<height - 1 {
            for u in 0..<width - 1 {
                let i = v * width + u
                let d = depth[i]
                guard confidence[i] == high, d > 0.08, d < 1.2 else { continue }
                guard abs(depth[i + 1] - d) < 0.02 * d, abs(depth[i + width] - d) < 0.02 * d else { continue }
                let p = SIMD4<Float>((Float(u) + 0.5 - cx) * d / fx, -(Float(v) + 0.5 - cy) * d / fy, -d, 1)
                let w = camera * p
                use(SIMD3(w.x, w.y, w.z), u % 3 == 0 && v % 3 == 0)
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
                .gesture(SpatialTapGesture().onEnded { scanner.place(at: $0.location) })
            if scanner.phase == .aiming {
                Image(systemName: "plus").font(.system(size: 28, weight: .light)).foregroundStyle(.white).shadow(radius: 2).allowsHitTesting(false)
            }
            VStack(spacing: 12) {
                HStack {
                    Button("Cancel", action: cancel).buttonStyle(.bordered)
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
            hint(scanner.mode == .object
                ? "Put the object on a table. Choose the box size, then tap the object."
                : "Choose the box size, then tap the middle of the surface to scan.")
            Picker("Size", selection: $scanner.size) {
                ForEach([0.1, 0.2, 0.3, 0.4] as [Float], id: \.self) { Text("\(Int($0 * 100)) cm").tag($0) }
            }
            .pickerStyle(.segmented)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
        case .scanning:
            hint(distanceHint + "\n" + (scanner.mode == .object
                ? "Move slowly around the object, from above and from the sides, so the mesh covers it everywhere."
                : "Sweep slowly over the surface, also at a slant into corners and recesses.")
                + " Seen: \(Int(scanner.seen * 100)) %")
            HStack {
                Button("Start over") { scanner.restart() }.buttonStyle(.bordered)
                Button("Done", action: finish).buttonStyle(.borderedProminent).controlSize(.large).disabled(scanner.seen < 0.05)
            }
        case .building:
            ProgressView("Building the part…").padding().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var distanceHint: String {
        guard let d = scanner.distance else { return "Point the phone at it." }
        let cm = Int((d * 100).rounded())
        if d < 0.15 { return "\(cm) cm away: a bit further back." }
        if d > 0.6 { return "\(cm) cm away: closer gives more detail." }
        return "\(cm) cm away: good."
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
