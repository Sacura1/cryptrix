import type { Config, Transaction } from '../types';
export function amount(value: string, min = '0.1', max = '10') {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value))
    throw new Error('Use a positive amount with at most six decimal places.');
  const units = (v: string) => {
    const [whole, fraction = ''] = v.split('.');
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  };
  const result = units(value);
  if (result < units(min) || result > units(max))
    throw new Error(`Amount must be between ${min} and ${max} USDC.`);
  return value;
}
export function guardTransaction(
  tx: Transaction,
  config: Config | undefined,
  owner: string | undefined,
  practiceWallet: boolean,
) {
  if (!owner || practiceWallet || config?.mode !== 'paid')
    throw new Error('Connect a real owner wallet to the paid environment.');
  if (tx.chainId !== config.chainId || ![5042, 5042002].includes(tx.chainId))
    throw new Error('The transaction network does not match the configured Arc network.');
  if (tx.fromAccount.toLowerCase() !== owner.toLowerCase())
    throw new Error(
      'This transaction must be signed by the agent wallet. Use your external agent runtime.',
    );
  if (tx.value !== '0')
    throw new Error('Unexpected native transfer. Review the transaction with the operator.');
  if (!/^0x[\da-fA-F]{40}$/.test(tx.to) || !/^0x(?:[\da-fA-F]{2})*$/.test(tx.data))
    throw new Error('The transaction plan is invalid.');
}
