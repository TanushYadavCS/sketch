import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
      "@sketch/shared": resolve(import.meta.dirname, "../shared/src/index.ts"),
      "@sketch/ui/components": resolve(import.meta.dirname, "../ui/src/components/ui"),
      "@sketch/ui/hooks": resolve(import.meta.dirname, "../ui/src/hooks"),
      "@sketch/ui/lib": resolve(import.meta.dirname, "../ui/src/lib"),
      "@sketch/ui": resolve(import.meta.dirname, "../ui/src"),
      "@ui/components/ui": resolve(import.meta.dirname, "../ui/src/components/ui"),
      "@ui/hooks": resolve(import.meta.dirname, "../ui/src/hooks"),
      "@ui/lib": resolve(import.meta.dirname, "../ui/src/lib"),
      "@ui": resolve(import.meta.dirname, "../ui/src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
