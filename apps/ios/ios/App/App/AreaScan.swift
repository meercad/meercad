import ARKit
import CoreImage
import Foundation
import ImageIO
import RealityKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// An area (a garden bed, a terrace, a room corner, a wall) scanned with LiDAR: ARKit builds a mesh
/// of everything the sensor sees while the user walks about, the mesh shows live so it is clear what
/// is still missing, and camera pictures taken along the way colour it. No box, no size limit, no
/// waiting for photogrammetry, true size and level (ARKit's world is upright, in metres). Written as
/// a GLB in millimetres, Z up, like the terrain from photos, so the same tools work on it.
@available(iOS 17, *)
@MainActor
final class AreaScanner: NSObject, ObservableObject, ARSessionDelegate {
    enum Phase { case scanning, building }
    @Published var phase = Phase.scanning
    @Published var area: Float = 0
    @Published var pictures = 0
    @Published var tracking: String?

    let arView = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
    private let queue = DispatchQueue(label: "dev.meercad.area-scan", qos: .userInitiated)
    private let pictureStore = PictureStore()
    private var lastStats = Date.distantPast
    private let started = Date()

    static var isSupported: Bool { ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) }

    func start() {
        let config = ARWorldTrackingConfiguration()
        config.sceneReconstruction = .mesh
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) { config.frameSemantics = [.sceneDepth] }
        config.environmentTexturing = .none
        arView.session.delegate = self
        arView.session.delegateQueue = queue
        // ARKit's own mesh drawn over the camera: what is covered already.
        arView.debugOptions.insert(.showSceneUnderstanding)
        arView.renderOptions.insert(.disableMotionBlur)
        arView.session.run(config)
    }

    func stop() { arView.session.pause() }

    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        pictureStore.offer(frame)
        let now = Date()
        Task { @MainActor in
            guard now.timeIntervalSince(self.lastStats) > 0.5 else { return }
            self.lastStats = now
            self.pictures = self.pictureStore.count
            self.area = Self.meshArea(session.currentFrame?.anchors ?? [])
            switch frame.camera.trackingState {
            case .limited(.excessiveMotion): self.tracking = L("Slower, please.")
            case .limited(.insufficientFeatures): self.tracking = L("Too little to see here: point at more of the area.")
            case .limited: self.tracking = L("Hold on, finding the way…")
            default: self.tracking = nil
            }
        }
    }

    private static func meshArea(_ anchors: [ARAnchor]) -> Float {
        var total: Float = 0
        for case let m as ARMeshAnchor in anchors { total += Float(m.geometry.faces.count) * 0.0015 }
        return total
    }

    /// The mesh with its colours, as a GLB; the session stops first.
    func finish(to glb: URL) async throws -> [String: Any] {
        let anchors = arView.session.currentFrame?.anchors.compactMap { $0 as? ARMeshAnchor } ?? []
        arView.session.pause()
        phase = .building
        guard !anchors.isEmpty else { throw ScanError.failed(L("Nothing was scanned.")) }
        let mesh = AreaMesh(anchors)
        let pictures = pictureStore.all()
        let started = self.started
        return try await Task.detached(priority: .userInitiated) {
            let colours = mesh.colours(from: pictures)
            let stats = try mesh.writeGLB(colours: colours, to: glb)
            return ["path": glb.path, "photos": pictures.count, "triangles": stats.triangles, "size": stats.size, "seconds": Int(Date().timeIntervalSince(started)), "measured": true]
        }.value
    }
}

/// Camera pictures kept for colouring: small JPEGs with where the camera was and, with LiDAR, its depth.
final class PictureStore: @unchecked Sendable {
    struct Picture: Sendable {
        let jpeg: Data
        let width: Int, height: Int
        /// Camera to world.
        let pose: simd_float4x4
        /// Focal lengths and centre, in this picture's pixels.
        let fx: Float, fy: Float, cx: Float, cy: Float
        /// Depth (metres) on a smaller grid over the same view, row by row.
        let depth: [Float]
        let depthWidth: Int, depthHeight: Int
    }

    private let lock = NSLock()
    private var pictures: [Picture] = []
    private var lastPose: simd_float4x4?
    private let context = CIContext(options: [.useSoftwareRenderer: false])
    static let limit = 240
    static let width: CGFloat = 640

