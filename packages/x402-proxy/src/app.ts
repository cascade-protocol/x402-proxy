import { buildApplication, buildRouteMap } from "@stricli/core";
import { fetchCommand } from "./commands/fetch.js";
import { mcpCommand } from "./commands/mcp.js";
import { setupCommand } from "./commands/setup.js";
import { statusCommand } from "./commands/status.js";
import { walletInfoCommand } from "./commands/wallet.js";
import { walletHistoryCommand } from "./commands/wallet-history.js";
import { walletFundCommand } from "./commands/wallet-fund.js";
import { walletExportCommand } from "./commands/wallet-export.js";

const walletRoutes = buildRouteMap({
  routes: {
    info: walletInfoCommand,
    history: walletHistoryCommand,
    fund: walletFundCommand,
    "export-key": walletExportCommand,
  },
  defaultCommand: "info",
  docs: {
    brief: "Wallet management",
  },
});

const routes = buildRouteMap({
  routes: {
    fetch: fetchCommand,
    mcp: mcpCommand,
    wallet: walletRoutes,
    setup: setupCommand,
    status: statusCommand,
  },
  defaultCommand: "fetch",
  docs: {
    brief: "x402 payment proxy - pay for any x402 resource",
  },
});

export const app = buildApplication(routes, {
  name: "x402-proxy",
  versionInfo: {
    currentVersion: "0.2.0",
  },
  scanner: {
    caseStyle: "allow-kebab-for-camel",
  },
});
