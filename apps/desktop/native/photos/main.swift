import Foundation
import RealityKit
import simd

/// Mac helper: builds a model from a folder of photos (see TerrainBuild, shared with the iPad app).
/// Usage: meercad-photos <photo folder> <out.glb> <work folder> [preview|reduced|medium|full]
/// Prints one JSON object per line: {"progress": 0.4, "step": "model"}, then {"done": {...}} or {"error": "..."}.
func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

let args = CommandLine.arguments
// Checks the GPS placement on made-up cameras: a known turn, size and shift must come back.
if args.count == 2, args[1] == "--selftest" {
    let turn = simd_quatd(angle: 0.7, axis: simd_normalize(SIMD3(0.3, 1, -0.2)))
    var cameras: [(model: SIMD3<Double>, gps: SIMD3<Double>)] = []
    for i in 0..<5 {
        for j in 0..<6 {
            let enu = SIMD3(Double(i) * 30 - 60, Double(j) * 25 - 60, 80 + Double((i * 7 + j * 3) % 5) * 0.3)
            // The model frame: Y up, a fifth of the size, turned and moved.
            let yUp = SIMD3(enu.x, enu.z, -enu.y)
            let model = turn.act(yUp) * 0.2 + SIMD3(3, -1, 7)
            let lat = 47.0 + enu.y / TerrainBuild.metresPerDegree
            let lon = 8.0 + enu.x / (TerrainBuild.metresPerDegree * cos(47.0 * .pi / 180))
            cameras.append((model, SIMD3(lat, lon, 500 + enu.z)))
        }
    }
    let p = TerrainBuild.locate(cameras)
    let ok = p.located != nil && abs(p.scale - 5) < 1e-3 && p.located!.error < 0.05
    // A model point straight above another stays straight above it on the map.
    let up = p.apply(cameras[0].model + turn.act(SIMD3(0, 1, 0))) - p.apply(cameras[0].model)
    emit(["selftest": ok && abs(up.x) < 1e-3 && abs(up.y) < 1e-3 && up.z > 0, "scale": p.scale, "error": p.located?.error ?? -1, "up": [up.x, up.y, up.z]])
    exit(0)
}
guard args.count >= 4 else {
    emit(["error": "usage: meercad-photos <photo folder> <out.glb> <work folder> [detail]"])
    exit(2)
}
guard PhotogrammetrySession.isSupported else {
    emit(["error": "unsupported"])
    exit(3)
}
let details: [String: PhotogrammetrySession.Request.Detail] = ["preview": .preview, "reduced": .reduced, "medium": .medium, "full": .full]
let detail = details[args.count > 4 ? args[4] : "full"] ?? .full

Task {
    do {
        var last = -1.0
        let result = try await TerrainBuild.run(images: URL(fileURLWithPath: args[1]), glb: URL(fileURLWithPath: args[2]), work: URL(fileURLWithPath: args[3]), detail: detail) { fraction, step in
            guard fraction - last >= 0.01 || fraction == 0 else { return }
            last = fraction
            emit(["progress": fraction, "step": step])
        }
        emit(["done": result])
        exit(0)
    } catch {
        emit(["error": error.localizedDescription])
        exit(1)
    }
}
dispatchMain()
