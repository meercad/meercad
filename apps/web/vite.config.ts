import react from "@vitejs/plugin-react";
import { defineConfig, type Connect, type Plugin } from "vite";

// Cross-origin isolation (SharedArrayBuffer for the multi-threaded OCCT build).
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/**
 * Sends the isolation headers on every response. `server.headers` / `preview.headers` miss the
 * preview server's 304 revalidations, and Safari then refuses to start the kernel worker on reload.
 */
function isolationHeaders(): Plugin {
  const set: Connect.NextHandleFunction = (_req, res, next) => {
    for (const [k, v] of Object.entries(isolation)) res.setHeader(k, v);
    next();
  };
  return {
    name: "meercad-isolation-headers",
    configureServer: (server) => void server.middlewares.use(set),
    configurePreviewServer: (server) => void server.middlewares.use(set),
  };
}

export default defineConfig({
  plugins: [react(), isolationHeaders()],
  server: { headers: isolation, port: 5173 },
  preview: { headers: isolation },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 2500 },
  optimizeDeps: { exclude: ["replicad-opencascadejs", "@salusoft89/planegcs"] },
});
