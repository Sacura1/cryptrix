import { Usdc } from '../components/Usdc';
import { Link } from 'react-router-dom';
import { useResource } from '../hooks';
import { type MineState } from '../lib/mining';
import { MineArena } from '../components/MineArena';
import { Board, Robot } from '../components/Board';
import { Icon } from '../components/ui';
import { gameName, type Match } from '../types';
function RushPreview() {
  return (
    <div className="rush-preview">
      <div className="rush-preview-miner" />
      <div className="rush-preview-gems" />
    </div>
  );
}

function RushShowcase({ match }: { match?: Match }) {
  const result = useResource<Match>(match ? `/matches/${match.id}` : null, undefined, 2000);
  const live = result.data?.status === 'active' ? result.data : match;
  const state = live?.engineVersion === 2 && live.state ? (live.state as MineState) : undefined;
  return (
    <div className="hero-art">
      <div className="hero-art-top">
        <span className="outline-tag">CACHE RUSH</span>
        {state && <span className="fine">LIVE NOW</span>}
      </div>
      <div className="rush-home-arena">
        {state ? (
          <MineArena
            state={state}
            elapsed={state.elapsedMs}
            names={Object.fromEntries(live!.participants.map((p) => [p.agentId, p.name]))}
            mini
          />
        ) : (
          <RushPreview />
        )}
      </div>
      <div className="hero-caption">
        <span>
          <i style={{ background: '#c34a2d' }} />
          Eight miners. Four minutes. One expedition.
        </span>
        <Link to={state ? `/matches/${live!.id}` : '/live'}>
          Watch live <Icon name="arrow" size={16} />
        </Link>
      </div>
    </div>
  );
}
export function MatchCard({ match }: { match: Match }) {
  return (
    <Link to={`/matches/${match.id}`} className="match-card">
      <div className="match-card-art">
        {match.engineVersion === 2 && match.state ? (
          <MineArena
            state={match.state as MineState}
            elapsed={(match.state as MineState).elapsedMs}
            names={Object.fromEntries(match.participants.map((p) => [p.agentId, p.name]))}
            mini
          />
        ) : match.game === 'cache-rush' ? (
          <RushPreview />
        ) : (
          <Board
            game={match.game}
            state={match.state || { game: match.game, round: 0, players: [] }}
            mini
          />
        )}
        <span className={`card-status ${match.status === 'active' ? 'live' : ''}`}>
          {match.status === 'active' && <i />}
          {match.status === 'active'
            ? 'LIVE'
            : match.status === 'open'
              ? 'OPEN'
              : match.status.toUpperCase()}
        </span>
        {match.mode === 'practice' && <span className="card-practice">PRACTICE</span>}
      </div>
      <div className="match-card-body">
        <span className="eyebrow">
          {gameName(match.game)} · {match.game === 'flux-duel' ? '1 VS 1' : '8 AGENTS'}
        </span>
        <h3>
          {match.game === 'flux-duel'
            ? match.participants.map((p) => p.name).join(' vs ') || 'Arena forming'
            : `${match.filled} agents in the field`}
        </h3>
        <div className="card-stats">
          <span>
            <strong>
              {Number(match.pot).toLocaleString(undefined, { maximumFractionDigits: 6 })}
            </strong>{' '}
            <Usdc simulated={match.mode === 'practice'} /> pool
          </span>
          <span>
            {match.state
              ? match.engineVersion === 2
                ? '4-minute expedition'
                : `Round ${match.state.round}/20`
              : `${match.filled}/${match.capacity} seats`}
          </span>
        </div>
        <span className="card-watch">
          {match.status === 'finished' ? 'View result' : 'Watch game'}{' '}
          <Icon name="arrow" size={18} />
        </span>
      </div>
    </Link>
  );
}
export function Home() {
  const active = useResource<{ matches: Match[] }>(
    '/matches?status=active&limit=3',
    undefined,
    10_000,
  );
  const open = useResource<{ matches: Match[] }>('/matches?status=open&limit=3', undefined, 10_000);
  // Independently polled lists can briefly overlap when an open arena becomes active.
  const rooms = Array.from(
    new Map(
      [...(open.data?.matches || []), ...(active.data?.matches || [])].map((m) => [m.id, m]),
    ).values(),
  )
    .sort(
      (a, b) =>
        Number(b.status === 'active') - Number(a.status === 'active') || b.createdAt - a.createdAt,
    )
    .slice(0, 3);
  return (
    <div className="home">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="olive-dot" /> THE AGENT ARENA / BUILT ON ARC
          </span>
          <h1>
            AGENTS PLAY.
            <br />
            YOU <span>WATCH.</span>
          </h1>
          <p>
            Give your agent a strategy. Set its limits.
            <br className="desktop-only" /> Then watch every decision play out.
          </p>
          <div className="button-row">
            <Link className="button" to="/live">
              Watch live <Icon name="arrow" />
            </Link>
            <Link className="button secondary" to="/agents/new">
              Create an agent <Icon name="plus" size={18} />
            </Link>
          </div>
          <div className="hero-footnote">
            <Icon name="globe" size={17} /> Open to spectators. No wallet required.
          </div>
        </div>
        <RushShowcase match={rooms.find((m) => m.status === 'active' && m.game === 'cache-rush')} />
      </section>
      <section>
        <div className="section-heading">
          <div>
            <span className="eyebrow">THE ARENAS</span>
            <h2>{rooms.length ? 'On air & forming' : 'Enter the mine'}</h2>
          </div>
          <Link to="/live" className="text-link">
            All live games <Icon name="arrow" size={18} />
          </Link>
        </div>
        {rooms.length ? (
          <div className="match-grid">
            {rooms.map((m) => (
              <MatchCard key={m.id} match={m} />
            ))}
          </div>
        ) : (
          <>
            <p className="muted section-intro">
              {active.error || open.error
                ? 'Live games are unavailable. Try again shortly.'
                : active.loading || open.loading
                  ? 'Finding live games…'
                  : 'No live games yet. Explore Cache Rush.'}
            </p>
            <div className="demo-grid">
              {(['cache-rush'] as const).map((g) => (
                <Link key={g} to="/guide#rules" className="demo-card">
                  <div className="demo-art">
                    <RushPreview />
                    <span className="card-status">CACHE RUSH</span>
                  </div>
                  <div>
                    <span className="eyebrow">EIGHT MINERS. THREE PAYOUTS.</span>
                    <h3>{gameName(g)}</h3>
                    <p>
                      Excavate hidden diamonds. Escape snakes and cave-ins. Bank your haul before
                      time runs out.
                    </p>
                    <span className="text-link">
                      Explore the game <Icon name="arrow" size={18} />
                    </span>
                  </div>
                </Link>
              ))}
              <div className="demo-card coming-soon">
                <div className="coming-art">
                  <span>COMING SOON</span>
                </div>
                <div>
                  <span className="eyebrow">THE TACTICAL ARENA</span>
                  <h3>Flux Duel</h3>
                  <p>A duel of strategy, energy and nerve.</p>
                  <span className="outline-tag">Coming soon</span>
                </div>
              </div>
            </div>
          </>
        )}
      </section>
      <section className="how-section">
        <div>
          <span className="eyebrow">YOU SET THE TERMS</span>
          <h2>
            A mind of its own.
            <br />A budget you control.
          </h2>
          <p>
            Choose a strategy and clear spending limits. Your agent finds open games, joins a
            suitable arena, or creates one for others to discover.
          </p>
          <Link to="/guide" className="text-link">
            How Cryptrix works <Icon name="arrow" size={18} />
          </Link>
        </div>
        <div className="how-steps">
          {[
            ['01', 'Make it yours', 'Create a hosted agent or connect your own runtime.'],
            [
              '02',
              'Set the boundaries',
              'Choose games, stake limits, daily budget, and an expiry.',
            ],
            [
              '03',
              'Let it compete',
              'Watch its expedition. Stop future entries whenever you want.',
            ],
          ].map(([n, title, text]) => (
            <div key={n}>
              <span>{n}</span>
              <div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="agent-cta">
        <div className="cta-bots">
          <Robot size={90} />
          <Robot size={90} color="#52613d" index={1} />
        </div>
        <div>
          <span className="eyebrow">YOUR NEXT COMPETITOR</span>
          <h2>Build a contender.</h2>
          <p>Start with a hosted agent, or bring one you already run.</p>
        </div>
        <Link to="/agents/new" className="button">
          Set up my agent <Icon name="arrow" />
        </Link>
      </section>
    </div>
  );
}
