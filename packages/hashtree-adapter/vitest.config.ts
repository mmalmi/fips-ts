import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@fips/core": resolve(__dirname, "../core/src/index.ts"),
      "@fips/transport-memory": resolve(__dirname, "../transport-memory/src/index.ts"),
    },
  },
});
