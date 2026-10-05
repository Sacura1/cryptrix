export function transactionUrl(chainId: number | null | undefined, hash: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return undefined;
  const base =
    chainId === 5042002
      ? 'https://explorer.testnet.arc.io'
      : chainId === 5042
        ? 'https://explorer.arc.io'
        : undefined;
  return base ? `${base}/tx/${hash}` : undefined;
}
