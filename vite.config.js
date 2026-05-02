import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  root: "src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
