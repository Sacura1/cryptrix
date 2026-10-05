import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import { digest, Fault } from '../domain.js';
import type { RemoteSigningProvider } from './signer.js';

// Private service protocol: no key import/export, arbitrary call, or owner credential endpoint.
export function buildSignerApp(signer: RemoteSigningProvider, credential: string, readiness: () => boolean = () => true) {
  if (credential.length < 32) throw new Error('Signer credential must contain at least 32 characters.');
  const app = Fastify({ logger: false, bodyLimit: 2_000_000 });
  app.get('/health', (_req, reply) => reply.code(readiness() ? 200 : 503).send({ ok: readiness() }));
  app.addHook('onRequest', async req => {
    if (req.routeOptions.url === '/health') return;
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!timingSafeEqual(Buffer.from(digest(token)), Buffer.from(digest(credential)))) throw new Fault(401, 'SIGNER_UNAUTHORISED', 'Signer authentication failed.');
  });
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof Fault ? error.status : error instanceof ZodError ? 400 : 503).send({ error: error instanceof Fault ? error.code : error instanceof ZodError ? 'INVALID_SIGNING_REQUEST' : 'SIGNER_FAILURE' }));
  app.get('/v1/keys/:scope', async req => { const scope = z.object({ scope: z.string().max(80) }).parse(req.params).scope; return { address: await signer.address(scope) }; });
  app.post('/v1/transactions', async req => {
    const body = z.object({ scope: z.string().max(80), operationId: z.string().min(8).max(256), transaction: z.object({ chainId: z.number().int().positive(), to: z.string().regex(/^0x[0-9a-fA-F]{40}$/), data: z.string().regex(/^0x([0-9a-fA-F]{2}){0,16384}$/), value: z.literal('0'), nonce: z.number().int().nonnegative(), gas: z.string().regex(/^\d{1,8}$/), maxFeePerGas: z.string().regex(/^\d{1,18}$/), maxPriorityFeePerGas: z.string().regex(/^\d{1,18}$/) }).strict(), context: z.object({ purpose: z.enum(['settlement', 'refund', 'claim']), matchId: z.string().regex(/^0x[0-9a-fA-F]{64}$/), agentId: z.string().uuid().optional(), resultHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(), replay: z.unknown().optional() }).strict() }).strict().parse(req.body);
    return { serializedTransaction: await signer.sign(body.scope, body.operationId, { ...body.transaction, data: body.transaction.data as `0x${string}` }, body.context) };
  });
  return app;
}
