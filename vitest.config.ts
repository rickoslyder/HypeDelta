import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "apps/web/src"),
      "@hypedelta/author-side": path.resolve(__dirname, "src/author-side.ts"),
      "@hypedelta/researcher-identity": path.resolve(__dirname, "src/researcher-identity.ts"),
      "@hypedelta/topic-synthesis": path.resolve(__dirname, "src/topic-synthesis.ts"),
    },
  },
});
