import type { State, TurnAction } from '../types.ts';
import { turnEffects } from './turns.ts';

export type SoundKind =
  | 'dig'
  | 'rattle'
  | 'bite'
  | 'warning'
  | 'collapse'
  | 'step'
  | 'shot'
  | 'impact'
  | 'shield'
  | 'scan'
  | 'charge'
  | 'collect'
  | 'deposit'
  | 'defeat'
  | 'victory';
export interface SoundCue {
  kind: SoundKind;
  delay: number;
  pan: number;
}

// Only resolved public actions/events reach this function. Seeking a replay is silent.
export function soundCues(
  state: State,
  actions: Record<string, TurnAction> = {},
  events: string[] = [],
): SoundCue[] {
  const cues: SoundCue[] = [];
  const pan = (id: string) =>
    ((state.players.find((p) => p.id === id)?.x ?? 3) / (state.game === 'flux-duel' ? 6 : 10) -
      0.5) *
    1.2;
  for (const [id, action] of Object.entries(actions)) {
    const kind = (
      {
        move: 'step',
        attack: 'shot',
        shield: 'shield',
        scan: 'scan',
        recharge: 'charge',
        collect: 'collect',
        deposit: 'deposit',
      } as const
    )[action.type as Exclude<TurnAction['type'], 'wait'>];
    if (kind)
      cues.push({
        kind,
        delay: kind === 'shot' ? 1.1 : kind === 'shield' ? 0.5 : kind === 'step' ? 0.1 : 0.8,
        pan: pan(id),
      });
  }
  for (const hit of turnEffects(state, actions, events).hits) {
    // Live public hit events can animate a shot even when actions are unavailable.
    if (!actions[hit.from.id]) cues.push({ kind: 'shot', delay: 1.1, pan: pan(hit.from.id) });
    cues.push({ kind: 'impact', delay: 1.65, pan: pan(hit.to.id) });
    if (hit.to.health === 0) cues.push({ kind: 'defeat', delay: 2, pan: pan(hit.to.id) });
  }
  for (const event of events) {
    const deposit = /^(.+) deposited ([1-9]\d*)\.$/.exec(event);
    if (deposit && !actions[deposit[1]])
      cues.push({ kind: 'deposit', delay: 0.8, pan: pan(deposit[1]) });
  }
  return cues.slice(0, 16);
}
