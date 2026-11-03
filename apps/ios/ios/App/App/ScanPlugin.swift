import ARKit
import Capacitor
import Foundation
import ModelIO
import RealityKit
import SwiftUI
import UIKit

/// Texts of the scan screens in the web app's interface language (it passes `lang`; otherwise the
/// device language). Kept here rather than in a strings catalog so the app follows the language
/// chosen inside meerCAD, not only the system one.
enum Loc {
    static var lang: String = Locale.preferredLanguages.first?.hasPrefix("de") == true ? "de" : "en"
    static func use(_ call: CAPPluginCall) {
        if let l = call.getString("lang"), l == "de" || l == "en" { lang = l }
    }
    static let de: [String: String] = [
        "A scan from {when} was built, but never became a part.": "Ein Scan vom {when} wurde berechnet, aber nie zu einem Teil.",
        "A scan was built, but never became a part.": "Ein Scan wurde berechnet, aber nie zu einem Teil.",
        "Add it as a part": "Als Teil einfügen",
        "Another ring": "Noch eine Runde",
        "Build the model": "Modell berechnen",
        "Building the model failed: {e}": "Das Modell konnte nicht berechnet werden: {e}",
        "Building the model": "Modell wird berechnet",
        "Building the part…": "Teil wird erstellt …",
        "Cancel": "Abbrechen",
        "Continue": "Weiter",
        "Corner {n} of 4: aim the cross on the table (or floor) around the object and tap.": "Ecke {n} von 4: Richte das Kreuz auf den Tisch (oder Boden) neben dem Objekt und tippe.",
        "Discard and scan again": "Verwerfen und neu scannen",
        "Done": "Fertig",
        "Finishing the capture…": "Aufnahme wird abgeschlossen …",
        "Fit the box around the object.": "Passe die Box um das Objekt an.",
        "Go slowly all the way round the object, from above and from low at the sides, until the teal surface covers it everywhere (half a minute or more). Sides left out stay open.": "Geh langsam einmal ganz um das Objekt herum, von oben und tief von den Seiten, bis die türkise Fläche es überall bedeckt (eine halbe Minute oder länger). Ausgelassene Seiten bleiben offen.",
        "Height": "Höhe",
        "Keep a finger on the screen to record what is inside the circle, like painting. Let go to move on.": "Halte einen Finger auf dem Bildschirm, um aufzunehmen, was im Kreis ist, wie beim Malen. Lass los, um weiterzugehen.",
        "Nothing found there. Aim from a hand's width or two away and tap again.": "Dort wurde nichts gefunden. Ziele aus ein bis zwei Handbreit Abstand und tippe noch einmal.",
        "Paint slowly over the surface with the circle, also at a slant into corners and recesses.": "Male mit dem Kreis langsam über die Fläche, auch schräg in Ecken und Vertiefungen.",
        "Pass {n}": "Runde {n}",
        "Point at the surface for the corner.": "Richte das Kreuz für die Ecke auf die Fläche.",
        "Point at the table or floor for the corner.": "Richte das Kreuz für die Ecke auf den Tisch oder Boden.",
        "Point the phone at it.": "Richte das iPhone darauf.",
        "Preparing the part": "Teil wird vorbereitet",
        "Put the object on a plain, matt surface with room to walk around it. Good, even light helps.": "Stell das Objekt auf eine schlichte, matte Fläche, um die du herumgehen kannst. Gutes, gleichmäßiges Licht hilft.",
        "Put the object on a table or the floor. Aim the cross at four corners on the table (or floor) around the object and tap for each.": "Stell das Objekt auf einen Tisch oder den Boden. Richte das Kreuz auf vier Ecken auf dem Tisch (oder Boden) um das Objekt und tippe jeweils.",
        "Ring complete. For a full model, turn the object over and scan its other side.": "Runde fertig. Für ein vollständiges Modell dreh das Objekt um und scanne die andere Seite.",
        "Ring complete. This object cannot be turned over for scanning; go round once more higher or lower, or finish.": "Runde fertig. Dieses Objekt lässt sich zum Scannen nicht umdrehen; geh noch einmal höher oder tiefer herum oder beende den Scan.",
        "Scan cancelled": "Scan abgebrochen",
        "Scanning needs an iPhone or iPad with LiDAR and iOS 18 or later.": "Zum Scannen brauchst du ein iPhone oder iPad mit LiDAR und iOS 18 oder neuer.",
        "Scanning needs iOS 18 or later (this is {v}).": "Zum Scannen brauchst du iOS 18 oder neuer (hier ist {v}).",
        "Scanning stopped: {e}": "Scan abgebrochen: {e}",
        "Set corner": "Ecke setzen",
        "Start over": "Neu beginnen",
        "Start scanning": "Scan starten",
        "That is as much as fits. Tap Done, or Start over.": "Mehr passt nicht. Tippe auf Fertig oder Neu beginnen.",
        "That is more than 3 m across. Tap the corners again, closer around the object.": "Das ist breiter als 3 m. Setze die Ecken noch einmal, enger um das Objekt.",
        "That is more than 2.5 m across. Record a smaller area.": "Das ist breiter als 2,5 m. Nimm eine kleinere Fläche auf.",
        "The model came out empty.": "Das Modell ist leer.",
        "The photos did not give a model. Scan again with the object filling more of the frame, from all sides.": "Aus den Fotos ist kein Modell entstanden. Scanne noch einmal, mit dem Objekt größer im Bild und von allen Seiten.",
        "The table is not found yet. Show the table (or floor) for a moment, then tap again.": "Der Tisch ist noch nicht erkannt. Zeig kurz den Tisch (oder Boden) und tippe dann noch einmal.",
        "This device has no LiDAR scanner, which scanning needs.": "Dieses Gerät hat keinen LiDAR-Scanner, den das Scannen braucht.",
        "This iPhone has LiDAR, but Apple's object capture reports it as unsupported on this iOS version (a known Apple issue on iPhone 18 Pro / Pro Max with iOS 27). Scanning will work once Apple fixes it.": "Dieses iPhone hat LiDAR, aber Apples Objekterfassung meldet es in dieser iOS-Version als nicht unterstützt (ein bekannter Fehler von Apple beim iPhone 18 Pro / Pro Max mit iOS 27). Das Scannen geht, sobald Apple das behebt.",
        "This takes a minute or two. Keep the app open.": "Das dauert ein bis zwei Minuten. Lass die App geöffnet.",
        "Too little was recorded. Hold the button and sweep slowly over the surface.": "Es wurde zu wenig aufgenommen. Halte den Finger auf dem Bildschirm und fahre langsam über die Fläche.",
        "Too little was seen. Sweep slowly over everything inside the box, from several sides.": "Es wurde zu wenig erfasst. Fahre langsam über alles in der Box, von mehreren Seiten.",
        "Nothing was scanned.": "Es wurde nichts gescannt.",
        "Scanning rooms needs an iPhone or iPad with LiDAR and iOS 17 or later.": "Zum Scannen von Räumen brauchst du ein iPhone oder iPad mit LiDAR und iOS 17 oder neuer.",
        "Scanning areas needs an iPhone or iPad with LiDAR.": "Zum Scannen von Flächen brauchst du ein iPhone oder iPad mit LiDAR.",
        "Walk slowly over the area and point at everything you need: the mesh shows what is in. Close up gives more detail; also at a slant into corners.": "Geh langsam über die Fläche und richte das Gerät auf alles, was du brauchst: Das Gitter zeigt, was schon erfasst ist. Nah dran gibt mehr Details, auch schräg in Ecken.",
        "{m2} m² · {n} pictures": "{m2} m² · {n} Bilder",
        "Preparing the model": "Modell wird vorbereitet",
        "Colouring it from the pictures taken.": "Es wird aus den aufgenommenen Bildern eingefärbt.",
        "Slower, please.": "Bitte langsamer.",
        "Too little to see here: point at more of the area.": "Hier ist zu wenig zu sehen: Richte das Gerät auf mehr von der Fläche.",
        "Hold on, finding the way…": "Moment, Orientierung wird gesucht …",
        "Turn over and continue": "Umdrehen und weiter",
        "Undo corner": "Ecke zurücknehmen",
        "Unfinished scan": "Unfertiger Scan",
        "Walk slowly around the object, keeping it in the frame, until the ring is full.": "Geh langsam um das Objekt herum und halte es im Bild, bis der Ring voll ist.",
        "{cm} cm away: a bit further back.": "{cm} cm entfernt: etwas weiter zurück.",
        "{cm} cm away: closer gives more detail.": "{cm} cm entfernt: näher gibt mehr Details.",
        "{cm} cm away: good.": "{cm} cm entfernt: gut.",
        "{n} photos from {when} were captured, but they never became a part.": "{n} Fotos vom {when} wurden aufgenommen, aber nie zu einem Teil.",
        "{n} photos were captured, but they never became a part.": "{n} Fotos wurden aufgenommen, aber nie zu einem Teil.",
        "{w} × {d} cm, height {h} cm. Set the height so the whole object fits.": "{w} × {d} cm, Höhe {h} cm. Stell die Höhe so ein, dass das ganze Objekt hineinpasst.",
    ]
}

