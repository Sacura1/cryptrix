import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useArenaSound } from '../hooks/useArenaSound';
import { colors, type Game, type State, type TurnAction } from '../types';
import { turnEffects } from '../lib/turns';
import { Icon } from './ui';

export function Robot({
  color = '#c34a2d',
  size = 64,
  index = 0,
  salvage = false,
  badge = true,
}: {
  color?: string;
  size?: number;
  index?: number;
  salvage?: boolean;
  badge?: boolean;
}) {
  const sprite = salvage ? 2 + (index % 2) : index % 4;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <ellipse cx="32" cy="51" rx="25" ry="9" fill="#171e14" opacity=".3" />
      <svg x="0" y="0" width="64" height="64" viewBox="0 0 64 64" overflow="hidden">
        <image
          href="/art/robot-atlas.webp"
          width="128"
          height="128"
          x={-(sprite % 2) * 64}
          y={-Math.floor(sprite / 2) * 64}
        />
      </svg>
      {badge && (
        <>
          <circle cx="51" cy="52" r="8" fill={color} stroke="#f2e6ca" strokeWidth="1.5" />
          <text
            x="51"
            y="55"
            textAnchor="middle"
            fontSize="8"
            fill="#fff7e8"
            fontFamily="Manrope"
            fontWeight="800"
          >
            {index + 1}
          </text>
        </>
      )}
    </svg>
  );
}

function previewState(game: Game): State {
  return game === 'flux-duel'
    ? {
        game,
        round: 0,
        players: [
          { id: 'a', x: 1, y: 3, health: 12, energy: 6, objective: 0 },
          { id: 'b', x: 5, y: 3, health: 12, energy: 6, objective: 0 },
        ],
      }
    : {
        game,
        round: 0,
        bases: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
        hazards: [
          { x: 3, y: 3 },
          { x: 7, y: 3 },
          { x: 7, y: 7 },
          { x: 3, y: 7 },
        ],
        players: Array.from({ length: 8 }, (_, i) => ({
          id: String(i),
          x: [1, 9, 10, 10, 9, 1, 0, 0][i],
          y: [0, 0, 1, 9, 10, 10, 9, 1][i],
          deposited: 0,
        })),
      };
}

