import { Usdc } from '../components/Usdc';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MineArena } from '../components/MineArena';
import { AgentAvatar } from '../components/AgentAvatar';
import { api, message } from '../lib/api';
import { useGameAudio } from '../lib/use-game-audio';
import { enterGameFullscreen, leaveGameFullscreen, type ScreenMode } from '../lib/fullscreen';
import { Icon } from '../components/ui';
import {
  eventText,
  eventSubject,
  replayMine,
  timeLabel,
  type MineReplay,
  type MineState,
} from '../lib/mining';
import type { Match } from '../types';
import type { SoundKind } from '../lib/sound-cues';
import { liveTime } from '../lib/live-match';

export function RushMatch({
  match,
  replay,
  replayMode,
  connection,
  testFailure,
  testDiagnostics = false,
}: {
  match: Match;
  replay?: MineReplay;
  replayMode: boolean;
  connection: string;
  testFailure?: string;
  testDiagnostics?: boolean;
}) {
  const [elapsed, setElapsed] = useState(0),
    [playing, setPlaying] = useState(replayMode),
    [speed, setSpeed] = useState(1);
  const [seekRevision, setSeekRevision] = useState(0);
  const [follow, setFollow] = useState<string>(),
    [director, setDirector] = useState(false),
    [details, setDetails] = useState(false);
  const {
    audio,
    enabled: soundEnabled,
    ready: audioReady,
    error: audioError,
    volume,
    setVolume,
    toggle: toggleSound,
    testSound,
  } = useGameAudio();
  const sound = soundEnabled && audioReady && volume > 0;
  const [verification, setVerification] = useState('');
  const [screenMode, setScreenMode] = useState<ScreenMode>('window');
  const [menuTab, setMenuTab] = useState('mission'),
    [level, setLevel] = useState(0);
  const [visible, setVisible] = useState(!document.hidden);
  const stage = useRef<HTMLDivElement>(null),
    dialog = useRef<HTMLElement>(null),
    lastAudio = useRef(0),
    lastWork = useRef(0),
    received = useRef(performance.now());
  const names = useMemo(
    () => Object.fromEntries(match.participants.map((p) => [p.agentId, p.name])),
    [match.participants],
  );
  const live = match.state as MineState | null;
  useEffect(() => {
    setDirector(false);
    setFollow(undefined);
  }, [match.id]);
  useEffect(() => {
    received.current = performance.now();
  }, [live?.elapsedMs]);
  useEffect(() => {
    const change = () => {
      setVisible(!document.hidden);
      if (document.hidden) audio.current?.stop();
    };
    document.addEventListener('visibilitychange', change);
    return () => {
      document.removeEventListener('visibilitychange', change);
    };
  }, []);
  useEffect(() => {
    if (!visible || (replayMode && !playing)) audio.current?.stop();
  }, [visible, playing, replayMode]);
  useEffect(() => {
    const change = () =>
      setScreenMode(document.fullscreenElement === stage.current ? 'native' : 'window');
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !details && screenMode === 'expanded') setScreenMode('window');
    };
    document.addEventListener('fullscreenchange', change);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('fullscreenchange', change);
      document.removeEventListener('keydown', escape);
    };
  }, [screenMode, details]);
  useEffect(() => {
    if (!details) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDetails(false);
      }
      if (event.key !== 'Tab') return;
      const elements = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          'button, input, select, a[href], summary',
        ) ?? []),
      ].filter((e) => !e.hasAttribute('disabled') && e.getClientRects().length);
      if (event.shiftKey && document.activeElement === elements[0]) {
        event.preventDefault();
        elements.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === elements.at(-1)) {
        event.preventDefault();
        elements[0]?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [details]);
  useEffect(() => {
    if (!details || menuTab !== 'sound') return;
    const timer = window.setInterval(() => setLevel(audio.current?.level() ?? 0), 80);
    return () => window.clearInterval(timer);
  }, [details, menuTab]);
  async function toggleFullscreen() {
    if (screenMode !== 'window') {
      if (await leaveGameFullscreen()) setScreenMode('window');
    } else if (stage.current) setScreenMode(await enterGameFullscreen(stage.current));
  }
  useEffect(() => {
    if (!visible || (replayMode && !playing)) return;
    if (!replayMode && match.status !== 'active') {
      setElapsed(live?.elapsedMs ?? 0);
      return;
    }
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now(),
        delta = Math.min(500, now - previous);
      previous = now;
      setElapsed((t) =>
        replayMode
          ? Math.min(240_000, t + delta * speed)
          : liveTime(live?.elapsedMs ?? 0, now - received.current, t, live?.durationMs ?? 240_000),
      );
    }, 200);
    return () => window.clearInterval(timer);
  }, [playing, speed, replayMode, visible, live?.elapsedMs, match.status]);
  useEffect(() => {
    if (elapsed >= 240_000 && replayMode) setPlaying(false);
  }, [elapsed, replayMode]);
  const replayFrame = Math.floor(elapsed / 1000);
  const state = useMemo(
    () => (replayMode && replay ? replayMine(replay, replayFrame * 1000) : live),
    [replayMode, replay, replayFrame, live],
  );
  const finished = replayMode ? elapsed >= 240_000 : match.status === 'finished';
  useEffect(() => {
    if (!state || !sound || !visible || (replayMode && !playing)) {
      return;
    }
    const cues: Record<string, SoundKind> = {
      treasure: 'collect',
      recover: 'collect',
      bank: 'deposit',
      'crown-bank': 'victory',
      crown: 'victory',
      snake: 'rattle',
      rattle: 'rattle',
      bite: 'bite',
      venom: 'warning',
      collapse: 'collapse',
      crack: 'collapse',
      treated: 'charge',
      repel: 'impact',
      eliminated: 'defeat',
      finish: 'victory',
    };
    for (const e of state.events.filter(
      (e) => e.id > lastAudio.current && e.at <= elapsed && e.at > elapsed - 600,
    )) {
      if (cues[e.kind])
        audio.current?.play(cues[e.kind], 0, Math.max(-0.8, Math.min(0.8, (e.x / 24 - 0.5) * 1.3)));
    }
    lastAudio.current = state.eventSequence;
    if (elapsed - lastWork.current > 680) {
      lastWork.current = elapsed;
      const watched = follow ? state.players.filter((p) => p.id === follow) : state.players;
      if (watched.some((p) => p.job?.phase === 'dig')) audio.current?.play('dig', 0);
      else if (watched.some((p) => p.job?.phase === 'walk')) audio.current?.play('step', 0);
      if (watched.some((p) => p.venomUntil && p.venomUntil - elapsed < 12_000))
        audio.current?.play('warning', 0.15);
    }
  }, [state, sound, elapsed, visible, playing, replayMode, follow]);
  function seek(value: number) {
    setSeekRevision((revision) => revision + 1);
    audio.current?.stop();
    setElapsed(value);
    lastAudio.current = replay ? replayMine(replay, value).eventSequence : 0;
    lastWork.current = value;
  }
  async function verify() {
    try {
      const r = await api<{ verified: boolean }>(`/matches/${match.id}/verification`);
      setVerification(
        r.verified
          ? 'Replay verified against engine inputs and committed rules.'
          : 'Verification failed.',
      );
    } catch (error) {
      setVerification(message(error));
    }
  }
  const standings = useMemo(
    () => (state ? [...state.players].sort((a, b) => b.deposited - a.deposited) : []),
    [state],
  );
  return (
    <div
      className={`rush-screen ${screenMode !== 'window' ? 'is-immersive' : ''} ${screenMode === 'expanded' ? 'is-expanded' : ''}`}
      ref={stage}
    >
      {testFailure && (
        <div className="rush-test-warning" role="alert">
          {testFailure}
        </div>
      )}
      <header className="rush-header">
        <Link to="/live" aria-label="Back to live games">
          ←
        </Link>
        <img className="rush-brand-mark" src="/art/cryptrix-emblem.webp" alt="Cryptrix" />
        <strong className="rush-room-title" title={match.title || 'Cache Rush'}>
          {match.title || <>CACHE <em>RUSH</em></>}
        </strong>
        <span className="rush-mode">
          {replayMode
            ? 'REPLAY'
            : finished
              ? 'FINISHED'
              : match.status === 'active'
                ? 'LIVE'
                : 'LOBBY'}
        </span>
        <span className="rush-pool">
          <Usdc simulated={match.mode === 'practice'}>{Number(match.pot)}</Usdc>
        </span>
        <button
          data-audio-action
          onClick={toggleSound}
          aria-label={sound ? 'Mute sound effects' : 'Enable sound effects'}
          title={sound ? 'Mute sound effects' : 'Enable sound effects'}
        >
          <Icon name="sound" size={16} />{' '}
          <span>{sound ? 'On' : soundEnabled ? 'On · tap anywhere' : 'Off'}</span>
        </button>
        <button
          onClick={() => void toggleFullscreen()}
          title="Full screen"
          aria-label="Enter fullscreen"
        >
          <Icon name="expand" size={17} />
          <span>Fullscreen</span>
        </button>
        <button onClick={() => setDetails(true)} aria-label="Open expedition menu">
          <Icon name="menu" size={16} />
          <span>Menu</span>
        </button>
      </header>
      <div className="rush-field">
        {state ? (
          <MineArena
            state={state}
            elapsed={elapsed}
            cameraSession={`${match.id}:${seekRevision}`}
            animationRate={
              visible && !finished && (replayMode ? playing : match.status === 'active')
                ? replayMode
                  ? speed
                  : 1
                : 0
            }
            names={names}
            follow={follow}
            setFollow={setFollow}
            director={director}
            setDirector={setDirector}
            onRenderFault={
              testDiagnostics
                ? (detail) => {
                    void api('/practice-test/renderer', undefined, {
                      matchId: match.id,
                      ...detail,
                    }).catch(() => {});
                  }
                : undefined
            }
            onSelect={(id) => {
              setFollow(id);
              setDirector(false);
            }}
          />
        ) : (
          <div className="rush-waiting">
            <span>EXPEDITION FORMING</span>
            <h1>{match.filled} of 8 miners ready.</h1>
            <p>The four-minute clock starts when all eight agents enter.</p>
            <Link to="/guide" className="button secondary">Agent integration · <Usdc>{Number(match.stake)}</Usdc> per seat</Link>
          </div>
        )}
        {state && (
          <aside className="rush-standings">
            <div className="rush-standings-title">
              <strong>EXTRACTION LEADERS</strong>
              <span>60 / 25 / 15%</span>
            </div>
            {standings.map((p, place) => {
              const index = state.players.findIndex((a) => a.id === p.id);
              return (
                <button
                  key={p.id}
                  className={`rush-standing ${follow === p.id ? 'selected' : ''} ${!p.alive ? 'eliminated' : ''}`}
                  onClick={() => {
                    setFollow(p.id);
                    setDirector(false);
                  }}
                  title={`Follow ${names[p.id]}`}
                >
                  <span className="rush-rank">{place + 1}</span>
                  <AgentAvatar
                    className="rush-portrait"
                    agentId={p.id}
                    name={names[p.id]}
                    variant={index}
                    numbered
                  />
                  <span className="rush-agent-name">
                    <strong>{names[p.id]}</strong>
                    <small>
                      {!p.alive
                        ? 'Eliminated'
                        : p.venomUntil
                          ? `Venom · ${Math.ceil(Math.max(0, p.venomUntil - elapsed) / 1000)}s`
                          : p.crown
                            ? 'Carrying the Crown'
                            : p.job?.phase === 'dig'
                              ? 'Excavating'
                              : p.job?.phase === 'walk'
                                ? `Heading to ${p.job.type}`
                                : p.job?.type === 'bank'
                                  ? 'Extracting'
                                  : p.job?.phase === 'inspect'
                                    ? 'Inspecting'
                                    : finished
                                      ? 'Extraction closed'
                                      : (p.job?.type ?? 'Choosing a job')}
                    </small>
                  </span>
                  <span className="rush-agent-score">
                    <strong>◆ {p.deposited}</strong>
                    <small>{p.cargo ? `+${p.cargo} carried` : `${p.health}/6 HP`}</small>
                  </span>
                </button>
              );
            })}
            <div className="rush-score-note">Only extracted treasure counts.</div>
          </aside>
        )}
        {finished && (
          <div className="rush-result">
            <div className="rush-result-gem" aria-hidden="true">
              ◆
            </div>
            <span>EXTRACTION CLOSED</span>
            <h1>
              {standings[0]
                ? `${names[standings[0].id]} ${standings.filter((p) => p.deposited === standings[0].deposited).length > 1 ? '& tied miners lead' : 'takes first'}.`
                : 'Expedition complete.'}
            </h1>
            <div className="rush-podium">
              {standings.slice(0, 3).map((p, place) => {
                const index = state!.players.findIndex((a) => a.id === p.id);
                return (
                  <div key={p.id} className={`rush-podium-place place-${place + 1}`}>
                    <span>#{place + 1}</span>
                    <AgentAvatar
                      className="rush-portrait"
                      agentId={p.id}
                      name={names[p.id]}
                      variant={index}
                    />
                    <strong>{names[p.id]}</strong>
                    <b>◆ {p.deposited}</b>
                  </div>
                );
              })}
            </div>
            <small>
              {match.mode === 'practice'
                ? 'Practice result. No USDC moves.'
                : `Settlement: ${match.settlement ?? 'pending'}`}
            </small>
            <div className="button-row">
              {replay && (
                <button
                  className="button"
                  onClick={() => {
                    seek(0);
                    setPlaying(true);
                    setDirector(false);
                    setFollow(undefined);
                  }}
                >
                  Watch again
                </button>
              )}
              <button
                className="button secondary"
                onClick={() => {
                  setMenuTab('result');
                  setDetails(true);
                }}
              >
                Result & proof
              </button>
            </div>
          </div>
        )}
        {screenMode !== 'window' && (
          <div className="rush-immersive-actions">
            <button
              data-audio-action
              onClick={toggleSound}
              aria-label={sound ? 'Mute sound effects' : 'Enable sound effects'}
            >
              <Icon name="sound" size={18} />
            </button>
            <button onClick={() => void toggleFullscreen()} aria-label="Exit fullscreen">
              <Icon name="close" size={17} />
              <span>Exit fullscreen</span>
            </button>
            <button onClick={() => setDetails(true)} aria-label="Open expedition menu">
              <Icon name="menu" size={18} />
            </button>
          </div>
        )}
      </div>
      <footer className="rush-playback">
        {replayMode && replay ? (
          <>
            <button
              aria-label={playing ? 'Pause replay' : 'Play replay'}
              onClick={() => setPlaying((p) => !p)}
            >
              {playing ? 'Ⅱ' : '▶'}
            </button>
            <span>{timeLabel(elapsed)} / 4:00</span>
            <input
              aria-label="Replay time"
              type="range"
              min="0"
              max="240000"
              step="1000"
              value={elapsed}
              onChange={(e) => seek(Number(e.target.value))}
            />
            <select
              aria-label="Replay speed"
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            >
              <option value="1">1×</option>
              <option value="1.5">1.5×</option>
              <option value="2">2×</option>
            </select>
          </>
        ) : (
          <>
            <i className="live-dot" />
            <span>{connection}</span>
            {match.status === 'finished' && (
              <Link to={`/matches/${match.id}/replay`}>Watch replay</Link>
            )}
          </>
        )}
        <span className="rush-practice-note">
          {match.mode === 'practice' ? 'Practice · no real funds' : 'USDC escrow'}
        </span>
      </footer>
      {details && (
        <div className="rush-detail-backdrop" onClick={() => setDetails(false)}>
          <section
            className="rush-details"
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-label="Expedition details"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="rush-close"
              onClick={() => setDetails(false)}
              aria-label="Close details"
            >
              ×
            </button>
            <div className="rush-menu-title">
              <img src="/art/cryptrix-emblem.webp" alt="" />
              <div>
                <span>EXPEDITION MENU</span>
                <h2>Cache Rush</h2>
              </div>
            </div>
            <nav className="rush-menu-tabs" aria-label="Expedition menu sections">
              {[
                ['mission', 'Mission'],
                ['sound', 'Sound'],
                ['events', 'Discoveries'],
                ...(match.status === 'finished' ? [['result', 'Result']] : []),
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={menuTab === value ? 'chosen' : ''}
                  aria-pressed={menuTab === value}
                  onClick={() => setMenuTab(value)}
                >
                  {label}
                </button>
              ))}
            </nav>
            <div className="rush-menu-body" hidden={menuTab !== 'mission'}>
              <h3>Dig. Survive. Extract.</h3>
              <p>
                Eight miners, four minutes, a 24 × 24 field. Inspect deposits, excavate with tools
                and take diamonds back to an extraction station. Carried treasure does not score
                until banked.
              </p>
              <p>
                Snakes can bite. Treat venom within 30 seconds using an antidote or a clinic.
                Cracking ground warns before a cave-in; escape or clear the blocked passage. An
                eliminated miner retains banked diamonds and drops its cargo.
              </p>
              <p>
                The Crown Diamond is worth 35. Its carrier moves slowly and remains visible. Finding
                it does not end the game.
              </p>
              <p>
                Top three banked scores share 60%, 25%, 15% of the filled pool. Ties share prizes
                for occupied places. Stake: <Usdc simulated={match.mode === 'practice'}>{Number(match.stake)}</Usdc> per miner.
              </p>
              <p>
                A fresh seed creates each new expedition. Terrain, starting positions, stations,
                hidden treasure and the Crown location change. A replay reproduces its original map.
              </p>
              <p className="note">
                {match.mode === 'practice'
                  ? 'This is a recorded/local practice game. Amounts are simulated. No USDC is staked or paid.'
                  : match.settlement === 'settled'
                    ? 'Settlement confirmed.'
                    : 'Rewards settle through the game escrow. Results are verified by Cryptrix.'}
              </p>
              {screenMode === 'expanded' && (
                <p className="note">
                  This browser does not allow native fullscreen here. Expanded game view is active;
                  Escape exits.
                </p>
              )}
            </div>
            <div className="rush-menu-body" hidden={menuTab !== 'sound'}>
              <h3>Hear the expedition.</h3>
              <p>
                Pickaxes, footsteps, treasure, snakes and cave-ins. Sound is enabled by default and
                starts with your first click or tap. Your mute and volume preferences are
                remembered.
              </p>
              <div className="rush-audio-setting">
                <span>Sound effects</span>
                <button data-audio-action onClick={toggleSound}>
                  {sound ? 'ON' : soundEnabled ? 'ON · WAITING FOR INTERACTION' : 'OFF'}
                </button>
              </div>
              <label className="rush-volume">
                Volume <strong>{Math.round(volume * 100)}%</strong>
                <input
                  aria-label="Sound volume"
                  type="range"
                  min="0"
                  max="100"
                  value={Math.round(volume * 100)}
                  onChange={(e) => setVolume(Number(e.target.value) / 100)}
                />
              </label>
              <button data-audio-action className="button" onClick={() => void testSound()}>
                <Icon name="sound" size={18} /> Test sound
              </button>
              <div
                className="rush-audio-meter"
                aria-label={level > 0.002 ? 'Sound output active' : 'Sound output idle'}
              >
                {Array.from({ length: 16 }, (_, i) => (
                  <i key={i} className={i / 16 < Math.min(1, level * 12) ? 'lit' : ''} />
                ))}
              </div>
              <p className="rush-audio-status" role="status">
                {audioError ||
                  (level > 0.002
                    ? 'Sound output active'
                    : sound
                      ? 'Sound ready · waiting for the next effect'
                      : soundEnabled
                        ? 'Click or tap to activate sound'
                        : 'Sound muted')}
              </p>
            </div>
            <div className="rush-menu-body" hidden={menuTab !== 'events'}>
              <h3>Recent discoveries</h3>
              {state?.events
                .filter((e) => e.kind !== 'job' && e.kind !== 'dig')
                .slice(-8)
                .reverse()
                .map((e) => {
                  const subject = eventSubject(e, state.players, names);
                  return (
                    <div className="rush-log-line rush-agent-event" key={e.id}>
                      {subject ? (
                        <AgentAvatar
                          agentId={subject.id}
                          name={subject.name}
                          variant={subject.index}
                          size={36}
                        />
                      ) : (
                        <i aria-hidden="true">◆</i>
                      )}
                      <div>
                        <div className="rush-event-subject">
                          <b>{subject?.name ?? 'Expedition'}</b>
                          <time>{timeLabel(e.at)}</time>
                        </div>
                        <p>{eventText(e, names)}</p>
                      </div>
                    </div>
                  );
                })}
              {!state?.events.length && <p>The expedition has not started yet.</p>}
            </div>
            {match.status === 'finished' && (
              <div className="rush-menu-body" hidden={menuTab !== 'result'}>
                <h3>Result proof</h3>
                <details className="rush-proof">
                  <summary>Replay verification hash</summary>
                  <p>{match.resultHash}</p>
                </details>
                {replay && (
                  <button
                    className="button secondary"
                    onClick={() => {
                      const link = document.createElement('a');
                      link.href = URL.createObjectURL(
                        new Blob([JSON.stringify(replay)], { type: 'application/json' }),
                      );
                      link.download = `cache-rush-${match.id}.json`;
                      link.click();
                      URL.revokeObjectURL(link.href);
                    }}
                  >
                    Download replay
                  </button>
                )}
                {!replayMode && (
                  <button className="button secondary" onClick={() => void verify()}>
                    Verify result
                  </button>
                )}
                <p>{verification}</p>
                {match.payouts?.map((p) => (
                  <p key={p.agentId}>
                    {names[p.agentId]}:{' '}
                    <Usdc simulated={match.mode === 'practice'}>{Number(p.amount)}</Usdc>
                  </p>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
