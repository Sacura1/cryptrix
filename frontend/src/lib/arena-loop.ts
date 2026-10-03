export type ArenaFault = 'frame-error' | 'context-lost' | 'context-restored';
export function arenaErrorName(error: unknown) {
  const allowed = [
    'TypeError',
    'RangeError',
    'IndexSizeError',
    'InvalidStateError',
    'SecurityError',
    'Error',
  ];
  const name = error instanceof Error ? error.name : 'Error';
  return allowed.includes(name) ? name : 'Error';
}
// Schedule the next frame before drawing. A single failed frame cannot kill the
// animation chain, and persistent faults back off rather than flood the browser.
export function startArenaLoop(
  draw: (wall: number) => void,
  options: {
    request: (callback: (wall: number) => void) => number;
    cancel: (ticket: number) => void;
    onError: (error: unknown) => void;
  },
) {
  let alive = true,
    ticket = 0,
    retryAt = 0;
  const frame = (wall: number) => {
    if (!alive) return;
    ticket = options.request(frame);
    if (wall < retryAt) return;
    try {
      draw(wall);
    } catch (error) {
      retryAt = wall + 500;
      try {
        options.onError(error);
      } catch {
        /* Diagnostics must never end rendering. */
      }
    }
  };
  ticket = options.request(frame);
  return () => {
    alive = false;
    options.cancel(ticket);
  };
}

// Browser frame APIs require their Window receiver. Wrappers preserve it when
// the scheduler is passed through another object.
export function browserArenaScheduler(
  host: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'> = window,
) {
  return {
    request: (callback: (wall: number) => void) => host.requestAnimationFrame(callback),
    cancel: (ticket: number) => host.cancelAnimationFrame(ticket),
  };
}
