import Capacitor
import RealityKit
@_weakLinked import RoomPlan
import SwiftUI
import UIKit

/// Scanning rooms and areas in the app, guided live so nobody has to think about how to film:
/// - a room with Apple's RoomPlan (LiDAR): walls, doors, windows, openings, floor and furniture as
///   measured shapes, which the web app turns into editable parts;
/// - an area (garden bed, terrace, a corner, a wall) with Object Capture in area mode: photos with
///   LiDAR depth, built into a textured model on the device (true size, level), shown as surroundings.
@objc(RoomPlugin)
public class RoomPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RoomPlugin"
    public let jsName = "Room"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanRoom", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanArea", returnType: CAPPluginReturnPromise),
    ]

    @objc func capabilities(_ call: CAPPluginCall) {
        Loc.use(call)
        Task { @MainActor in
            var room = false, area = false
            if #available(iOS 17, *) { room = RoomCaptureSession.isSupported }
            if #available(iOS 18, *) { area = ObjectCaptureSession.isSupported }
            call.resolve(["room": room, "area": area])
        }
    }

    // MARK: Room

    @objc func scanRoom(_ call: CAPPluginCall) {
        Loc.use(call)
        Task { @MainActor [weak self] in
            guard #available(iOS 17, *), RoomCaptureSession.isSupported else {
                return call.reject(L("Scanning rooms needs an iPhone or iPad with LiDAR and iOS 17 or later."), "unsupported")
            }
            guard let host = self?.bridge?.viewController else { return call.reject("no view") }
            let controller = RoomScanController { result in
                host.dismiss(animated: true)
                switch result {
                case .success(let room): call.resolve(room)
                case .failure(let e): call.reject(e.localizedDescription, (e as? ScanError)?.code)
                }
            }
            controller.modalPresentationStyle = .fullScreen
            host.present(controller, animated: true)
        }
    }

    // MARK: Area

    @objc func scanArea(_ call: CAPPluginCall) {
        Loc.use(call)
        Task { @MainActor [weak self] in
            guard #available(iOS 18, *), ObjectCaptureSession.isSupported else {
                return call.reject(L("Scanning areas needs an iPhone or iPad with LiDAR and iOS 18 or later."), "unsupported")
            }
            guard let self, let host = self.bridge?.viewController else { return call.reject("no view") }
            let flow = AreaFlow { fraction in self.notifyListeners("progress", data: ["progress": fraction]) }
            let view = AreaScanView(flow: flow) { result in
                host.dismiss(animated: true)
                switch result {
                case .success(let r): call.resolve(r)
                case .failure(let e): call.reject(e.localizedDescription, (e as? ScanError)?.code)
                }
            }
            let controller = UIHostingController(rootView: view)
            controller.modalPresentationStyle = .fullScreen
            UIApplication.shared.isIdleTimerDisabled = true
            host.present(controller, animated: true)
        }
    }
}

// MARK: - Room scan

/// Apple's room capture screen with its live coaching, plus Done and Cancel.
@available(iOS 17, *)
final class RoomScanController: UIViewController, RoomCaptureViewDelegate {
    private let done: (Result<[String: Any], Error>) -> Void
    private var captureView: RoomCaptureView!
    private var finished = false

    init(done: @escaping (Result<[String: Any], Error>) -> Void) {
        self.done = done
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        captureView = RoomCaptureView(frame: view.bounds)
        captureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        captureView.delegate = self
        view.addSubview(captureView)
        let bar = UIStackView()
        bar.axis = .horizontal
        bar.spacing = 16
        bar.translatesAutoresizingMaskIntoConstraints = false
        let cancel = UIButton(configuration: .gray(), primaryAction: UIAction(title: L("Cancel")) { [weak self] _ in self?.cancel() })
        var doneConfig = UIButton.Configuration.borderedProminent()
        doneConfig.title = L("Done")
        let doneButton = UIButton(configuration: doneConfig, primaryAction: UIAction { [weak self] _ in self?.captureView.captureSession.stop() })
        bar.addArrangedSubview(cancel)
        bar.addArrangedSubview(doneButton)
        view.addSubview(bar)
        NSLayoutConstraint.activate([
            bar.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            bar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -20),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
        captureView.captureSession.run(configuration: RoomCaptureSession.Configuration())
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
    }

    private func cancel() {
        guard !finished else { return }
        finished = true
        captureView.captureSession.stop(pauseARSession: true)
        done(.failure(ScanError.cancelled))
    }

    // Let RoomPlan build the final room from what it saw.
    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool { true }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        guard !finished else { return }
        finished = true
        if let error { return done(.failure(ScanError.failed(L("Scanning stopped: {e}", ["e": error.localizedDescription])))) }
        done(.success(RoomExport.json(processedResult)))
    }
}

