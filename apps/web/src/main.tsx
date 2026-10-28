import "./lib/legacy";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { installLongPressMenus } from "./lib/gestures";
import { installKeyboardDetection } from "./lib/keyboard";

installLongPressMenus();
// Development builds expose the stores so test runs can read the document and the result (docs/TESTING.md).
if (import.meta.env.DEV)
  void Promise.all([import("./store"), import("./sketch/state")]).then(([store, sketch]) => {
    (window as unknown as { meercadTest: unknown }).meercadTest = { app: store.useApp, sketch: sketch.useSketchUi, store };
  });
installKeyboardDetection();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
