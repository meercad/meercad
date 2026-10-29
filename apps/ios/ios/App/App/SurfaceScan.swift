import ARKit
import Foundation
import RealityKit
import SwiftUI
import UIKit

/// Scanning a surface with the LiDAR sensor, for parts that must fit onto or into something one cannot
/// walk around (a recess, a contour, a mount on a wall).
///
/// The user picks a patch size and taps the middle of the surface; the patch lies on the surface there,
/// facing the phone. While the phone sweeps over it, every LiDAR depth frame adds its high-confidence
/// points to a `SurfaceField`; a small map shows which parts were seen. Done closes the field into a
/// solid (the surface with material below) and writes it as STL in millimetres, the surface facing up.
@available(iOS 17, *)
@MainActor
final class SurfaceScanner: NSObject, ObservableObject, ARSessionDelegate {
    enum Phase: Equatable { case aiming, scanning, building }
    @Published var phase = Phase.aiming
    @Published var size: Float = 0.2
    @Published var coverage: Double = 0
    @Published var preview: CGImage?
    /// Distance to the surface at the middle of the view (metres), nil without a reading.
    @Published var distance: Float?
    @Published var message: String?

    let arView = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
    private let queue = DispatchQueue(label: "dev.meercad.surface-scan", qos: .userInitiated)
    /// The patch on the surface: origin and its axes (x, y along the surface, z out of it).
    private var origin = SIMD3<Float>.zero
    private var axes = simd_float3x3()
    private var marker: AnchorEntity?
    /// The samples so far, touched only on `queue`.
    private let store = FieldStore()
    private var busy = false
    private var lastPublish = Date.distantPast
    private var frames = 0
    private var started = Date()

    func start() {
        let config = ARWorldTrackingConfiguration()
        config.frameSemantics = [.sceneDepth]
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) { config.sceneReconstruction = .mesh }
        arView.session.delegate = self
        arView.session.run(config)
    }

    func stop() {
        arView.session.pause()
    }

    /// Places the patch on the surface under a tap.
    func place(at point: CGPoint) {
        guard phase == .aiming, let frame = arView.session.currentFrame else { return }
        guard let hit = arView.raycast(from: point, allowing: .estimatedPlane, alignment: .any).first else {
            message = "No surface found there. Aim at it from a hand's width or two away and tap again."
            return
        }
        let t = hit.worldTransform
        let at = SIMD3<Float>(t.columns.3.x, t.columns.3.y, t.columns.3.z)
        var n = simd_normalize(SIMD3<Float>(t.columns.1.x, t.columns.1.y, t.columns.1.z))
        let cam = frame.camera.transform
        let camPos = SIMD3<Float>(cam.columns.3.x, cam.columns.3.y, cam.columns.3.z)
        if simd_dot(n, camPos - at) < 0 { n = -n }
        // The patch's x follows the screen's right, so the map reads like the view.
        let right = SIMD3<Float>(cam.columns.0.x, cam.columns.0.y, cam.columns.0.z)
        let screenRight = UIDevice.current.orientation.isLandscape ? right : SIMD3<Float>(-cam.columns.1.x, -cam.columns.1.y, -cam.columns.1.z)
        var u = screenRight - simd_dot(screenRight, n) * n
        if simd_length(u) < 1e-3 { u = simd_cross(SIMD3<Float>(0, 1, 0), n) }
        u = simd_normalize(u)
        let v = simd_cross(n, u)
        origin = at
        axes = simd_float3x3(u, v, n)
        showMarker()
        let size = self.size
        queue.async { [store] in store.field = SurfaceField(size: size) }
        frames = 0
        started = Date()
        message = nil
        phase = .scanning
    }

    func restart() {
        queue.sync { store.field = nil }
        marker?.removeFromParent()
        marker = nil
        coverage = 0
        preview = nil
        phase = .aiming
    }

    /// Closes what was seen into a solid and writes it; returns the result for the web app.
    func finish() async throws -> [String: Any] {
        phase = .building
        let size = self.size
        let frames = self.frames
        let seconds = Int(Date().timeIntervalSince(started))
        let result: (URL, Int, [Double], Double) = try await withCheckedThrowingContinuation { done in
            queue.async { [store] in
                guard let field = store.field, let corners = field.solid() else { return done.resume(throwing: ScanError.failed("Too little of the surface was seen. Sweep slowly over the whole area until the map is filled.")) }
                do {
                    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                    let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
                    let folder = docs.appendingPathComponent("Scans/\(stamp)-surface", isDirectory: true)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    let stl = folder.appendingPathComponent("scan.stl")
                    let (triangles, mm) = try MeshExport.writeSTL(corners, to: stl)
                    let log: [String: Any] = ["mode": "surface", "patchMm": Int(size * 1000), "frames": frames, "coverage": field.coverage, "seconds": seconds,
                                              "triangles": triangles, "sizeMm": mm, "machine": Self.machine(), "system": "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)"]
                    if let data = try? JSONSerialization.data(withJSONObject: log, options: [.prettyPrinted, .sortedKeys]) {
                        try? data.write(to: folder.appendingPathComponent("scan.json"))
                    }
                    done.resume(returning: (stl, triangles, mm, field.coverage))
                } catch {
                    done.resume(throwing: error)
                }
            }
        }
        return ["path": result.0.path, "folder": result.0.deletingLastPathComponent().path, "triangles": result.1, "size": result.2, "photos": 0, "seconds": seconds, "coverage": result.3]
    }

    private func showMarker() {
        marker?.removeFromParent()
        let anchor = AnchorEntity(world: simd_float4x4(SIMD4(axes.columns.0, 0), SIMD4(axes.columns.2, 0), SIMD4(simd_cross(axes.columns.0, axes.columns.2), 0), SIMD4(origin, 1)))
        var material = UnlitMaterial(color: .systemTeal)
        material.blending = .transparent(opacity: .init(floatLiteral: 0.22))
        let plane = ModelEntity(mesh: .generatePlane(width: size, depth: size), materials: [material])
        plane.position.y = 0.001
        anchor.addChild(plane)
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
        let origin = self.origin, axes = self.axes, publish = Date().timeIntervalSince(lastPublish) > 0.3
        if publish { lastPublish = Date() }
        queue.async { [store, weak self] in
            // Taken out while adding, so its arrays are not copied.
            if var f = store.field {
                store.field = nil
                sample.points { p in f.add(axes.transpose * (p - origin)) }
                store.field = f
            }
            let update = publish ? store.field.map { ($0.coverage, Self.image($0.preview(size: 120), 120)) } : nil
            Task { @MainActor in
                guard let self else { return }
                self.busy = false
                if let update {
                    self.coverage = update.0
                    self.preview = update.1
                }
            }
        }
    }

    private nonisolated static func image(_ rgba: [UInt8], _ size: Int) -> CGImage? {
        let data = Data(rgba) as CFData
        guard let provider = CGDataProvider(data: data) else { return nil }
        return CGImage(width: size, height: size, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }

    private nonisolated static func machine() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }
}

