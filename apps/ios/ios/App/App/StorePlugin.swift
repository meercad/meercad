import Capacitor
import Foundation

/// The App Store side of the app. For now it only says where the installed app came from:
/// TestFlight and Xcode installs carry a sandbox receipt, App Store downloads a production one.
/// Later it carries the meerCAD Pro purchase (StoreKit 2).
@objc(StorePlugin)
public class StorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StorePlugin"
    public let jsName = "Store"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "environment", returnType: CAPPluginReturnPromise),
    ]

    @objc func environment(_ call: CAPPluginCall) {
        let sandbox = Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
        call.resolve(["environment": sandbox ? "sandbox" : "production"])
    }
}
