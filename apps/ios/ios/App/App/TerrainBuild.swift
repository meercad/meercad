import CoreGraphics
import Foundation
import ImageIO
import ModelIO
import RealityKit
import UniformTypeIdentifiers
import simd

/// A textured 3D model of an area from overhead photos (a drone flight): Apple's photogrammetry
/// builds it, the GPS position in each photo gives it its true size, level and north, and it is
/// written as a GLB in millimetres with Z up, east along +X and north along +Y. Shared by the iPad
/// app and the Mac helper, so it uses nothing from UIKit or AppKit.
@available(iOS 17, macOS 14, *)
enum TerrainBuild {
    enum Failure: LocalizedError {
        case tooFewPhotos(Int)
        case failed(String)
        case empty

        var errorDescription: String? {
            switch self {
            case .tooFewPhotos(let n): return "Only \(n) photos were found; a model needs at least 10 that overlap."
            case .failed(let e): return e
            case .empty: return "The photos did not give a model. They need to overlap by about two thirds."
            }
        }
    }

    struct Located {
        let lat: Double, lon: Double, alt: Double
        /// Root mean square distance between where the photos say they were taken and where the model puts them (m).
        let error: Double
        let cameras: Int
    }

    static let photoTypes: Set<String> = ["jpg", "jpeg", "heic", "png", "tif", "tiff", "dng"]

    /// Photos in the folder (not its subfolders), in name order.
    static func photos(in folder: URL) -> [URL] {
        let names = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        return names.filter { photoTypes.contains($0.pathExtension.lowercased()) }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    /// Builds the model from the photos in `images` into `glb`; `work` holds the intermediate files.
    /// `progress` gets a fraction and a step name ("model", "writing").
    static func run(images: URL, glb: URL, work: URL, detail: PhotogrammetrySession.Request.Detail, progress: @escaping (Double, String) -> Void) async throws -> [String: Any] {
        let started = Date()
        let list = photos(in: images)
        guard list.count >= 10 else { throw Failure.tooFewPhotos(list.count) }
        var gps: [String: SIMD3<Double>] = [:]
        for url in list { if let g = position(of: url) { gps[url.standardizedFileURL.path] = g } }

        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let usdz = work.appendingPathComponent("terrain.usdz")
        try? FileManager.default.removeItem(at: usdz)
        var config = PhotogrammetrySession.Configuration()
        // A landscape is not an object in front of a background: keep everything.
        config.isObjectMaskingEnabled = false
        config.sampleOrdering = .unordered
        config.checkpointDirectory = work.appendingPathComponent("checkpoints")
        let session = try PhotogrammetrySession(input: images, configuration: config)
        try session.process(requests: [.poses, .modelFile(url: usdz, detail: detail)])
        var cameras: [(model: SIMD3<Double>, gps: SIMD3<Double>)] = []
        var failure: Error?
        var models = 0
        outputs: for try await output in session.outputs {
            switch output {
            case .requestProgress(let request, let fraction):
                if case .modelFile = request { progress(fraction, "model") }
            case .requestComplete(_, .poses(let poses)):
                for (id, pose) in poses.posesBySample {
                    guard let url = poses.urlsBySample[id], let g = gps[url.standardizedFileURL.path] else { continue }
                    cameras.append((SIMD3<Double>(pose.translation), g))
                }
            case .requestComplete(_, .modelFile):
                models += 1
            case .requestError(_, let error):
                failure = error
                break outputs
            case .processingComplete:
                break outputs
            case .processingCancelled:
                failure = Failure.failed("Cancelled")
                break outputs
            default: break
            }
        }
        if let failure { throw Failure.failed(failure.localizedDescription) }
        guard models > 0, FileManager.default.fileExists(atPath: usdz.path) else { throw Failure.empty }

        progress(0, "writing")
        let place = locate(cameras)
        let stats = try GLBWriter.write(usdz: usdz, to: glb, place: place)
        var result: [String: Any] = [
            "path": glb.path,
            "photos": list.count,
            "triangles": stats.triangles,
            "size": stats.size,
            "seconds": Int(Date().timeIntervalSince(started)),
        ]
        if let at = place.located {
            // The geographic position of the model's origin (centre of the area, at its lowest point).
            let origin = place.origin
            result["geo"] = ["lat": at.lat + origin.y / metresPerDegree, "lon": at.lon + origin.x / (metresPerDegree * cos(at.lat * .pi / 180)), "alt": at.alt + origin.z, "error": at.error, "cameras": at.cameras]
        }
        return result
    }

    // MARK: GPS

    static let metresPerDegree = 111_320.0

    /// Latitude, longitude (degrees) and altitude (m) from a photo's EXIF.
    static func position(of url: URL) -> SIMD3<Double>? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let g = props[kCGImagePropertyGPSDictionary] as? [CFString: Any],
              var lat = g[kCGImagePropertyGPSLatitude] as? Double,
              var lon = g[kCGImagePropertyGPSLongitude] as? Double else { return nil }
        if (g[kCGImagePropertyGPSLatitudeRef] as? String) == "S" { lat = -lat }
        if (g[kCGImagePropertyGPSLongitudeRef] as? String) == "W" { lon = -lon }
        var alt = g[kCGImagePropertyGPSAltitude] as? Double ?? 0
        if (g[kCGImagePropertyGPSAltitudeRef] as? Int) == 1 { alt = -alt }
        return SIMD3(lat, lon, alt)
    }

