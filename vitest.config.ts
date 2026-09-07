import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

// Point workspace imports at source so the suite doesn't need a build first.
export default defineConfig({
  resolve: {
    alias: {
      "@collab/crdt": pkg("crdt"),
      "@collab/protocol": pkg("protocol"),
      "@collab/client": pkg("client"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
