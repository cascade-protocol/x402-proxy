import { spawn } from "node:child_process";
import { buildCommand, type CommandContext } from "@stricli/core";
import { dim, error } from "../lib/output.js";
import { DEFAULT_SURF_UPSTREAM_URL } from "../openclaw/defaults.js";
import { startServeServer } from "./serve.js";

const DEFAULT_MODEL = "minimax/minimax-m2.7";

type ClaudeFlags = {
  model: string;
  upstream: string | undefined;
  protocol: string | undefined;
  network: string | undefined;
  port: string;
  evmKey: string | undefined;
  solanaKey: string | undefined;
};

function normalizeClaudeArgs(args: string[]): string[] {
  return args[0] === "--" ? args.slice(1) : args;
}

export const claudeCommand = buildCommand<ClaudeFlags, string[], CommandContext>({
  docs: {
    brief: "Run Claude Code through a paid local proxy",
    fullDescription: `Start a local x402-proxy server and launch Claude Code with ANTHROPIC_BASE_URL pointed at it.

Examples:
  $ x402-proxy claude
  $ x402-proxy claude --model z-ai/glm-5
  $ x402-proxy claude -- --print "explain this codebase"`,
  },
  parameters: {
    flags: {
      model: {
        kind: "parsed",
        brief: "Model to use (default: minimax/minimax-m2.7)",
        parse: String,
        default: DEFAULT_MODEL,
      },
      upstream: {
        kind: "parsed",
        brief: "Upstream inference URL",
        parse: String,
        optional: true,
      },
      protocol: {
        kind: "parsed",
        brief: "Payment protocol (x402, mpp, auto)",
        parse: String,
        optional: true,
      },
      network: {
        kind: "parsed",
        brief: "Preferred or required network (base, solana, tempo)",
        parse: String,
        optional: true,
      },
      port: {
        kind: "parsed",
        brief: "Proxy listen port (0 = ephemeral)",
        parse: String,
        default: "0",
      },
      evmKey: {
        kind: "parsed",
        brief: "EVM private key (hex)",
        parse: String,
        optional: true,
      },
      solanaKey: {
        kind: "parsed",
        brief: "Solana private key (base58)",
        parse: String,
        optional: true,
      },
    },
    positional: {
      kind: "array",
      parameter: {
        brief: "Arguments to forward to claude",
        parse: String,
      },
    },
  },
  async func(flags, ...rawClaudeArgs) {
    const started = await startServeServer({
      upstreamUrl: flags.upstream ?? DEFAULT_SURF_UPSTREAM_URL,
      port: Number(flags.port),
      protocol: flags.protocol,
      network: flags.network,
      evmKey: flags.evmKey,
      solanaKey: flags.solanaKey,
      quiet: false,
    });

    const claudeArgs = normalizeClaudeArgs(rawClaudeArgs);
    const child = spawn("claude", claudeArgs, {
      stdio: "inherit",
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${started.port}`,
        ANTHROPIC_MODEL: flags.model,
        ANTHROPIC_CUSTOM_MODEL_OPTION: flags.model,
      },
    });

    const stopProxy = async () => {
      await started.close().catch(() => {});
    };

    const forwardSignal = (signal: NodeJS.Signals) => {
      dim(`Forwarding ${signal} to claude...`);
      child.kill(signal);
    };
    const onSigInt = () => forwardSignal("SIGINT");
    const onSigTerm = () => forwardSignal("SIGTERM");
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);

    child.once("error", async (err) => {
      process.off("SIGINT", onSigInt);
      process.off("SIGTERM", onSigTerm);
      await stopProxy();
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        error("Claude Code CLI not found. Install: npm i -g @anthropic-ai/claude-code");
      } else {
        error(err instanceof Error ? err.message : String(err));
      }
      process.exit(1);
    });

    child.once("exit", async (code, signal) => {
      process.off("SIGINT", onSigInt);
      process.off("SIGTERM", onSigTerm);
      await stopProxy();
      if (signal) {
        process.exit(signal === "SIGINT" ? 130 : 143);
      }
      process.exit(code ?? 1);
    });
  },
});