    /// How model coordinates (metres, Y up, any orientation and scale) map to the map: east, north, up.
    struct Placement {
        var scale: Double = 1
        var rotation = simd_quatd(ix: 0, iy: 0, iz: 0, r: 1)
        var shift = SIMD3<Double>.zero
        var located: Located?
        /// Where the model's origin ends up on the map (m from the reference point), set by the writer.
        var origin = SIMD3<Double>.zero

        func apply(_ p: SIMD3<Double>) -> SIMD3<Double> { rotation.act(p) * scale + shift }
    }

    /// The similarity that takes the cameras' model positions to their GPS positions (Horn's
    /// closed-form method). Without enough GPS it only turns Y up into Z up.
    static func locate(_ cameras: [(model: SIMD3<Double>, gps: SIMD3<Double>)]) -> Placement {
        let upright = Placement(rotation: simd_quatd(angle: .pi / 2, axis: [1, 0, 0]))
        guard cameras.count >= 3 else { return upright }
        let ref = cameras.reduce(SIMD3<Double>.zero) { $0 + $1.gps } / Double(cameras.count)
        let cosLat = cos(ref.x * .pi / 180)
        let enu = cameras.map { c in SIMD3((c.gps.y - ref.y) * metresPerDegree * cosLat, (c.gps.x - ref.x) * metresPerDegree, c.gps.z - ref.z) }
        let model = cameras.map(\.model)
        let cm = model.reduce(SIMD3<Double>.zero, +) / Double(model.count)
        let ce = enu.reduce(SIMD3<Double>.zero, +) / Double(enu.count)
        let a = model.map { $0 - cm }, b = enu.map { $0 - ce }
        let spreadA = a.reduce(0) { $0 + simd_length_squared($1) }, spreadB = b.reduce(0) { $0 + simd_length_squared($1) }
        // Photos all taken from one spot (or no GPS change) give no size or direction.
        guard spreadA > 1e-9, spreadB / Double(b.count) > 4 else { return upright }
        var s = simd_double3x3()
        for (p, q) in zip(a, b) { s += simd_double3x3(columns: (p * q.x, p * q.y, p * q.z)) }
        // s[j][i] = Σ a_i b_j; Horn's N matrix from the cross-covariance M_ij = Σ a_i b_j.
        let m = { (i: Int, j: Int) in s[j][i] }
        let n: [[Double]] = [
            [m(0, 0) + m(1, 1) + m(2, 2), m(1, 2) - m(2, 1), m(2, 0) - m(0, 2), m(0, 1) - m(1, 0)],
            [m(1, 2) - m(2, 1), m(0, 0) - m(1, 1) - m(2, 2), m(0, 1) + m(1, 0), m(2, 0) + m(0, 2)],
            [m(2, 0) - m(0, 2), m(0, 1) + m(1, 0), -m(0, 0) + m(1, 1) - m(2, 2), m(1, 2) + m(2, 1)],
            [m(0, 1) - m(1, 0), m(2, 0) + m(0, 2), m(1, 2) + m(2, 1), -m(0, 0) - m(1, 1) + m(2, 2)],
        ]
        let v = largestEigenvector(n)
        let rotation = simd_normalize(simd_quatd(ix: v[1], iy: v[2], iz: v[3], r: v[0]))
        let scale = sqrt(spreadB / spreadA)
        var placement = Placement(scale: scale, rotation: rotation, shift: ce - rotation.act(cm) * scale)
        let error = sqrt(zip(model, enu).reduce(0) { $0 + simd_length_squared(placement.apply($1.0) - $1.1) } / Double(model.count))
        // A fit off by more than a fifth of the flight's size is not one to trust.
        guard error < 0.2 * sqrt(spreadB / Double(b.count)) else { return upright }
        placement.located = Located(lat: ref.x, lon: ref.y, alt: ref.z, error: error, cameras: cameras.count)
        return placement
    }

