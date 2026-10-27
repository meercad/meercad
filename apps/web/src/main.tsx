import "./lib/legacy";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { installLongPressMenus } from "./lib/gestures";
import { installKeyboardDetection } from "./lib/keyboard";

installLongPressMenus();
installKeyboardDetection();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
