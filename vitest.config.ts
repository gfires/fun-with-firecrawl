import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest config. Only concern: resolve the `@/` path alias (mirrors tsconfig paths) so the
 * pure-logic tests can import from `@/lib/*`. Tests are node-environment; no DOM needed since
 * we only unit-test pure functions (intents, scoring, schema, the stream reducer).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
