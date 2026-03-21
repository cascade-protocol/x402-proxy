import { buildCommand, type CommandContext } from "@stricli/core";
import pc from "picocolors";
import { getConfigDirShort, loadConfig, type ProxyConfig, saveConfig } from "../lib/config.js";
import { dim, error } from "../lib/output.js";

const VALID_KEYS: Record<
  keyof ProxyConfig,
  { description: string; parse: (v: string) => unknown }
> = {
  defaultNetwork: {
    description: "Preferred network (base, solana, tempo)",
    parse: (v) => {
      if (!["base", "solana", "tempo"].includes(v)) {
        throw new Error("Must be one of: base, solana, tempo");
      }
      return v;
    },
  },
  preferredProtocol: {
    description: "Payment protocol (x402, mpp)",
    parse: (v) => {
      if (!["x402", "mpp"].includes(v)) {
        throw new Error("Must be one of: x402, mpp");
      }
      return v;
    },
  },
  mppSessionBudget: {
    description: "Max USDC per MPP session (default: 1)",
    parse: (v) => {
      const n = Number(v);
      if (Number.isNaN(n) || n <= 0) throw new Error("Must be a positive number");
      return v;
    },
  },
  spendLimitDaily: {
    description: "Daily spending limit in USDC",
    parse: (v) => {
      const n = Number(v);
      if (Number.isNaN(n) || n <= 0) throw new Error("Must be a positive number");
      return n;
    },
  },
  spendLimitPerTx: {
    description: "Per-transaction spending limit in USDC",
    parse: (v) => {
      const n = Number(v);
      if (Number.isNaN(n) || n <= 0) throw new Error("Must be a positive number");
      return n;
    },
  },
};

function isConfigKey(k: string): k is keyof ProxyConfig {
  return k in VALID_KEYS;
}

export const configShowCommand = buildCommand({
  docs: {
    brief: "Show current configuration",
  },
  parameters: {
    flags: {},
    positional: { kind: "tuple", parameters: [] },
  },
  async func() {
    const config = loadConfig();

    console.log();
    console.log(pc.bold("Configuration"));
    dim(`  ${getConfigDirShort()}/config.yaml`);
    console.log();

    if (!config || Object.keys(config).length === 0) {
      dim("  No configuration set. Using defaults.");
      console.log();
      dim("  Available keys:");
      for (const [key, meta] of Object.entries(VALID_KEYS)) {
        dim(`    ${pc.cyan(key)} - ${meta.description}`);
      }
      console.log();
      dim(`  Set with: ${pc.cyan("npx x402-proxy config set <key> <value>")}`);
      console.log();
      return;
    }

    for (const key of Object.keys(VALID_KEYS)) {
      const value = config[key as keyof ProxyConfig];
      if (value !== undefined) {
        console.log(`  ${pc.cyan(key)}: ${pc.green(String(value))}`);
      } else {
        dim(`  ${key}: ${pc.dim("(not set)")}`);
      }
    }
    console.log();
  },
});

export const configSetCommand = buildCommand<
  Record<string, never>,
  [key: string, value: string],
  CommandContext
>({
  docs: {
    brief: "Set a configuration value",
    fullDescription: `Set a configuration value.

Available keys:
${Object.entries(VALID_KEYS)
  .map(([k, v]) => `  ${k} - ${v.description}`)
  .join("\n")}

To unset a value, use: npx x402-proxy config unset <key>`,
  },
  parameters: {
    flags: {},
    positional: {
      kind: "tuple",
      parameters: [
        { brief: "Configuration key", parse: String },
        { brief: "Value to set", parse: String },
      ],
    },
  },
  async func(_flags, key: string, value: string) {
    if (!isConfigKey(key)) {
      error(`Unknown config key: ${key}`);
      console.error();
      dim("  Available keys:");
      for (const [k, m] of Object.entries(VALID_KEYS)) {
        dim(`    ${pc.cyan(k)} - ${m.description}`);
      }
      process.exit(1);
    }

    const meta = VALID_KEYS[key];
    let parsed: unknown;
    try {
      parsed = meta.parse(value);
    } catch (err) {
      error(`Invalid value for ${key}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const config = loadConfig() ?? {};
    (config as Record<string, unknown>)[key] = parsed;
    saveConfig(config);

    console.log(`  ${pc.cyan(key)} = ${pc.green(String(parsed))}`);
  },
});

export const configUnsetCommand = buildCommand<
  Record<string, never>,
  [key: string],
  CommandContext
>({
  docs: {
    brief: "Unset a configuration value",
  },
  parameters: {
    flags: {},
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Configuration key to remove", parse: String }],
    },
  },
  async func(_flags, key: string) {
    if (!isConfigKey(key)) {
      error(`Unknown config key: ${key}`);
      process.exit(1);
    }

    const config = loadConfig() ?? {};
    delete config[key];
    saveConfig(config);

    dim(`  ${key} unset`);
  },
});
