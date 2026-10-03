import type { Replay, State, TurnAction } from '../types.ts';

export function replayInitialState(replay: Replay): State {
  if (replay.version === 2 && replay.initialState) return structuredClone(replay.initialState);
  const game = replay.rules.game;
  if (game === 'flux-duel')
    return {
      game,
      round: 0,
      players: replay.entries.map((entry, i) => ({
        id: entry.agentId,
        x: i ? 5 : 1,
        y: 3,
        health: 12,
        energy: 6,
        objective: 0,
      })),
    };
  // Version-one Rush never places relics on a spawn tile. No first-turn action can
  // collect a relic, so round one's full replay map is also the initial map.
  const starts = [
    [1, 0],
    [9, 0],
    [10, 1],
    [10, 9],
    [9, 10],
    [1, 10],
    [0, 9],
    [0, 1],
  ];
  const first = replay.rounds[0]?.state;
  return {
    game,
    round: 0,
    relics: first?.relics,
    bases: first?.bases,
    hazards: first?.hazards,
    players: replay.entries.map((entry, i) => ({
      id: entry.agentId,
      x: starts[i][0],
      y: starts[i][1],
      cargo: 0,
      deposited: 0,
    })),
  };
}

// Effects describe resolved records only. Never infer or expose hidden live Rush actions.
export function turnEffects(
  state: State,
  actions: Record<string, TurnAction> = {},
  events: string[] = [],
) {
  const hits = events.flatMap((event) => {
    const match = /^(.+) hit (.+) for (\d+)\.$/.exec(event);
    if (!match) return [];
    const from = state.players.find((p) => p.id === match[1]);
    const to = state.players.find((p) => p.id === match[2]);
    return from && to ? [{ from, to, damage: Number(match[3]) }] : [];
  });
  const labels = Object.fromEntries(
    state.players.flatMap((p) => {
      const action = actions[p.id];
      if (action)
        return [
          [
            p.id,
            action.type === 'move'
              ? `MOVE ${action.direction.toUpperCase()}`
              : action.type.toUpperCase(),
          ],
        ];
      return hits.some((hit) => hit.from.id === p.id) ? [[p.id, 'ATTACK']] : [];
    }),
  );
  return { hits, labels };
}
