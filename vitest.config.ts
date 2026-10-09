import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // The invariant tests share one running stack; run files one at a time.
    fileParallelism: false,
  },
});
