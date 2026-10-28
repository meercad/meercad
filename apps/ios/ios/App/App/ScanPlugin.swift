import Capacitor
import Foundation
import RealityKit
import SwiftUI
import UIKit

/// 3D scanning for the web app, all on the device (iPhone/iPad with LiDAR, iOS 18+).
///
/// `scan` walks the user around an object with RealityKit's guided object capture, then rebuilds a
/// mesh from the photos. The capture session is released before the rebuild starts (both at once
/// run out of memory), and the rebuild reuses the capture's checkpoint folder (LiDAR points and camera
/// poses). Each scan is kept in Documents/Scans/<date> with the mesh as binary STL in millimetres
/// (Z up, like meerCAD), the USDZ, and scan.json with what happened, so a failed scan can be looked at
/// in the Files app.
@objc(ScanPlugin)
public class ScanPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScanPlugin"
    public let jsName = "Scan"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
    ]

    @objc func capabilities(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard #available(iOS 18, *) else {
                return call.resolve(["scan": false, "reason": "Scanning needs iOS 18 or later (this is \(UIDevice.current.systemVersion))."])
            }
            let supported = ObjectCaptureSession.isSupported
            call.resolve(["scan": supported, "reason": supported ? "" : "This device does not support object capture (it needs a LiDAR scanner)."])
        }
    }

    @objc func scan(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            guard #available(iOS 18, *), ObjectCaptureSession.isSupported else {
                return call.reject("Scanning needs an iPhone or iPad with LiDAR and iOS 18 or later.")
            }
            guard let self, let host = self.bridge?.viewController else { return call.reject("no view") }
            let flow = ScanFlow()
            let view = ScanView(flow: flow) { result in
                host.dismiss(animated: true)
                switch result {
                case .success(let r): call.resolve(r)
                case .failure(let e): call.reject(e.localizedDescription, (e as? ScanError)?.code)
                }
            }
            let controller = UIHostingController(rootView: view)
            controller.modalPresentationStyle = .fullScreen
            host.present(controller, animated: true)
        }
    }
}

enum ScanError: LocalizedError {
    case cancelled, noModel, emptyModel, failed(String)
    var code: String {
        switch self {
        case .cancelled: return "cancelled"
        case .noModel, .emptyModel: return "no_model"
        case .failed: return "failed"
        }
    }
    var errorDescription: String? {
        switch self {
        case .cancelled: return "Scan cancelled"
        case .noModel: return "The photos did not give a model. Scan again with the object filling more of the frame, from all sides."
        case .emptyModel: return "The model came out empty."
        case .failed(let m): return m
        }
    }
}

// MARK: - Flow state

/// Everything one scan needs, kept outside the views so the capture session can be released early.
@available(iOS 18, *)
@MainActor
final class ScanFlow: ObservableObject {
    enum Phase { case capturing, rebuilding, writing }
    @Published var phase = Phase.capturing
    @Published var session: ObjectCaptureSession?
    @Published var progress: Double = 0
    @Published var passes = 0
    @Published var askNext = false

    let folder: URL
    let images: URL
    let checkpoints: URL
    private let started = Date()
    private var captureSeconds: Double = 0
    var log: [String: Any] = [:]

    init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        folder = docs.appendingPathComponent("Scans/\(stamp)", isDirectory: true)
        images = folder.appendingPathComponent("Images", isDirectory: true)
        checkpoints = folder.appendingPathComponent("Checkpoints", isDirectory: true)
        for dir in [images, checkpoints] { try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
        log["device"] = UIDevice.current.model
        log["system"] = "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)"
        log["machine"] = Self.machine()
    }

    func start() {
        let s = ObjectCaptureSession()
        var config = ObjectCaptureSession.Configuration()
        config.checkpointDirectory = checkpoints
        config.isOverCaptureEnabled = false
        s.start(imagesDirectory: images, configuration: config)
        session = s
    }

