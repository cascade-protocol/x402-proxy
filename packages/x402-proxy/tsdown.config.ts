import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const { version } = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig([
  {
    entry: { "bin/cli": "src/bin/cli.ts" },
    format: ["esm"],
    fixedExtension: false,
    dts: false,
    clean: true,
    treeshake: true,
    banner: { js: "#!/usr/bin/env node" },
    define: { __VERSION__: JSON.stringify(version) },
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
