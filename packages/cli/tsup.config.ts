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
  // Bundle @papicandela/mcx-core directly but keep native modules external
  noExternal: ["@papicandela/mcx-core"],
  external: ["isolated-vm"],
});
