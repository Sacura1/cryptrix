import { getAddress } from 'viem';
import { ArcGateway } from '../src/chain.js';

// Read-only integration preflight. Never signs, deploys, approves or transfers funds.
if (!process.env.ESCROW_ADDRESS) throw new Error('Set the public deployed ESCROW_ADDRESS first.');
const network = process.env.ARC_NETWORK ?? 'testnet';
if (network !== 'testnet' && network !== 'mainnet') throw new Error('ARC_NETWORK must be testnet or mainnet.');
const chain = new ArcGateway(getAddress(process.env.ESCROW_ADDRESS), network, process.env.ARC_RPC_URL);
await chain.initialise();
const block = await chain.client.getBlock();
console.log(JSON.stringify({ verified: true, network, chainId: chain.chainId, escrow: chain.escrow, resolver: chain.resolver, block: String(block.number), timestamp: String(block.timestamp), scope: 'Read-only chain, token, equipment and escrow-version configuration checks. Funded integration is a separate launch check.' }, null, 2));