/// Holds the surface field for the scanner's processing queue (only that queue touches it).
final class FieldStore: @unchecked Sendable {
    var field: SurfaceField?
}

/// One LiDAR depth frame copied out of ARKit (frames must not be held), with what is needed to turn
/// its pixels into points in the world.
struct DepthSample: Sendable {
    let width: Int, height: Int
    let depth: [Float32]
    let confidence: [UInt8]
    let fx: Float, fy: Float, cx: Float, cy: Float
    let camera: simd_float4x4

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
    /// the sensor blends near and far into points in mid-air).
    func points(_ use: (SIMD3<Float>) -> Void) {
        let high = UInt8(ARConfidenceLevel.high.rawValue)
        for v in 0..<height - 1 {
            for u in 0..<width - 1 {
                let i = v * width + u
                let d = depth[i]
                guard confidence[i] == high, d > 0.08, d < 1.2 else { continue }
                guard abs(depth[i + 1] - d) < 0.02 * d, abs(depth[i + width] - d) < 0.02 * d else { continue }
                let p = SIMD4<Float>((Float(u) + 0.5 - cx) * d / fx, -(Float(v) + 0.5 - cy) * d / fy, -d, 1)
                let w = camera * p
                use(SIMD3(w.x, w.y, w.z))
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
struct SurfaceScanView: View {
    @StateObject var scanner: SurfaceScanner
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
                HStack(alignment: .top) {
                    Button("Cancel", action: cancel).buttonStyle(.bordered)
                    Spacer()
                    if scanner.phase == .scanning, let preview = scanner.preview {
                        Image(decorative: preview, scale: 1).resizable().interpolation(.none).frame(width: 110, height: 110)
                            .clipShape(RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(.white.opacity(0.6)))
                    }
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
            hint("Choose the area's size, then tap the middle of the surface to scan.")
            Picker("Size", selection: $scanner.size) {
                ForEach([0.1, 0.2, 0.3, 0.4] as [Float], id: \.self) { Text("\(Int($0 * 100)) cm").tag($0) }
            }
            .pickerStyle(.segmented)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
        case .scanning:
            hint(distanceHint + "\nSweep slowly over the whole square, also at a slant into corners and recesses. Seen: \(Int(scanner.coverage * 100)) %")
            HStack {
                Button("Start over") { scanner.restart() }.buttonStyle(.bordered)
                Button("Done", action: finish).buttonStyle(.borderedProminent).controlSize(.large).disabled(scanner.coverage < 0.05)
            }
        case .building:
            ProgressView("Building the part…").padding().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var distanceHint: String {
        guard let d = scanner.distance else { return "Point the phone at the surface." }
        let cm = Int((d * 100).rounded())
        if d < 0.15 { return "\(cm) cm away: a bit further back." }
        if d > 0.5 { return "\(cm) cm away: closer gives more detail." }
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
