import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.join(repoRoot, "packages", "x402-proxy");
const { version } = JSON.parse(readFileSync(path.join(sourceRoot, "package.json"), "utf-8")) as {
  version: string;
};

export default defineConfig([
  {
    entry: {
      index: path.join(sourceRoot, "src/index.ts"),
    },
    outDir: path.join(sourceRoot, ".artifacts/cli/dist"),
    format: ["esm"],
    fixedExtension: false,
    dts: true,
    clean: true,
    treeshake: true,
  },
  {
    entry: {
      "bin/cli": path.join(sourceRoot, "src/bin/cli.ts"),
    },
    outDir: path.join(sourceRoot, ".artifacts/cli/dist"),
    format: ["esm"],
    fixedExtension: false,
    dts: false,
    clean: false,
    treeshake: true,
    banner: { js: "#!/usr/bin/env node" },
    define: { __VERSION__: JSON.stringify(version) },
  },
  {
    entry: {
      "openclaw/plugin": path.join(sourceRoot, "src/openclaw/plugin.ts"),
    },
    outDir: path.join(sourceRoot, ".artifacts/openclaw/dist"),
    format: ["esm"],
    fixedExtension: false,
    dts: true,
    clean: true,
    treeshake: true,
    unbundle: true,
    deps: {
      skipNodeModulesBundle: true,
    },
    define: { __VERSION__: JSON.stringify(version) },
  },
]);
