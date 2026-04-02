import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(repoRoot, "packages", "x402-proxy");
const artifactsDir = path.join(sourceDir, ".artifacts");
const releaseDir = path.join(sourceDir, ".release");
const cliArtifactDir = path.join(artifactsDir, "cli");
const openclawArtifactDir = path.join(artifactsDir, "openclaw");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureExists(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function resetDir(dirPath) {
  rmSync(dirPath, { recursive: true, force: true });
  mkdirSync(dirPath, { recursive: true });
}

function copyIfExists(from, to) {
  if (existsSync(from)) {
    cpSync(from, to, { recursive: true });
  }
}

const sourcePackage = readJson(path.join(sourceDir, "package.json"));
const pluginManifest = readJson(path.join(sourceDir, "openclaw.plugin.json"));

ensureExists(path.join(cliArtifactDir, "dist"), "CLI build output");
ensureExists(path.join(openclawArtifactDir, "dist"), "OpenClaw build output");

pluginManifest.version = sourcePackage.version;

resetDir(releaseDir);

const cliStageDir = path.join(releaseDir, "x402-proxy");
const pluginStageDir = path.join(releaseDir, "x402-proxy-openclaw");

mkdirSync(cliStageDir, { recursive: true });
mkdirSync(pluginStageDir, { recursive: true });

const commonManifestFields = {
  version: sourcePackage.version,
  type: sourcePackage.type,
  sideEffects: sourcePackage.sideEffects,
  license: sourcePackage.license,
  engines: sourcePackage.engines,
  repository: sourcePackage.repository,
  homepage: sourcePackage.homepage,
  bugs: sourcePackage.bugs,
};

const cliManifest = {
  name: "x402-proxy",
  description:
    "curl for x402 paid APIs. Auto-pays any endpoint on Base, Solana, and Tempo.",
  ...commonManifestFields,
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": sourcePackage.exports["."],
    "./package.json": "./package.json",
  },
  bin: sourcePackage.bin,
  dependencies: sourcePackage.dependencies,
  keywords: (sourcePackage.keywords ?? []).filter(
    (keyword) => keyword !== "openclaw" && keyword !== "openclaw-plugin",
  ),
};

const pluginManifestPackage = {
  name: "x402-proxy-openclaw",
  description:
    "OpenClaw plugin for x402 and MPP payments, wallet tools, and paid inference proxying.",
  ...commonManifestFields,
  main: "./dist/openclaw/plugin.js",
  types: "./dist/openclaw/plugin.d.ts",
  exports: {
    ".": {
      types: "./dist/openclaw/plugin.d.ts",
      default: "./dist/openclaw/plugin.js",
    },
    "./package.json": "./package.json",
  },
  openclaw: {
    ...sourcePackage.openclaw,
    extensions: ["./dist/openclaw/plugin.js"],
  },
  peerDependencies: sourcePackage.peerDependencies,
  peerDependenciesMeta: sourcePackage.peerDependenciesMeta,
  dependencies: sourcePackage.dependencies,
  keywords: Array.from(
    new Set([...(sourcePackage.keywords ?? []).filter((keyword) => keyword !== "cli"), "openclaw-plugin"]),
  ),
};

writeJson(path.join(cliStageDir, "package.json"), cliManifest);
writeJson(path.join(pluginStageDir, "package.json"), pluginManifestPackage);

cpSync(path.join(cliArtifactDir, "dist"), path.join(cliStageDir, "dist"), { recursive: true });
cpSync(path.join(openclawArtifactDir, "dist"), path.join(pluginStageDir, "dist"), { recursive: true });

cpSync(path.join(sourceDir, "README.md"), path.join(cliStageDir, "README.md"));
cpSync(path.join(sourceDir, "README.openclaw.md"), path.join(pluginStageDir, "README.md"));
cpSync(path.join(sourceDir, "CHANGELOG.md"), path.join(cliStageDir, "CHANGELOG.md"));
cpSync(path.join(sourceDir, "CHANGELOG.md"), path.join(pluginStageDir, "CHANGELOG.md"));
cpSync(path.join(repoRoot, "LICENSE"), path.join(cliStageDir, "LICENSE"));
cpSync(path.join(repoRoot, "LICENSE"), path.join(pluginStageDir, "LICENSE"));

copyIfExists(path.join(sourceDir, "skills"), path.join(pluginStageDir, "skills"));

writeJson(path.join(pluginStageDir, "openclaw.plugin.json"), pluginManifest);
writeJson(path.join(pluginStageDir, "dist", "openclaw.plugin.json"), pluginManifest);
