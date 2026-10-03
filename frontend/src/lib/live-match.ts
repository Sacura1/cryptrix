import type { Match } from '../types.ts';

// HTTP polling can complete after a newer SSE packet. Never rewind a live world.
export function acceptLiveMatch(current: Match | undefined, incoming: Match): Match {
  if (!current || current.id !== incoming.id) return incoming;
  if (['finished', 'cancelled'].includes(current.status) && incoming.status !== current.status)
    return current;
  if (current.engineVersion === 2 && incoming.engineVersion === 2) {
    const time = (match: Match) => (match.state as { elapsedMs?: number } | null)?.elapsedMs ?? -1;
    if (time(incoming) < time(current)) return current;
    if (time(incoming) === time(current)) {
      const sequence = (match: Match) =>
        (match.state as { eventSequence?: number } | null)?.eventSequence ?? 0;
      if (sequence(incoming) < sequence(current)) return current;
    }
  } else if ((incoming.state?.round ?? -1) < (current.state?.round ?? -1)) return current;
  return incoming;
}

// Presentation time must not depend on model latency or SSE packet cadence.
// This advances the clock, not the authoritative state, treasure or decisions.
export function liveTime(elapsed: number, age: number, previous: number, duration: number) {
  return Math.min(duration, Math.max(previous, elapsed + Math.max(0, age)));
}
