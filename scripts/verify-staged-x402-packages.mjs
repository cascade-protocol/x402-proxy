import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCANNABLE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"]);

const LINE_RULES = [
  {
    ruleId: "dangerous-exec",
    severity: "critical",
    message: "Shell command execution detected (child_process)",
    pattern: /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/,
    requiresContext: /child_process/,
  },
];

const SOURCE_RULES = [
  {
    ruleId: "potential-exfiltration",
    severity: "warn",
    message: "File read combined with network send — possible data exfiltration",
    pattern: /readFileSync|readFile/,
    requiresContext: /\bfetch\b|\bpost\b|http\.request/i,
  },
  {
    ruleId: "env-harvesting",
    severity: "critical",
    message: "Environment variable access combined with network send — possible credential harvesting",
    pattern: /process\.env/,
    requiresContext: /\bfetch\b|\bpost\b|http\.request/i,
  },
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(repoRoot, "packages", "x402-proxy");
const releaseDir = path.join(sourceDir, ".release");
const cliStageDir = path.join(releaseDir, "x402-proxy");
const pluginStageDir = path.join(releaseDir, "x402-proxy-openclaw");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function collectScannableFiles(rootDir) {
  const files = [];

  function walk(dirPath) {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (entry.isFile() && SCANNABLE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return files;
}

function scanSource(filePath, source) {
  const findings = [];
  const lines = source.split("\n");

  for (const rule of LINE_RULES) {
    if (rule.requiresContext && !rule.requiresContext.test(source)) {
      continue;
    }

    for (let index = 0; index < lines.length; index += 1) {
      if (!rule.pattern.test(lines[index])) {
        continue;
      }

      findings.push({
        file: filePath,
        line: index + 1,
        severity: rule.severity,
        ruleId: rule.ruleId,
        message: rule.message,
      });
      break;
    }
  }

  for (const rule of SOURCE_RULES) {
    if (!rule.pattern.test(source)) {
      continue;
    }
    if (rule.requiresContext && !rule.requiresContext.test(source)) {
      continue;
    }

    let line = 1;
    for (let index = 0; index < lines.length; index += 1) {
      if (!rule.pattern.test(lines[index])) {
        continue;
      }
      line = index + 1;
      break;
    }

    findings.push({
      file: filePath,
      line,
      severity: rule.severity,
      ruleId: rule.ruleId,
      message: rule.message,
    });
  }

  return findings;
}

function scanDirectory(rootDir) {
  const findings = [];

  for (const filePath of collectScannableFiles(rootDir)) {
    findings.push(...scanSource(filePath, readFileSync(filePath, "utf8")));
  }

  return findings;
}

function relativeStagePath(filePath) {
  return path.relative(sourceDir, filePath);
}

assert(existsSync(cliStageDir), `CLI stage directory missing: ${cliStageDir}`);
assert(existsSync(pluginStageDir), `Plugin stage directory missing: ${pluginStageDir}`);

const sourcePackage = readJson(path.join(sourceDir, "package.json"));
const cliPackage = readJson(path.join(cliStageDir, "package.json"));
const pluginPackage = readJson(path.join(pluginStageDir, "package.json"));
const pluginManifest = readJson(path.join(pluginStageDir, "openclaw.plugin.json"));

assert(cliPackage.name === "x402-proxy", `Unexpected CLI package name: ${cliPackage.name}`);
assert(pluginPackage.name === "x402-proxy-openclaw", `Unexpected plugin package name: ${pluginPackage.name}`);
assert(
  cliPackage.version === sourcePackage.version && pluginPackage.version === sourcePackage.version,
  `Staged package versions must match source version ${sourcePackage.version}`,
);
assert(pluginManifest.version === sourcePackage.version, "Staged plugin manifest version is out of sync");

assert(Boolean(cliPackage.bin?.["x402-proxy"]), "CLI stage must publish the x402-proxy binary");
assert(!("openclaw" in cliPackage), "CLI stage must not publish OpenClaw package metadata");
assert(!existsSync(path.join(cliStageDir, "openclaw.plugin.json")), "CLI stage must not include openclaw.plugin.json");

assert(!("bin" in pluginPackage), "Plugin stage must not publish CLI binaries");
assert(
  Array.isArray(pluginPackage.openclaw?.extensions) &&
    pluginPackage.openclaw.extensions.includes("./dist/openclaw/plugin.js"),
  "Plugin stage must expose ./dist/openclaw/plugin.js via openclaw.extensions",
);
assert(existsSync(path.join(pluginStageDir, "openclaw.plugin.json")), "Plugin stage must include openclaw.plugin.json");
assert(
  !existsSync(path.join(pluginStageDir, "dist", "bin", "cli.js")),
  "Plugin stage must not contain dist/bin/cli.js",
);

const findings = scanDirectory(pluginStageDir);
const criticalFindings = findings.filter((finding) => finding.severity === "critical");
const warnFindings = findings.filter((finding) => finding.severity === "warn");
const scannedPluginFiles = collectScannableFiles(pluginStageDir).length;

if (warnFindings.length > 0) {
  console.warn("Release verification warnings:");
  for (const finding of warnFindings) {
    console.warn(
      `- ${finding.message} (${relativeStagePath(finding.file)}:${finding.line})`,
    );
  }
}

assert(
  criticalFindings.length === 0,
  [
    "Staged OpenClaw package still triggers critical scan findings:",
    ...criticalFindings.map(
      (finding) => `- ${finding.message} (${relativeStagePath(finding.file)}:${finding.line})`,
    ),
  ].join("\n"),
);

console.log(
  JSON.stringify(
    {
      cliPackage: cliPackage.name,
      pluginPackage: pluginPackage.name,
      version: sourcePackage.version,
      scannedPluginFiles,
      criticalFindings: criticalFindings.length,
      warnFindings: warnFindings.length,
    },
    null,
    2,
  ),
);
