import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type ProxyConfig = {
  defaultNetwork?: string;
  preferredProtocol?: "x402" | "mpp";
  mppSessionBudget?: string;
  spendLimitDaily?: number;
  spendLimitPerTx?: number;
};

export type WalletFile = {
  version: 1;
  mnemonic: string;
  addresses: {
    evm: string;
    solana: string;
  };
};

const APP_NAME = "x402-proxy";

export function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, APP_NAME);
}

/** Config dir with $HOME replaced by ~ for display */
export function getConfigDirShort(): string {
  const dir = getConfigDir();
  const home = os.homedir();
  return dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}

export function getWalletPath(): string {
  return path.join(getConfigDir(), "wallet.json");
}

export function getHistoryPath(): string {
  return path.join(getConfigDir(), "history.jsonl");
}

export function ensureConfigDir(): void {
  fs.mkdirSync(getConfigDir(), { recursive: true });
}

export function loadWalletFile(): WalletFile | null {
  const p = getWalletPath();
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (data.version === 1 && typeof data.mnemonic === "string") return data as WalletFile;
    return null;
  } catch {
    return null;
  }
}

export function saveWalletFile(wallet: WalletFile): void {
  ensureConfigDir();
  fs.writeFileSync(getWalletPath(), JSON.stringify(wallet, null, 2), {
    mode: 0o600,
    encoding: "utf-8",
  });
}

export function loadConfig(): ProxyConfig | null {
  const dir = getConfigDir();
  const candidates = ["config.yaml", "config.yml", "config.jsonc", "config.json"];

  for (const name of candidates) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, "utf-8");
      if (name.endsWith(".yaml") || name.endsWith(".yml")) {
        return parseYaml(raw) as ProxyConfig;
      }
      // JSONC: strip // and /* */ comments before parsing
      if (name.endsWith(".jsonc")) {
        const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
        return JSON.parse(stripped) as ProxyConfig;
      }
      return JSON.parse(raw) as ProxyConfig;
    } catch {}
  }
  return null;
}

export function saveConfig(config: ProxyConfig): void {
  ensureConfigDir();
  const p = path.join(getConfigDir(), "config.yaml");
  fs.writeFileSync(p, stringifyYaml(config), "utf-8");
}

// --- MPP session persistence ---

export type StoredSession = {
  channelId: string;
  createdAt: string;
};

export function getSessionPath(): string {
  return path.join(getConfigDir(), "session.json");
}

export function loadStoredSession(): StoredSession | null {
  const p = getSessionPath();
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (typeof data.channelId === "string") return data as StoredSession;
    return null;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  ensureConfigDir();
  fs.writeFileSync(getSessionPath(), JSON.stringify(session, null, 2), "utf-8");
}

export function clearSession(): void {
  try {
    fs.unlinkSync(getSessionPath());
  } catch {
    // file may not exist
  }
}

export function isConfigured(): boolean {
  if (process.env.X402_PROXY_WALLET_MNEMONIC) return true;
  if (process.env.X402_PROXY_WALLET_EVM_KEY) return true;
  if (process.env.X402_PROXY_WALLET_SOLANA_KEY) return true;
  return loadWalletFile() !== null;
}
