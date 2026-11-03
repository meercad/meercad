import Capacitor
import RealityKit
import UIKit
import UniformTypeIdentifiers

/// A textured model of an area from a folder of photos (a drone flight, copied onto the iPad or on
/// a card in the Files app), built on the device with Apple's photogrammetry (see TerrainBuild).
/// Reports progress as "progress" events; the model comes back as a GLB file path.
@objc(TerrainPlugin)
public class TerrainPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "TerrainPlugin"
    public let jsName = "Terrain"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "build", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]
    private var pending: CAPPluginCall?
    private var task: Task<Void, Never>?

    @objc func build(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard #available(iOS 17, *), PhotogrammetrySession.isSupported else {
                return call.reject("This device cannot build models from photos.", "unsupported")
            }
            guard let host = self.bridge?.viewController, self.pending == nil else { return call.reject("busy") }
            self.pending = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
            picker.delegate = self
            host.present(picker, animated: true)
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        task?.cancel()
        call.resolve()
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pending?.resolve(["cancelled": true])
        pending = nil
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pending, let folder = urls.first else { return }
        pending = nil
        guard #available(iOS 17, *) else { return }
        task = Task.detached { [weak self] in
            let access = folder.startAccessingSecurityScopedResource()
            // The build runs only while the app is open: keep the screen from locking meanwhile.
            await MainActor.run { UIApplication.shared.isIdleTimerDisabled = true }
            defer {
                if access { folder.stopAccessingSecurityScopedResource() }
                Task { @MainActor in UIApplication.shared.isIdleTimerDisabled = false }
            }
            let work = FileManager.default.temporaryDirectory.appendingPathComponent("terrain-\(Int(Date().timeIntervalSince1970))")
            let glb = FileManager.default.temporaryDirectory.appendingPathComponent("terrain-\(Int(Date().timeIntervalSince1970)).glb")
            do {
                // On the iPad Apple offers only reduced detail (the Mac builds full).
                var result = try await TerrainBuild.run(images: folder, glb: glb, work: work, detail: .reduced) { fraction, step in
                    self?.notifyListeners("progress", data: ["progress": fraction, "step": step])
                }
                result["folder"] = folder.lastPathComponent
                try? FileManager.default.removeItem(at: work)
                call.resolve(result)
            } catch {
                try? FileManager.default.removeItem(at: work)
                call.reject(Task.isCancelled ? "cancelled" : error.localizedDescription, Task.isCancelled ? "cancelled" : "failed")
            }
        }
    }
}
