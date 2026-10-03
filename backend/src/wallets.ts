import { encodeFunctionData, formatUnits, getAddress, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { GAME_IDS, parseUsdc, requireThat, type Agent } from './domain.js';
import { USDC, type ArcGateway, type TransactionIntent } from './chain.js';

const factoryAbi = parseAbi([
  'function predict(address owner,bytes32 salt) view returns (address)',
  'function isAccount(address) view returns (bool)',
  'function create(address owner,bytes32 salt) returns (address)',
]);
export const walletAbi = parseAbi([
  'function owner() view returns (address)',
  'function policy() view returns (address key,uint256 maxStake,uint256 dailyBudget,uint32 gamesPerDay,uint64 expiresAt,uint8 gameMask)',
  'function dailyUsage(uint256) view returns (uint256 stake,uint32 games)',
  'function activeMatch() view returns (bytes32)',
  'function setPolicy((address key,uint256 maxStake,uint256 dailyBudget,uint32 gamesPerDay,uint64 expiresAt,uint8 gameMask) next)',
  'function revoke()', 'function withdraw(uint256 amount)', 'function claim()',
  'function cancelExpired(bytes32 id)', 'function cancelUnfilled(bytes32 id)',
]);
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address to,uint256 amount) returns (bool)']);
const creditAbi = parseAbi(['function credits(address) view returns (uint256)']);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const walletOperation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('fund'), amount: z.string() }).strict(),
  z.object({ operation: z.literal('withdraw'), amount: z.string() }).strict(),
  z.object({ operation: z.literal('authorize'), key: address }).strict(),
  z.object({ operation: z.literal('revoke') }).strict(),
  z.object({ operation: z.literal('claim') }).strict(),
  z.object({ operation: z.literal('cancel-expired'), matchId: bytes32 }).strict(),
  z.object({ operation: z.literal('cancel-unfilled'), matchId: bytes32 }).strict(),
]);
export type WalletOperation = z.infer<typeof walletOperation>;
export interface WalletGateway {
  creation(owner: string, salt: Hex): Promise<{ account: string; alreadyCreated: boolean; transactions: TransactionIntent[] }>;
  status(agent: Agent, now: number): Promise<unknown>;
  operation(agent: Agent, input: WalletOperation, now: number): Promise<{ transactions: TransactionIntent[]; notice: string }>;
}
export class ArcWallets implements WalletGateway {
  constructor(private readonly chain: ArcGateway, private readonly factory?: Address) {}
  private intent(owner: string, to: string, data: Hex, purpose: string, amountUnits?: string): TransactionIntent {
    return { chainId: this.chain.chainId, fromAccount: owner, to, data, value: '0', purpose, ...(amountUnits === undefined ? {} : { amountUnits }) };
  }
  async creation(owner: string, salt: Hex) {
    requireThat(this.factory, 'ACCOUNT_FACTORY_REQUIRED', 'Configure the agent-account factory before creating accounts.', 503);
    const walletOwner = getAddress(owner);
    const account = await this.chain.client.readContract({ address: this.factory, abi: factoryAbi, functionName: 'predict', args: [walletOwner, salt] });
    const alreadyCreated = await this.chain.client.readContract({ address: this.factory, abi: factoryAbi, functionName: 'isAccount', args: [account] });
    if (alreadyCreated) await this.chain.verifyHostedAccount(account, owner);
    return { account, alreadyCreated, transactions: alreadyCreated ? [] : [this.intent(owner, this.factory, encodeFunctionData({ abi: factoryAbi, functionName: 'create', args: [walletOwner, salt] }), 'Create a fixed agent account owned by your connected wallet. No delegated permission is granted yet.')] };
  }
  private async verify(agent: Agent) {
    requireThat(agent.kind === 'hosted', 'NOT_HOSTED', 'External agents manage their own wallet through their runtime.', 400);
    await this.chain.verifyHostedAccount(agent.wallet, agent.owner);
  }
  async status(agent: Agent, now: number) {
    await this.verify(agent);
    const account = getAddress(agent.wallet);
    // Read a single block so balances, policy and counters cannot come from different heads.
    const block = await this.chain.client.getBlock();
    const blockNumber = block.number;
    const [balance, credit, policy, usage, activeMatch] = await Promise.all([
      this.chain.client.readContract({ address: USDC, abi: tokenAbi, functionName: 'balanceOf', args: [account], blockNumber }),
      this.chain.client.readContract({ address: this.chain.escrow, abi: creditAbi, functionName: 'credits', args: [account], blockNumber }),
      this.chain.client.readContract({ address: account, abi: walletAbi, functionName: 'policy', blockNumber }),
      this.chain.client.readContract({ address: account, abi: walletAbi, functionName: 'dailyUsage', args: [block.timestamp / 86_400n], blockNumber }),
      this.chain.client.readContract({ address: account, abi: walletAbi, functionName: 'activeMatch', blockNumber }),
    ]);
    return { chainId: this.chain.chainId, account, owner: agent.owner, blockNumber: String(blockNumber), balanceUsdc: formatUnits(balance, 6), claimableUsdc: formatUnits(credit, 6), policy: { key: policy[0], maxStake: formatUnits(policy[1], 6), dailyStake: formatUnits(policy[2], 6), gamesPerDay: policy[3], expiresAt: Number(policy[4]) * 1000, allowedGames: GAME_IDS.filter((_, i) => policy[5] & (1 << i)), revoked: policy[0] === zeroAddress }, onChainUsage: { grossStake: formatUnits(usage[0], 6), games: usage[1] }, activeMatch, notice: 'Balance excludes unclaimed escrow credits. This reads the single six-decimal USDC balance; native gas is the same asset. Platform limits and wallet policy are independent.' };
  }
  async operation(agent: Agent, input: WalletOperation, now: number) {
    await this.verify(agent);
    const account = getAddress(agent.wallet);
    let data: Hex, target: Address = account, amountUnits: string | undefined;
    let notice = 'Your owner wallet must review and sign. This API does not submit the transaction.';
    if (input.operation === 'fund' || input.operation === 'withdraw') {
      const amount = parseUsdc(input.amount);
      requireThat(amount > 0 && amount <= 1_000_000_000, 'FUNDING_RANGE', 'Amount must be greater than zero and at most 1000 USDC.', 400);
      amountUnits = String(amount);
      if (input.operation === 'fund') { target = USDC; data = encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [account, BigInt(amount)] }); }
      else data = encodeFunctionData({ abi: walletAbi, functionName: 'withdraw', args: [BigInt(amount)] });
    } else if (input.operation === 'authorize') {
      const key = getAddress(input.key), limits = agent.limits;
      requireThat(key !== zeroAddress && key.toLowerCase() !== agent.owner.toLowerCase() && key.toLowerCase() !== agent.wallet.toLowerCase(), 'INVALID_SESSION_KEY', 'Use a distinct restricted agent signing address, not the owner or account address.', 400);
      const expiresAt = Math.floor(limits.expiresAt / 1000);
      requireThat(expiresAt > Math.floor(now / 1000) && expiresAt <= Math.floor(now / 1000) + 30 * 86_400, 'INVALID_EXPIRY', 'Choose unexpired permissions within thirty days.', 400);
      const gameMask = limits.allowedGames.reduce((mask, game) => mask | (1 << GAME_IDS.indexOf(game)), 0);
      data = encodeFunctionData({ abi: walletAbi, functionName: 'setPolicy', args: [{ key, maxStake: BigInt(limits.maxStake), dailyBudget: BigInt(limits.dailyStake), gamesPerDay: limits.gamesPerDay, expiresAt: BigInt(expiresAt), gameMask }] });
      notice = 'This grants the specified agent key create/join authority under the current platform limits. It cannot withdraw or execute arbitrary calls. Usage survives key rotation. Owner signs; a platform limit change alone does not change this policy.';
    } else if (input.operation === 'cancel-expired' || input.operation === 'cancel-unfilled') {
      data = encodeFunctionData({ abi: walletAbi, functionName: input.operation === 'cancel-expired' ? 'cancelExpired' : 'cancelUnfilled', args: [input.matchId as Hex] });
    } else data = encodeFunctionData({ abi: walletAbi, functionName: input.operation === 'revoke' ? 'revoke' : 'claim' });
    return { transactions: [this.intent(agent.owner, target, data, input.operation, amountUnits)], notice };
  }
}
