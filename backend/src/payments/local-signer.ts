import type { GasSponsor } from './gas-sponsor.js';
import { decodeFunctionData, getAddress, parseAbi, type Address } from 'viem';
import { accountAbi, escrowAbi, type ArcGateway } from '../chain.js';
import { canonical, equipmentCommitment, PLAY_SECONDS, requireThat, rules, type Match } from '../domain.js';
import { verifyResult } from '../replay.js';
import { acceptMining, advanceMining, initialiseMining, MINING_MS, rulesForMining } from '../mining.js';
import { MAX_FEE, MAX_GAS, MAX_GAS_PER_DAY, MIN_FEE, type RemoteSigningProvider, type SigningContext, type UnsignedTransaction } from './signer.js';
import { SignerKeystore } from './keystore.js';

const factoryAbi = parseAbi(['function isAccount(address) view returns (bool)']);
const permissionAbi = parseAbi(['function dailyUsage(uint256 day) view returns (uint256 stake,uint32 games)']);
export class LocalSigningProvider implements RemoteSigningProvider {
  constructor(readonly keys: SignerKeystore, readonly chain?: ArcGateway, readonly factory?: Address, readonly sponsor?: GasSponsor) {}
  async address(scope: string) { const address = this.keys.account(scope).address; await this.keys.flush(); await this.sponsor?.ensure(scope); return address; }
  async sign(scope: string, operation: string, tx: UnsignedTransaction, context: SigningContext) {
    requireThat(this.chain, 'SIGNER_CHAIN_REQUIRED', 'Configure Arc before signing transactions.', 503);
    requireThat(tx.chainId === this.chain.chainId && tx.value === '0' && BigInt(tx.gas) > 0n && BigInt(tx.gas) <= MAX_GAS && BigInt(tx.maxFeePerGas) >= MIN_FEE && BigInt(tx.maxFeePerGas) <= MAX_FEE && BigInt(tx.maxPriorityFeePerGas) >= 0n && BigInt(tx.maxPriorityFeePerGas) <= BigInt(tx.maxFeePerGas), 'SIGNER_TRANSACTION_LIMIT', 'Signing request violates chain, value or fee limits.', 403);
    const cached = this.keys.cached(operation, scope, tx, context); if (cached) { await this.keys.flush(); return cached; }
    const account = this.keys.account(scope), block = await this.chain.client.getBlock();
    const nonce = await this.chain.client.getTransactionCount({ address: account.address, blockTag: 'pending' });
    requireThat(nonce === tx.nonce, 'SIGNER_NONCE', 'Signing nonce differs from the network pending nonce.', 409);
    const target = getAddress(tx.to);
    if (scope.startsWith('agent:')) {
      requireThat(context.purpose === 'entry' && `agent:${context.agentId}` === scope && this.factory, 'SIGNER_SCOPE', 'Agent keys only sign their scoped game entries.', 403);
      const registered = await this.chain.client.readContract({ address: this.factory, abi: factoryAbi, functionName: 'isAccount', args: [target] });
      requireThat(registered, 'SIGNER_TARGET', 'Agent key target must be a fixed factory account.', 403);
      const decoded = decodeFunctionData({ abi: accountAbi, data: tx.data });
      const args = decoded.args as readonly any[];
      requireThat(['createMatchWithEquipment', 'joinMatchWithEquipment'].includes(decoded.functionName) && args[0] === context.matchId, 'SIGNER_METHOD', 'Agent key cannot sign arbitrary calls.', 403);
      let game: number, stake: bigint;
      if (decoded.functionName === 'createMatchWithEquipment') {
        game = Number(args[1]); stake = args[2];
        requireThat(args[3] > block.timestamp && args[3] <= block.timestamp + 86400n && args[4] === PLAY_SECONDS, 'SIGNER_TERMS', 'Invalid entry deadlines.', 403);
      } else {
        const info = await this.chain.client.readContract({ address: this.chain.escrow, abi: escrowAbi, functionName: 'getMatch', args: [context.matchId as `0x${string}`] });
        game = info[0]; stake = info[1]; requireThat(info[2] === 1 && info[4] > block.timestamp && stake === args[1], 'SIGNER_TERMS', 'Escrow is not open at the accepted stake.', 409);
      }
      const policy = await this.chain.client.readContract({ address: target, abi: accountAbi, functionName: 'policy' });
      const usage = await this.chain.client.readContract({ address: target, abi: permissionAbi, functionName: 'dailyUsage', args: [block.timestamp / 86400n] });
      requireThat(policy[0].toLowerCase() === account.address.toLowerCase() && policy[4] > block.timestamp && (policy[5] & (1 << game)) !== 0 && stake <= policy[1] && usage[0] + stake <= policy[2] && usage[1] < policy[3], 'SIGNER_POLICY', 'Owner policy rejects this entry.', 403);
    } else if (scope === 'keeper' && context.purpose === 'claim') {
      requireThat(this.factory && context.agentId, 'SIGNER_SCOPE', 'Claim needs a scoped agent account.', 403);
      const decoded = decodeFunctionData({ abi: accountAbi, data: tx.data });
      requireThat(decoded.functionName === 'claim', 'SIGNER_METHOD', 'Keeper can only return credits to the account.', 403);
      const registered = await this.chain.client.readContract({ address: this.factory, abi: factoryAbi, functionName: 'isAccount', args: [target] });
      const info = await this.chain.client.readContract({ address: this.chain.escrow, abi: escrowAbi, functionName: 'getMatch', args: [context.matchId as `0x${string}`] });
      const participants = await this.chain.client.readContract({ address: this.chain.escrow, abi: escrowAbi, functionName: 'participants', args: [context.matchId as `0x${string}`] });
      requireThat(registered && [3,4].includes(info[2]) && participants.some(p => p.toLowerCase() === target.toLowerCase()), 'SIGNER_CLAIM', 'Only a finished entrant may claim into its fixed account.', 403);
    } else {
      requireThat(target.toLowerCase() === this.chain.escrow.toLowerCase(), 'SIGNER_TARGET', 'Service roles can only call the fixed escrow.', 403);
      const decoded = decodeFunctionData({ abi: escrowAbi, data: tx.data });
      const args = decoded.args as readonly any[];
      requireThat(args[0] === context.matchId, 'SIGNER_CONTEXT', 'Match ID changed.', 403);
      if (scope === 'keeper') {
        requireThat(context.purpose === 'refund' && decoded.functionName === 'cancelExpired', 'SIGNER_METHOD', 'Keeper only signs deadline refunds.', 403);
        const info = await this.chain.client.readContract({ address: target, abi: escrowAbi, functionName: 'getMatch', args: [context.matchId as `0x${string}`] });
        requireThat((info[2] === 1 && info[4] <= block.timestamp) || (info[2] === 2 && info[5] <= block.timestamp), 'SIGNER_REFUND', 'Match is not refund-eligible.', 409);
      } else {
        requireThat(scope === 'resolver' && context.purpose === 'settlement' && decoded.functionName === 'settleMatch', 'SIGNER_METHOD', 'Resolver only signs verified game results.', 403);
        const resolver = await this.chain.client.readContract({ address: target, abi: escrowAbi, functionName: 'resolver' });
        requireThat(resolver.toLowerCase() === account.address.toLowerCase(), 'SIGNER_RESOLVER', 'Key is not the escrow resolver.', 403);
        const proof = context.replay as any;
        requireThat((proof?.version === 1 || proof?.version === 2) && proof.matchId === context.matchId && context.resultHash === args[2] && canonical(proof.ranks) === canonical(args[1]), 'SIGNER_PROOF', 'Settlement lacks its exact replay proof.', 403);
        const info = await this.chain.client.readContract({ address: target, abi: escrowAbi, functionName: 'getMatch', args: [context.matchId as `0x${string}`] });
        requireThat(proof.rules?.game === (info[0] === 0 ? 'flux-duel' : 'cache-rush') && canonical(proof.rules) === canonical(proof.version === 2 ? rulesForMining(proof.rules.mapGeneration ?? 1) : rules(proof.rules.game)), 'SIGNER_PROOF', 'Replay rules do not match the fixed escrow game.', 403);
        const players = await this.chain.client.readContract({ address: target, abi: escrowAbi, functionName: 'participants', args: [context.matchId as `0x${string}`] });
        requireThat(info[2] === 2 && info[5] > block.timestamp && proof.rulesHash === info[6] && proof.entries.length === players.length && proof.entries.every((entry: any, i: number) => entry.wallet.toLowerCase() === players[i]!.toLowerCase()), 'SIGNER_PROOF', 'Replay is not bound to the active escrow entrants.', 403);
        for (const entry of proof.entries) {
          const committed = await this.chain.client.readContract({ address: target, abi: escrowAbi, functionName: 'equipmentCommitments', args: [context.matchId as `0x${string}`, getAddress(entry.wallet)] });
          requireThat(committed === equipmentCommitment(entry.equipment, entry.equipmentSalt), 'SIGNER_PROOF', 'Replay equipment differs from funded commitment.', 403);
        }
        const reconstructed = { id: proof.matchId, game: proof.rules.game, mode: 'paid', status: 'finished', stake: Number(info[1]), seed: proof.seed, commitment: proof.seedCommitment, rulesHash: proof.rulesHash, entries: proof.entries, history: proof.version === 1 ? proof.rounds : [], ranks: proof.ranks, payouts: proof.payouts, state: proof.version === 1 ? proof.rounds.at(-1)?.state : undefined, resultHash: args[2], pending: {} } as Match;
        if (proof.version === 2) {
          const generation = proof.rules.mapGeneration ?? 1;
          requireThat([1, 2, 3].includes(generation) && Array.isArray(proof.inputs) && Array.isArray(proof.frames) && proof.inputs.length <= 160 && proof.frames.length <= 481, 'SIGNER_PROOF', 'Invalid mining recording.', 403);
          const world = initialiseMining(proof.entries, proof.seed, generation);
          for (const input of proof.inputs) {
            requireThat(Number.isSafeInteger(input.at) && input.at % 500 === 0 && input.at >= world.elapsedMs && input.at < MINING_MS, 'SIGNER_PROOF', 'Invalid mining command time.', 403);
            advanceMining(world, input.at);
            acceptMining(world, input.agentId, input.sequence, input.command);
          }
          advanceMining(world, MINING_MS);
          reconstructed.engineVersion = 2;
          reconstructed.miningMapVersion = generation === 1 ? undefined : generation;
          reconstructed.mining = { startedAt: 0, world, inputs: proof.inputs, frames: proof.frames };
        }
        verifyResult(reconstructed);
      }
    }
    this.keys.reserve(operation, scope, tx, context, account.address.toLowerCase(), Number(block.timestamp / 86400n), MAX_GAS_PER_DAY);
    const raw = await account.signTransaction({ type: 'eip1559', chainId: tx.chainId, to: target, data: tx.data, value: 0n, nonce: tx.nonce, gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) });
    const committed = this.keys.commit(operation, raw); await this.keys.flush(); return committed;
  }
}
