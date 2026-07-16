import { defineConfig } from "vitest/config";

// Unit tests target the platform's pure logic (FWI math, scoring, H3 helpers).
// These need no Workers runtime, so the default Node environment is enough and
// keeps the suite fast. Tests are colocated next to their source as *.test.ts.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
