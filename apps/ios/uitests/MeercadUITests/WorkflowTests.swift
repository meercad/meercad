import XCTest

/// Modelling with fingers on iPhone and iPad, from an empty part to a solid, each step checked
/// against what must come out.
final class WorkflowTests: XCTestCase {
    var m: MeerCAD!

    override func setUp() {
        continueAfterFailure = false
        m = MeerCAD(self)
        m.launch()
    }

    override func tearDown() {
        let shot = XCTAttachment(screenshot: m.app.screenshot())
        shot.lifetime = .deleteOnSuccess
        add(shot)
        m.app.terminate()
    }

    /// Sketch a rectangle with two taps on the Top plane, extrude it, then undo and redo with two-
    /// and three-finger taps.
    func testSketchARectangleAndExtrudeIt() {
        m.newPart()
        m.tap("Sketch")
        m.tap("Top")
        let sketching = m.waitFor("the sketch on Top", timeout: 20) { $0.sketch != nil && $0.axes != nil }
        // The sketch looks straight down at Top: 10 mm along X and Y are a known distance apart on screen.
        _ = sketching
        let axes = m.steadyAxes()
        m.tool("Rectangle", item: "Corner rectangle")
        // Two corners 40 × 30 mm apart, on grid points (the grid snaps a finger to them).
        m.screen((-20, -10, 0), axes).tap()
        Thread.sleep(forTimeInterval: 0.5)
        m.screen((20, 20, 0), axes).tap()
        let drawn = m.waitFor("the rectangle", timeout: 10) { ($0.sketchInfo?.lines ?? 0) >= 4 }
        XCTAssertEqual(drawn.sketchInfo?.lines, 4)
        XCTAssertEqual(drawn.sketchInfo?.regions.count, 1, "the rectangle is not one closed region")
        let area = drawn.sketchInfo!.regions[0]
        XCTAssertEqual(area, 1200, accuracy: 1200 * 0.15, "the rectangle is not about 40 × 30 mm")

        // The rail's Finish; on the phone the sketch header's Done (the bar scrolls).
        m.tap(m.element("Done").exists ? "Done" : "Finish")
        m.waitFor("the sketch to close") { $0.sketch == nil }
        m.tool("Create", item: "Extrude")
        m.waitFor("the extrude dialog") { $0.dialog?.hasPrefix("extrude") == true }
        m.settled()
        m.tap("Accept")
        let solid = m.waitFor("the solid", timeout: 60) { $0.dialog == nil && $0.bodies.count == 1 && !$0.busy }
        let b = solid.bodies[0]
        // A box: its volume is the drawn area times its height.
        XCTAssertEqual(b.volume, area * b.size[2], accuracy: b.volume * 1e-6)
        XCTAssertEqual(b.size[0] * b.size[1], area, accuracy: area * 1e-6)
        XCTAssertGreaterThan(b.size[2], 0)

        // Two fingers tap: undo; three fingers: redo.
        modelArea().twoFingerTap()
        m.waitFor("a two-finger tap to undo the extrusion", timeout: 20) { $0.bodies.isEmpty && !$0.busy }
        tripleTap()
        let back = m.waitFor("a three-finger tap to redo it", timeout: 20) { $0.bodies.count == 1 && !$0.busy }
        XCTAssertEqual(back.bodies[0].volume, b.volume, accuracy: 1e-6)
    }

    /// Measure with taps: a 20 mm cube's top face is 400 mm².
    func testMeasureAFaceByTapping() {
        m.newPart()
        m.tool("Create", item: "Basic solid")
        m.waitFor("the basic solid dialog") { $0.dialog?.hasPrefix("primitive") == true }
        m.settled()
        m.tap("Accept")
        let cube = m.waitFor("the cube", timeout: 60) { $0.dialog == nil && $0.bodies.count == 1 && !$0.busy && $0.axes != nil }
        XCTAssertEqual(cube.bodies[0].volume, 8000, accuracy: 1e-3)
        m.tool("Measure")
        // The top face's middle: (0, 0, 20).
        m.screen((0, 0, 20), m.steadyAxes()).tap()
        let measured = m.waitFor("a measurement", timeout: 15) { $0.measure != nil }
        let rows = measured.measure!.map { $0.joined(separator: " ") }.joined(separator: "; ")
        XCTAssertNotNil(rows.range(of: #"Area 400(\.0+)? mm²"#, options: .regularExpression), "measured: \(rows)")
    }

    /// The model view (the page names it "3D view"), for gestures with several fingers.
    private func modelArea() -> XCUIElement {
        let view = m.app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "3D view")).firstMatch
        XCTAssertTrue(view.waitForExistence(timeout: 5), "no 3D view")
        return view
    }

    private func tripleTap() {
        // XCUITest has no three-finger tap: three touches at once, made from a tap with three fingers.
        modelArea().tap(withNumberOfTaps: 1, numberOfTouches: 3)
    }
}