    /// Eigenvector of the largest eigenvalue of a symmetric 4 × 4 matrix (Jacobi rotations).
    static func largestEigenvector(_ input: [[Double]]) -> [Double] {
        var a = input
        var v = (0..<4).map { i in (0..<4).map { $0 == i ? 1.0 : 0 } }
        for _ in 0..<50 {
            var off = 0.0
            for i in 0..<4 { for j in (i + 1)..<4 { off += a[i][j] * a[i][j] } }
            if off < 1e-22 { break }
            for p in 0..<4 {
                for q in (p + 1)..<4 where abs(a[p][q]) > 1e-30 {
                    let theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
                    let t = (theta >= 0 ? 1 : -1) / (abs(theta) + sqrt(theta * theta + 1))
                    let c = 1 / sqrt(t * t + 1), s = t * c
                    for k in 0..<4 {
                        let akp = a[k][p], akq = a[k][q]
                        a[k][p] = c * akp - s * akq
                        a[k][q] = s * akp + c * akq
                    }
                    for k in 0..<4 {
                        let apk = a[p][k], aqk = a[q][k]
                        a[p][k] = c * apk - s * aqk
                        a[q][k] = s * apk + c * aqk
                    }
                    for k in 0..<4 {
                        let vkp = v[k][p], vkq = v[k][q]
                        v[k][p] = c * vkp - s * vkq
                        v[k][q] = s * vkp + c * vkq
                    }
                }
            }
        }
        let best = (0..<4).max { a[$0][$0] < a[$1][$1] }!
        return (0..<4).map { v[$0][best] }
    }
}

/// The rebuilt USDZ as a binary glTF: one primitive per textured piece, positions in millimetres,
/// textures as JPEG no larger than 4096 pixels, unlit (the photos already hold the light).
@available(iOS 17, macOS 14, *)
enum GLBWriter {
    struct Piece {
        var positions: [SIMD3<Float>] = []
        var uvs: [SIMD2<Float>] = []
        var indices: [UInt32] = []
        var texture: CGImage?
    }