    /// Capture done: release the session first, then rebuild from the photos.
    func rebuild() async throws -> [String: Any] {
        captureSeconds = Date().timeIntervalSince(started)
        session = nil
        phase = .rebuilding
        progress = 0
        let photoCount = (try? FileManager.default.contentsOfDirectory(atPath: images.path).count) ?? 0
        let checkpointBytes = Self.size(of: checkpoints)
        log["photos"] = photoCount
        log["passes"] = passes
        log["checkpointBytes"] = checkpointBytes
        log["captureSeconds"] = Int(captureSeconds)

        let t0 = Date()
        var config = PhotogrammetrySession.Configuration()
        config.checkpointDirectory = checkpoints
        let usdz = folder.appendingPathComponent("scan.usdz")
        let rebuild = try PhotogrammetrySession(input: images, configuration: config)
        try rebuild.process(requests: [.modelFile(url: usdz, detail: .reduced)])
        var failure: Error?
        for try await output in rebuild.outputs {
            switch output {
            case .requestProgress(_, let fraction): progress = fraction
            case .requestError(_, let error): failure = error
            default: break
            }
        }
        log["rebuildSeconds"] = Int(Date().timeIntervalSince(t0))
        if let failure {
            log["error"] = "\(failure)"
            writeLog()
            throw ScanError.failed("Building the model failed: \(failure.localizedDescription)")
        }
        guard FileManager.default.fileExists(atPath: usdz.path) else {
            writeLog()
            throw ScanError.noModel
        }

        phase = .writing
        let stl = folder.appendingPathComponent("scan.stl")
        let stats = try await MeshExport.write(usdz: usdz, stl: stl)
        log["triangles"] = stats.triangles
        log["sizeMm"] = stats.size
        writeLog()
        // The photos are only needed for the rebuild; the checkpoints stay for a later finer one.
        try? FileManager.default.removeItem(at: images)
        return ["path": stl.path, "folder": folder.path, "triangles": stats.triangles, "size": stats.size, "photos": photoCount, "seconds": Int(Date().timeIntervalSince(started))]
    }

    func fail(_ error: Error) {
        log["error"] = "\(error)"
        log["captureSeconds"] = Int(Date().timeIntervalSince(started))
        writeLog()
    }

    private func writeLog() {
        if let data = try? JSONSerialization.data(withJSONObject: log, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: folder.appendingPathComponent("scan.json"))
        }
    }

    private static func size(of dir: URL) -> Int {
        let files = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.fileSizeKey])
        var total = 0
        while let url = files?.nextObject() as? URL { total += (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0 }
        return total
    }

    private static func machine() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }
}

// MARK: - Mesh export

/// The rebuilt USDZ as a binary STL in millimetres, turned from RealityKit's Y-up metres to meerCAD's Z-up.
@available(iOS 18, *)
enum MeshExport {
    static func write(usdz: URL, stl: URL) async throws -> (triangles: Int, size: [Double]) {
        let root = try await Entity(contentsOf: usdz)
        var corners: [SIMD3<Float>] = []
        collect(root, root: root, into: &corners)
        guard !corners.isEmpty else { throw ScanError.emptyModel }
        var lo = SIMD3<Float>(repeating: .greatestFiniteMagnitude), hi = -lo
        for p in corners {
            lo = simd_min(lo, p)
            hi = simd_max(hi, p)
        }
        var data = Data(count: 80)
        var count = UInt32(corners.count / 3)
        data.append(Data(bytes: &count, count: 4))
        for t in stride(from: 0, to: corners.count, by: 3) {
            let a = corners[t], b = corners[t + 1], c = corners[t + 2]
            var n = simd_cross(b - a, c - a)
            let len = simd_length(n)
            n = len > 0 ? n / len : SIMD3<Float>(0, 0, 0)
            for v in [n, a, b, c] {
                var x = v.x, y = v.y, z = v.z
                data.append(Data(bytes: &x, count: 4))
                data.append(Data(bytes: &y, count: 4))
                data.append(Data(bytes: &z, count: 4))
            }
            var attr: UInt16 = 0
            data.append(Data(bytes: &attr, count: 2))
        }
        try data.write(to: stl)
        let size = hi - lo
        return (Int(count), [Double(size.x), Double(size.y), Double(size.z)].map { ($0 * 10).rounded() / 10 })
    }

    private static func collect(_ entity: Entity, root: Entity, into out: inout [SIMD3<Float>]) {
        if let model = entity.components[ModelComponent.self] {
            let matrix = entity.transformMatrix(relativeTo: root)
            for m in model.mesh.contents.models {
                for part in m.parts {
                    let positions = Array(part.positions)
                    let indices: [UInt32] = part.triangleIndices.map { Array($0) } ?? Array(0..<UInt32(positions.count))
                    for i in indices {
                        let p = positions[Int(i)]
                        let w = matrix * SIMD4<Float>(p.x, p.y, p.z, 1)
                        // Y up (RealityKit) → Z up (meerCAD), metres → millimetres.
                        out.append(SIMD3<Float>(w.x, -w.z, w.y) * 1000)
                    }
                }
            }
        }
        for child in entity.children { collect(child, root: root, into: &out) }
    }
}