/// A scan-screen text in the chosen language, with `{name}` placeholders filled in.
func L(_ s: String, _ vars: [String: Any] = [:]) -> String {
    var out = Loc.lang == "de" ? (Loc.de[s] ?? s) : s
    for (k, v) in vars { out = out.replacingOccurrences(of: "{\(k)}", with: "\(v)") }
    return out
}

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
        CAPPluginMethod(name: "imported", returnType: CAPPluginReturnPromise),
    ]

    /// Object or surface with the LiDAR sensor (see `LidarScanner`).
    private func scanLidar(_ call: CAPPluginCall, surface: Bool) {
        Task { @MainActor [weak self] in
            guard #available(iOS 17, *), ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else {
                return call.reject("Scanning with LiDAR needs an iPhone or iPad with LiDAR and iOS 17 or later.")
            }
            guard let self, let host = self.bridge?.viewController else { return call.reject("no view") }
            let view = LidarScanView(scanner: LidarScanner(mode: surface ? .surface : .object)) { result in
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

    /// The web app has the scan as a part: its photos can go, and it is no longer offered as unfinished.
    @objc func imported(_ call: CAPPluginCall) {
        guard let path = call.getString("folder") else { return call.reject("no folder") }
        let folder = URL(fileURLWithPath: path, isDirectory: true)
        try? FileManager.default.removeItem(at: folder.appendingPathComponent("Images"))
        FileManager.default.createFile(atPath: folder.appendingPathComponent(scanImportedMarker).path, contents: nil)
        call.resolve()
    }

    @objc func capabilities(_ call: CAPPluginCall) {
        Loc.use(call)
        Task { @MainActor in
            guard #available(iOS 18, *) else {
                return call.resolve(["scan": false, "reason": L("Scanning needs iOS 18 or later (this is {v}).", ["v": UIDevice.current.systemVersion])])
            }
            // Object capture says whether it runs here; the LiDAR checks are asked too, because the first
            // answer has been seen wrong on new devices (an iPhone 18 Pro Max on iOS 27.0.1 said no).
            let objectCapture = ObjectCaptureSession.isSupported
            let lidar = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
            let sceneMesh = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
            // Starting object capture where it says no ends the app, so only its own answer counts.
            let scan = objectCapture
            call.resolve([
                "scan": scan,
                // The LiDAR scans need only depth.
                "surface": lidar,
                "objectCapture": objectCapture,
                "lidar": lidar,
                "sceneMesh": sceneMesh,
                "photogrammetry": PhotogrammetrySession.isSupported,
                "reason": scan ? "" : lidar
                    ? L("This iPhone has LiDAR, but Apple's object capture reports it as unsupported on this iOS version (a known Apple issue on iPhone 18 Pro / Pro Max with iOS 27). Scanning will work once Apple fixes it.")
                    : L("This device has no LiDAR scanner, which scanning needs."),
            ])
        }
    }

    @objc func scan(_ call: CAPPluginCall) {
        Loc.use(call)
        if let mode = call.getString("mode"), mode == "surface" || mode == "lidar" { return scanLidar(call, surface: mode == "surface") }
        Task { @MainActor [weak self] in
            guard #available(iOS 18, *), ObjectCaptureSession.isSupported else {
                return call.reject(L("Scanning needs an iPhone or iPad with LiDAR and iOS 18 or later."))
            }
            guard let self, let host = self.bridge?.viewController else { return call.reject("no view") }
            // A capture whose model was never built (the app ended after it) is offered first.
            let flow = ScanFlow(leftover: ScanFlow.leftover())
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

/// Marks a scan folder whose mesh made it into a part.
let scanImportedMarker = "imported"

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
        case .cancelled: return L("Scan cancelled")
        case .noModel: return L("The photos did not give a model. Scan again with the object filling more of the frame, from all sides.")
        case .emptyModel: return L("The model came out empty.")
        case .failed(let m): return m
        }
    }
}

