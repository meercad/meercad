import Capacitor
import UIKit
import WebKit

/// Apple Pencil hardware gestures for the web app: double-tap (Pencil 2 and Pro) and squeeze
/// (Pencil Pro) arrive in JavaScript as a "tap" event with `kind` "tap" or "squeeze".
/// Respects the user's system setting: nothing is sent when it says to ignore the gesture.
@objc(PencilPlugin)
public class PencilPlugin: CAPPlugin, CAPBridgedPlugin, UIPencilInteractionDelegate {
    public let identifier = "PencilPlugin"
    public let jsName = "Pencil"
    public let pluginMethods: [CAPPluginMethod] = []

    override public func load() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let view = self.bridge?.viewController?.view else { return }
            let interaction = UIPencilInteraction()
            interaction.delegate = self
            view.addInteraction(interaction)
        }
    }

    @available(iOS 17.5, *)
    public func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        guard UIPencilInteraction.preferredTapAction != .ignore else { return }
        notifyListeners("tap", data: ["kind": "tap"])
    }

    @available(iOS 17.5, *)
    public func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        guard squeeze.phase == .ended, UIPencilInteraction.preferredSqueezeAction != .ignore else { return }
        notifyListeners("tap", data: ["kind": "squeeze"])
    }

    /// Before iOS 17.5 only the double-tap exists.
    public func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        if #available(iOS 17.5, *) { return }
        guard UIPencilInteraction.preferredTapAction != .ignore else { return }
        notifyListeners("tap", data: ["kind": "tap"])
    }
}

/// The app's web view controller: registers the plugins that live in this app target and makes the
/// page cross-origin isolated (see `IsolatedWebViewConfiguration`).
class AppViewController: CAPBridgeViewController {
    override open func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let base = super.webViewConfiguration(for: instanceConfiguration)
        // Capacitor builds a plain configuration; copy its settings into the isolating subclass.
        let config = IsolatedWebViewConfiguration()
        config.websiteDataStore = base.websiteDataStore
        config.allowsInlineMediaPlayback = base.allowsInlineMediaPlayback
        config.suppressesIncrementalRendering = base.suppressesIncrementalRendering
        config.allowsAirPlayForMediaPlayback = base.allowsAirPlayForMediaPlayback
        config.mediaTypesRequiringUserActionForPlayback = base.mediaTypesRequiringUserActionForPlayback
        config.limitsNavigationsToAppBoundDomains = base.limitsNavigationsToAppBoundDomains
        config.preferences = base.preferences
        config.applicationNameForUserAgent = base.applicationNameForUserAgent
        config.defaultWebpagePreferences = base.defaultWebpagePreferences
        return config
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PencilPlugin())
        bridge?.registerPluginInstance(ScanPlugin())
        bridge?.registerPluginInstance(ICloudPlugin())
    }
}
