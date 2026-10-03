import { createPublicClient, decodeEventLog, encodeFunctionData, getAddress, http, parseAbi, type Address, type Hex } from 'viem';
import { arc, arcTestnet } from 'viem/chains';
import { digest, equipmentCommitment, Fault, PLAY_SECONDS, requireThat, type Agent, type Match } from './domain.js';
import { defaultEquipment } from './engine.js';
import { ArcWallets, type WalletGateway } from './wallets.js';

export const USDC = '0x3600000000000000000000000000000000000000' as const;
export const escrowAbi = parseAbi([
  'function usdc() view returns (address)',
  'function resolver() view returns (address)',
  'function DEFAULT_EQUIPMENT() view returns (bytes32)',
  'function getMatch(bytes32 id) view returns (uint8 game,uint256 stake,uint8 status,uint8 filled,uint64 fillDeadline,uint64 resolveDeadline,bytes32 rulesHash)',
  'function participants(bytes32 id) view returns (address[])',
  'function getResult(bytes32 id) view returns (bytes32 resultHash,uint8[] rankGroups)',
  'function createMatch(bytes32 id,uint8 game,uint256 stake,uint64 fillDeadline,uint32 playSeconds,bytes32 rulesHash)',
  'function joinMatch(bytes32 id,uint256 expectedStake)',
  'function createMatchWithEquipment(bytes32 id,uint8 game,uint256 stake,uint64 fillDeadline,uint32 playSeconds,bytes32 rulesHash,bytes32 equipmentCommitment)',
  'function joinMatchWithEquipment(bytes32 id,uint256 expectedStake,bytes32 equipmentCommitment)',
  'function equipmentCommitments(bytes32 id,address entrant) view returns (bytes32)',
  'function settleMatch(bytes32 id,uint8[] rankGroups,bytes32 resultHash)',
  'function cancelExpired(bytes32 id)',
  'function cancelUnfilled(bytes32 id)',
  'function claim()',
  'event MatchCreated(bytes32 indexed id,address indexed creator,uint8 game,uint256 stake,bytes32 rulesHash)',
  'event MatchJoined(bytes32 indexed id,address indexed entrant,uint8 slot)',
  'event MatchStarted(bytes32 indexed id,uint64 resolveDeadline)',
  'event EquipmentCommitted(bytes32 indexed id,address indexed entrant,bytes32 commitment)',
  'event MatchSettled(bytes32 indexed id,bytes32 resultHash,uint8[] rankGroups)',
  'event MatchCancelled(bytes32 indexed id)',
  'event CreditClaimed(address indexed account,uint256 amount)',
]);
export const accountAbi = parseAbi([
  'function claim()',
  'function owner() view returns (address)',
  'function escrow() view returns (address)',
  'function policy() view returns (address key,uint256 maxStake,uint256 dailyBudget,uint32 gamesPerDay,uint64 expiresAt,uint8 gameMask)',
  'function createMatch(bytes32 id,uint8 game,uint256 stake,uint64 fillDeadline,uint32 playSeconds,bytes32 rulesHash)',
  'function joinMatch(bytes32 id,uint256 expectedStake)',
  'function createMatchWithEquipment(bytes32 id,uint8 game,uint256 stake,uint64 fillDeadline,uint32 playSeconds,bytes32 rulesHash,bytes32 equipmentCommitment)',
  'function joinMatchWithEquipment(bytes32 id,uint256 expectedStake,bytes32 equipmentCommitment)',
]);
const factoryAbi = parseAbi(['function escrow() view returns (address)', 'function isAccount(address) view returns (bool)']);
const tokenAbi = parseAbi(['function approve(address spender,uint256 amount) returns (bool)']);
export interface TransactionIntent { chainId: number; fromAccount: string; to: string; data: Hex; value: '0'; amountUnits?: string; purpose: string }
export interface ChainSnapshot { status: number; participants: string[]; resolveDeadline: number; resultHash?: Hex; ranks?: readonly number[]; equipment?: Record<string, Hex>; enteredAt?: Record<string, number> }
export interface ChainGateway {
  chainId: number; escrow: Address;
  wallets?: WalletGateway;
  verifySignature(wallet: string, message: string, signature: Hex): Promise<boolean>;
  verifyHostedAccount(wallet: string, owner: string): Promise<void>;
  prepare(match: Match, agent: Agent, create: boolean, equipment?: import('./domain.js').Equipment, equipmentSalt?: string): TransactionIntent[];
  confirm(match: Match, wallet: string, hash: Hex): Promise<ChainSnapshot>;
  snapshot(match: Match): Promise<ChainSnapshot>;
  settlement(match: Match): TransactionIntent;
}
export class ArcGateway implements ChainGateway {
  readonly client;
  readonly chainId: number;
  readonly wallets: WalletGateway;
  resolver?: Address;
  constructor(public escrow: Address, network: 'mainnet' | 'testnet', rpc?: string, private factory?: Address) {
    const chain = network === 'mainnet' ? arc : arcTestnet;
    this.chainId = chain.id;
    this.client = createPublicClient({ chain, transport: http(rpc, { timeout: 15_000, retryCount: 1 }) });
    this.wallets = new ArcWallets(this, factory);
  }
  async initialise(): Promise<void> {
    const actual = await this.client.getChainId();
    requireThat(actual === this.chainId, 'WRONG_CHAIN', 'RPC network does not match configured Arc network.', 503);
    const token = await this.client.readContract({ address: this.escrow, abi: escrowAbi, functionName: 'usdc' });
    requireThat(token.toLowerCase() === USDC.toLowerCase(), 'WRONG_TOKEN', 'Escrow must use the Arc USDC ERC-20 interface.', 503);
    const equipment = await this.client.readContract({ address: this.escrow, abi: escrowAbi, functionName: 'DEFAULT_EQUIPMENT' });
    requireThat(equipment === digest(defaultEquipment), 'ESCROW_VERSION', 'Escrow equipment commitments do not match this backend release.', 503);
    this.resolver = await this.client.readContract({ address: this.escrow, abi: escrowAbi, functionName: 'resolver' });
    if (this.factory) {
      const escrow = await this.client.readContract({ address: this.factory, abi: factoryAbi, functionName: 'escrow' });
      requireThat(escrow.toLowerCase() === this.escrow.toLowerCase(), 'WRONG_FACTORY', 'Account factory uses a different escrow.', 503);
    }
  }
  async verifySignature(wallet: string, message: string, signature: Hex): Promise<boolean> {
    return this.client.verifyMessage({ address: getAddress(wallet), message, signature });
  }
  async verifyHostedAccount(wallet: string, owner: string): Promise<void> {
    requireThat(this.factory, 'ACCOUNT_FACTORY_REQUIRED', 'Configure the audited account factory before linking paid hosted accounts.', 503);
    const isAccount = await this.client.readContract({ address: this.factory, abi: factoryAbi, functionName: 'isAccount', args: [getAddress(wallet)] });
    requireThat(isAccount, 'INVALID_AGENT_ACCOUNT', 'Hosted wallet was not created by the configured agent-account factory.', 400);
    const actualOwner = await this.client.readContract({ address: getAddress(wallet), abi: accountAbi, functionName: 'owner' });
    requireThat(actualOwner.toLowerCase() === owner.toLowerCase(), 'WALLET_NOT_OWNED', 'This owner does not control the agent account.', 403);
  }
  prepare(match: Match, agent: Agent, create: boolean, equipment = defaultEquipment, equipmentSalt?: string): TransactionIntent[] {
    const delegated = agent.kind === 'hosted';
    const target = delegated ? getAddress(agent.wallet) : this.escrow;
    const abi = delegated ? accountAbi : escrowAbi;
    const commitment = equipmentCommitment(equipment, equipmentSalt);
    const data = create ? encodeFunctionData({ abi, functionName: 'createMatchWithEquipment', args: [match.id, match.game === 'flux-duel' ? 0 : 1, BigInt(match.stake), BigInt(Math.floor(match.fillDeadline / 1000)), PLAY_SECONDS, match.rulesHash, commitment] }) : encodeFunctionData({ abi, functionName: 'joinMatchWithEquipment', args: [match.id, BigInt(match.stake), commitment] });
    const transactions: TransactionIntent[] = [];
    if (!delegated) transactions.push({ chainId: this.chainId, fromAccount: agent.wallet, to: USDC, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [this.escrow, BigInt(match.stake)] }), value: '0', amountUnits: String(match.stake), purpose: 'Approve this exact entry stake, not an unlimited allowance.' });
    transactions.push({ chainId: this.chainId, fromAccount: agent.wallet, to: target, data, value: '0', amountUnits: String(match.stake), purpose: delegated ? 'The authorised agent key signs this restricted account call; its wallet pays transaction gas separately.' : create ? 'Create and fund the match.' : 'Join and fund the match.' });
    return transactions;
  }
  async confirm(match: Match, wallet: string, hash: Hex): Promise<ChainSnapshot> {
    const receipt = await this.client.getTransactionReceipt({ hash });
    requireThat(receipt.status === 'success', 'TRANSACTION_FAILED', 'Entry transaction failed.', 400);
    const event = receipt.logs.some(log => {
      if (log.address.toLowerCase() !== this.escrow.toLowerCase()) return false;
      try {
        const decoded = decodeEventLog({ abi: escrowAbi, eventName: 'MatchJoined', data: log.data, topics: log.topics });
        return decoded.args.id.toLowerCase() === match.id.toLowerCase() && decoded.args.entrant.toLowerCase() === wallet.toLowerCase();
      } catch { return false; }
    });
    requireThat(event, 'INVALID_RECEIPT', 'Receipt contains no matching escrow entry for this wallet.', 400);
    const snapshot = await this.snapshot(match);
    if (receipt.blockNumber !== undefined && receipt.blockNumber !== null) {
      const block = await this.client.getBlock({ blockNumber: receipt.blockNumber });
      snapshot.enteredAt = { ...snapshot.enteredAt, [wallet.toLowerCase()]: Number(block.timestamp) * 1000 };
    }
    requireThat(snapshot.status !== 0 && snapshot.participants.includes(wallet.toLowerCase()), 'INVALID_RECEIPT_STATE', 'Confirmed entry is absent from current escrow state.', 400);
    return snapshot;
  }
  async snapshot(match: Match): Promise<ChainSnapshot> {
    const block = await this.client.getBlock();
    const [info, players] = await Promise.all([
      this.client.readContract({ address: this.escrow, abi: escrowAbi, functionName: 'getMatch', args: [match.id], blockNumber: block.number }),
      this.client.readContract({ address: this.escrow, abi: escrowAbi, functionName: 'participants', args: [match.id], blockNumber: block.number }),
    ]);
    if (info[2] === 0) return { status: 0, participants: [], resolveDeadline: 0 };
    requireThat(info[0] === (match.game === 'flux-duel' ? 0 : 1) && info[1] === BigInt(match.stake) && info[6] === match.rulesHash && Number(info[4]) === Math.floor(match.fillDeadline / 1000), 'CHAIN_TERMS_MISMATCH', 'On-chain match terms do not match this offer.', 400);
    const result = info[2] === 3 ? await this.client.readContract({ address: this.escrow, abi: escrowAbi, functionName: 'getResult', args: [match.id], blockNumber: block.number }) : undefined;
    const equipment = Object.fromEntries(await Promise.all(players.map(async wallet => [wallet.toLowerCase(), await this.client.readContract({ address: this.escrow, abi: escrowAbi, functionName: 'equipmentCommitments', args: [match.id, wallet], blockNumber: block.number })])));
    return { status: info[2], participants: players.map(p => p.toLowerCase()), resolveDeadline: Number(info[5]) * 1000, equipment, ...(result ? { resultHash: result[0], ranks: result[1] } : {}) };
  }
  settlement(match: Match): TransactionIntent {
    if (!match.ranks || !match.resultHash) throw new Fault(409, 'RESULT_NOT_READY', 'Match has no final result.');
    return { chainId: this.chainId, fromAccount: 'escrow.resolver()', to: this.escrow, data: encodeFunctionData({ abi: escrowAbi, functionName: 'settleMatch', args: [match.id, match.ranks, match.resultHash] }), value: '0', purpose: 'Only the immutable resolver may submit the computed result. This API does not hold its signing key.' };
  }
  claimAccount(wallet: string): TransactionIntent { return { chainId: this.chainId, fromAccount: 'permissionless-keeper', to: getAddress(wallet), data: encodeFunctionData({ abi: accountAbi, functionName: 'claim' }), value: '0', purpose: 'Return earned credits to the agent account.' }; }
  refund(id: Hex): TransactionIntent { return { chainId: this.chainId, fromAccount: 'permissionless-keeper', to: this.escrow, data: encodeFunctionData({ abi: escrowAbi, functionName: 'cancelExpired', args: [id] }), value: '0', purpose: 'Release expired stakes as participant credits; keeper pays gas.' }; }
}
