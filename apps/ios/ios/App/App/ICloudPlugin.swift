import Capacitor
import Foundation

/// The app's iCloud Drive folder ("iCloud Drive › meerCAD") for the web app's project files.
/// The web app reads and writes there with the Filesystem plugin by absolute file URL; this plugin
/// finds the folder, fetches files that are still only in the cloud, and reports changes made on
/// other devices as a "change" event so the projects list can refresh.
@objc(ICloudPlugin)
public class ICloudPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ICloudPlugin"
    public let jsName = "ICloud"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "watch", returnType: CAPPluginReturnPromise),
    ]

    private var query: NSMetadataQuery?

    /// The Documents folder of the iCloud container, created if needed, or nil without iCloud
    /// (signed out, iCloud Drive off for the app). Looking it up can take a while: never on main.
    private func documents() -> URL? {
        guard let container = FileManager.default.url(forUbiquityContainerIdentifier: nil) else { return nil }
        let docs = container.appendingPathComponent("Documents", isDirectory: true)
        try? FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
        return docs
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            if let docs = self.documents() {
                call.resolve(["available": true, "url": docs.absoluteString])
            } else {
                call.resolve(["available": false])
            }
        }
    }

    /// Makes sure a file is on this device: starts the download if it is only in the cloud and
    /// waits for it (up to `timeout` seconds, default 30). A file that is here in an older version
    /// is read as it is while the newer one comes in: a design the Mac saves again and again (an
    /// assistant at work) was otherwise never current, and opening it waited and then failed.
    @objc func download(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let url = URL(string: s) else { return call.reject("missing url") }
        let timeout = call.getDouble("timeout") ?? 30
        DispatchQueue.global(qos: .userInitiated).async {
            let fm = FileManager.default
            // Before iOS 17 a file not yet downloaded is a placeholder ".Name.meercad.icloud".
            let placeholder = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
            let current: () -> Bool = {
                if fm.fileExists(atPath: placeholder.path) { return false }
                let values = try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey])
                guard let status = values?.ubiquitousItemDownloadingStatus else { return fm.fileExists(atPath: url.path) }
                return status == .current
            }
            if current() { return call.resolve() }
            do {
                try fm.startDownloadingUbiquitousItem(at: url)
            } catch {
                return call.reject("could not download \(url.lastPathComponent): \(error.localizedDescription)")
            }
            let values = try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey])
            if values?.ubiquitousItemDownloadingStatus == .downloaded && !fm.fileExists(atPath: placeholder.path) { return call.resolve() }
            let end = Date().addingTimeInterval(timeout)
            while Date() < end {
                if current() { return call.resolve() }
                Thread.sleep(forTimeInterval: 0.2)
            }
            call.reject("\(url.lastPathComponent) is still downloading from iCloud")
        }
    }

    /// Watches the folder: files from other devices are fetched, and every change is reported.
    @objc func watch(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.query == nil {
                let q = NSMetadataQuery()
                q.searchScopes = [NSMetadataQueryUbiquitousDocumentsScope]
                q.predicate = NSPredicate(format: "%K LIKE '*'", NSMetadataItemFSNameKey)
                NotificationCenter.default.addObserver(self, selector: #selector(self.changed(_:)), name: .NSMetadataQueryDidFinishGathering, object: q)
                NotificationCenter.default.addObserver(self, selector: #selector(self.changed(_:)), name: .NSMetadataQueryDidUpdate, object: q)
                q.start()
                self.query = q
            }
            call.resolve()
        }
    }

    @objc private func changed(_ note: Notification) {
        guard let q = query else { return }
        q.disableUpdates()
        var urls: [URL] = []
        for case let item as NSMetadataItem in q.results {
            guard let url = item.value(forAttribute: NSMetadataItemURLKey) as? URL else { continue }
            let status = item.value(forAttribute: NSMetadataUbiquitousItemDownloadingStatusKey) as? String
            if status != NSMetadataUbiquitousItemDownloadingStatusCurrent { urls.append(url) }
        }
        q.enableUpdates()
        DispatchQueue.global(qos: .utility).async {
            for url in urls { try? FileManager.default.startDownloadingUbiquitousItem(at: url) }
        }
        notifyListeners("change", data: [:])
    }

    deinit {
        query?.stop()
        NotificationCenter.default.removeObserver(self)
    }
}
