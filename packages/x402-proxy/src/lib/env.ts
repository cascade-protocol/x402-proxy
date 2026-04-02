export function isDebugEnabled(): boolean {
  return process.env.X402_PROXY_DEBUG === "1";
}

export function getMppVoucherHeadroomUsdc(): string | undefined {
  return process.env.X402_PROXY_MPP_VOUCHER_HEADROOM_USDC;
}
