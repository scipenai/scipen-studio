import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// SPA dev server. In dev, `/api` is proxied to the Rust backend; in
// production the SPA is served from the same axum listener that owns
// `/api/v1/*`, so the proxy here only matters for `npm run dev`.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: false,
      },
      "/healthz": {
        target: "http://127.0.0.1:8080",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Drop sourcemaps from the embedded payload to keep release binary
    // sizes sane.
    sourcemap: false,
  },
});
