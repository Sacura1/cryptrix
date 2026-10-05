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