    var count: Int { lock.lock(); defer { lock.unlock() }; return pictures.count }
    func all() -> [Picture] { lock.lock(); defer { lock.unlock() }; return pictures }

    /// Keeps the frame when the camera has moved or turned enough since the last one.
    func offer(_ frame: ARFrame) {
        guard case .normal = frame.camera.trackingState else { return }
        let pose = frame.camera.transform
        lock.lock()
        let full = pictures.count >= Self.limit
        let last = lastPose
        lock.unlock()
        if full { return }
        if let last {
            let moved = simd_distance(pose.columns.3, last.columns.3)
            let turn = acos(min(1, max(-1, simd_dot(simd_normalize(SIMD3(pose.columns.2.x, pose.columns.2.y, pose.columns.2.z)), simd_normalize(SIMD3(last.columns.2.x, last.columns.2.y, last.columns.2.z))))))
            if moved < 0.25 && turn < 0.2 { return }
        }
        let image = CIImage(cvPixelBuffer: frame.capturedImage)
        let scale = Self.width / image.extent.width
        let small = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cg = context.createCGImage(small, from: small.extent) else { return }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return }
        let k = frame.camera.intrinsics
        var depth: [Float] = [], dw = 0, dh = 0
        if let map = frame.sceneDepth?.depthMap {
            CVPixelBufferLockBaseAddress(map, .readOnly)
            dw = CVPixelBufferGetWidth(map)
            dh = CVPixelBufferGetHeight(map)
            let row = CVPixelBufferGetBytesPerRow(map)
            if let base = CVPixelBufferGetBaseAddress(map) {
                depth.reserveCapacity(dw * dh)
                for y in 0..<dh {
                    let p = base.advanced(by: y * row).assumingMemoryBound(to: Float32.self)
                    for x in 0..<dw { depth.append(p[x]) }
                }
            }
            CVPixelBufferUnlockBaseAddress(map, .readOnly)
        }
        let s = Float(scale)
        let picture = Picture(jpeg: data as Data, width: cg.width, height: cg.height, pose: pose, fx: k[0][0] * s, fy: k[1][1] * s, cx: k[2][0] * s, cy: k[2][1] * s, depth: depth, depthWidth: dw, depthHeight: dh)
        lock.lock()
        pictures.append(picture)
        lastPose = pose
        lock.unlock()
    }
}

/// ARKit's mesh pieces joined into one, in world metres (Y up).
struct AreaMesh: Sendable {
    var positions: [SIMD3<Float>] = []
    var normals: [SIMD3<Float>] = []
    var indices: [UInt32] = []

    init(_ anchors: [ARMeshAnchor]) {
        for a in anchors {
            let g = a.geometry
            let base = UInt32(positions.count)
            let m = a.transform
            let rot = simd_float3x3(SIMD3(m.columns.0.x, m.columns.0.y, m.columns.0.z), SIMD3(m.columns.1.x, m.columns.1.y, m.columns.1.z), SIMD3(m.columns.2.x, m.columns.2.y, m.columns.2.z))
            let vs = g.vertices, ns = g.normals
            for i in 0..<vs.count {
                let p = vs.buffer.contents().advanced(by: vs.offset + vs.stride * i).assumingMemoryBound(to: Float.self)
                let w = m * SIMD4<Float>(p[0], p[1], p[2], 1)
                positions.append(SIMD3(w.x, w.y, w.z))
                let n = ns.buffer.contents().advanced(by: ns.offset + ns.stride * i).assumingMemoryBound(to: Float.self)
                normals.append(simd_normalize(rot * SIMD3(n[0], n[1], n[2])))
            }
            let f = g.faces
            let ptr = f.buffer.contents()
            for i in 0..<(f.count * f.indexCountPerPrimitive) {
                let v: UInt32 = f.bytesPerIndex == 4 ? ptr.load(fromByteOffset: i * 4, as: UInt32.self) : UInt32(ptr.load(fromByteOffset: i * 2, as: UInt16.self))
                indices.append(base + v)
            }
        }
    }