    static func write(usdz: URL, to glb: URL, place: TerrainBuild.Placement) throws -> (triangles: Int, size: [Double]) {
        let asset = MDLAsset(url: usdz)
        asset.loadTextures()
        var pieces: [Piece] = []
        for i in 0..<asset.count { collect(asset.object(at: i), into: &pieces) }
        pieces.removeAll { $0.indices.isEmpty }
        guard !pieces.isEmpty else { throw TerrainBuild.Failure.empty }

        // Onto the map, then the origin moved to the middle of the area at its lowest point.
        var placed = pieces.map { $0.positions.map { place.apply(SIMD3<Double>($0)) } }
        var lo = SIMD3<Double>(repeating: .greatestFiniteMagnitude), hi = -lo
        for list in placed { for p in list { lo = simd_min(lo, p); hi = simd_max(hi, p) } }
        let origin = SIMD3((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z)
        var place = place
        place.origin = origin
        placed = placed.map { $0.map { ($0 - origin) * 1000 } }
        for k in pieces.indices { pieces[k].positions = placed[k].map { SIMD3<Float>($0) } }

        var bin = Data()
        var views: [[String: Any]] = [], accessors: [[String: Any]] = [], images: [[String: Any]] = [], textures: [[String: Any]] = [], materials: [[String: Any]] = [], primitives: [[String: Any]] = []
        func view(_ data: Data, target: Int? = nil) -> Int {
            while bin.count % 4 != 0 { bin.append(0) }
            var v: [String: Any] = ["buffer": 0, "byteOffset": bin.count, "byteLength": data.count]
            if let target { v["target"] = target }
            bin.append(data)
            views.append(v)
            return views.count - 1
        }
        var textureOf: [ObjectIdentifier: Int] = [:]
        for piece in pieces {
            var lo = SIMD3<Float>(repeating: .greatestFiniteMagnitude), hi = -lo
            for p in piece.positions { lo = simd_min(lo, p); hi = simd_max(hi, p) }
            // SIMD3<Float> is 16 bytes apart in memory: pack it tightly.
            var packed = Data(capacity: piece.positions.count * 12)
            for p in piece.positions { withUnsafeBytes(of: (p.x, p.y, p.z)) { packed.append(contentsOf: $0) } }
            accessors.append(["bufferView": view(packed, target: 34962), "componentType": 5126, "count": piece.positions.count, "type": "VEC3", "min": [lo.x, lo.y, lo.z], "max": [hi.x, hi.y, hi.z]])
            var attributes: [String: Int] = ["POSITION": accessors.count - 1]
            if piece.uvs.count == piece.positions.count {
                var uv = Data(capacity: piece.uvs.count * 8)
                // glTF counts texture rows from the top, USD from the bottom.
                for t in piece.uvs { withUnsafeBytes(of: (t.x, 1 - t.y)) { uv.append(contentsOf: $0) } }
                accessors.append(["bufferView": view(uv, target: 34962), "componentType": 5126, "count": piece.uvs.count, "type": "VEC2"])
                attributes["TEXCOORD_0"] = accessors.count - 1
            }
            let idx = piece.indices.withUnsafeBufferPointer { Data(buffer: $0) }
            accessors.append(["bufferView": view(idx, target: 34963), "componentType": 5125, "count": piece.indices.count, "type": "SCALAR"])
            var primitive: [String: Any] = ["attributes": attributes, "indices": accessors.count - 1, "mode": 4]
            if let image = piece.texture, attributes["TEXCOORD_0"] != nil {
                let key = ObjectIdentifier(image)
                if textureOf[key] == nil, let jpeg = jpeg(image) {
                    images.append(["bufferView": view(jpeg), "mimeType": "image/jpeg"])
                    textures.append(["source": images.count - 1])
                    materials.append(["pbrMetallicRoughness": ["baseColorTexture": ["index": textures.count - 1], "metallicFactor": 0, "roughnessFactor": 1], "extensions": ["KHR_materials_unlit": [:] as [String: Any]]])
                    textureOf[key] = materials.count - 1
                }
                if let m = textureOf[key] { primitive["material"] = m }
            }
            primitives.append(primitive)
        }
        while bin.count % 4 != 0 { bin.append(0) }
        var json: [String: Any] = [
            "asset": ["version": "2.0", "generator": "meerCAD"],
            "scene": 0,
            "scenes": [["nodes": [0]]],
            "nodes": [["mesh": 0]],
            "meshes": [["primitives": primitives]],
            "buffers": [["byteLength": bin.count]],
            "bufferViews": views,
            "accessors": accessors,
        ]
        if !materials.isEmpty {
            json["images"] = images
            json["textures"] = textures
            json["materials"] = materials
            json["extensionsUsed"] = ["KHR_materials_unlit"]
        }
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

        let triangles = pieces.reduce(0) { $0 + $1.indices.count / 3 }
        let size = (hi - lo) * 1000
        return (triangles, [size.x, size.y, size.z].map { ($0 * 10).rounded() / 10 })
    }

    private static func jpeg(_ image: CGImage) -> Data? {
        var image = image
        let longest = max(image.width, image.height)
        if longest > 4096 {
            let k = 4096.0 / Double(longest)
            let w = Int(Double(image.width) * k), h = Int(Double(image.height) * k)
            guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
            ctx.interpolationQuality = .high
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            guard let small = ctx.makeImage() else { return nil }
            image = small
        }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? data as Data : nil
    }

    private static func collect(_ object: MDLObject, into out: inout [Piece]) {
        if let mesh = object as? MDLMesh, let attr = mesh.vertexAttributeData(forAttributeNamed: MDLVertexAttributePosition, as: .float3) {
            let matrix = MDLTransform.globalTransform(with: object, atTime: 0)
            let uv = mesh.vertexAttributeData(forAttributeNamed: MDLVertexAttributeTextureCoordinate, as: .float2)
            var positions: [SIMD3<Float>] = []
            var uvs: [SIMD2<Float>] = []
            positions.reserveCapacity(mesh.vertexCount)
            for i in 0..<mesh.vertexCount {
                let p = attr.dataStart.advanced(by: i * attr.stride).assumingMemoryBound(to: Float.self)
                let w = matrix * SIMD4<Float>(p[0], p[1], p[2], 1)
                positions.append(SIMD3(w.x, w.y, w.z))
                if let uv {
                    let t = uv.dataStart.advanced(by: i * uv.stride).assumingMemoryBound(to: Float.self)
                    uvs.append(SIMD2(t[0], t[1]))
                }
            }
            for case let sub as MDLSubmesh in mesh.submeshes ?? [] where sub.geometryType == .triangles {
                var piece = Piece(positions: positions, uvs: uvs)
                let map = sub.indexBuffer.map()
                piece.indices.reserveCapacity(sub.indexCount)
                for k in 0..<sub.indexCount {
                    switch sub.indexType {
                    case .uInt8: piece.indices.append(UInt32(map.bytes.load(fromByteOffset: k, as: UInt8.self)))
                    case .uInt16: piece.indices.append(UInt32(map.bytes.load(fromByteOffset: k * 2, as: UInt16.self)))
                    default: piece.indices.append(map.bytes.load(fromByteOffset: k * 4, as: UInt32.self))
                    }
                }
                if let texture = sub.material?.property(with: .baseColor)?.textureSamplerValue?.texture {
                    piece.texture = texture.imageFromTexture()?.takeUnretainedValue()
                }
                out.append(piece)
            }
        }
        for child in object.children.objects { collect(child, into: &out) }
    }
}