/// A captured room in meerCAD's frame: millimetres, Z up (RoomPlan works in metres with Y up).
@available(iOS 17, *)
enum RoomExport {
    static func json(_ room: CapturedRoom) -> [String: Any] {
        func point(_ m: simd_float4x4, _ local: SIMD3<Float> = .zero) -> [Double] {
            let w = m * SIMD4<Float>(local.x, local.y, local.z, 1)
            return [Double(w.x * 1000), Double(-w.z * 1000), Double(w.y * 1000)]
        }
        // The direction of a shape's width (its local x) seen from above.
        func across(_ m: simd_float4x4) -> [Double] {
            let x = m.columns.0
            let l = max(1e-6, hypot(x.x, x.z))
            return [Double(x.x / l), Double(-x.z / l)]
        }
        func surface(_ s: CapturedRoom.Surface) -> [String: Any] {
            var out: [String: Any] = [
                "id": s.identifier.uuidString,
                "center": point(s.transform),
                "along": across(s.transform),
                "size": [Double(s.dimensions.x * 1000), Double(s.dimensions.y * 1000), Double(s.dimensions.z * 1000)],
            ]
            if let parent = s.parentIdentifier { out["wall"] = parent.uuidString }
            if !s.polygonCorners.isEmpty { out["corners"] = s.polygonCorners.map { point(s.transform, $0) } }
            return out
        }
        func category(_ c: CapturedRoom.Object.Category) -> String {
            switch c {
            case .bed: return "bed"
            case .sofa: return "sofa"
            case .table: return "table"
            case .chair: return "chair"
            case .storage: return "storage"
            case .refrigerator: return "refrigerator"
            case .stove: return "stove"
            case .oven: return "oven"
            case .dishwasher: return "dishwasher"
            case .washerDryer: return "washer"
            case .toilet: return "toilet"
            case .bathtub: return "bathtub"
            case .sink: return "sink"
            case .fireplace: return "fireplace"
            case .stairs: return "stairs"
            case .television: return "television"
            @unknown default: return "object"
            }
        }
        let objects: [[String: Any]] = room.objects.map { o in
            ["category": category(o.category), "center": point(o.transform), "along": across(o.transform), "size": [Double(o.dimensions.x * 1000), Double(o.dimensions.z * 1000), Double(o.dimensions.y * 1000)]]
        }
        return [
            "walls": room.walls.map(surface),
            "doors": room.doors.map(surface),
            "windows": room.windows.map(surface),
            "openings": room.openings.map(surface),
            "floors": room.floors.map(surface),
            "objects": objects,
        ]
    }
}

// MARK: - Area scan

/// One area capture: the photos go into a folder of their own, then become a textured model.
@available(iOS 18, *)
@MainActor
final class AreaFlow: ObservableObject {
    enum Phase { case capturing, building }
    @Published var phase = Phase.capturing
    @Published var session: ObjectCaptureSession?
    @Published var progress: Double = 0
    let folder: URL
    let images: URL
    private let report: (Double) -> Void

    init(report: @escaping (Double) -> Void) {
        self.report = report
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        folder = docs.appendingPathComponent("Scans/area-\(stamp)", isDirectory: true)
        images = folder.appendingPathComponent("Images", isDirectory: true)
        try? FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)
    }

    func start() {
        let s = ObjectCaptureSession()
        var config = ObjectCaptureSession.Configuration()
        config.checkpointDirectory = folder.appendingPathComponent("Checkpoints", isDirectory: true)
        s.start(imagesDirectory: images, configuration: config)
        session = s
    }

    /// Capture done: build the model from the photos (on the device) as a GLB.
    func build() async throws -> [String: Any] {
        session = nil
        phase = .building
        let glb = folder.appendingPathComponent("area.glb")
        var result = try await TerrainBuild.run(images: images, glb: glb, work: folder.appendingPathComponent("Work"), detail: .reduced) { [weak self] fraction, _ in
            Task { @MainActor in
                self?.progress = fraction
                self?.report(fraction)
            }
        }
        try? FileManager.default.removeItem(at: images)
        result["folder"] = ""
        return result
    }
}

@available(iOS 18, *)
struct AreaScanView: View {
    @ObservedObject var flow: AreaFlow
    let done: (Result<[String: Any], Error>) -> Void
    @State private var finished = false
    @State private var capturing = false

    var body: some View {
        ZStack {
            if flow.phase == .building {
                Working(title: L("Building the model"), detail: L("This takes a few minutes. Keep the app open."), progress: flow.progress)
            } else if let session = flow.session {
                ObjectCaptureView(session: session)
                    .ignoresSafeArea()
                    .task {
                        for await state in session.stateUpdates {
                            switch state {
                            case .ready:
                                // Area mode: skipping object detection (no box) records everything the camera sees.
                                if !capturing {
                                    capturing = true
                                    session.startCapturing()
                                }
                            case .completed: await build()
                            case .failed(let e): finish(.failure(ScanError.failed(L("Scanning stopped: {e}", ["e": e.localizedDescription]))))
                            default: break
                            }
                        }
                    }
                VStack {
                    Text(L("Walk slowly along the area and sweep the iPhone over everything: from above, and at a slant into corners. The rings show what is still missing."))
                        .font(.callout).multilineTextAlignment(.center).padding(12)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12)).padding()
                    Spacer()
                    HStack(spacing: 16) {
                        Button(L("Cancel")) { cancel() }.buttonStyle(.bordered).controlSize(.large)
                        Button(L("Done")) { session.finish() }.buttonStyle(.borderedProminent).controlSize(.large)
                    }
                    .padding(.bottom, 24)
                }
            } else {
                ProgressView()
            }
        }
        .onAppear { if flow.session == nil && flow.phase == .capturing { flow.start() } }
    }

    private func cancel() {
        flow.session?.cancel()
        finish(.failure(ScanError.cancelled))
    }

    private func build() async {
        do { finish(.success(try await flow.build())) } catch { finish(.failure(error)) }
    }

    private func finish(_ result: Result<[String: Any], Error>) {
        guard !finished else { return }
        finished = true
        UIApplication.shared.isIdleTimerDisabled = false
        done(result)
    }
}
