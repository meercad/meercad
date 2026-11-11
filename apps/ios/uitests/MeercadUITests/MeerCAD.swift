import XCTest

/// What the page reports about itself (apps/web/src/lib/uitestProbe.ts).
struct Probe: Decodable {
    let scale: Double
    let width: Double
    let visible: Double
    let layout: Double
    let compact: Bool
    let screen: String
    let busy: Bool
    let sideOpen: Bool
    let sketch: String?
    let dialog: String?
    let features: [String]
    let params: [String: ParamValue]
    let bodies: [BodyInfo]
    let errors: [String]
    let toasts: [String]
    let rects: [String: [Double]?]

    struct BodyInfo: Decodable {
        let id: String
        let volume: Double
        let size: [Double]
    }

    enum ParamValue: Decodable, Equatable, CustomStringConvertible {
        case number(Double), text(String)
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let n = try? c.decode(Double.self) { self = .number(n) } else { self = .text(try c.decode(String.self)) }
        }
        var description: String {
            switch self {
            case .number(let n): return String(n)
            case .text(let t): return t
            }
        }
    }

    func rect(_ name: String) -> CGRect? {
        guard let r = rects[name] ?? nil, r.count == 4 else { return nil }
        return CGRect(x: r[0], y: r[1], width: r[2], height: r[3])
    }
}

/// The meerCAD app under test, driven by touches the way a person uses it.
final class MeerCAD {
    let app = XCUIApplication(bundleIdentifier: "app.meercad")
    let test: XCTestCase

    init(_ test: XCTestCase) {
        self.test = test
        app.launchArguments = ["-meercadUITest", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
    }

    func launch() {
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 60), "the app's page did not appear")
        _ = waitFor("the page to start", timeout: 60) { _ in true }
    }

    var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    // MARK: reading the page

    private var probeElement: XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "UITEST ")).firstMatch
    }

    func probe() -> Probe? {
        let el = probeElement
        guard el.exists else { return nil }
        let text = String(el.label.dropFirst("UITEST ".count))
        return try? JSONDecoder().decode(Probe.self, from: Data(text.utf8))
    }

    /// Waits until the page's state passes `ok`, failing the test with `what` after `timeout`.
    @discardableResult
    func waitFor(_ what: String, timeout: TimeInterval = 30, file: StaticString = #filePath, line: UInt = #line, _ ok: (Probe) -> Bool) -> Probe {
        let end = Date().addingTimeInterval(timeout)
        var last: Probe?
        while Date() < end {
            if let p = probe() {
                last = p
                if ok(p) { return p }
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        if last == nil {
            // No probe at all: show what the accessibility tree does have, to see why.
            let tree = app.debugDescription
            let att = XCTAttachment(string: tree)
            att.name = "accessibility tree"
            att.lifetime = .keepAlways
            test.add(att)
            print(String(tree.prefix(6000)))
        }
        XCTFail("timed out waiting for \(what); last state: \(String(describing: last))", file: file, line: line)
        if let p = last { return p }
        fatalError("no state from the page")
    }

    /// The result of the last change, once the kernel has caught up.
    @discardableResult
    func settled(timeout: TimeInterval = 120, file: StaticString = #filePath, line: UInt = #line) -> Probe {
        Thread.sleep(forTimeInterval: 0.4)
        return waitFor("the model to finish building", timeout: timeout, file: file, line: line) { !$0.busy }
    }

    // MARK: touching

    /// A button, link or other element whose label contains `label`.
    func element(_ label: String) -> XCUIElement {
        let p = NSPredicate(format: "label CONTAINS %@ AND NOT (label BEGINSWITH %@)", label, "UITEST ")
        let button = app.buttons.matching(p).firstMatch
        if button.exists { return button }
        return app.descendants(matching: .any).matching(p).firstMatch
    }

    func tap(_ label: String, timeout: TimeInterval = 15, file: StaticString = #filePath, line: UInt = #line) {
        let el = element(label)
        XCTAssertTrue(el.waitForExistence(timeout: timeout), "not on screen: \(label)", file: file, line: line)
        el.tap()
    }

    /// A point on the screen in the page's coordinates (CSS pixels are points in the web view).
    func point(_ x: Double, _ y: Double) -> XCUICoordinate {
        let web = app.webViews.firstMatch
        return web.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
    }

    func screenSize() -> CGSize { app.webViews.firstMatch.frame.size }

    // MARK: flows

    /// From the overview, opens an example as a new part and waits for it to build.
    func openExample(_ name: String, file: StaticString = #filePath, line: UInt = #line) -> Probe {
        waitFor("the overview", file: file, line: line) { $0.screen == "home" }
        // The example's card, not a part saved earlier under the same name: examples come last.
        func exampleCard() -> XCUIElement {
            let all = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).allElementsBoundByIndex
            return all.max(by: { $0.frame.minY < $1.frame.minY }) ?? element(name)
        }
        var card = exampleCard()
        if !card.waitForExistence(timeout: 3) {
            // The examples section may be folded away.
            tap("Examples", file: file, line: line)
            card = exampleCard()
        }
        if !card.isHittable { app.swipeUp() }
        XCTAssertTrue(card.waitForExistence(timeout: 10), "no example \(name)", file: file, line: line)
        card.tap()
        waitFor("the example to open", timeout: 60, file: file, line: line) { $0.screen == "editor" && !$0.bodies.isEmpty }
        return settled(file: file, line: line)
    }
}
