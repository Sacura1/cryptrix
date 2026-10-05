import { GasSponsor } from './payments/gas-sponsor.js';
import { getAddress } from 'viem';
import { z } from 'zod';
import { ArcGateway } from './chain.js';
import { SignerKeystore } from './payments/keystore.js';
import { LocalSigningProvider } from './payments/local-signer.js';
import { backupKey } from './backup.js';
import { buildSignerApp } from './payments/signer-app.js';

// A separate process and database. Never run with the API server's OS identity in production.
const env = z.object({ GAS_SPONSOR_ENABLED: z.enum(['true','false']).default('false'), SIGNER_TOKEN: z.string().min(32), SIGNER_ENCRYPTION_KEY: z.string(), SIGNER_DATABASE_URL: z.string().url().optional(), SIGNER_STATE_NAMESPACE: z.string().optional(), SIGNER_DATABASE: z.string().default('./data/signer/keys.sqlite'), SIGNER_HOST: z.string().default('127.0.0.1'), SIGNER_PORT: z.coerce.number().int().min(1).max(65535).default(3001), ARC_NETWORK: z.enum(['mainnet', 'testnet']).default('testnet'), ARC_RPC_URL: z.string().url().optional(), ESCROW_ADDRESS: z.string().optional() }).parse(process.env);
if (process.env.NODE_ENV === 'production' && !env.SIGNER_DATABASE_URL) throw new Error('Production signer requires durable PostgreSQL storage.');
const keys = await SignerKeystore.open(env.SIGNER_DATABASE, backupKey(env.SIGNER_ENCRYPTION_KEY), env.SIGNER_DATABASE_URL, env.SIGNER_STATE_NAMESPACE ?? `signer:${env.ARC_NETWORK}`);
let chain: ArcGateway | undefined;
if (env.ESCROW_ADDRESS) { chain = new ArcGateway(getAddress(env.ESCROW_ADDRESS), env.ARC_NETWORK, env.ARC_RPC_URL); await chain.initialise(); }
const sponsor = env.GAS_SPONSOR_ENABLED === 'true' && chain ? new GasSponsor(keys, chain) : undefined;
const signer = new LocalSigningProvider(keys, chain, sponsor);
const app = buildSignerApp(signer, env.SIGNER_TOKEN, () => !!chain?.resolver && (keys.persistence?.healthy ?? true));
const healthTimer = setInterval(() => {
  if (keys.persistence && !keys.persistence.healthy) {
    clearInterval(healthTimer);
    process.exitCode = 1;
    void app.close().catch(() => { process.exitCode = 1; });
  }
}, 2000);
healthTimer.unref();
app.addHook('onClose', async () => { clearInterval(healthTimer); await keys.shutdown(); });
process.once('SIGINT', () => void app.close()); process.once('SIGTERM', () => void app.close());
await app.listen({ host: env.SIGNER_HOST, port: env.SIGNER_PORT });
