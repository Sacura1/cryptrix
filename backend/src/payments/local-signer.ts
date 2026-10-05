import type { GasSponsor } from './gas-sponsor.js';
import { decodeFunctionData, getAddress } from 'viem';
import { escrowAbi, type ArcGateway } from '../chain.js';
import { canonical, equipmentCommitment, requireThat, rules, type Match } from '../domain.js';
import { verifyResult } from '../replay.js';
import { acceptMining, advanceMining, initialiseMining, MINING_MS, rulesForMining } from '../mining.js';
import { MAX_FEE, MAX_GAS, MAX_GAS_PER_DAY, MIN_FEE, type RemoteSigningProvider, type SigningContext, type UnsignedTransaction } from './signer.js';
import { SignerKeystore } from './keystore.js';

export class LocalSigningProvider implements RemoteSigningProvider {
  constructor(readonly keys: SignerKeystore, readonly chain?: ArcGateway, readonly sponsor?: GasSponsor) {}
  async address(scope: string) { requireThat(scope === 'keeper' || scope === 'resolver', 'SIGNER_SCOPE', 'Only service keys are available.', 403); const address = this.keys.account(scope).address; await this.keys.flush(); await this.sponsor?.ensure(scope); return address; }
  async sign(scope: string, operation: string, tx: UnsignedTransaction, context: SigningContext) {
    requireThat(this.chain, 'SIGNER_CHAIN_REQUIRED', 'Configure Arc before signing transactions.', 503);
    requireThat(tx.chainId === this.chain.chainId && tx.value === '0' && BigInt(tx.gas) > 0n && BigInt(tx.gas) <= MAX_GAS && BigInt(tx.maxFeePerGas) >= MIN_FEE && BigInt(tx.maxFeePerGas) <= MAX_FEE && BigInt(tx.maxPriorityFeePerGas) >= 0n && BigInt(tx.maxPriorityFeePerGas) <= BigInt(tx.maxFeePerGas), 'SIGNER_TRANSACTION_LIMIT', 'Signing request violates chain, value or fee limits.', 403);
    const cached = this.keys.cached(operation, scope, tx, context); if (cached) { await this.keys.flush(); return cached; }
    requireThat(scope === 'keeper' || scope === 'resolver', 'SIGNER_SCOPE', 'Only settlement and keeper service roles exist.', 403);
    const account = this.keys.account(scope), block = await this.chain.client.getBlock();
    const nonce = await this.chain.client.getTransactionCount({ address: account.address, blockTag: 'pending' });
    requireThat(nonce === tx.nonce, 'SIGNER_NONCE', 'Signing nonce differs from the network pending nonce.', 409);
    const target = getAddress(tx.to);
    if (scope === 'keeper' && context.purpose === 'claim') {
      requireThat(target.toLowerCase() === this.chain.escrow.toLowerCase(), 'SIGNER_TARGET', 'Keeper claims only from the configured escrow.', 403);
      const decoded = decodeFunctionData({ abi: escrowAbi, data: tx.data });
      requireThat(decoded.functionName === 'claimFor', 'SIGNER_METHOD', 'Keeper only transfers credits to the credited entrant.', 403);
      const recipient = (decoded.args as readonly string[])[0]!;
      const info = await this.chain.client.readContract({ address: target, abi: escrowAbi, functionName: 'getMatch', args: [context.matchId as `0x${string}`] });
      const participants = await this.chain.client.readContract({ address: target, abi: escrowAbi, functionName: 'participants', args: [context.matchId as `0x${string}`] });
      requireThat([3, 4].includes(info[2]) && participants.some(p => p.toLowerCase() === recipient.toLowerCase()), 'SIGNER_CLAIM', 'Only a finished entrant may receive its escrow credits.', 403);
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
        requireThat(proof.rules?.game === (info[0] === 0 ? 'flux-duel' : 'cache-rush') && canonical(proof.rules) === canonical(proof.version === 2 ? rulesForMining(proof.rules.mapGeneration ?? 1, proof.rules.protocolVersion ?? 1) : rules(proof.rules.game, proof.rules.protocolVersion ?? 1)), 'SIGNER_PROOF', 'Replay rules do not match the fixed escrow game.', 403);
        const players = await this.chain.client.readContract({ address: target, abi: escrowAbi, functionName: 'participants', args: [context.matchId as `0x${string}`] });
        requireThat(info[2] === 2 && info[5] > block.timestamp && proof.rulesHash === info[6] && proof.entries.length === players.length && proof.entries.every((entry: any, i: number) => entry.wallet.toLowerCase() === players[i]!.toLowerCase()), 'SIGNER_PROOF', 'Replay is not bound to the active escrow entrants.', 403);
        for (const entry of proof.entries) {
          const committed = await this.chain.client.readContract({ address: target, abi: escrowAbi, functionName: 'equipmentCommitments', args: [context.matchId as `0x${string}`, getAddress(entry.wallet)] });
          requireThat(committed === equipmentCommitment(entry.equipment, entry.equipmentSalt), 'SIGNER_PROOF', 'Replay equipment differs from funded commitment.', 403);
        }
        const reconstructed = { protocolVersion: proof.rules.protocolVersion, id: proof.matchId, game: proof.rules.game, mode: 'paid', status: 'finished', stake: Number(info[1]), seed: proof.seed, commitment: proof.seedCommitment, rulesHash: proof.rulesHash, entries: proof.entries, history: proof.version === 1 ? proof.rounds : [], ranks: proof.ranks, payouts: proof.payouts, state: proof.version === 1 ? proof.rounds.at(-1)?.state : undefined, resultHash: args[2], pending: {} } as Match;
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
