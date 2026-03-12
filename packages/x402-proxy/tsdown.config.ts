import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: { "bin/cli": "src/bin/cli.ts" },
    format: ["esm"],
    fixedExtension: false,
    dts: false,
    clean: true,
    treeshake: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    fixedExtension: false,
    dts: true,
    clean: false,
    treeshake: true,
  },
]);
