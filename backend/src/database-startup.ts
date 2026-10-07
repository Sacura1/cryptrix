import type { WriterStartupOptions } from './persistence.js';

/** Allow a previous writer's lease to clear without accepting traffic prematurely. */
export async function withDatabaseStartup<T>(waitMs: number, open: (options: WriterStartupOptions) => Promise<T>, close: (resource: T) => Promise<void>): Promise<T> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const resource = await open({
      waitMs,
      signal: controller.signal,
      onWait: () => console.warn('Waiting for the previous database writer to stop. Use Immediate deployment strategy on Koyeb.'),
    });
    if (controller.signal.aborted) {
      await close(resource);
      throw new Error('NEON_STARTUP_CANCELLED');
    }
    return resource;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
