import { createServer } from 'node:http';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { WriterStartupOptions } from './persistence.js';

type ServerFactory = NonNullable<FastifyServerOptions['serverFactory']>;

/** Liveness starts before storage; application traffic starts only after exclusive restore. */
export async function withDatabaseStartup<T extends { app: FastifyInstance }>(
  config: { host: string; port: number; waitMs: number },
  open: (options: WriterStartupOptions, serverFactory: ServerFactory) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let handler: Parameters<ServerFactory>[0] | undefined, active = false, resource: T | undefined;
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000, keepAliveTimeout: 5000 }, (req, res) => {
    if (active && !controller.signal.aborted && handler) return handler(req, res);
    const live = req.url?.split('?')[0] === '/health' && !controller.signal.aborted;
    req.resume();
    res.writeHead(live ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '2', connection: 'close' });
    res.end(JSON.stringify({ ok: false, ready: false, status: controller.signal.aborted ? 'stopping' : 'starting', ...(!live ? { error: 'SERVICE_STARTING' } : {}) }));
  });
  const closeListener = () => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  const removeSignals = () => {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  };
  const stop = () => {
    controller.abort();
    if (resource) void resource.app.close().catch(() => { process.exitCode = 1; });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve(); });
    });
    resource = await open({
      waitMs: config.waitMs,
      signal: controller.signal,
      onWait: () => console.info('Waiting for the previous database writer to stop; application requests are temporarily unavailable.'),
    }, httpHandler => { handler = httpHandler; return server; });
    resource.app.addHook('preClose', async () => { active = false; controller.abort(); });
    // Fastify does not own a custom server that was already listening before ready().
    resource.app.addHook('onClose', async () => { removeSignals(); await closeListener(); });
    await resource.app.ready();
    if (controller.signal.aborted) throw new Error('NEON_STARTUP_CANCELLED');
    active = true;
    return resource;
  } catch (error) {
    controller.abort(); removeSignals();
    try { await resource?.app.close(); } finally { await closeListener(); }
    throw error;
  }
}

export function handleStartupError(error: unknown): void {
  if (error instanceof Error && error.message === 'NEON_STARTUP_CANCELLED') {
    console.info('Service startup stopped by shutdown signal.');
    return;
  }
  throw error;
}
