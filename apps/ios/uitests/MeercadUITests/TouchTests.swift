import XCTest

/// Touch on iPhone and iPad, in the real app in the Simulator. Each test is a thing a person does
/// with their fingers, checked against what must come out. Run with `pnpm test:ios`.
final class TouchTests: XCTestCase {
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

    /// Found 2026-11-11 on the iPad: two quick taps zoomed the whole interface like a web page, and
    /// it stayed zoomed until the app was restarted.
    func testDoubleTapsAndPinchesNeverZoomTheInterface() {
        _ = m.openExample("Mounting plate")
        let size = m.screenSize()
        let spots: [(Double, Double)] = [
            (size.width / 2 + 120, 75), // top bar (below the system area, where a double tap sizes the window)
            (size.width - 40, size.height / 2), // beside the model
            (size.width / 2, size.height - 30), // tool bar
            (40, size.height / 2), // left edge
            (size.width / 2, size.height / 2), // the model
        ]
        let start = m.probe()!
        print("before: scale \(start.scale) inner \(start.width) visible \(start.visible) layout \(start.layout) screen \(size)")
        XCTAssertEqual(start.visible, start.layout, accuracy: 1, "zoomed before any tap")
        for (x, y) in spots {
            m.point(x, y).doubleTap()
            Thread.sleep(forTimeInterval: 0.8)
            let p = m.probe()!
            print("after double tap at \(x), \(y): scale \(p.scale) inner \(p.width) visible \(p.visible) layout \(p.layout)")
            XCTAssertEqual(p.scale, 1, "double tap at \(x), \(y) zoomed the interface")
            XCTAssertEqual(p.visible, start.visible, accuracy: 1, "double tap at \(x), \(y) zoomed the interface")
            XCTAssertEqual(p.layout, start.layout, accuracy: 1)
            // Taps select; they never change the design.
            XCTAssertEqual(p.params["thickness"]?.description, "4 mm", "a double tap at \(x), \(y) changed the thickness")
            XCTAssertEqual(p.features, start.features, "a double tap at \(x), \(y) changed the steps")
        }
        // A pinch zooms the camera on the model, never the page itself.
        m.app.webViews.firstMatch.pinch(withScale: 2.5, velocity: 2)
        Thread.sleep(forTimeInterval: 0.8)
        let after = m.probe()!
        XCTAssertEqual(after.scale, 1, "a pinch zoomed the interface")
        XCTAssertEqual(after.visible, start.visible, accuracy: 1, "a pinch zoomed the interface")
        // Two fingers move the camera; they never drag the arrow of the selected face.
        let built = m.settled()
        XCTAssertEqual(built.params["thickness"]?.description, "4 mm", "a pinch over the selected face changed the thickness")
        XCTAssertEqual(built.features, start.features, "a pinch changed the steps")
    }

    /// Found 2026-11-11 on the iPad: dragging the mounting plate's top face added a new step
    /// "Extrude 3" although the arrow showed the variable, and the holes no longer went through.
    func testDraggingTheTopFaceChangesTheThicknessVariable() {
        let before = m.openExample("Mounting plate")
        XCTAssertEqual(before.params["thickness"]?.description, "4 mm")
        let size = m.screenSize()
        // The plate fills the middle of the view: a tap there picks its top face.
        m.point(size.width / 2, size.height / 2).tap()
        let chip = m.element("4 mm")
        XCTAssertTrue(chip.waitForExistence(timeout: 10), "no drag arrow with the plate's 4 mm on the top face")
        // The value chip sits 16 pt right of and 16 pt above the arrow's tip.
        let f = chip.frame
        let tip = m.app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: f.minX - 14, dy: f.minY + 16))
        tip.press(forDuration: 0.25, thenDragTo: tip.withOffset(CGVector(dx: 0, dy: -70)))
        let after = m.settled()
        XCTAssertEqual(after.features, before.features, "the drag added or removed a step")
        XCTAssertNotEqual(after.params["thickness"]?.description, "4 mm", "the drag did not change thickness")
        XCTAssertEqual(after.errors, [])
        XCTAssertEqual(after.bodies.count, 1)
        // The part is exactly as thick as the variable says: the holes still go all the way through
        // because the whole history built again with the new thickness.
        if case .text(let t)? = after.params["thickness"], let mm = Double(t.replacingOccurrences(of: " mm", with: "")) {
            XCTAssertEqual(after.bodies[0].size[2], mm, accuracy: 1e-3)
            XCTAssertGreaterThan(mm, 4)
        } else {
            XCTFail("thickness is not a length in mm: \(String(describing: after.params["thickness"]))")
        }
        // One undo puts it back.
        m.tap("Undo")
        let undone = m.settled()
        XCTAssertEqual(undone.params["thickness"]?.description, "4 mm")
    }

    /// Found 2026-11-11 on the iPhone: the parts sheet stayed open in a sketch, covered half of it
    /// and the step's dialog, and could neither be swiped away nor closed.
    func testPartsSheetMakesWayForSketchesAndDialogs() throws {
        let start = m.openExample("Mounting plate")
        try XCTSkipUnless(start.compact, "the parts sheet is the phone layout's")
        m.tap("Parts")
        m.waitFor("the parts sheet to open") { $0.sideOpen }
        // Swiping the grip down closes it.
        let grip = m.element("Close")
        XCTAssertTrue(grip.waitForExistence(timeout: 5))
        let g = grip.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        g.press(forDuration: 0.05, thenDragTo: g.withOffset(CGVector(dx: 0, dy: 120)))
        m.waitFor("a swipe down to close the parts sheet") { !$0.sideOpen }

        // Open again, then start a step: its dialog takes the place of the sheet.
        m.tap("Parts")
        m.waitFor("the parts sheet to open") { $0.sideOpen }
        m.tap("Extrude")
        let dialog = m.waitFor("the extrude dialog") { $0.dialog != nil }
        XCTAssertFalse(dialog.sideOpen, "the parts sheet stayed open over the dialog")
        m.tap("Cancel")
        m.waitFor("the dialog to close") { $0.dialog == nil }

        // Open again, then edit a sketch from the history: the sheet goes, the sketch is free.
        m.tap("Parts")
        m.waitFor("the parts sheet to open") { $0.sideOpen }
        let holes = m.element("Holes")
        XCTAssertTrue(holes.waitForExistence(timeout: 5))
        holes.doubleTap()
        let sketching = m.waitFor("the sketch to open", timeout: 20) { $0.sketch != nil || $0.dialog != nil }
        XCTAssertFalse(sketching.sideOpen, "the parts sheet stayed open in the sketch")
    }

    /// Found 2026-11-11 in the iPad Simulator: the tool wall example once failed with
    /// "could not cut the shape" (Geom2d_Curve).
    func testToolWallExampleBuildsWithoutErrors() {
        let p = m.openExample("Tool wall on openGrid")
        XCTAssertEqual(p.errors, [])
        XCTAssertFalse(p.toasts.contains { $0.contains("could not") }, "\(p.toasts)")
        XCTAssertGreaterThanOrEqual(p.bodies.count, 6)
    }

    /// The other examples a person sees first build without errors on the device's own kernel.
    func testFirstExamplesBuild() {
        for name in ["Mounting plate", "Project box", "Flange"] {
            let p = m.openExample(name)
            XCTAssertEqual(p.errors, [], name)
            XCTAssertFalse(p.bodies.isEmpty, name)
            m.tap("All projects")
            m.waitFor("the overview") { $0.screen == "home" }
        }
    }
}