    /// A colour per vertex from the picture that sees it best: facing it, close, and not hidden
    /// behind something nearer (checked against that picture's depth). Grey where none sees it.
    func colours(from pictures: [PictureStore.Picture]) -> [SIMD3<UInt8>] {
        var colour = [SIMD3<UInt8>](repeating: SIMD3(150, 150, 150), count: positions.count)
        var score = [Float](repeating: 0, count: positions.count)
        for pic in pictures {
            guard let source = CGImageSourceCreateWithData(pic.jpeg as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { continue }
            let w = image.width, h = image.height
            var rgba = [UInt8](repeating: 0, count: w * h * 4)
            guard let ctx = CGContext(data: &rgba, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { continue }
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            let toCamera = pic.pose.inverse
            let eye = SIMD3(pic.pose.columns.3.x, pic.pose.columns.3.y, pic.pose.columns.3.z)
            for i in positions.indices {
                let p = positions[i]
                let c = toCamera * SIMD4<Float>(p.x, p.y, p.z, 1)
                // ARKit's camera looks along -Z, with Y up; pictures count rows from the top.
                let d = -c.z
                guard d > 0.1, d < 6 else { continue }
                let u = pic.fx * c.x / d + pic.cx, v = pic.fy * -c.y / d + pic.cy
                guard u >= 0, v >= 0, u < Float(w - 1), v < Float(h - 1) else { continue }
                let view = simd_normalize(eye - p)
                let facing = simd_dot(view, normals[i])
                guard facing > 0.15 else { continue }
                if pic.depthWidth > 0 {
                    let dx = min(pic.depthWidth - 1, Int(u / Float(w) * Float(pic.depthWidth)))
                    let dy = min(pic.depthHeight - 1, Int(v / Float(h) * Float(pic.depthHeight)))
                    if d > pic.depth[dy * pic.depthWidth + dx] + 0.06 { continue }
                }
                let s = facing / d
                guard s > score[i] else { continue }
                score[i] = s
                let o = (Int(v) * w + Int(u)) * 4
                colour[i] = SIMD3(rgba[o], rgba[o + 1], rgba[o + 2])
            }
        }
        return colour
    }

    /// The mesh as a GLB: millimetres, Z up, the middle of the area at the origin and the ground
    /// (its lowest few percent) at height 0; vertex colours, unlit.
    func writeGLB(colours: [SIMD3<UInt8>], to glb: URL) throws -> (triangles: Int, size: [Double]) {
        guard !indices.isEmpty else { throw ScanError.emptyModel }
        var mm = positions.map { SIMD3<Float>($0.x, -$0.z, $0.y) * 1000 }
        var lo = SIMD3<Float>(repeating: .greatestFiniteMagnitude), hi = -lo
        for p in mm { lo = simd_min(lo, p); hi = simd_max(hi, p) }
        let heights = mm.map(\.z).sorted()
        let ground = heights[min(heights.count - 1, heights.count / 50)]
        let shift = SIMD3((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, ground)
        mm = mm.map { $0 - shift }
        lo -= shift
        hi -= shift

        var bin = Data()
        var views: [[String: Any]] = []
        func view(_ data: Data, target: Int) -> Int {
            while bin.count % 4 != 0 { bin.append(0) }
            views.append(["buffer": 0, "byteOffset": bin.count, "byteLength": data.count, "target": target])
            bin.append(data)
            return views.count - 1
        }
        var pos = Data(capacity: mm.count * 12)
        for p in mm { withUnsafeBytes(of: (p.x, p.y, p.z)) { pos.append(contentsOf: $0) } }
        // glTF vertex colours are linear; the pictures are sRGB.
        let linear = (0..<256).map { v -> Float in
            let c = Float(v) / 255
            return c <= 0.04045 ? c / 12.92 : powf((c + 0.055) / 1.055, 2.4)
        }
        var col = Data(capacity: colours.count * 12)
        for c in colours { withUnsafeBytes(of: (linear[Int(c.x)], linear[Int(c.y)], linear[Int(c.z)])) { col.append(contentsOf: $0) } }
        let idx = indices.withUnsafeBufferPointer { Data(buffer: $0) }
        let accessors: [[String: Any]] = [
            ["bufferView": view(pos, target: 34962), "componentType": 5126, "count": mm.count, "type": "VEC3", "min": [lo.x, lo.y, lo.z], "max": [hi.x, hi.y, hi.z]],
            ["bufferView": view(col, target: 34962), "componentType": 5126, "count": colours.count, "type": "VEC3"],
            ["bufferView": view(idx, target: 34963), "componentType": 5125, "count": indices.count, "type": "SCALAR"],
        ]
        while bin.count % 4 != 0 { bin.append(0) }
        let json: [String: Any] = [
            "asset": ["version": "2.0", "generator": "meerCAD"],
            "scene": 0,
            "scenes": [["nodes": [0]]],
            "nodes": [["mesh": 0]],
            "meshes": [["primitives": [["attributes": ["POSITION": 0, "COLOR_0": 1], "indices": 2, "mode": 4, "material": 0]]]],
            "materials": [["pbrMetallicRoughness": ["metallicFactor": 0, "roughnessFactor": 1], "doubleSided": true, "extensions": ["KHR_materials_unlit": [:] as [String: Any]]]],
            "extensionsUsed": ["KHR_materials_unlit"],
            "buffers": [["byteLength": bin.count]],
            "bufferViews": views,
            "accessors": accessors,
        ]
        var text = try JSONSerialization.data(withJSONObject: json)
        while text.count % 4 != 0 { text.append(0x20) }
        var out = Data()
        func u32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { out.append(contentsOf: $0) } }
        u32(0x4654_6C67)
        u32(2)
        u32(12 + 8 + text.count + 8 + bin.count)
        u32(text.count)
        u32(0x4E4F_534A)
        out.append(text)
        u32(bin.count)
        u32(0x004E_4942)
        out.append(bin)
        try out.write(to: glb)
        let size = hi - lo
        return (indices.count / 3, [size.x, size.y, size.z].map { (Double($0) * 10).rounded() / 10 })
    }
}

@available(iOS 17, *)
struct AreaScanView: View {
    @StateObject var scanner: AreaScanner
    let done: (Result<[String: Any], Error>) -> Void
    @State private var finished = false

    var body: some View {
        ZStack {
            AreaARContainer(view: scanner.arView).ignoresSafeArea()
            if scanner.phase == .building {
                Color.black.opacity(0.55).ignoresSafeArea()
                VStack(spacing: 16) {
                    Text(L("Preparing the model")).font(.headline)
                    ProgressView()
                    Text(L("Colouring it from the pictures taken.")).font(.footnote).foregroundStyle(.secondary)
                }
                .padding(32)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
            } else {
                VStack(spacing: 12) {
                    Text(scanner.tracking ?? L("Walk slowly over the area and point at everything you need: the mesh shows what is in. Close up gives more detail; also at a slant into corners."))
                        .font(.callout).multilineTextAlignment(.center).padding(12)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12)).padding(.horizontal)
                    Spacer()
                    Text(L("{m2} m² · {n} pictures", ["m2": Int(scanner.area.rounded()), "n": scanner.pictures]))
                        .font(.footnote.monospacedDigit()).padding(.horizontal, 10).padding(.vertical, 4)
                        .background(.ultraThinMaterial, in: Capsule())
                    HStack(spacing: 16) {
                        Button(L("Cancel")) { cancel() }.buttonStyle(.bordered).controlSize(.large)
                        Button(L("Done")) { Task { await finish() } }.buttonStyle(.borderedProminent).controlSize(.large)
                    }
                    .padding(.bottom, 24)
                }
                .padding(.top, 12)
            }
        }
        .onAppear { scanner.start() }
    }

    private func cancel() {
        scanner.stop()
        complete(.failure(ScanError.cancelled))
    }

    private func finish() async {
        let glb = FileManager.default.temporaryDirectory.appendingPathComponent("area-\(Int(Date().timeIntervalSince1970)).glb")
        do { complete(.success(try await scanner.finish(to: glb))) } catch { complete(.failure(error)) }
    }

    private func complete(_ result: Result<[String: Any], Error>) {
        guard !finished else { return }
        finished = true
        UIApplication.shared.isIdleTimerDisabled = false
        done(result)
    }
}

private struct AreaARContainer: UIViewRepresentable {
    let view: ARView
    func makeUIView(context: Context) -> ARView { view }
    func updateUIView(_ uiView: ARView, context: Context) {}
}
