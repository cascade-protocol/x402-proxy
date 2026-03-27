import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import * as prompts from "@clack/prompts";
import { buildCommand, type CommandContext } from "@stricli/core";
import pc from "picocolors";
import { isConfigured } from "../lib/config.js";
import { resolveWallet } from "../lib/resolve-wallet.js";
import { runSetup } from "./setup.js";
import { fetchAllBalances } from "./wallet.js";

function resolvePlatformPath(raw: string): string {
  let p = raw;
  if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  p = p.replace(/%UserProfile%/gi, homedir());
  p = p.replace(/%AppData%/gi, process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"));
  p = p.replace(
    /%LocalAppData%/gi,
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
  );
  return normalize(p);
}

function parseConfigFile(path: string, format: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) return {};
  if (format === "json" || format === "jsonc") {
    const stripped =
      format === "jsonc" ? raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "") : raw;
    return JSON.parse(stripped);
  }
  // YAML and TOML handled via dynamic imports in the command func
  return JSON.parse(raw);
}

type McpAddFlags = {
  client: string | undefined;
  yes: boolean;
};

export const mcpAddCommand = buildCommand<McpAddFlags, [name: string, url: string], CommandContext>(
  {
    docs: {
      brief: "Add an MCP server to your AI client",
      fullDescription:
        "Add a remote MCP server to Claude Code, Cursor, VS Code, or other AI clients with automatic x402 payment proxy.",
    },
    parameters: {
      flags: {
        client: {
          kind: "parsed",
          brief: "Target client (claude-code, cursor, vscode, etc.)",
          parse: String,
          optional: true,
        },
        yes: {
          kind: "boolean",
          brief: "Skip confirmation prompt",
          default: false,
        },
      },
      positional: {
        kind: "tuple",
        parameters: [
          {
            brief: "Server name",
            parse: String,
          },
          {
            brief: "Remote MCP server URL",
            parse: String,
          },
        ],
      },
    },
    async func(flags, name: string, url: string) {
      prompts.intro(pc.cyan("Add MCP server"));

      // Validate URL
      try {
        new URL(url);
      } catch {
        prompts.log.error(`Invalid URL: ${url}`);
        prompts.cancel("Aborted.");
        process.exit(1);
      }

      const serverName = name;

      // Wallet check first - setup before anything else
      if (!isConfigured()) {
        prompts.log.warn("No wallet configured. Let's set one up first.\n");
        await runSetup();
        console.log();
        prompts.log.step(pc.cyan("Continuing MCP setup..."));
      }

      // Dynamic import to keep startup fast for non-add commands
      const { generators, getAppIds, generateConfig, deepMerge } = await import(
        "@getmcp/generators"
      );
      type AppId = ReturnType<typeof getAppIds>[number];

      // Client selection
      let clientId: AppId;
      if (flags.client) {
        const appIds = getAppIds();
        if (!appIds.includes(flags.client as AppId)) {
          prompts.log.error(`Unknown client: ${flags.client}`);
          prompts.log.info(`Supported: ${appIds.join(", ")}`);
          prompts.cancel("Aborted.");
          process.exit(1);
        }
        clientId = flags.client as AppId;
      } else {
        const appIds = getAppIds();
        const detected = appIds.filter((id) => generators[id].detectInstalled());

        const selected = await prompts.select({
          message: "Where would you like to install the MCP server?",
          options: appIds.map((id) => ({
            value: id,
            label: `${generators[id].app.name}${detected.includes(id) ? pc.dim(" (detected)") : ""}`,
          })),
          initialValue: detected.includes("claude-code" as AppId)
            ? "claude-code"
            : (detected[0] ?? "claude-code"),
        });
        if (prompts.isCancel(selected)) {
          prompts.cancel("Cancelled.");
          process.exit(0);
        }
        clientId = selected as AppId;
      }

      const generator = generators[clientId];

      // Resolve config path (user/global scope)
      const globalPaths = generator.app.globalConfigPaths as Record<string, string> | null;
      const platform = process.platform as string;
      const rawPath = globalPaths?.[platform];
      if (!rawPath) {
        prompts.log.error(`No global config path for ${generator.app.name} on ${platform}`);
        prompts.cancel("Aborted.");
        process.exit(1);
      }
      const configPath = resolvePlatformPath(rawPath);
      const configFormat = generator.app.configFormat as string;

      // Generate config object - inject XDG_CONFIG_HOME if -c was used
      const configDirOverride = process.env.X402_PROXY_CONFIG_DIR_OVERRIDE;
      const serverEnv: Record<string, string> = configDirOverride
        ? { XDG_CONFIG_HOME: configDirOverride }
        : {};
      const generated = generateConfig(clientId, serverName, {
        command: "npx",
        args: ["-y", "x402-proxy", "mcp", url],
        env: serverEnv,
        transport: "stdio",
      });

      // Read existing config
      let existing: Record<string, unknown>;
      if (configFormat === "yaml") {
        const { default: YAML } = await import("yaml");
        if (existsSync(configPath)) {
          const raw = readFileSync(configPath, "utf-8").trim();
          existing = raw ? ((YAML.parse(raw) as Record<string, unknown>) ?? {}) : {};
        } else {
          existing = {};
        }
      } else {
        existing = parseConfigFile(configPath, configFormat);
      }

      // Check for existing server
      const rootKey = Object.keys(generated)[0] ?? "mcpServers";
      const existingServers = (existing[rootKey] ?? {}) as Record<string, unknown>;
      if (existingServers[serverName]) {
        prompts.log.warn(`Server ${pc.bold(serverName)} already exists in config`);
        prompts.log.message(
          pc.dim(JSON.stringify({ [serverName]: existingServers[serverName] }, null, 2)),
        );
        const overwrite = await prompts.confirm({ message: "Overwrite?" });
        if (prompts.isCancel(overwrite) || !overwrite) {
          prompts.cancel("Cancelled.");
          process.exit(0);
        }
      }

      // Show preview
      prompts.log.info(`Config will be added to ${pc.dim(configPath)}`);

      const previewStr = generator.serialize(generated);
      const previewLines = previewStr.split("\n");
      const formatted = previewLines
        .map((line, i) => {
          if (i === 0 || i === previewLines.length - 1) return line;
          const trimmed = line.trimStart();
          if (trimmed.startsWith(`"${rootKey}"`) || trimmed.startsWith(`${rootKey}:`)) return line;
          return `${pc.green("+")} ${line}`;
        })
        .join("\n");
      prompts.log.message(formatted);

      // Confirm
      if (!flags.yes) {
        const proceed = await prompts.confirm({
          message: "Would you like to proceed?",
        });
        if (prompts.isCancel(proceed) || !proceed) {
          prompts.cancel("Cancelled.");
          process.exit(0);
        }
      }

      // Merge and write
      const merged = deepMerge(existing, generated);
      const dir = dirname(configPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const serialized = generator.serialize(merged);
      const content = serialized.endsWith("\n") ? serialized : `${serialized}\n`;
      writeFileSync(configPath, content);

      prompts.log.success(`Added ${pc.bold(serverName)} MCP to ${pc.bold(generator.app.name)}`);

      // Balance check
      const wallet = resolveWallet();
      if (wallet.source !== "none") {
        const balances = await fetchAllBalances(wallet.evmAddress, wallet.solanaAddress);

        const evmUsdc = balances.evm ? Number(balances.evm.usdc) : 0;
        const solUsdc = balances.sol ? Number(balances.sol.usdc) : 0;
        const tempoUsdc = balances.tempo ? Number(balances.tempo.usdc) : 0;

        if (evmUsdc === 0 && solUsdc === 0 && tempoUsdc === 0) {
          prompts.log.warn("Balance: 0 USDC");
          prompts.log.info("To use paid MCP tools, send USDC to your wallet:");
          if (wallet.evmAddress) prompts.log.message(`  Base:   ${pc.cyan(wallet.evmAddress)}`);
          if (wallet.solanaAddress)
            prompts.log.message(`  Solana: ${pc.cyan(wallet.solanaAddress)}`);
        } else {
          const parts: string[] = [];
          if (balances.evm) parts.push(`Base: ${balances.evm.usdc} USDC`);
          if (balances.sol) parts.push(`Solana: ${balances.sol.usdc} USDC`);
          if (balances.tempo) parts.push(`Tempo: ${balances.tempo.usdc} USDC`);
          prompts.log.success(`Balance: ${parts.join(" | ")}`);
        }
      }

      prompts.log.step("Try your first request:");
      prompts.log.message(
        `  ${pc.cyan(`$ npx x402-proxy -X POST -d '{"ref":"CoinbaseDev"}' https://surf.cascade.fyi/api/v1/twitter/user`)}`,
      );
      prompts.log.message(
        `  ${pc.dim("Run")} ${pc.cyan("npx x402-proxy")} ${pc.dim("to see your wallet and balance")}`,
      );

      prompts.outro(pc.green(`MCP server ${pc.bold(serverName)} is ready to use!`));
    },
  },
);
