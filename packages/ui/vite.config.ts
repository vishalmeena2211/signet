import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4701,
    proxy: {
      "/api": "http://127.0.0.1:4700",
      "/ws": { target: "ws://127.0.0.1:4700", ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
