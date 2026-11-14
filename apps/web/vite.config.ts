import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run build:pages` sets VITE_QUEUE_BACKEND=browser: the console then runs the ledger engine in the tab,
// uses relative asset paths (so it works under any sub-path, e.g. GitHub Pages) and builds into dist-pages/.
const hosted = process.env.VITE_QUEUE_BACKEND === "browser";
// Social previews need an absolute image URL. The Pages workflow passes the site's public address; elsewhere the
// image is addressed from the site root.
process.env.VITE_QUEUE_SITE_URL ??= "/";

export default defineConfig({
  base: hosted ? "./" : "/",
  plugins: [react()],
  server: {
    port: 4178,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:8789",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4178,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:8789",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: hosted ? "dist-pages" : "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          motion: ["framer-motion"],
          markdown: ["react-markdown", "remark-gfm"],
          remotion: ["remotion", "@remotion/player"],
        },
      },
    },
  },
});
