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
    let axes: Axes?
    let sketchInfo: SketchInfo?
    let measure: [[String]]?

    struct Axes: Decodable {
        let o: [Double], x: [Double], y: [Double], z: [Double]
    }
    struct SketchInfo: Decodable {
        let lines: Int
        let circles: Int
        let dof: Int?
        let regions: [Double]
    }

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
        // A cold start after a fresh install can take a while in a busy Simulator; launch once more if
        // the page never reports.
        if !waitQuietly(90) {
            app.terminate()
            app.launch()
        }
        _ = waitFor("the page to start", timeout: 90) { _ in true }
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
        do {
            return try JSONDecoder().decode(Probe.self, from: Data(text.utf8))
        } catch {
            print("probe not readable: \(error) in \(text.prefix(400))")
            return nil
        }
    }

    private func waitQuietly(_ seconds: TimeInterval) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if probe() != nil { return true }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return false
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
    /// Prefers a button named exactly so, then one whose name starts with it (a tool and its key),
    /// then anything containing it, hittable ones first.
    func element(_ label: String) -> XCUIElement {
        let tries = [
            NSPredicate(format: "label == %@", label),
            NSPredicate(format: "label BEGINSWITH %@", label + " "),
            NSPredicate(format: "label CONTAINS %@ AND NOT (label BEGINSWITH %@)", label, "UITEST "),
        ]
        for p in tries {
            for query in [app.buttons.matching(p), app.descendants(matching: .any).matching(p)] {
                let all = query.allElementsBoundByIndex
                if let hit = all.first(where: { $0.isHittable }) ?? all.first { return hit }
            }
        }
        return app.buttons.matching(tries[2]).firstMatch
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

    /// Where a point of the model (mm) is on screen, from the probe's axes (exact on the origin
    /// planes in a straight view, close enough elsewhere to land on a face).
    func screen(_ p: (Double, Double, Double), _ axes: Probe.Axes) -> XCUICoordinate {
        let x = axes.o[0] + (axes.x[0] - axes.o[0]) * p.0 / 10 + (axes.y[0] - axes.o[0]) * p.1 / 10 + (axes.z[0] - axes.o[0]) * p.2 / 10
        let y = axes.o[1] + (axes.x[1] - axes.o[1]) * p.0 / 10 + (axes.y[1] - axes.o[1]) * p.1 / 10 + (axes.z[1] - axes.o[1]) * p.2 / 10
        return point(x, y)
    }

    /// The axes once the camera stands still (a view turns for a moment after a sketch starts).
    func steadyAxes(file: StaticString = #filePath, line: UInt = #line) -> Probe.Axes {
        var last: [Double] = []
        let end = Date().addingTimeInterval(15)
        while Date() < end {
            if let a = probe()?.axes {
                let now = a.o + a.x + a.y + a.z
                if now == last { return a }
                last = now
            }
            Thread.sleep(forTimeInterval: 0.6)
        }
        XCTFail("the view did not come to rest", file: file, line: line)
        return probe()!.axes!
    }

    /// A tool in the rail (or the phone's bar), and an item of its group if it opens one.
    func tool(_ label: String, item: String? = nil, file: StaticString = #filePath, line: UInt = #line) {
        tap(label, file: file, line: line)
        if let item {
            // A group's items are menu items named by their hint; their visible name is a text inside.
            let inMenu = app.menuItems.containing(NSPredicate(format: "label == %@", item)).firstMatch
            let el = inMenu.waitForExistence(timeout: 3) ? inMenu : element(item)
            if !el.exists {
                let tree = app.debugDescription
                print(tree.split(separator: "\n").filter { $0.contains("Menu") || $0.contains("Basic") || $0.contains("ectangle") || $0.contains("Create") }.joined(separator: "\n"))
            }
            XCTAssertTrue(el.waitForExistence(timeout: 5), "no \(item) under \(label)", file: file, line: line)
            el.tap()
        }
        Thread.sleep(forTimeInterval: 0.4)
    }

    /// A new empty part from the overview.
    func newPart(file: StaticString = #filePath, line: UInt = #line) {
        waitFor("the overview", file: file, line: line) { $0.screen == "home" }
        // The overview's big New part card; a first tap into a just-started app can get lost, so
        // a person taps again.
        for attempt in 0..<3 {
            let card = app.buttons.matching(NSPredicate(format: "label == %@", "New part")).allElementsBoundByIndex.filter { $0.isHittable }.max { $0.frame.height < $1.frame.height }
            XCTAssertNotNil(card, "no New part card", file: file, line: line)
            card?.tap()
            let end = Date().addingTimeInterval(8)
            while Date() < end, probe()?.screen != "editor" { Thread.sleep(forTimeInterval: 0.3) }
            if probe()?.screen == "editor" || attempt == 2 { break }
        }
        waitFor("the new part", file: file, line: line) { $0.screen == "editor" }
        Thread.sleep(forTimeInterval: 1)
    }

    /// Edits a step in the history list the touch way: a long press opens its menu, then Edit.
    func editRow(_ name: String, file: StaticString = #filePath, line: UInt = #line) {
        let row = element(name)
        XCTAssertTrue(row.waitForExistence(timeout: 5), "no step \(name) in the history", file: file, line: line)
        row.press(forDuration: 0.9)
        Thread.sleep(forTimeInterval: 0.4)
        // The menu opens at the row: its Edit is the "Edit" nearest to it.
        let y = row.frame.midY
        let edit = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Edit")).allElementsBoundByIndex
            .filter { $0.isHittable && $0.frame.height > 20 }
            .min { abs($0.frame.midY - y) < abs($1.frame.midY - y) }
        XCTAssertNotNil(edit, "no Edit in the step's menu", file: file, line: line)
        edit?.tap()
    }

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
        for _ in 0..<12 where card.exists && !card.isHittable { app.webViews.firstMatch.swipeUp(velocity: .slow) }
        XCTAssertTrue(card.waitForExistence(timeout: 10), "no example \(name)", file: file, line: line)
        card.tap()
        waitFor("the example to open", timeout: 60, file: file, line: line) { $0.screen == "editor" && !$0.bodies.isEmpty }
        return settled(file: file, line: line)
    }
}
