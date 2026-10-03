import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentAvatar } from './AgentAvatar';
import {
  arenaPixelRatio,
  arenaTime,
  clampCamera,
  scrollCamera,
  zoomCamera,
} from '../lib/mine-camera';
import { spriteFrame, resetArtCaches } from '../lib/mine-art';
import {
  arenaErrorName,
  browserArenaScheduler,
  startArenaLoop,
  type ArenaFault,
} from '../lib/arena-loop';
import { createMineRenderer } from '../lib/mine-renderer';
import {
  broadcastCamera,
  cameraTarget,
  createMineDirector,
  framedCenter,
  moveCamera,
} from '../lib/mine-director';
import {
  eventText,
  eventSubject,
  mineHighlight,
  minerColors,
  minerPosition,
  timeLabel,
  type MineState,
  type Point,
} from '../lib/mining';

const TILE = 80;
const artUrls = [
  '/art/miners-a.webp',
  '/art/miners-b.webp',
  '/art/mine-props.webp',
  '/art/mine-terrain.webp',
  '/art/miners-walk-empty-v2.webp',
  '/art/miners-walk-loaded-v2.webp',
];
const art: HTMLImageElement[] = [];
let artPromise: Promise<void> | undefined;
function loadArt() {
  if (artPromise) return artPromise;
  if (!art.length)
    for (const url of artUrls) {
      const image = new Image();
      image.src = url;
      art.push(image);
    }
  artPromise = Promise.all(
    art.map((i) =>
      i.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            i.onload = () => resolve();
            i.onerror = () => resolve();
          }),
    ),
  ).then(() => {
    // Warm the cache before the first frame, including the miner's contrast halo.
    art.forEach((image, sheet) => {
      if (!image.naturalWidth) return;
      const rows = sheet === 3 ? 2 : 4;
      const cols = sheet === 3 ? 2 : 4;
      for (let index = 0; index < rows * cols; index++)
        spriteFrame(image, index, rows, cols, sheet === 0 || sheet === 1 || sheet >= 4);
    });
  });
  return artPromise;
}
const MinimapTerrain = memo(
  function MinimapTerrain({ tiles }: { tiles: MineState['tiles']; signature: string }) {
    // One SVG path per ground type rather than hundreds of DOM nodes per clock tick.
    const colors = ['#af996a', '#7c905d', '#b58662', '#b8a17b', '#303d2b'];
    const paths = colors.map(() => '');
    tiles.forEach((tile, i) => {
      paths[tile.blocked ? 4 : tile.zone] +=
        `M${(i % 24) * 10} ${Math.floor(i / 24) * 10}h10v10h-10z`;
    });
    return (
      <>
        {paths.map((d, i) => (
          <path key={i} d={d} fill={colors[i]} />
        ))}
      </>
    );
  },
  (before, after) => before.signature === after.signature,
);
export function MineArena({
  state,
  elapsed,
  names,
  follow,
  setFollow,
  director,
  setDirector,
  mini = false,
  onSelect,
  onRenderFault,
  animationRate = 1,
  cameraSession = '',
}: {
  state: MineState;
  elapsed: number;
  names: Record<string, string>;
  follow?: string;
  setFollow?: (id?: string) => void;
  director?: boolean;
  setDirector?: (enabled: boolean) => void;
  mini?: boolean;
  onSelect?: (id: string) => void;
  onRenderFault?: (detail: {
    kind: ArenaFault;
    errorName: string;
    elapsedMs: number;
    width: number;
    height: number;
  }) => void;
  animationRate?: number;
  cameraSession?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    host = useRef<HTMLDivElement>(null);
  const current = useRef({ state, elapsed, names, follow, director, animationRate, onRenderFault });
  const clock = useRef({ elapsed, animationRate, at: performance.now() });
  if (clock.current.elapsed !== elapsed || clock.current.animationRate !== animationRate)
    clock.current = { elapsed, animationRate, at: performance.now() };
  current.current = { state, elapsed, names, follow, director, animationRate, onRenderFault };
  const camera = useRef({ x: 5 * TILE, y: 5 * TILE, zoom: mini ? 0.75 : 1, initialized: false });
  const pointers = useRef(new Map<number, Point>()),
    pinch = useRef(0);
  const broadcast = useRef(createMineDirector());
  const viewingClock = useRef(0);
  const cameraSessionRef = useRef(cameraSession);
  if (cameraSessionRef.current !== cameraSession) {
    cameraSessionRef.current = cameraSession;
    broadcast.current = createMineDirector();
    camera.current.initialized = false;
    viewingClock.current = 0;
  }
  const drag = useRef({ distance: 0, moved: false });
  const [zoom, setZoom] = useState(1),
    [ready, setReady] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const manual = useCallback(() => {
    setDirector?.(false);
    setFollow?.(undefined);
    current.current.director = false;
    current.current.follow = undefined;
  }, [setDirector, setFollow]);
  const changeZoom = useCallback((value: number, anchor?: Point) => {
    const rect = canvas.current?.getBoundingClientRect();
    zoomCamera(camera.current, value, rect ?? { width: 800, height: 500 }, anchor);
    setZoom(camera.current.zoom);
  }, []);
  const terrainSignature = useMemo(
    () => state.tiles.map((t) => `${t.zone}${Number(t.blocked)}`).join(''),
    [state.tiles],
  );
  useEffect(() => {
    let alive = true;
    void loadArt().then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return;
      zoomCamera(camera.current, camera.current.zoom, entry.contentRect);
      setZoom(camera.current.zoom);
      setSize((previous) =>
        previous.width === entry.contentRect.width && previous.height === entry.contentRect.height
          ? previous
          : { width: entry.contentRect.width, height: entry.contentRect.height },
      );
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (mini || (!event.deltaX && !event.deltaY)) return;
      event.preventDefault();
      manual();
      const rect = element.getBoundingClientRect();
      const action = scrollCamera(camera.current, rect, event, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
      if (action === 'zoom') setZoom(camera.current.zoom);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [mini, manual]);
  useEffect(() => {
    const element = canvas.current,
      ctx = element?.getContext('2d', { alpha: false });
    if (!ctx || !element || !ready) return;
    const ratio = arenaPixelRatio(size, window.devicePixelRatio);
    element.width = size.width * ratio;
    element.height = size.height * ratio;
    let last = performance.now(),
      zoomReportedAt = 0,
      lost = false,
      faultAt = -Infinity,
      failed = false;
    const draw = createMineRenderer(ctx, size, ratio, art);
    const report = (kind: ArenaFault, error?: unknown) => {
      const detail = {
        kind,
        errorName: arenaErrorName(error),
        elapsedMs: current.current.state.elapsedMs,
        width: Math.round(size.width),
        height: Math.round(size.height),
      };
      console.warn('Arena rendering diagnostic', detail);
      current.current.onRenderFault?.(detail);
    };
    const loss = (event: Event) => {
      event.preventDefault();
      lost = true;
      failed = true;
      setRecovering(true);
      report('context-lost');
    };
    const restore = () => {
      lost = false;
      resetArtCaches();
      report('context-restored');
    };
    element.addEventListener('contextlost', loss);
    element.addEventListener('contextrestored', restore);
    const render = (wall: number) => {
      // Leave headroom for live updates and input. Animation time stays wall-clock based.
      if (typeof ctx.isContextLost === 'function') {
        const unavailable = ctx.isContextLost();
        if (unavailable && !lost) {
          lost = true;
          failed = true;
          setRecovering(true);
          report('context-lost');
        } else if (!unavailable && lost) restore();
      }
      if (document.hidden || lost || wall - last < 1000 / 60 - 1) return;
      if (
        art.length !== artUrls.length ||
        art.some((image) => !image.complete || !image.naturalWidth)
      ) {
        if (!art.length) void loadArt();
        return;
      }
      const { state: w, names, follow, director } = current.current;
      const t = arenaTime(
        clock.current.elapsed,
        wall - clock.current.at,
        clock.current.animationRate,
        w.durationMs,
      );
      const cam = camera.current,
        dt = Math.min(100, wall - last);
      last = wall;
      if (clock.current.animationRate > 0) viewingClock.current += dt;
      if (!cam.initialized) {
        if (!mini && !follow) {
          cam.zoom = Math.max(0.15, Math.min(size.width, size.height) / 2040);
          Object.assign(cam, framedCenter({ x: 960, y: 960 }, cam.zoom, size));
        } else {
          cam.x = (w.players[0]?.x ?? 5) * TILE + TILE / 2;
          cam.y = (w.players[0]?.y ?? 5) * TILE + TILE / 2;
        }
        cam.initialized = true;
      }
      const target = cameraTarget(
        broadcast.current,
        w,
        t,
        follow,
        mini || director,
        viewingClock.current,
      );
      if (mini) {
        cam.zoom = 0.95;
        if (target) {
          moveCamera(cam, target, dt);
          if (
            broadcast.current.arrivedAt === undefined &&
            Math.hypot(cam.x - target.x, cam.y - target.y) < 30
          )
            broadcast.current.arrivedAt = viewingClock.current;
        }
        clampCamera(cam, size);
      } else if (target && director && !follow) {
        broadcastCamera(broadcast.current, cam, target, size, viewingClock.current, dt, w);
      } else if (target && follow) {
        moveCamera(cam, framedCenter(target, cam.zoom, size), dt);
      } else clampCamera(cam, size);
      draw(w, t, names, cam, mini);
      if (failed) {
        failed = false;
        setRecovering(false);
      }
      if (!mini && wall - zoomReportedAt > 250) {
        zoomReportedAt = wall;
        setZoom((previous) => (Math.abs(previous - cam.zoom) > 0.015 ? cam.zoom : previous));
      }
    };
    const stop = startArenaLoop(render, {
      ...browserArenaScheduler(),
      onError: (error) => {
        failed = true;
        setRecovering(true);
        // Reset a partially drawn canvas/save stack, without reallocating art on every fault.
        element.width = Math.round(size.width * ratio);
        if (performance.now() - faultAt >= 5000) {
          faultAt = performance.now();
          report('frame-error', error);
        }
      },
    });
    return () => {
      stop();
      element.removeEventListener('contextlost', loss);
      element.removeEventListener('contextrestored', restore);
    };
  }, [ready, size, mini]);
  const important = mineHighlight(state.events, elapsed);
  const subject = important ? eventSubject(important, state.players, names) : undefined;
  const zone = ['OLD MINE', 'MOSSY HOLLOW', 'ROCKY RAVINE', 'SERPENT RUINS'][
    state.tiles[
      Math.min(575, Math.floor(camera.current.y / TILE) * 24 + Math.floor(camera.current.x / TILE))
    ]?.zone ?? 0
  ];
  return (
    <div className={`mine-arena ${mini ? 'mine-mini' : ''}`} ref={host}>
      <canvas
        ref={canvas}
        aria-label="Treasure mine. Scroll to move up or down; Shift and scroll moves sideways. Use plus and minus or Ctrl and scroll to zoom. Drag or use arrow keys to explore; pinch to zoom on touchscreens. Select a miner to follow."
        tabIndex={mini ? -1 : 0}
        onKeyDown={(event) => {
          if (mini) return;
          const k = event.key;
          if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '-', '='].includes(k)) {
            event.preventDefault();
            manual();
            if (k === '+' || k === '=') changeZoom(camera.current.zoom * 1.15);
            else if (k === '-') changeZoom(camera.current.zoom / 1.15);
            else {
              camera.current.x += k === 'ArrowRight' ? 100 : k === 'ArrowLeft' ? -100 : 0;
              camera.current.y += k === 'ArrowDown' ? 100 : k === 'ArrowUp' ? -100 : 0;
            }
          }
        }}
        onPointerDown={(event) => {
          if (mini) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          if (!pointers.current.size) drag.current = { distance: 0, moved: false };
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (pointers.current.size > 1) {
            drag.current.moved = true;
            manual();
          }
          pinch.current = 0;
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId);
          if (!previous) return;
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          drag.current.distance += Math.hypot(
            event.clientX - previous.x,
            event.clientY - previous.y,
          );
          if (drag.current.distance > 5) drag.current.moved = true;
          if (!drag.current.moved) return;
          manual();
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            const gap = Math.hypot(a.x - b.x, a.y - b.y);
            const rect = event.currentTarget.getBoundingClientRect();
            if (pinch.current)
              changeZoom((camera.current.zoom * gap) / pinch.current, {
                x: (a.x + b.x) / 2 - rect.left,
                y: (a.y + b.y) / 2 - rect.top,
              });
            pinch.current = gap;
          } else {
            camera.current.x -= (event.clientX - previous.x) / camera.current.zoom;
            camera.current.y -= (event.clientY - previous.y) / camera.current.zoom;
          }
        }}
        onPointerUp={(event) => {
          pointers.current.delete(event.pointerId);
          pinch.current = 0;
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId);
          pinch.current = 0;
          drag.current.moved = true;
        }}
        onClick={(event) => {
          if (!onSelect || mini || drag.current.moved) return;
          const rect = event.currentTarget.getBoundingClientRect(),
            cam = camera.current;
          const x = (event.clientX - rect.left - rect.width / 2) / cam.zoom + cam.x,
            y = (event.clientY - rect.top - rect.height / 2) / cam.zoom + cam.y;
          const found = state.players.find((p) => {
            const q = minerPosition(p, elapsed);
            return Math.hypot((q.x + 0.5) * TILE - x, (q.y + 0.4) * TILE - y) < 48;
          });
          if (found) onSelect(found.id);
        }}
      />
      <div className="mine-vignette" aria-hidden="true" />
      {!ready && <div className="mine-loading">Preparing the mine…</div>}
      {recovering && (
        <div className="mine-render-recovery" role="status">
          Restoring the view…
        </div>
      )}
      {!mini && (
        <>
          <div className="mine-location">
            <span>CRYPTRIX / EXPEDITION 24</span>
            <strong>{zone}</strong>
            <small>
              {follow
                ? `Following ${names[follow]}`
                : director
                  ? 'Broadcast camera'
                  : 'Free camera · scroll or drag to explore'}
            </small>
          </div>
          <div className="mine-timer">
            <span>EXTRACTION CLOSES IN</span>
            <strong>{timeLabel(state.durationMs - elapsed)}</strong>
          </div>
          {important && (
            <div
              key={important.id}
              className={`mine-announcement ${important.kind === 'crown' ? 'gold' : ''} ${['snake', 'venom', 'bite', 'collapse', 'eliminated', 'crack'].includes(important.kind) ? 'danger' : ''}`}
            >
              {subject ? (
                <AgentAvatar
                  agentId={subject.id}
                  name={subject.name}
                  variant={subject.index}
                  className="mine-event-avatar"
                  numbered
                />
              ) : (
                <i aria-hidden="true">
                  {['snake', 'venom', 'bite', 'collapse', 'eliminated', 'crack'].includes(
                    important.kind,
                  )
                    ? '!'
                    : '◆'}
                </i>
              )}
              <div className="mine-announcement-copy">
                <div className="mine-announcement-heading">
                  <b>{subject?.name ?? 'Expedition'}</b>
                  <span>{important.kind.replaceAll('-', ' ').toUpperCase()}</span>
                </div>
                <strong>{eventText(important, names)}</strong>
              </div>
            </div>
          )}
          <div className="mine-camera-controls">
            <button
              title="Zoom out (or Ctrl + scroll)"
              aria-label="Zoom out"
              onClick={() => {
                manual();
                changeZoom(camera.current.zoom / 1.2);
              }}
            >
              −
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              title="Zoom in (or Ctrl + scroll)"
              aria-label="Zoom in"
              onClick={() => {
                manual();
                changeZoom(camera.current.zoom * 1.2);
              }}
            >
              +
            </button>
            <button
              className={director ? 'chosen' : ''}
              title="Automatic broadcast camera"
              onClick={() => {
                setDirector?.(!director);
                setFollow?.(undefined);
              }}
            >
              Auto
            </button>
            <button
              title="Show the whole map"
              onClick={() => {
                manual();
                camera.current.x = 960;
                camera.current.y = 960;
                changeZoom(Math.min(size.width, size.height) / 2040);
              }}
            >
              Map
            </button>
          </div>
          <button
            className="mine-minimap"
            aria-label="Mine overview: click a location to move the camera"
            onClick={(event) => {
              const r = event.currentTarget.getBoundingClientRect();
              manual();
              camera.current.x = ((event.clientX - r.left) / r.width) * 1920;
              camera.current.y = ((event.clientY - r.top) / r.height) * 1920;
            }}
          >
            <svg viewBox="0 0 240 240" aria-hidden="true">
              <rect width="240" height="240" fill="#5b5940" />
              <MinimapTerrain tiles={state.tiles} signature={terrainSignature} />
              {state.bases.map((p, i) => (
                <rect
                  key={`b${i}`}
                  x={p.x * 10}
                  y={p.y * 10}
                  width="10"
                  height="10"
                  fill="#fff0c1"
                />
              ))}
              {state.players.map((p, i) => (
                <circle
                  key={p.id}
                  cx={(p.x + 0.5) * 10}
                  cy={(p.y + 0.5) * 10}
                  r={p.alive ? 5 : 2}
                  fill={minerColors[i]}
                  stroke="#192920"
                  strokeWidth="2"
                />
              ))}
              <rect
                x={(camera.current.x - size.width / camera.current.zoom / 2) / 8}
                y={(camera.current.y - size.height / camera.current.zoom / 2) / 8}
                width={size.width / camera.current.zoom / 8}
                height={size.height / camera.current.zoom / 8}
                fill="none"
                stroke="#fff5d1"
                strokeWidth="2"
              />
            </svg>
            <span>24 × 24 / FIELD MAP</span>
          </button>
        </>
      )}
    </div>
  );
}
