import "./lib/legacy";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { desktop } from "./lib/persistence";
import { nativeApp } from "./lib/native";
import { installLongPressMenus } from "./lib/gestures";
import { installKeyboardDetection } from "./lib/keyboard";
import { installProbe, uiTesting } from "./lib/uitestProbe";

installLongPressMenus();
// Development builds expose the stores so test runs can read the document and the result (docs/TESTING.md).
// So does an iOS app started by a UI test, which also reads the state from an accessibility label.
if (import.meta.env.DEV || uiTesting())
  void Promise.all([import("./store"), import("./sketch/state"), import("./lib/mcpBridge")]).then(([store, sketch, bridge]) => {
    (window as unknown as { meercadTest: unknown }).meercadTest = { app: store.useApp, sketch: sketch.useSketchUi, store, mcp: bridge.testCall };
    if (uiTesting()) installProbe(store.useApp, store.rebuilding);
  });
installKeyboardDetection();

// meerCAD is the Mac and iPad app; opened anywhere else (a browser on the dev server) it says so.
const root = createRoot(document.getElementById("root")!);
if (desktop || nativeApp)
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
else root.render(<p style={{ margin: "40vh auto", textAlign: "center", font: "15px system-ui" }}>meerCAD runs as the Mac and iPad app.</p>);
