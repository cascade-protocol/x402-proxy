import pc from "picocolors";

export function isTTY(): boolean {
  return !!process.stderr.isTTY;
}

export function info(msg: string): void {
  process.stderr.write(`${isTTY() ? pc.cyan(msg) : msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`${isTTY() ? pc.yellow(msg) : msg}\n`);
}

export function error(msg: string): void {
  process.stderr.write(`${isTTY() ? pc.red(msg) : msg}\n`);
}

export function dim(msg: string): void {
  process.stderr.write(`${isTTY() ? pc.dim(msg) : msg}\n`);
}

export function success(msg: string): void {
  process.stderr.write(`${isTTY() ? pc.green(msg) : msg}\n`);
}