// MARK: - Views

@available(iOS 18, *)
struct ScanView: View {
    @ObservedObject var flow: ScanFlow
    let done: (Result<[String: Any], Error>) -> Void
    @State private var finished = false

    var body: some View {
        ZStack {
            switch flow.phase {
            case .capturing:
                if let session = flow.session {
                    CaptureScreen(session: session, flow: flow, cancel: cancel, failed: failCapture, finish: finishCapture)
                } else {
                    ProgressView()
                }
            case .rebuilding:
                Working(title: "Building the model", detail: "This takes a minute or two. Keep the app open.", progress: flow.progress)
            case .writing:
                Working(title: "Preparing the part", detail: nil, progress: nil)
            }
        }
        .onAppear { if flow.session == nil { flow.start() } }
    }

    private func cancel() {
        guard !finished else { return }
        finished = true
        flow.session?.cancel()
        flow.fail(ScanError.cancelled)
        done(.failure(ScanError.cancelled))
    }

    private func failCapture(_ error: Error) {
        guard !finished else { return }
        finished = true
        flow.fail(error)
        done(.failure(ScanError.failed("Scanning stopped: \(error.localizedDescription)")))
    }

    private func finishCapture() {
        guard !finished else { return }
        finished = true
        Task {
            do { done(.success(try await flow.rebuild())) } catch { done(.failure(error)) }
        }
    }
}

@available(iOS 18, *)
struct CaptureScreen: View {
    let session: ObjectCaptureSession
    @ObservedObject var flow: ScanFlow
    let cancel: () -> Void
    let failed: (Error) -> Void
    let finish: () -> Void

    var body: some View {
        ZStack {
            ObjectCaptureView(session: session)
                .ignoresSafeArea()
            VStack(spacing: 12) {
                HStack {
                    Button("Cancel", action: cancel).buttonStyle(.bordered)
                    Spacer()
                    if flow.passes > 0 { Text("Pass \(flow.passes + 1)").font(.footnote).padding(8).background(.ultraThinMaterial, in: Capsule()) }
                }
                Spacer()
                if flow.askNext { nextPass } else { controls }
            }
            .padding()
        }
        .onChange(of: session.userCompletedScanPass) { _, completed in
            if completed { flow.askNext = true }
        }
        .onChange(of: session.state) { _, state in
            switch state {
            case .completed: finish()
            case .failed(let error): failed(error)
            default: break
            }
        }
    }

    @ViewBuilder private var controls: some View {
        switch session.state {
        case .ready:
            hint("Put the object on a plain, matt surface with room to walk around it. Good, even light helps.")
            Button("Continue") { _ = session.startDetecting() }.buttonStyle(.borderedProminent).controlSize(.large)
        case .detecting:
            hint("Fit the box around the object.")
            Button("Start scanning") { session.startCapturing() }.buttonStyle(.borderedProminent).controlSize(.large)
        case .capturing:
            hint("Walk slowly around the object, keeping it in the frame, until the ring is full.")
        case .finishing:
            ProgressView("Finishing the capture…").padding().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        default:
            EmptyView()
        }
    }

    /// After each ring: flip the object for the underside, go round once more, or stop.
    private var nextPass: some View {
        VStack(spacing: 10) {
            hint("Ring complete. For a full model, turn the object over and scan its other side.")
            Button("Turn over and continue") {
                flow.passes += 1
                flow.askNext = false
                session.beginNewScanPassAfterFlip()
            }
            .buttonStyle(.borderedProminent).controlSize(.large)
            HStack {
                Button("Another ring") {
                    flow.passes += 1
                    flow.askNext = false
                    session.beginNewScanPass()
                }
                .buttonStyle(.bordered)
                Button("Done") {
                    flow.passes += 1
                    flow.askNext = false
                    session.finish()
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(.callout).multilineTextAlignment(.center).padding(10).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

@available(iOS 18, *)
struct Working: View {
    let title: String
    let detail: String?
    let progress: Double?
    var body: some View {
        VStack(spacing: 16) {
            Text(title).font(.headline)
            if let progress {
                ProgressView(value: progress).frame(maxWidth: 280)
                Text("\(Int(progress * 100)) %").font(.footnote).foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
            if let detail { Text(detail).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center) }
        }
        .padding(32)
    }
}