// MARK: - Flow state

/// Everything one scan needs, kept outside the views so the capture session can be released early.
@available(iOS 18, *)
@MainActor
final class ScanFlow: ObservableObject {
    enum Phase { case leftover, capturing, rebuilding, writing }
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

    /// Photos from an earlier capture that never got its model, and when it was taken.
    let leftoverPhotos: Int
    let leftoverDate: Date?

    init(leftover: URL? = nil) {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        folder = leftover ?? docs.appendingPathComponent("Scans/\(stamp)", isDirectory: true)
        images = folder.appendingPathComponent("Images", isDirectory: true)
        leftoverPhotos = leftover.map { Self.photos(in: $0.appendingPathComponent("Images")) } ?? 0
        leftoverDate = leftover.flatMap { try? $0.resourceValues(forKeys: [.creationDateKey]).creationDate }
        checkpoints = folder.appendingPathComponent("Checkpoints", isDirectory: true)
        for dir in [images, checkpoints] { try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
        log["device"] = UIDevice.current.model
        log["system"] = "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)"
        log["machine"] = Self.machine()
        if leftover != nil {
            phase = .leftover
            log["resumed"] = true
        }
    }

    /// The newest scan folder with photos or a model that never made it into a part, if any.
    static func leftover() -> URL? {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let scans = docs.appendingPathComponent("Scans", isDirectory: true)
        let folders = (try? FileManager.default.contentsOfDirectory(at: scans, includingPropertiesForKeys: nil)) ?? []
        return folders.sorted { $0.lastPathComponent > $1.lastPathComponent }.first { dir in
            let has = { (name: String) in FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path) }
            return (photos(in: dir.appendingPathComponent("Images")) > 0 || has("scan.usdz")) && !has(scanImportedMarker)
        }
    }

