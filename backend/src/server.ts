import { getAddress } from 'viem';
import { z } from 'zod';
import { buildApp } from './app.js';
import { ArcGateway } from './chain.js';
import { OpenAIResponsesProvider } from './hosted/provider.js';
import { HostedWorker } from './hosted/worker.js';
import { randomUUID } from 'node:crypto';
import { HttpSigningProvider, SigningService } from './payments/signer.js';
import { PaymentWorker } from './payments/worker.js';
import { ChainIndexer } from './indexer.js';

const env = z.object({
  MATCH_MODE: z.enum(['practice', 'paid']).default('practice'), HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000), DATABASE_PATH: z.string().default('./data/platform.sqlite'), DATABASE_URL: z.string().url().optional(), STATE_NAMESPACE: z.string().optional(),
  AUTH_ORIGIN: z.string().url().default('http://localhost:3000'), ARC_NETWORK: z.enum(['mainnet', 'testnet']).default('testnet'),
  ARC_RPC_URL: z.string().url().optional(), ESCROW_ADDRESS: z.string().optional(), AGENT_ACCOUNT_FACTORY: z.string().optional(),
  HOSTED_DECISIONS: z.enum(['strategy', 'model', 'disabled']).default('strategy'),
  HOSTED_MODEL: z.string().min(1).optional(), OPENAI_API_KEY: z.string().min(1).optional(),
  HOSTED_REASONING_EFFORT: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  HOSTED_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  SIGNER_URL: z.string().url().optional(), SIGNER_TOKEN: z.string().min(16).optional(),
  OPS_TOKEN: z.string().min(32).optional(),
  ESCROW_DEPLOYMENT_BLOCK: z.string().regex(/^\d+$/).optional(),
  FRONTEND_ORIGINS: z.string().optional(), TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(4).default(0), FRONTEND_PROXY_TOKEN: z.string().min(32).optional(),
}).parse(process.env);
if (process.env.NODE_ENV === 'production' && !env.DATABASE_URL) throw new Error('Production API requires DATABASE_URL.');
// Deployment credentials are never retained by the running API.
delete process.env.key; delete process.env.PRIVATE_KEY; delete process.env.DEPLOYER_PRIVATE_KEY;
let chain: ArcGateway | undefined;
if (env.MATCH_MODE === 'paid') {
  if (!env.ESCROW_ADDRESS) throw new Error('Paid mode requires ESCROW_ADDRESS; no simulated funding is accepted.');
  if (!env.ESCROW_DEPLOYMENT_BLOCK) throw new Error('Paid mode requires the escrow deployment block for complete indexing.');
  chain = new ArcGateway(getAddress(env.ESCROW_ADDRESS), env.ARC_NETWORK, env.ARC_RPC_URL, env.AGENT_ACCOUNT_FACTORY ? getAddress(env.AGENT_ACCOUNT_FACTORY) : undefined);
  await chain.initialise();
}
const provider = env.HOSTED_DECISIONS === 'model'
  ? new OpenAIResponsesProvider(env.OPENAI_API_KEY ?? '', env.HOSTED_MODEL ?? '', fetch, env.HOSTED_REASONING_EFFORT) : undefined;
if (!!env.SIGNER_URL !== !!env.SIGNER_TOKEN) throw new Error('Signer URL and service credential must be configured together.');
const signing = chain && env.SIGNER_URL ? new SigningService(chain, new HttpSigningProvider(env.SIGNER_URL, env.SIGNER_TOKEN!)) : undefined;
const holder = randomUUID();
let ready = false;
const { app, platform, store } = await buildApp({ database: env.DATABASE_PATH, databaseUrl: env.DATABASE_URL, stateNamespace: env.STATE_NAMESPACE ?? `backend:${env.ARC_NETWORK}:${env.MATCH_MODE}`, mode: env.MATCH_MODE, chain, origin: env.AUTH_ORIGIN, logger: true, hostedMode: env.HOSTED_DECISIONS, minimumRoundMs: 10_000, miningEnabled: true, signing, opsToken: env.OPS_TOKEN, trustedProxyHops: env.TRUSTED_PROXY_HOPS, proxyToken: env.FRONTEND_PROXY_TOKEN, allowedOrigins: env.FRONTEND_ORIGINS?.split(',').map(value => value.trim()), readiness: () => {
  const time = Date.now();
  const fresh = (name: string, age: number) => !!store.db.prepare('SELECT 1 FROM service_status WHERE name=? AND failures=0 AND last_success>?').get(name, time - age);
  const checks = { storage: store.healthy, scheduler: fresh('clock', 5000), indexer: !chain || fresh('indexer', 30_000), reconciliation: !chain || fresh('reconciliation', 30_000), configuredSigner: !chain || !!signing };
  return { ready: ready && Object.values(checks).every(Boolean), checks };
} });
const worker = provider ? new HostedWorker(platform, provider, env.HOSTED_CONCURRENCY) : undefined;
const payments = signing ? new PaymentWorker(platform, signing) : undefined;
const indexer = chain ? new ChainIndexer(platform, chain, BigInt(env.ESCROW_DEPLOYMENT_BLOCK!)) : undefined;
let syncTask: Promise<void> | undefined, ticks = 0;
const timer = setInterval(() => {
  try {
    if (store.lease('match-clock', holder, platform.now(), 5000)) { platform.tick(holder); store.service('clock', platform.now()); }
    if (!chain) ready = true;
    void store.flush().catch(() => { ready = false; app.log.error('Durable storage failed; stopping coordination'); void app.close(); });
  } catch { ready = false; store.service('clock', platform.now(), 'CLOCK_FAILED'); app.log.error('Match clock failed'); }
  // Do not log provider exceptions: they may contain private observations or credentials.
  if (worker) void worker.runOnce().catch(() => app.log.error('Hosted decision batch failed'));
  if (syncTask || ++ticks % 2) return;
  syncTask = (async () => {
    await indexer?.runOnce();
    if (payments) { if (worker && store.db.prepare("SELECT holder FROM leases WHERE name='match-clock' AND expires_at>?").get(platform.now())?.holder === holder) await payments.automaticEntries(); await payments.runOnce(); }
    ready = !chain || (!!signing && !!indexer?.caughtUp);
  })().catch(() => { ready = false; app.log.error('Chain/payment coordination needs attention'); }).finally(() => { syncTask = undefined; });
}, 1000);
app.addHook('preClose', async () => { ready = false; clearInterval(timer); await worker?.stop(); await indexer?.stop(); await payments?.stop(); await syncTask; store.releaseLease('match-clock', holder); });
const close = async () => { await app.close(); process.exit(0); };
process.once('SIGINT', close); process.once('SIGTERM', close);
await app.listen({ host: env.HOST, port: env.PORT });
