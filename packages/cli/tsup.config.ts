import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Bundle @mcx/core directly but keep native modules external
  noExternal: ["@mcx/core"],
  external: ["isolated-vm"],
});
