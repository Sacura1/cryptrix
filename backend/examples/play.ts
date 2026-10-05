import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { AgentClient, AgentApiError } from '../src/sdk.js';
import { TestnetWalletAdapter } from './wallet-adapter.js';
import { decide } from './decision.js';

const base = process.env.AGENT_API_URL ?? 'http://127.0.0.1:3011';
const escrow = process.env.AGENT_ESCROW, secret = process.env.AGENT_PRIVATE_KEY;
const stake = process.env.AGENT_STAKE ?? '1';
if (!escrow || !secret || !/^[1-5]$/.test(stake)) throw new Error('Set AGENT_ESCROW, AGENT_PRIVATE_KEY and a whole AGENT_STAKE from 1 to 5.');
const response = await fetch(`${base.replace(/\/$/, '')}/config`);
if (!response.ok) throw new Error('Cannot read game configuration');
const config = await response.json() as any;
if (config.chainId !== 5042002 || config.mode !== 'paid' || config.escrow?.toLowerCase() !== escrow.toLowerCase()) throw new Error('Configured deployment does not match wallet policy');
const account = privateKeyToAccount((secret.startsWith('0x') ? secret : `0x${secret}`) as Hex);
delete process.env.AGENT_PRIVATE_KEY;
const wallet = new TestnetWalletAdapter(account, escrow, process.env.AGENT_JOURNAL ?? `./data/external-${account.address}.json`, process.env.ARC_RPC_URL, BigInt(stake) * 1_000_000n);
const client = await AgentClient.connect(base, wallet);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let match;
for (;;) {
  try { match = await client.findOrCreate('cache-rush', stake, undefined, { title: process.env.AGENT_ROOM_TITLE }); break; }
  catch (error) {
    if (!(error instanceof AgentApiError) || !['ROOM_ALREADY_OPEN', 'ROOM_FUNDING', 'OPEN_ROOM_LIMIT'].includes(error.code)) throw error;
    console.log('Waiting for a suitable room…'); await delay(10000);
  }
}
console.log(JSON.stringify({ wallet: account.address, matchId: match.id }));
for (;;) {
  try {
    const view = await client.observation(match.id);
    if (view.status === 'finished' || view.status === 'cancelled') { console.log(JSON.stringify(await client.result(match.id))); break; }
    if (view.status === 'active' && !view.actionLocked) await client.command(match.id, view.nextSequence!, decide(view.observation));
  } catch (error) {
    // Refetch state before another command; never retry an entry payment here.
    if (error instanceof AgentApiError && error.status === 401) await client.authenticate();
    else if (error instanceof AgentApiError && error.status < 500 && ![409,429].includes(error.status)) throw error;
  }
  await delay(1500);
}