    private static func photos(in dir: URL) -> Int {
        (try? FileManager.default.contentsOfDirectory(atPath: dir.path).count) ?? 0
    }

    /// Throws the unfinished scan away and starts a fresh capture in a new folder.
    func discardLeftover() -> ScanFlow {
        try? FileManager.default.removeItem(at: folder)
        return ScanFlow()
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

        let usdz = folder.appendingPathComponent("scan.usdz")
        // A model built before the app ended is used as it is (the rebuild will not overwrite a file).
        if !FileManager.default.fileExists(atPath: usdz.path) { try await build(usdz) }

        phase = .writing
        let stl = folder.appendingPathComponent("scan.stl")
        let stats = try await Task.detached { try MeshExport.write(usdz: usdz, stl: stl) }.value
        log["triangles"] = stats.triangles
        log["sizeMm"] = stats.size
        log["holesClosed"] = stats.holes
        writeLog()
        return ["path": stl.path, "folder": folder.path, "triangles": stats.triangles, "size": stats.size, "photos": photoCount, "seconds": Int(Date().timeIntervalSince(started))]
    }

    /// Builds the model from the photos into `usdz`.
    private func build(_ usdz: URL) async throws {
        let t0 = Date()
        var config = PhotogrammetrySession.Configuration()
        config.checkpointDirectory = checkpoints
        let rebuild = try PhotogrammetrySession(input: images, configuration: config)
        try rebuild.process(requests: [.modelFile(url: usdz, detail: .reduced)])
        var failure: Error?
        // The outputs never end on their own: stop at the request's end.
        outputs: for try await output in rebuild.outputs {
            switch output {
            case .requestProgress(_, let fraction): progress = fraction
            case .requestError(_, let error):
                failure = error
                break outputs
            case .requestComplete, .processingComplete: break outputs
            case .processingCancelled:
                failure = ScanError.cancelled
                break outputs
            default: break
            }
        }
        log["rebuildSeconds"] = Int(Date().timeIntervalSince(t0))
        if let failure {
            log["error"] = "\(failure)"
            writeLog()
            throw ScanError.failed(L("Building the model failed: {e}", ["e": failure.localizedDescription]))
        }
        guard FileManager.default.fileExists(atPath: usdz.path) else {
            writeLog()
            throw ScanError.noModel
        }
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
enum MeshExport {
    static func write(usdz: URL, stl: URL) throws -> (triangles: Int, size: [Double], holes: Int) {
        let asset = MDLAsset(url: usdz)
        var corners: [SIMD3<Float>] = []
        for i in 0..<asset.count { collect(asset.object(at: i), into: &corners) }
        guard !corners.isEmpty else { throw ScanError.emptyModel }
        let holes = closeHoles(&corners)
        let (count, size) = try writeSTL(corners, to: stl)
        return (count, size, holes)
    }

    /// Triangle corners (millimetres) as a binary STL; returns the triangle count and the size in mm.
    static func writeSTL(_ corners: [SIMD3<Float>], to stl: URL) throws -> (triangles: Int, size: [Double]) {
        var lo = SIMD3<Float>(repeating: .greatestFiniteMagnitude), hi = -lo
        for p in corners {
            lo = simd_min(lo, p)
            hi = simd_max(hi, p)
        }
        let count = corners.count / 3
        var data = Data(count: 80)
        data.reserveCapacity(84 + count * 50)
        withUnsafeBytes(of: UInt32(count).littleEndian) { data.append(contentsOf: $0) }
        var record = [Float](repeating: 0, count: 12)
        for t in stride(from: 0, to: corners.count, by: 3) {
            let a = corners[t], b = corners[t + 1], c = corners[t + 2]
            var n = simd_cross(b - a, c - a)
            let len = simd_length(n)
            n = len > 0 ? n / len : .zero
            for (k, v) in [n, a, b, c].enumerated() {
                record[k * 3] = v.x
                record[k * 3 + 1] = v.y
                record[k * 3 + 2] = v.z
            }
            record.withUnsafeBytes { data.append(contentsOf: $0) }
            data.append(contentsOf: [0, 0])
        }
        try data.write(to: stl)
        let size = hi - lo
        return (count, [Double(size.x), Double(size.y), Double(size.z)].map { ($0 * 10).rounded() / 10 })
    }

    /// A scan is open where the object stood or the camera did not see: every loop of open edges is
    /// filled with a fan around its centre, so the mesh imports as a closed solid. Returns the loops filled.
    static func closeHoles(_ corners: inout [SIMD3<Float>]) -> Int {
        // Corners at the same spot (split by texture seams) are one vertex.
        var ids: [SIMD3<Int32>: Int] = [:]
        var points: [SIMD3<Float>] = []
        let index = corners.map { p -> Int in
            let key = SIMD3<Int32>((p * 1000).rounded(.toNearestOrAwayFromZero))
            if let i = ids[key] { return i }
            ids[key] = points.count
            points.append(p)
            return points.count - 1
        }
        struct Edge: Hashable { let a: Int, b: Int }
        var edges = Set<Edge>()
        for t in stride(from: 0, to: index.count, by: 3) {
            for k in 0..<3 { edges.insert(Edge(a: index[t + k], b: index[t + (k + 1) % 3])) }
        }
        // An edge without its reverse borders a hole; walking them backwards keeps the fill facing out.
        var next: [Int: Int] = [:]
        for e in edges where !edges.contains(Edge(a: e.b, b: e.a)) { next[e.b] = e.a }
        var loops = 0
        while let start = next.keys.first {
            var loop = [start]
            var at = next.removeValue(forKey: start)!
            while at != start, let n = next.removeValue(forKey: at), loop.count < 100_000 {
                loop.append(at)
                at = n
            }
            guard at == start, loop.count >= 3 else { continue }
            let centre = loop.reduce(SIMD3<Float>.zero) { $0 + points[$1] } / Float(loop.count)
            for (i, v) in loop.enumerated() {
                corners += [points[v], points[loop[(i + 1) % loop.count]], centre]
            }
            loops += 1
        }
        return loops
    }

    private static func collect(_ object: MDLObject, into out: inout [SIMD3<Float>]) {
        if let mesh = object as? MDLMesh, let attr = mesh.vertexAttributeData(forAttributeNamed: MDLVertexAttributePosition, as: .float3) {
            let matrix = MDLTransform.globalTransform(with: object, atTime: 0)
            let base = attr.dataStart
            let position = { (i: Int) -> SIMD3<Float> in
                let p = base.advanced(by: i * attr.stride).assumingMemoryBound(to: Float.self)
                let w = matrix * SIMD4<Float>(p[0], p[1], p[2], 1)
                // Y up (RealityKit) → Z up (meerCAD), metres → millimetres.
                return SIMD3<Float>(w.x, -w.z, w.y) * 1000
            }
            for case let sub as MDLSubmesh in mesh.submeshes ?? [] where sub.geometryType == .triangles {
                let map = sub.indexBuffer.map()
                for k in 0..<sub.indexCount {
                    let index: Int
                    switch sub.indexType {
                    case .uInt8: index = Int(map.bytes.load(fromByteOffset: k, as: UInt8.self))
                    case .uInt16: index = Int(map.bytes.load(fromByteOffset: k * 2, as: UInt16.self))
                    default: index = Int(map.bytes.load(fromByteOffset: k * 4, as: UInt32.self))
                    }
                    out.append(position(index))
                }
            }
        }
        for child in object.children.objects { collect(child, into: &out) }
    }
}

// MARK: - Views

@available(iOS 18, *)
struct ScanView: View {
    @State var flow: ScanFlow
    let done: (Result<[String: Any], Error>) -> Void

    var body: some View {
        // A new flow (after discarding leftover photos) gets a fresh view and session.
        ScanFlowView(flow: flow, done: done, discard: { flow = flow.discardLeftover() })
            .id(ObjectIdentifier(flow))
    }
}

@available(iOS 18, *)
struct ScanFlowView: View {
    @ObservedObject var flow: ScanFlow
    let done: (Result<[String: Any], Error>) -> Void
    let discard: () -> Void
    @State private var finished = false

    var body: some View {
        ZStack {
            switch flow.phase {
            case .leftover:
                Leftover(photos: flow.leftoverPhotos, date: flow.leftoverDate, build: finishCapture, discard: discard, cancel: cancel)
            case .capturing:
                if let session = flow.session {
                    CaptureScreen(session: session, flow: flow, cancel: cancel, failed: failCapture, finish: finishCapture)
                } else {
                    ProgressView()
                }
            case .rebuilding:
                Working(title: L("Building the model"), detail: L("This takes a minute or two. Keep the app open."), progress: flow.progress)
            case .writing:
                Working(title: L("Preparing the part"), detail: nil, progress: nil)
            }
        }
        .onAppear { if flow.session == nil && flow.phase == .capturing { flow.start() } }
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
        done(.failure(ScanError.failed(L("Scanning stopped: {e}", ["e": error.localizedDescription]))))
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
                    Button(L("Cancel"), action: cancel).buttonStyle(.bordered)
                    Spacer()
                    if flow.passes > 0 { Text(L("Pass {n}", ["n": flow.passes + 1])).font(.footnote).padding(8).background(.ultraThinMaterial, in: Capsule()) }
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
            hint(L("Put the object on a plain, matt surface with room to walk around it. Good, even light helps."))
            Button(L("Continue")) { _ = session.startDetecting() }.buttonStyle(.borderedProminent).controlSize(.large)
        case .detecting:
            hint(L("Fit the box around the object."))
            Button(L("Start scanning")) { session.startCapturing() }.buttonStyle(.borderedProminent).controlSize(.large)
        case .capturing:
            hint(L("Walk slowly around the object, keeping it in the frame, until the ring is full."))
        case .finishing:
            ProgressView(L("Finishing the capture…")).padding().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        default:
            EmptyView()
        }
    }

    /// iOS ends the app when asked to flip an object it judged not flippable (or outside a finished
    /// ring), so turning over is only offered when it is allowed.
    private var canFlip: Bool {
        session.state == .capturing && session.userCompletedScanPass && !session.feedback.contains(.objectNotFlippable)
    }

    /// After each ring: flip the object for the underside, go round once more, or stop.
    private var nextPass: some View {
        VStack(spacing: 10) {
            if canFlip {
                hint(L("Ring complete. For a full model, turn the object over and scan its other side."))
                Button(L("Turn over and continue")) {
                    print("scan: flip, feedback \(session.feedback), state \(session.state)")
                    guard canFlip else { return }
                    flow.passes += 1
                    flow.askNext = false
                    session.beginNewScanPassAfterFlip()
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
            } else {
                hint(L("Ring complete. This object cannot be turned over for scanning; go round once more higher or lower, or finish."))
            }
            HStack {
                Button(L("Another ring")) {
                    flow.passes += 1
                    flow.askNext = false
                    session.beginNewScanPass()
                }
                .buttonStyle(.bordered)
                Button(L("Done")) {
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

/// An earlier capture whose model was never built: build it now or start over.
@available(iOS 18, *)
struct Leftover: View {
    let photos: Int
    let date: Date?
    let build: () -> Void
    let discard: () -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "cube.transparent").font(.system(size: 44)).foregroundStyle(.secondary)
            Text(L("Unfinished scan")).font(.title2.bold())
            let when = date.map { $0.formatted(date: .abbreviated, time: .shortened) }
            Text(photos > 0
                ? when.map { L("{n} photos from {when} were captured, but they never became a part.", ["n": photos, "when": $0]) } ?? L("{n} photos were captured, but they never became a part.", ["n": photos])
                : when.map { L("A scan from {when} was built, but never became a part.", ["when": $0]) } ?? L("A scan was built, but never became a part."))
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button(photos > 0 ? L("Build the model") : L("Add it as a part"), action: build).buttonStyle(.borderedProminent).controlSize(.large)
            Button(L("Discard and scan again"), role: .destructive, action: discard).buttonStyle(.bordered)
            Button(L("Cancel"), action: cancel)
        }
        .padding(32)
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
