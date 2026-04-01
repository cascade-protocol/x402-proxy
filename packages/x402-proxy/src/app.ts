declare const __VERSION__: string;

import { buildApplication, buildRouteMap } from "@stricli/core";
import { claudeCommand } from "./commands/claude.js";
import { configSetCommand, configShowCommand, configUnsetCommand } from "./commands/config.js";
import { fetchCommand } from "./commands/fetch.js";
import { mcpCommand } from "./commands/mcp.js";
import { mcpAddCommand } from "./commands/mcp-add.js";
import { serveCommand } from "./commands/serve.js";
import { setupCommand } from "./commands/setup.js";
import { statusCommand } from "./commands/status.js";
import { walletInfoCommand } from "./commands/wallet.js";
import { walletExportCommand } from "./commands/wallet-export.js";
import { walletHistoryCommand } from "./commands/wallet-history.js";

const walletRoutes = buildRouteMap({
  routes: {
    info: walletInfoCommand,
    history: walletHistoryCommand,
    "export-key": walletExportCommand,
  },
  defaultCommand: "info",
  docs: {
    brief: "Wallet management",
  },
});

const configRoutes = buildRouteMap({
  routes: {
    show: configShowCommand,
    set: configSetCommand,
    unset: configUnsetCommand,
  },
  defaultCommand: "show",
  docs: {
    brief: "Manage configuration",
  },
});

const mcpRoutes = buildRouteMap({
  routes: {
    proxy: mcpCommand,
    add: mcpAddCommand,
  },
  defaultCommand: "proxy",
  docs: {
    brief: "MCP proxy and management",
  },
});

const routes = buildRouteMap({
  routes: {
    fetch: fetchCommand,
    serve: serveCommand,
    claude: claudeCommand,
    mcp: mcpRoutes,
    wallet: walletRoutes,
    config: configRoutes,
    setup: setupCommand,
    status: statusCommand,
  },
  defaultCommand: "fetch",
  docs: {
    brief: "curl for x402 paid APIs",
  },
});

export const app = buildApplication(routes, {
  name: "x402-proxy",
  versionInfo: {
    currentVersion: __VERSION__,
  },
  scanner: {
    caseStyle: "allow-kebab-for-camel",
  },
});
