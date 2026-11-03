import Capacitor
@_weakLinked import RoomPlan
import SwiftUI
import UIKit
import simd

/// Scanning rooms and areas in the app, guided live so nobody has to think about how to film:
/// - a room with Apple's RoomPlan (LiDAR): walls, doors, windows, openings, floor and furniture as
///   measured shapes, which the web app turns into editable parts;
/// - an area (garden bed, terrace, a corner, a wall) with ARKit's LiDAR mesh, coloured from camera
///   pictures (see AreaScan), shown as surroundings in true size, level.
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
            if #available(iOS 17, *) {
                room = RoomCaptureSession.isSupported
                area = AreaScanner.isSupported
            }
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
            guard #available(iOS 17, *), AreaScanner.isSupported else {
                return call.reject(L("Scanning areas needs an iPhone or iPad with LiDAR."), "unsupported")
            }
            guard let host = self?.bridge?.viewController else { return call.reject("no view") }
            let view = AreaScanView(scanner: AreaScanner()) { result in
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
