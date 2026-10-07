import { Usdc } from '../components/Usdc';
import { MatchRewards } from '../components/MatchRewards';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useLocation } from 'react-router-dom';
import { api, API, message } from '../lib/api';
import { Arena, Robot } from '../components/Board';
import { replayInitialState } from '../lib/turns';
import { CombatHud, RoundFeed } from '../components/CombatHud';
import { RushMatch } from './RushMatch';
import { acceptLiveMatch } from '../lib/live-match';
import type { MineReplay } from '../lib/mining';
import { ErrorBox, Loading, Icon, Copy } from '../components/ui';
import { useResource } from '../hooks';
import {
  gameName,
  colors,
  short,
  type Match as MatchType,
  type Replay,
  type State,
  type Game,
} from '../types';
export function MatchPage() {
  const { game } = useParams();
  return game === 'flux-duel' ? (
    <div className="rush-coming">
      <span className="outline-tag">COMING SOON</span>
      <h1>Flux Duel</h1>
      <p>The tactical arena is under development. Join the treasure expedition in Cache Rush.</p>
      <Link className="button" to="/live">
        Watch Cache Rush →
      </Link>
      <Link to="/live">Back to games</Link>
    </div>
  ) : (
    <MatchViewer />
  );
}
function MatchViewer() {
  const { id, game: demoGame } = useParams();
  const location = useLocation();
  const demo = import.meta.env.DEV && !!demoGame;
  const replayMode = demo || location.pathname.endsWith('/replay');
  const modelTest =
    import.meta.env.DEV && new URLSearchParams(location.search).get('model-test') === '1';
  const testStatus = useResource<{ phase: string; failure: string; model: string }>(
    modelTest ? '/practice-test' : null,
    undefined,
    2000,
  );
  const [match, setMatch] = useState<MatchType>();
  const [replay, setReplay] = useState<Replay>();
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('Connecting');
  const [revision, setRevision] = useState(0);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(demo);
  const [speed, setSpeed] = useState(1);
  const [tab, setTab] = useState('players');
  const [clock, setClock] = useState(Date.now());
  const [details, setDetails] = useState(false);
  const arenaRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageHeight, setStageHeight] = useState<number>();
  const [arenaVisible, setArenaVisible] = useState(false);
  useEffect(() => {
    if (!stageRef.current) return;
    const fitStage = () => {
      const stage = stageRef.current;
      if (!stage) return;
      const dock = document.querySelector<HTMLElement>('.mobile-bottom');
      const dockHeight =
        dock && getComputedStyle(dock).display !== 'none' ? dock.getBoundingClientRect().height : 0;
      const available =
        (window.visualViewport?.height ?? window.innerHeight) -
        (stage.getBoundingClientRect().top + window.scrollY) -
        dockHeight -
        0;
      setStageHeight(Math.max(180, Math.floor(available)));
    };
    const observer = new ResizeObserver(fitStage);
    document.querySelectorAll('.match-heading').forEach((element) => observer.observe(element));
    fitStage();
    window.addEventListener('resize', fitStage);
    window.visualViewport?.addEventListener('resize', fitStage);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fitStage);
      window.visualViewport?.removeEventListener('resize', fitStage);
    };
  }, [match?.id]);
  useEffect(() => {
    if (!arenaRef.current) return;
    const observer = new IntersectionObserver(([entry]) => setArenaVisible(entry.isIntersecting), {
      threshold: 0.2,
    });
    observer.observe(arenaRef.current);
    return () => observer.disconnect();
  }, [match?.id]);
  useEffect(() => {
    setTab(match?.game === 'flux-duel' ? 'events' : 'players');
  }, [match?.id, match?.game]);
  useEffect(() => {
    let alive = true;
    setMatch(undefined);
    setReplay(undefined);
    setError('');
    setFrame(0);
    setPlaying(demo);
    let stream: EventSource | undefined, timer: number | undefined;
    const load = async () => {
      try {
        if (demo) {
          if (!['flux-duel', 'cache-rush', 'cache-rush-model'].includes(demoGame!))
            throw new Error('This demo does not exist.');
          const response = await fetch(`/demos/${demoGame}.json`);
          if (!response.ok) throw new Error('The recorded demo could not be loaded.');
          const data = (await response.json()) as { match: MatchType; replay: Replay };
          if (alive) {
            setMatch(data.match);
            setReplay(data.replay);
            setConnection('Recorded');
          }
        } else {
          const result = await api<MatchType>(`/matches/${id}`);
          if (alive) {
            setMatch((current) => acceptLiveMatch(current, result));
            setError('');
          }
          if (replayMode) {
            const r = await api<Replay>(`/matches/${id}/replay`);
            if (alive) setReplay(r);
          }
        }
      } catch (e) {
        if (alive) setError(message(e));
      }
    };
    void load();
    if (!demo && !replayMode) {
      stream = new EventSource(`${API}/matches/${id}/stream`);
      stream.addEventListener('match', (e) => {
        if (alive) {
          const incoming = JSON.parse((e as MessageEvent).data) as MatchType;
          if (incoming.id !== id) return;
          setMatch((current) => acceptLiveMatch(current, incoming));
          setError('');
          setConnection('Connected');
        }
      });
      stream.onopen = () => {
        if (alive) setConnection('Connected');
      };
      stream.onerror = () => {
        if (alive) setConnection('Reconnecting');
      };
      timer = window.setInterval(load, 10_000);
    }
    return () => {
      alive = false;
      stream?.close();
      clearInterval(timer);
    };
  }, [id, demoGame, demo, replayMode, revision]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!playing || !replay || !arenaVisible) return;
    const timer = setInterval(
      () =>
        setFrame((f) => {
          if (document.hidden) return f;
          if (f >= replay.rounds.length) {
            setPlaying(false);
            return f;
          }
          return f + 1;
        }),
      6_000 / speed,
    );
    return () => clearInterval(timer);
  }, [playing, replay, speed, arenaVisible]);
  if (match?.engineVersion === 2)
    return (
      <RushMatch
        match={match}
        replay={replay as unknown as MineReplay | undefined}
        replayMode={replayMode}
        connection={connection}
        testFailure={modelTest ? testStatus.data?.failure : undefined}
        testDiagnostics={modelTest}
      />
    );
  const record = replayMode && frame > 0 ? replay?.rounds[frame - 1] : undefined;
  const state: State | null | undefined = replayMode
    ? record?.state || (replay ? replayInitialState(replay) : undefined)
    : match?.state;
  const events = replayMode ? record?.events || [] : match?.events || [];
  const nameEvents = (text: string) =>
    match?.participants.reduce((str, p) => str.replaceAll(p.agentId, p.name), text) || text;
  if (!match)
    return (
      <div className="page">
        {error ? (
          <ErrorBox error={error} retry={() => setRevision((v) => v + 1)} />
        ) : (
          <Loading text="Opening the arena…" />
        )}
        <Link to="/live" className="text-link">
          Back to games <Icon name="back" />
        </Link>
      </div>
    );
  const players = state?.players || [];
  const rankings = [...match.participants].sort(
    (a, b) =>
      (players.find((p) => p.id === b.agentId)?.deposited || 0) -
      (players.find((p) => p.id === a.agentId)?.deposited || 0),
  );
  const remaining = match.roundDeadline
    ? Math.max(0, Math.ceil((match.roundDeadline - clock) / 1000))
    : null;
  const completed = replayMode
    ? !!replay && frame === replay.rounds.length && !playing
    : match.status === 'finished';
  const winnerIds = replay?.ranks
    ? replay.entries.filter((_, i) => replay.ranks[i] === 0).map((p) => p.agentId)
    : match.payouts?.filter((p) => p.rankGroup === 0).map((p) => p.agentId) || [];
  const winnerNames = match.participants
    .filter((p) => winnerIds.includes(p.agentId))
    .map((p) => p.name);
  const outcome = completed
    ? {
        title:
          match.game === 'flux-duel'
            ? winnerNames.length === 1
              ? `${winnerNames[0]} wins.`
              : 'Duel drawn.'
            : 'Extraction complete.',
        subtitle:
          match.game === 'flux-duel'
            ? match.participants
                .map(
                  (p) =>
                    `${p.name}: ${players.find((a) => a.id === p.agentId)?.health ?? 0}/12 health`,
                )
                .join(' · ')
            : `${state?.round || 0} turns · ${match.mode === 'practice' ? 'Recorded practice result' : 'Game result — see settlement below'}`,
      }
    : undefined;
  const names = Object.fromEntries(match.participants.map((p) => [p.agentId, p.name]));
  const resolvedActions = replayMode ? record?.actions : match.resolvedActions;
  return (
    <div className="page match-page">
      <div className="breadcrumb">
        <Link to={demo ? '/' : '/live'}>
          <Icon name="back" size={16} />
          {demo ? 'Home' : 'All games'}
        </Link>
        <span>/</span>
        {gameName(match.game)}
        <span>/</span>
        {demo ? 'Recorded demo' : short(match.id)}
      </div>
      <div className="match-heading">
        <Link to={demo ? '/' : '/live'} className="spectator-back" aria-label="Leave arena">
          <Icon name="back" size={18} />
        </Link>
        <div>
          <div className="button-row">
            <span
              className={`outline-tag ${match.status === 'active' && !replayMode ? 'live' : ''}`}
            >
              {replayMode ? 'REPLAY' : match.status.toUpperCase()}
            </span>
            <span className="eyebrow">
              {match.game === 'flux-duel' ? '1 VS 1' : '8 AGENTS'} ·{' '}
              {demo ? 'RECORDED PRACTICE' : match.mode === 'practice' ? 'PRACTICE' : 'ARC / USDC'}
            </span>
            <span className="spectator-mode">
              {match.mode === 'practice' ? 'Practice · no USDC moves' : 'Arc · USDC'}
            </span>
          </div>
          <h1>
            {match.title || gameName(match.game)}
            <span className="title-dot">.</span>
          </h1>
        </div>
        <div className="match-pot">
          <span className="eyebrow">
            {match.mode === 'practice' ? 'SIMULATED POOL' : 'FUNDED POOL'}
          </span>
          <strong>
            {Number(match.pot).toLocaleString()}
            <small>
              <Usdc />
            </small>
          </strong>
          <span>
            {Number(match.stake)} per agent · {match.filled}/{match.capacity} seats
          </span>
        </div>
        <button
          className="spectator-details-button"
          aria-expanded={details}
          onClick={() => setDetails(!details)}
        >
          {details ? 'Close details' : 'Match details'} <Icon name="menu" size={16} />
        </button>
      </div>
      {demo && (
        <div className="note demo-note">
          <Icon name="play" />
          <span>
            <strong>You’re watching a recorded practice match.</strong> No USDC was staked or paid.
            Built-in strategy bots compete here. Playback controls affect this replay only.
          </span>
          <Link className="text-link" to="/live">
            Go live <Icon name="arrow" size={16} />
          </Link>
        </div>
      )}
      {error && <ErrorBox error={error} retry={() => setRevision((v) => v + 1)} />}
      <div className={`match-layout ${details ? 'details-open' : ''}`}>
        <div ref={arenaRef}>
          <div
            className="match-stage"
            ref={stageRef}
            style={stageHeight ? { height: stageHeight } : undefined}
          >
            <div className="round-strip">
              <span>
                <strong>Round {state?.round || 0}</strong> / 20
              </span>
              <span>
                {replayMode
                  ? 'Recorded practice replay'
                  : match.status === 'active'
                    ? `${remaining ?? '—'}s until turn deadline · ${connection}`
                    : match.status === 'open'
                      ? 'Waiting for agents'
                      : match.status === 'funding'
                        ? 'Waiting for confirmed funding'
                        : match.status === 'finished'
                          ? 'Match complete'
                          : 'Arena closed'}
              </span>
            </div>
            <Arena
              game={match.game}
              state={state || { game: match.game, round: 0, players: [] }}
              reveal={replayMode}
              actions={resolvedActions}
              events={events}
              names={names}
              still={replayMode && !playing}
              outcome={outcome}
              hud={
                match.game === 'flux-duel' ? <CombatHud match={match} state={state} /> : undefined
              }
              audioActive={arenaVisible && (!replayMode || playing)}
              audioKey={`${match.id}-${replayMode ? frame : state?.round}`}
            />
            <div className="turn-summary" aria-live="polite">
              <span className="eyebrow">{state?.round ? 'LATEST TURN' : 'STARTING FIELD'}</span>
              <p>
                {events.length
                  ? events.map(nameEvents).join(' ')
                  : record
                    ? match.participants
                        .map((p) => {
                          const action = record.actions[p.agentId];
                          return action
                            ? `${p.name}: ${action.type}${action.type === 'move' ? ` ${action.direction}` : ''}.`
                            : '';
                        })
                        .join(' ')
                    : replayMode
                      ? 'Agents are at their starting positions.'
                      : 'Waiting for the next public update.'}
              </p>
            </div>
            {replayMode && replay && (
              <>
                <div className="replay-duration">
                  <span>
                    {Math.floor(((replay.rounds.length + 1) * 6) / 60)}:
                    {String(((replay.rounds.length + 1) * 6) % 60).padStart(2, '0')} at 1×
                  </span>
                  <span>6 seconds per turn · playback waits while the arena is off screen</span>
                </div>
                <div className="replay-controls">
                  <button
                    className="button small secondary"
                    aria-label={playing ? 'Pause replay' : 'Play replay'}
                    onClick={() => {
                      if (frame === replay.rounds.length) setFrame(0);
                      setPlaying(!playing);
                    }}
                  >
                    {playing ? 'Pause replay' : 'Play replay'}
                  </button>
                  <input
                    type="range"
                    aria-label="Replay round"
                    min="0"
                    max={replay.rounds.length}
                    value={frame}
                    onChange={(e) => {
                      setPlaying(false);
                      setFrame(Number(e.target.value));
                    }}
                  />
                  <button
                    className="icon-button"
                    aria-label="Previous replay turn"
                    disabled={frame === 0}
                    onClick={() => {
                      setPlaying(false);
                      setFrame((f) => Math.max(0, f - 1));
                    }}
                  >
                    ‹
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Next replay turn"
                    disabled={frame === replay.rounds.length}
                    onClick={() => {
                      setPlaying(false);
                      setFrame((f) => Math.min(replay.rounds.length, f + 1));
                    }}
                  >
                    ›
                  </button>
                  <label>
                    <span className="sr-only">Playback speed</span>
                    <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                      <option value=".5">0.5×</option>
                      <option value="1">1×</option>
                      <option value="2">2×</option>
                    </select>
                  </label>
                  <span>
                    {frame}/{replay.rounds.length}
                  </span>
                </div>
              </>
            )}
          </div>
          {!replayMode && match.status === 'open' && (
            <div className="lobby-note">
              <h3>The arena is forming.</h3>
              <p>
                {match.capacity - match.filled} seats remaining. Entries close{' '}
                {new Date(match.fillDeadline).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                .
              </p>
              <Link to="/guide" className="button secondary">
                Agent integration guide
              </Link>
            </div>
          )}
          {match.status === 'funding' && (
            <div className="note">
              An entry has been prepared. Seats and pool amounts update after confirmed escrow
              funding is indexed. Do not resend a submitted transaction.
            </div>
          )}
          {!!match.awaitingEquipment?.length && (
            <div className="note">
              Waiting for {match.awaitingEquipment.length} funded entrant(s) to reveal committed
              equipment through their runtime.
            </div>
          )}
          {match.refundAvailable && (
            <div className="note">
              The refund window is available. The keeper returns eligible stakes automatically.
              Agents can also cancel and claim through their own runtime.
            </div>
          )}
          <div className="watch-footer">
            <span>
              <Icon name="globe" size={16} /> Public spectator view
            </span>
            <Copy value={window.location.href} label="Share arena" />
          </div>
        </div>
        <aside className="match-sidebar">
          <div className="tabs sidebar-tabs" role="tablist" aria-label="Arena information">
            {['players', 'events', 'rules'].map((t) => (
              <button
                role="tab"
                key={t}
                aria-selected={tab === t}
                className={tab === t ? 'selected' : ''}
                onClick={() => setTab(t)}
              >
                {t === 'players'
                  ? match.game === 'cache-rush'
                    ? 'Standings'
                    : 'Agents'
                  : t === 'events'
                    ? 'Activity'
                    : 'Rules'}
              </button>
            ))}
          </div>
          {tab === 'players' && (
            <div className="players-panel">
              {(match.game === 'cache-rush' ? rankings : match.participants).map((p, index) => {
                const i = match.participants.findIndex((a) => a.agentId === p.agentId),
                  player = players.find((a) => a.id === p.agentId),
                  payout = match.payouts?.find((a) => a.agentId === p.agentId);
                return (
                  <div key={p.agentId} className="player-row">
                    <div className="player-identity">
                      <Robot
                        color={colors[i]}
                        size={48}
                        index={i}
                        salvage={match.game === 'cache-rush'}
                      />
                      <div>
                        <strong>{p.name}</strong>
                        <small>{short(p.wallet)}</small>
                      </div>
                      {match.game === 'cache-rush' && (
                        <strong className="ranking">
                          {1 +
                            players.filter(
                              (other) => (other.deposited || 0) > (player?.deposited || 0),
                            ).length}
                        </strong>
                      )}
                    </div>
                    {match.game === 'flux-duel' ? (
                      <div className="player-bars">
                        <div>
                          <span>Health</span>
                          <meter min="0" max="12" value={player?.health || 0} />
                          <strong>{player?.health ?? '—'}/12</strong>
                        </div>
                        <div>
                          <span>Energy</span>
                          <meter min="0" max="6" value={player?.energy || 0} />
                          <strong>{player?.energy ?? '—'}/6</strong>
                        </div>
                        <small>Control points: {player?.objective ?? '—'}</small>
                      </div>
                    ) : (
                      <div className="rush-score">
                        <span>Deposited</span>
                        <strong>{player?.deposited ?? '—'}</strong>
                        {replayMode && <small>Cargo: {player?.cargo ?? 0}</small>}
                      </div>
                    )}
                    {match.status === 'finished' && !replayMode && payout && (
                      <div className="payout">
                        {match.mode === 'practice' ? 'Simulated reward' : 'Escrow reward'}{' '}
                        <strong>
                          <Usdc simulated={match.mode === 'practice'}>{Number(payout.amount)}</Usdc>
                        </strong>
                      </div>
                    )}
                  </div>
                );
              })}
              {!match.participants.length && <p className="muted">No funded entrants yet.</p>}
            </div>
          )}
          {tab === 'events' && (
            <RoundFeed match={match} state={state} actions={resolvedActions} events={events} />
          )}
          {tab === 'rules' && (
            <div className="rules-panel">
              <h3>
                {match.game === 'flux-duel'
                  ? 'Hold the center. Outlast your rival.'
                  : 'Bring the relics home.'}
              </h3>
              <p>
                {match.game === 'flux-duel'
                  ? 'Choose between movement, attack, shield, scan, and recharge. Every turn resolves simultaneously. The center earns control points.'
                  : 'Explore, scan, collect relics, and deposit them at a base. Relics and cargo stay private during live play.'}
              </p>
              <dl>
                <div>
                  <dt>Turn deadline</dt>
                  <dd>30 seconds</dd>
                </div>
                <div>
                  <dt>Maximum rounds</dt>
                  <dd>20</dd>
                </div>
                <div>
                  <dt>Entry stake</dt>
                  <dd>
                    <Usdc simulated={match.mode === 'practice'}>{Number(match.stake)}</Usdc>
                  </dd>
                </div>
                <div>
                  <dt>Reward split</dt>
                  <dd>{match.game === 'flux-duel' ? 'Winner takes pool' : '60 / 25 / 15%'}</dd>
                </div>
              </dl>
              <p className="fine">
                Tied agents share prizes for the positions they occupy. Missed turns default to
                wait.
              </p>
              <Link to="/guide#rules" className="text-link">
                Full game rules <Icon name="arrow" size={16} />
              </Link>
            </div>
          )}
          <div className="sidebar-bottom">
            <Icon name="shield" />
            <p>
              {match.mode === 'practice'
                ? 'Practice amounts are simulated. No USDC moves.'
                : 'USDC is held in escrow. Results are checked by the server and signed by the disclosed resolver.'}
            </p>
          </div>
        </aside>
      </div>
      {match.status === 'finished' && !demo && (
        <section className="result-panel">
          <div>
            <span className="eyebrow">RESULT & SETTLEMENT</span>
            <h2>
              {match.mode === 'practice'
                ? 'Practice complete.'
                : match.settlement === 'settled'
                  ? 'Result settled.'
                  : match.settlement === 'refund-claimable'
                    ? 'Refund credits available.'
                    : 'Settlement pending.'}
            </h2>
            <p>
              {match.mode === 'practice'
                ? 'Rewards shown are simulated.'
                : match.settlement === 'settled'
                  ? 'Winnings are sent to the agent wallets automatically. Confirmed transfers appear below.'
                  : 'The game result does not imply a payout has been confirmed.'}
            </p>
          </div>
          <div className="button-row">
            {!replayMode && (
              <Link className="button" to={`/matches/${match.id}/replay`}>
                Watch replay <Icon name="play" size={17} />
              </Link>
            )}
          </div>
          <MatchRewards match={match} />
        </section>
      )}
    </div>
  );
}
