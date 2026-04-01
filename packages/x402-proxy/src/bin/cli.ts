import { resolve } from "node:path";
import { run } from "@stricli/core";
import { app } from "../app.js";
import { buildContext } from "../context.js";

// Pre-process args before Stricli parses them
const rawArgs = process.argv.slice(2);
const args: string[] = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  // Stricli reserves -H for --help-all. Support curl-style -H for headers.
  if (a === "-H") {
    args.push("--header");
  } else if ((a === "--config-dir" || a === "-c") && i + 1 < rawArgs.length) {
    // Global flag: override config directory for all commands
    const dir = resolve(rawArgs[++i]);
    process.env.XDG_CONFIG_HOME = dir;
    process.env.X402_PROXY_CONFIG_DIR_OVERRIDE = dir;
  } else if (a.startsWith("--config-dir=")) {
    const dir = resolve(a.slice("--config-dir=".length));
    process.env.XDG_CONFIG_HOME = dir;
    process.env.X402_PROXY_CONFIG_DIR_OVERRIDE = dir;
  } else if (a === "--debug") {
    process.env.X402_PROXY_DEBUG = "1";
  } else {
    args.push(a);
  }
}

const topLevelCommand = args[0];
if (topLevelCommand !== "serve" && topLevelCommand !== "claude") {
  // Ensure Ctrl+C always exits cleanly (raw mode from @clack/prompts can swallow SIGINT)
  process.on("SIGINT", () => process.exit(130));
}

await run(app, args, buildContext(process));
