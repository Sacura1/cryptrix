import { Robot } from './Board';
import { colors, type Match, type State, type TurnAction } from '../types';
import { turnEffects } from '../lib/turns';

export function CombatHud({ match, state }: { match: Match; state?: State | null }) {
  return (
    <div className="combat-scoreboard" aria-label="Duel health and energy">
      {match.participants.map((p, i) => {
        const player = state?.players.find((q) => q.id === p.agentId);
        return (
          <div className={`combat-contender contender-${i}`} key={p.agentId}>
            <div className="contender-portrait">
              <Robot size={80} index={i} color={colors[i]} />
            </div>
            <div className="contender-name">
              <strong>{p.name}</strong>
              <span>{player?.objective ?? 0} control pts</span>
            </div>
            <div className="contender-vitals">
              <div>
                <span>HEALTH</span>
                <meter
                  aria-label={`${p.name} health`}
                  min="0"
                  max="12"
                  value={player?.health ?? 12}
                />
                <b>{player?.health ?? '—'} / 12</b>
              </div>
              <div>
                <span>ENERGY</span>
                <meter
                  aria-label={`${p.name} energy`}
                  className="energy-meter"
                  min="0"
                  max="6"
                  value={player?.energy ?? 6}
                />
                <b>{player?.energy ?? '—'} / 6</b>
              </div>
            </div>
          </div>
        );
      })}
      <span className="combat-versus" aria-hidden="true">
        VS
      </span>
    </div>
  );
}

const descriptions: Record<string, string> = {
  attack: 'Opened fire',
  shield: 'Raised a shield',
  scan: 'Scanned the rival',
  recharge: 'Recharged the power core',
  wait: 'Held position',
  collect: 'Collected relics',
  deposit: 'Delivered cargo',
};
function ActionMark({ kind }: { kind: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      {kind === 'shield' ? (
        <path
          d="M16 3 27 7v10c0 6-11 12-11 12S5 23 5 17V7Z"
          fill="#ddae55"
          stroke="#685322"
          strokeWidth="2"
        />
      ) : kind === 'attack' ? (
        <path d="m16 1 3 9 8-4-4 9 8 4-10 2-2 10-5-9-9 5 4-10-8-4 11-3Z" fill="#c64f2c" />
      ) : kind === 'recharge' ? (
        <path d="m19 2-13 17h9l-2 11 13-18h-9Z" fill="#b98632" />
      ) : kind === 'scan' ? (
        <>
          <circle cx="16" cy="16" r="12" fill="none" stroke="#657449" strokeWidth="2" />
          <circle cx="16" cy="16" r="5" fill="none" stroke="#657449" strokeWidth="2" />
          <path d="M16 16 28 7" stroke="#657449" strokeWidth="3" />
        </>
      ) : (
        <path d="M4 16h23m-9-9 9 9-9 9" fill="none" stroke="#657449" strokeWidth="3" />
      )}
    </svg>
  );
}

export function RoundFeed({
  match,
  state,
  actions,
  events,
}: {
  match: Match;
  state?: State | null;
  actions?: Record<string, TurnAction>;
  events: string[];
}) {
  const named = (text: string) =>
    match.participants.reduce((result, p) => result.replaceAll(p.agentId, p.name), text);
  const hits = state ? turnEffects(state, actions, events).hits : [];
  const controller = state?.players.find((p) => p.x === 3 && p.y === 3 && (p.health ?? 1) > 0);
  return (
    <div className="round-feed">
      <div className="feed-heading">
        <h3>Last round</h3>
        <span>{state?.round ? `TURN ${state.round}` : 'OPENING'}</span>
      </div>
      {actions ? (
        match.participants.map((p) => {
          const action = actions[p.agentId];
          if (!action) return null;
          const hit = hits.find((h) => h.from.id === p.agentId),
            incoming = hits.find((h) => h.to.id === p.agentId);
          return (
            <div className="story-event" key={p.agentId}>
              <span className="story-mark">
                <ActionMark kind={action.type} />
              </span>
              <div>
                <strong>{p.name}</strong>
                <p>
                  {action.type === 'move'
                    ? `Advanced ${action.direction}`
                    : descriptions[action.type]}
                </p>
                {hit && (
                  <small>
                    {hit.damage} damage to{' '}
                    {match.participants.find((q) => q.agentId === hit.to.id)?.name || 'rival'}
                  </small>
                )}
                {action.type === 'shield' && incoming && (
                  <small>Shield active · {incoming.damage} damage taken</small>
                )}
              </div>
            </div>
          );
        })
      ) : events.length ? (
        events.map((event, i) => (
          <div className="story-event" key={i}>
            <span className="story-mark">
              <ActionMark kind={event.includes(' hit ') ? 'attack' : 'deposit'} />
            </span>
            <p>{named(event)}</p>
          </div>
        ))
      ) : (
        <p className="feed-empty">
          {state?.round
            ? 'Waiting for the next resolved turn.'
            : 'Robots enter the circuit. The first decisions are still hidden.'}
        </p>
      )}
      {match.game === 'flux-duel' && (
        <div className="zone-card">
          <div className="zone-illustration" />
          <div>
            <span className="eyebrow">CENTRAL ZONE</span>
            <strong>
              {controller
                ? `${match.participants.find((p) => p.agentId === controller.id)?.name || 'Agent'} controls the zone`
                : 'Control point unclaimed'}
            </strong>
            <p>Hold the mechanism to earn control points.</p>
          </div>
          <div className="zone-scores">
            {match.participants.map((p) => (
              <span key={p.agentId}>
                {p.name}
                <b>{state?.players.find((q) => q.id === p.agentId)?.objective || 0}</b>
              </span>
            ))}
          </div>
        </div>
      )}
      {match.status === 'active' && (
        <div className="next-turn">
          <span className="eyebrow">NEXT ROUND</span>
          <strong>Decisions stay hidden.</strong>
          <p>
            The next actions appear together when the turn resolves. Spectators never interrupt
            play.
          </p>
        </div>
      )}
    </div>
  );
}
