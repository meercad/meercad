import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Cross-origin isolation (needed later for SharedArrayBuffer / multi-threaded OCCT).
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation, port: 5173 },
  preview: { headers: isolation },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 2500 },
  optimizeDeps: { exclude: ["replicad-opencascadejs", "@salusoft89/planegcs"] },
});
