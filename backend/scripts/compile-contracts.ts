import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import type { Abi, Hex } from 'viem';

export interface Artifact { abi: Abi; bytecode: Hex }
export function compileContracts(): Record<string, Artifact> {
  const sources = Object.fromEntries(['GameEscrow.sol', 'test/MockUSDC.sol'].filter(name => existsSync(`contracts/${name}`)).map(name => [`contracts/${name}`, { content: readFileSync(`contracts/${name}`, 'utf8').replace(/\r\n/g, '\n') }]));
  const result = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: {
    // OpenZeppelin's current libraries use MCOPY. Arc's Osaka baseline supports Cancun.
    evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 }, viaIR: true,
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  } }), { import: (path: string) => {
    try { return { contents: readFileSync(resolve('node_modules', path), 'utf8').replace(/\r\n/g, '\n') }; }
    catch { return { error: `Import not found: ${path}` }; }
  } }));
  const errors = (result.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'));
  const artifacts: Record<string, Artifact> = {};
  for (const contracts of Object.values(result.contracts) as Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>[]) {
    for (const [name, contract] of Object.entries(contracts)) if (contract.evm.bytecode.object) artifacts[name] = { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
  }
  return artifacts;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync('artifacts', { recursive: true });
  const artifacts = compileContracts();
  for (const [name, artifact] of Object.entries(artifacts)) writeFileSync(`artifacts/${name}.json`, JSON.stringify(artifact, null, 2));
  console.log(`Compiled ${Object.keys(artifacts).join(', ')} with Solidity ${solc.version()}.`);
}
