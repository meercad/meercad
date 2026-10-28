import Foundation
import WebKit

/// Makes the app page cross-origin isolated, so the kernel gets SharedArrayBuffer and can use the
/// threaded OCCT build. Capacitor creates its scheme handler inside a `final` `loadView`, so the
/// handler can't be swapped there. Instead the web view configuration wraps whatever handler gets
/// registered, and the wrapper adds COOP, COEP and CORP to every response it passes on.
class IsolatedWebViewConfiguration: WKWebViewConfiguration {
    override func setURLSchemeHandler(_ urlSchemeHandler: WKURLSchemeHandler?, forURLScheme urlScheme: String) {
        super.setURLSchemeHandler(urlSchemeHandler.map { IsolatingSchemeHandler($0) }, forURLScheme: urlScheme)
    }
}

/// Hands each task to the wrapped handler as a proxy that adds the isolation headers.
private class IsolatingSchemeHandler: NSObject, WKURLSchemeHandler {
    private let inner: WKURLSchemeHandler
    // The inner handler marks tasks as stopped, so `stop` must reach it with the same proxy as `start`.
    private var proxies: [ObjectIdentifier: IsolatingSchemeTask] = [:]

    init(_ inner: WKURLSchemeHandler) {
        self.inner = inner
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        let proxy = IsolatingSchemeTask(urlSchemeTask) { [weak self] in self?.proxies[key] = nil }
        proxies[key] = proxy
        inner.webView(webView, start: proxy)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        guard let proxy = proxies.removeValue(forKey: key) else { return }
        inner.webView(webView, stop: proxy)
    }
}

private class IsolatingSchemeTask: NSObject, WKURLSchemeTask {
    static let headers = [
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "same-origin"
    ]

    private let task: WKURLSchemeTask
    private let onEnd: () -> Void

    init(_ task: WKURLSchemeTask, onEnd: @escaping () -> Void) {
        self.task = task
        self.onEnd = onEnd
    }

    var request: URLRequest { task.request }

    func didReceive(_ response: URLResponse) {
        task.didReceive(Self.isolated(response))
    }

    func didReceive(_ data: Data) {
        task.didReceive(data)
    }

    func didFinish() {
        task.didFinish()
        onEnd()
    }

    func didFailWithError(_ error: Error) {
        task.didFailWithError(error)
        onEnd()
    }

    /// Capacitor answers media files with a plain `URLResponse`, which has no headers. Those stay as
    /// they are: same-origin media needs no CORP.
    private static func isolated(_ response: URLResponse) -> URLResponse {
        guard let http = response as? HTTPURLResponse, let url = http.url else { return response }
        var fields: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            if let key = key as? String, let value = value as? String { fields[key] = value }
        }
        fields.merge(headers) { _, new in new }
        return HTTPURLResponse(url: url, statusCode: http.statusCode, httpVersion: nil, headerFields: fields) ?? response
    }
}
