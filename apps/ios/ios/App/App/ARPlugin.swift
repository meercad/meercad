import ARKit
import Capacitor
import QuickLook
import UIKit

/// The AR preview: shows a USDZ the web app wrote (a file URL in the app's caches) in AR Quick
/// Look, where the part stands on a table or the floor in real size. Pinching may not scale it,
/// so what is seen is what will be printed. Devices without AR show the 3D view only.
@objc(ARPlugin)
public class ARPlugin: CAPPlugin, CAPBridgedPlugin, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    public let identifier = "ARPlugin"
    public let jsName = "AR"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
    ]

    private var item: ARQuickLookPreviewItem?
    private var pending: CAPPluginCall?

    /// Whether this device can place things in the room (world tracking): every iPhone and iPad
    /// from the A9 on. Without it AR Quick Look still shows the part in 3D.
    @objc func available(_ call: CAPPluginCall) {
        call.resolve(["ar": ARWorldTrackingConfiguration.isSupported])
    }

    /// Shows the USDZ at `url` (file URL); resolves once the preview is closed.
    @objc func show(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw), url.isFileURL,
              FileManager.default.fileExists(atPath: url.path) else {
            call.reject("no USDZ file at the given URL")
            return
        }
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("no view to present from")
                return
            }
            let item = ARQuickLookPreviewItem(fileAt: url)
            item.allowsContentScaling = false
            self.item = item
            self.pending?.resolve()
            self.pending = call
            let ql = QLPreviewController()
            ql.dataSource = self
            ql.delegate = self
            presenter.present(ql, animated: true)
        }
    }

    public func numberOfPreviewItems(in controller: QLPreviewController) -> Int { item == nil ? 0 : 1 }

    public func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        item!
    }

    public func previewControllerDidDismiss(_ controller: QLPreviewController) {
        item = nil
        pending?.resolve()
        pending = nil
    }
}
