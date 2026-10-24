import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  // pack loads in beforeAll can take > 10 s when the suite runs in parallel on a loaded machine
  test: { include: ["tests/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 180_000 },
});
