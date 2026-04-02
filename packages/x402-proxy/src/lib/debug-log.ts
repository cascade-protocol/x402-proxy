import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { ensureConfigDir, getDebugLogPath } from "./config.js";

const MAX_DEBUG_LOG_BYTES = 10 * 1024 * 1024;
const ROTATED_DEBUG_LOG_SUFFIX = ".1";

export type DebugLogFields = Record<string, string | number | boolean | null | undefined>;

function rotateIfNeeded(path: string): void {
  if (!existsSync(path)) return;
  const { size } = statSync(path);
  if (size <= MAX_DEBUG_LOG_BYTES) return;

  const rotated = `${path}${ROTATED_DEBUG_LOG_SUFFIX}`;
  try {
    rmSync(rotated, { force: true });
  } catch {
    // best effort
  }
  renameSync(path, rotated);
}

export function writeDebugLog(event: string, fields: DebugLogFields = {}): void {
  try {
    ensureConfigDir();
    const path = getDebugLogPath();
    rotateIfNeeded(path);
    appendFileSync(
      path,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...fields,
      })}\n`,
      "utf-8",
    );
  } catch {
    // Debug logging must never break the proxy
  }
}