export function Board({
  game,
  state,
  mini = false,
  reveal = false,
  actions,
  events = [],
  names = {},
  still = false,
  aspect = 1.25,
}: {
  game: Game;
  state?: State | null;
  mini?: boolean;
  reveal?: boolean;
  actions?: Record<string, TurnAction>;
  events?: string[];
  names?: Record<string, string>;
  still?: boolean;
  aspect?: number;
}) {
  const uid = useId().replaceAll(':', '_');
  const s = state || previewState(game),
    n = game === 'flux-duel' ? 7 : 11;
  const worldWidth = Math.max(320, 800 * aspect),
    left = worldWidth * 0.11,
    fieldWidth = worldWidth * 0.78;
  const tileX = fieldWidth / n,
    tileY = 624 / n,
    robotSize =
      game === 'flux-duel' ? Math.min(116, Math.max(78, tileX * 0.94)) : Math.min(66, tileX * 0.92);
  const at = (p: { x: number; y: number }) => ({
    x: left + (p.x + 0.5) * tileX,
    y: 88 + (p.y + 0.5) * tileY,
  });
  const effects = turnEffects(s, actions, events);
  const shots = [
    ...effects.hits.map((hit) => ({ ...hit, miss: false })),
    ...events.flatMap((event) => {
      const match = /^(.+) missed: target out of range\.$/.exec(event);
      const from = match && s.players.find((p) => p.id === match[1]);
      const to = from && s.players.find((p) => p.id !== from.id);
      return from && to ? [{ from, to, damage: 0, miss: true }] : [];
    }),
  ];
  const controller = s.players.find((p) => p.x === 3 && p.y === 3 && (p.health ?? 1) > 0);
  return (
    <svg
      className={`arena-svg illustrated-world ${mini ? 'mini' : ''} ${still ? 'effects-still' : ''}`}
      viewBox={`0 0 ${worldWidth} 800`}
      role="img"
      aria-label={`${game === 'flux-duel' ? 'Duel' : 'Rush'} illustrated battlefield${state ? `, round ${state.round}` : ', illustrative preview'}`}
    >
      <defs>
        <filter id={`${uid}-bloom`} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <radialGradient id={`${uid}-shield`}>
          <stop stopColor="#f8db82" stopOpacity="0" />
          <stop offset=".75" stopColor="#f8db82" stopOpacity=".08" />
          <stop offset="1" stopColor="#fff0b0" stopOpacity=".55" />
        </radialGradient>
        <radialGradient id={`${uid}-energy`}>
          <stop stopColor="#ffe6a1" stopOpacity=".7" />
          <stop offset="1" stopColor="#e8b54d" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${uid}-vignette`} x2="0" y2="1">
          <stop stopColor="#10170f" stopOpacity=".3" />
          <stop offset=".35" stopOpacity="0" />
          <stop offset=".75" stopOpacity="0" />
          <stop offset="1" stopColor="#111b12" stopOpacity=".6" />
        </linearGradient>
      </defs>
      <image
        href={`/art/${game === 'flux-duel' ? 'duel' : 'rush'}-ruins.webp`}
        width={worldWidth}
        height="800"
        preserveAspectRatio="none"
      />
      <rect width={worldWidth} height="800" fill={`url(#${uid}-vignette)`} />
      {!mini && (
        <g stroke="#26321c" strokeOpacity=".1" strokeWidth="1">
          {Array.from({ length: n + 1 }, (_, i) => (
            <g key={i}>
              <path d={`M${left + i * tileX} 88v624M${left} ${88 + i * tileY}h${fieldWidth}`} />
            </g>
          ))}
        </g>
      )}
      {game === 'flux-duel' && (
        <g transform={`translate(${worldWidth / 2},400)`} className="control-mechanism">
          <circle
            r="61"
            fill="none"
            stroke={controller ? colors[s.players.indexOf(controller)] : '#eac071'}
            strokeWidth="4"
            opacity=".85"
          />
          <circle r="54" fill="none" stroke="#ffe2a4" strokeWidth="2" strokeDasharray="3 9" />
          <circle r="13" fill="#ffd991" opacity=".8" filter={`url(#${uid}-bloom)`} />
          <circle r="8" fill="#ffdd8f" />
        </g>
      )}
      {s.hazards?.map((p, i) => {
        const c = at(p);
        return (
          <g key={i} transform={`translate(${c.x},${c.y})`}>
            <circle
              r={tileY * 0.4}
              fill="#a0432033"
              stroke="#dd9455"
              strokeDasharray="5 4"
              strokeWidth="2"
            />
            <path d="M0-16 17 14H-17Z" fill="#9c4222" stroke="#efc986" strokeWidth="2" />
            <text y="9" textAnchor="middle" fill="#ffe3a5" fontSize="20" fontWeight="800">
              !
            </text>
          </g>
        );
      })}
      {s.bases?.map((p, i) => {
        const c = at(p);
        return (
          <g key={i} transform={`translate(${c.x},${c.y})`}>
            <rect
              x="-28"
              y="-24"
              width="56"
              height="48"
              rx="5"
              fill="#333d2b"
              stroke="#ddbb76"
              strokeWidth="3"
            />
            <circle r="19" fill="#e7a83e22" stroke="#f4be59" strokeWidth="2" />
            <path d="M0-10 10 0 0 10-10 0Z" fill="#f0be69" />
          </g>
        );
      })}
      {reveal &&
        Object.entries(s.relics || {})
          .filter(([, count]) => count > 0)
          .map(([key, count]) => {
            const [x, y] = key.split(',').map(Number),
              c = at({ x, y });
            return (
              <g key={key} transform={`translate(${c.x},${c.y})`}>
                <ellipse cy="15" rx="18" ry="5" fill="#25321f" opacity=".35" />
                <path
                  d="M0-24 13-6 8 14-7 15-14-6Z"
                  fill="#e7a137"
                  stroke="#6e431f"
                  strokeWidth="2"
                />
                <path
                  d="M0-24 0 13-14-6M0-24 13-6 0 13"
                  fill="#f6ce71"
                  stroke="#fff0b0"
                  strokeWidth="1"
                />
                <text
                  x="15"
                  y="23"
                  fill="#fff5dd"
                  stroke="#3c3524"
                  strokeWidth="4"
                  paintOrder="stroke"
                  fontSize="14"
                  fontWeight="800"
                >
                  {count}
                </text>
              </g>
            );
          })}
      {!mini &&
        shots.map((hit, i) => {
          const from = at(hit.from),
            target = at(hit.to),
            to = hit.miss
              ? { x: from.x + (target.x - from.x) * 0.72, y: from.y + (target.y - from.y) * 0.72 }
              : target,
            hue = s.players.indexOf(hit.from) % 2 ? '#ffe4a2' : '#ffaf57';
          const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
          return (
            <g key={`${s.round}-${i}`} className="shot-sequence">
              <path
                className="shot-trail"
                d={`M${from.x} ${from.y}L${to.x} ${to.y}`}
                stroke={hue}
                strokeWidth="10"
                filter={`url(#${uid}-bloom)`}
              />
              <path
                className="shot-trail"
                d={`M${from.x} ${from.y}L${to.x} ${to.y}`}
                stroke="#fff5c9"
                strokeWidth="2.5"
              />
              <path
                className="shot-projectile"
                d={`M${from.x} ${from.y}L${to.x} ${to.y}`}
                pathLength="100"
                stroke={hue}
                strokeWidth="7"
                strokeLinecap="round"
                strokeDasharray="12 88"
              />
              <g transform={`translate(${from.x},${from.y}) rotate(${angle})`}>
                <path
                  className="muzzle-flash"
                  d="M38 0 57-9 52-2 78 0 52 3 60 10Z"
                  fill="#fff0b0"
                />
              </g>
              <g transform={`translate(${to.x},${to.y})`}>
                {!hit.miss && <circle className="hit-burst" r="65" fill={`url(#${uid}-energy)`} />}
                {!hit.miss && (
                  <g className="impact-sparks" stroke="#ffe9a5" strokeWidth="3">
                    {Array.from({ length: 9 }, (_, j) => (
                      <path key={j} transform={`rotate(${j * 40})`} d="M48 0h34" />
                    ))}
                  </g>
                )}
                <text
                  className="damage-float"
                  x="32"
                  y="-38"
                  fill="#fff1c1"
                  stroke="#81341b"
                  strokeWidth="5"
                  paintOrder="stroke"
                  fontSize="31"
                  fontWeight="800"
                  fontFamily="Barlow Condensed"
                >
                  {hit.miss ? 'OUT OF RANGE' : `−${hit.damage}`}
                </text>
              </g>
            </g>
          );
        })}
      {s.players.map((p, i) => {
        const c = at(p),
          enemy = s.players.find((q) => q.id !== p.id),
          action = actions?.[p.id];
        const peers = s.players.filter((q) => q.x === p.x && q.y === p.y),
          peer = peers.indexOf(p);
        const spread =
          game === 'cache-rush' && peers.length > 1 ? (peer - (peers.length - 1) / 2) * 44 : 0;
        const orientation =
          game === 'flux-duel' && enemy
            ? (Math.atan2(at(enemy).y - c.y, at(enemy).x - c.x) * 180) / Math.PI + (i % 2 ? 180 : 0)
            : 0;
        const isHit = effects.hits.some((hit) => hit.to.id === p.id);
        return (
          <g
            key={p.id}
            className="world-agent"
            style={{ transform: `translate(${c.x + spread}px,${c.y}px)` }}
          >
            {!mini && (
              <ellipse
                cy={robotSize * 0.31}
                rx={robotSize * 0.36}
                ry={robotSize * 0.13}
                fill="#13200f"
                opacity=".45"
              />
            )}
            {!mini && (
              <ellipse
                rx={robotSize * 0.45}
                ry={robotSize * 0.32}
                fill="none"
                stroke={colors[i % colors.length]}
                strokeWidth="2"
                opacity=".7"
              />
            )}
            <g
              style={{ transform: `rotate(${orientation}deg)` }}
              className={`agent-facing unit-facing-${i % 2}`}
            >
              <g
                key={`${s.round}-${p.id}-body`}
                className={`agent-body ${p.health === 0 ? 'destroyed' : ''} ${isHit ? 'hit-reaction' : action?.type === 'attack' ? 'fire-recoil' : !mini ? 'idle-mechanism' : ''}`}
              >
                <g transform={`translate(${-robotSize / 2},${-robotSize / 2})`}>
                  <Robot
                    color={colors[i % colors.length]}
                    index={i}
                    size={robotSize}
                    salvage={game === 'cache-rush'}
                    badge={false}
                  />
                </g>
              </g>
            </g>
            <g transform={`translate(${robotSize * 0.38},${robotSize * 0.34})`}>
              <circle r="11" fill={colors[i % colors.length]} stroke="#f2e6ca" strokeWidth="1.5" />
              <text
                y="4"
                textAnchor="middle"
                fontSize="10"
                fill="#fff7e8"
                fontWeight="800"
                fontFamily="Manrope"
              >
                {i + 1}
              </text>
            </g>
            {!mini && action?.type === 'shield' && (
              <g key={`${s.round}-shield`} className="shield-field">
                <circle r="63" fill={`url(#${uid}-shield)`} />
                <path
                  d="M0-66A66 66 0 0 1 0 66"
                  transform={`rotate(${enemy ? (Math.atan2(at(enemy).y - c.y, at(enemy).x - c.x) * 180) / Math.PI : 0})`}
                  fill="none"
                  stroke="#ffe5a2"
                  strokeWidth="5"
                />
                <circle
                  r="65"
                  fill="none"
                  stroke="#e8ba65"
                  strokeWidth="1"
                  strokeDasharray="6 12"
                />
              </g>
            )}
            {!mini && ['scan', 'recharge', 'collect', 'deposit'].includes(action?.type || '') && (
              <g key={`${s.round}-power`} className={`power-effect power-${action?.type}`}>
                <circle r={game === 'flux-duel' ? 58 : 36} fill={`url(#${uid}-energy)`} />
                <circle
                  className="power-wave"
                  r={game === 'flux-duel' ? 52 : 30}
                  fill="none"
                  stroke="#ffe4a1"
                  strokeWidth="2"
                  strokeDasharray={action?.type === 'scan' ? '5 9' : undefined}
                />
                {Array.from({ length: 6 }, (_, j) => (
                  <circle
                    className="energy-mote"
                    key={j}
                    cx={Math.cos((j * Math.PI) / 3) * 42}
                    cy={Math.sin((j * Math.PI) / 3) * 42}
                    r="3"
                    fill="#fff0bb"
                    style={{ animationDelay: `${0.6 + j * 0.15}s` }}
                  />
                ))}
              </g>
            )}
            {!mini && p.health === 0 && (
              <g className="wreck-smoke">
                <circle cx="-6" cy="-27" r="11" fill="#323529" opacity=".65" />
                <circle cx="5" cy="-40" r="16" fill="#414536" opacity=".4" />
              </g>
            )}
            {!mini && game === 'cache-rush' && peers.length === 1 && (
              <g transform="translate(0,-51)" className="agent-nameplate">
                <rect
                  x="-37"
                  y="-13"
                  width="74"
                  height="21"
                  rx="3"
                  fill="#1a241bdd"
                  stroke={colors[i % colors.length]}
                  strokeWidth="1.5"
                />
                <text
                  y="2"
                  textAnchor="middle"
                  fill="#fff4d7"
                  fontSize="11"
                  fontWeight="800"
                  fontFamily="Manrope"
                >
                  {(names[p.id] || `AGENT ${i + 1}`).slice(0, 12)}
                </text>
                {p.health !== undefined && (
                  <>
                    <rect x="-49" y="10" width="98" height="6" rx="2" fill="#172116" />
                    <rect
                      x="-49"
                      y="10"
                      width={(98 * Math.max(0, p.health)) / 12}
                      height="6"
                      rx="2"
                      fill={p.health <= 3 ? '#e08b56' : '#b2bd79'}
                    />
                  </>
                )}
              </g>
            )}
            {!mini && p.health !== undefined && (
              <g transform={`translate(0,${-robotSize * 0.6})`}>
                <rect
                  x={-robotSize * 0.4}
                  width={robotSize * 0.8}
                  height="5"
                  rx="2"
                  fill="#172116"
                />
                <rect
                  x={-robotSize * 0.4}
                  width={(robotSize * 0.8 * p.health) / 12}
                  height="5"
                  rx="2"
                  fill={p.health <= 3 ? '#e08b56' : '#b2bd79'}
                />
              </g>
            )}
            {!mini && effects.labels[p.id] && (game === 'flux-duel' || action?.type !== 'move') && (
              <text
                key={`${s.round}-caption`}
                className="world-action"
                y={robotSize / 2 + 17}
                textAnchor="middle"
                fontSize={game === 'flux-duel' ? 12 : 9}
                fontWeight="800"
                fill="#fff0c9"
                stroke="#25331f"
                strokeWidth="4"
                paintOrder="stroke"
                fontFamily="Manrope"
              >
                {p.health === 0 ? 'KNOCKED OUT' : effects.labels[p.id]}
              </text>
            )}
            <title>{`${names[p.id] || `Agent ${i + 1}`} at ${String.fromCharCode(65 + p.x)}${p.y + 1}${p.health === 0 ? ', knocked out' : ''}`}</title>
          </g>
        );
      })}
      {!mini && (
        <g fill="#f8e6bf" opacity=".7" fontSize="11" fontFamily="Manrope" textAnchor="middle">
          {Array.from({ length: n }, (_, i) => (
            <g key={i}>
              <text x={left + (i + 0.5) * tileX} y="66">
                {String.fromCharCode(65 + i)}
              </text>
              <text x={left - 18} y={88 + (i + 0.5) * tileY + 4}>
                {i + 1}
              </text>
            </g>
          ))}
        </g>
      )}
    </svg>
  );
}

export function Arena({
  game,
  state,
  reveal = false,
  actions,
  events,
  names,
  still = false,
  outcome,
  hud,
  audioActive = false,
  audioKey = '',
}: {
  game: Game;
  state?: State | null;
  reveal?: boolean;
  actions?: Record<string, TurnAction>;
  events?: string[];
  names?: Record<string, string>;
  still?: boolean;
  outcome?: { title: string; subtitle: string };
  hud?: ReactNode;
  audioActive?: boolean;
  audioKey?: string;
}) {
  const ref = useRef<HTMLDivElement>(null),
    [motion, setMotion] = useState(true),
    [zoom, setZoom] = useState(false),
    [error, setError] = useState('');
  const viewportRef = useRef<HTMLDivElement>(null),
    [aspect, setAspect] = useState(1.25);
  useEffect(() => {
    if (!viewportRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setAspect(width / height);
    });
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, []);
  const sound = useArenaSound(audioKey, audioActive, state, actions, events, !!outcome);
  return (
    <div className={`arena-frame painted-arena ${motion ? '' : 'still'}`} ref={ref}>
      <div className="arena-toolbar">
        <span>
          <i className="olive-dot" />
          {game === 'flux-duel' ? 'THE OVERGROWN CIRCUIT' : 'THE SALVAGE GARDENS'}
        </span>
        <div>
          <button
            className={`sound-control ${sound.enabled ? 'enabled' : ''}`}
            aria-pressed={sound.enabled}
            aria-label={sound.enabled ? 'Mute game audio' : 'Enable game audio'}
            onClick={() => void sound.toggle()}
          >
            <Icon name="sound" size={17} />
            <span>Sound {sound.enabled ? 'on' : 'off'}</span>
          </button>
          <button
            className="icon-button"
            aria-label={zoom ? 'Fit arena' : 'Zoom arena'}
            onClick={() => setZoom(!zoom)}
          >
            {zoom ? '−' : '+'}
          </button>
          <button
            className="icon-button"
            aria-label="Toggle animation"
            aria-pressed={motion}
            onClick={() => setMotion(!motion)}
          >
            <Icon name="refresh" size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="Fullscreen arena"
            onClick={() => {
              void (
                document.fullscreenElement
                  ? document.exitFullscreen()
                  : ref.current?.requestFullscreen()
              )?.catch(() => setError('Fullscreen is unavailable in this browser.'));
            }}
          >
            <Icon name="expand" size={17} />
          </button>
        </div>
      </div>
      <div className={`board-viewport ${zoom ? 'zoom' : ''}`} ref={viewportRef}>
        {hud && <div className="arena-hud">{hud}</div>}
        <Board
          game={game}
          state={state}
          reveal={reveal}
          actions={actions}
          events={events}
          names={names}
          still={still || !motion}
          aspect={aspect}
        />
        {outcome && (
          <div className="arena-outcome">
            <span>ARENA RESOLVED</span>
            <strong>{outcome.title}</strong>
            <p>{outcome.subtitle}</p>
          </div>
        )}
      </div>
      <div className="arena-legend">
        {game === 'flux-duel' ? (
          <>
            <span>
              <i className="legend-core" />
              Central control zone
            </span>
            <span>Simultaneous tactics · 7 × 7</span>
          </>
        ) : (
          <>
            <span>
              <i className="legend-base" />
              Extraction pad
            </span>
            <span>
              <i className="legend-hazard" />
              Hazard
            </span>
            <span>{reveal ? 'Full replay map' : 'Relics and cargo stay private'}</span>
          </>
        )}
      </div>
      {(error || sound.error) && (
        <p role="status" className="fine">
          {error || sound.error}
        </p>
      )}
    </div>
  );
}
