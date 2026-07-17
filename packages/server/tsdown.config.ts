import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: "esm",
    outDir: "dist",
    noExternal: ["@sketch/shared", /^talisman/],
  },
  {
    entry: { "wa-gateway": "src/whatsapp/gateway/main.ts" },
    format: "esm",
    outDir: "dist",
    clean: false,
    noExternal: ["@sketch/shared", /^talisman/],
  },
]);
