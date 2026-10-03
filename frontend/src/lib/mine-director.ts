import { mineHighlight, minerPosition, type MineState, type Point } from './mining.ts';
import { maxArenaZoom, type Camera, type Viewport } from './mine-camera.ts';

const SHOT_MS = 12_000;
const IDLE_GRACE_MS = 3_000;
const MAJOR_EVENT_MS = 6_000;

export function createMineDirector() {
  return {
    targetId: undefined as string | undefined,
    eventSpot: undefined as Point | undefined,
    selectedAt: -Infinity,
    arrivedAt: undefined as number | undefined,
    lastActiveAt: -Infinity,
    lastTime: -1,
    lastEvent: 0,
    pending: undefined as MineState['events'][number] | undefined,
    shotAt: -Infinity,
    phase: 'out' as 'out' | 'travel' | 'close',
    wideZoom: 0.4,
    closeZoom: 1.35,
    transitionAt: 0,
    overview: false,
  };
}
export type MineDirector = ReturnType<typeof createMineDirector>;

export function cameraTarget(
  d: MineDirector,
  state: MineState,
  time: number,
  follow?: string,
  automatic = false,
  cameraTime = time,
): Point | undefined {
  // Game timestamps may be corrected by a live packet. Only an explicit seek
  // resets the director; shot leases use a separate, monotonic viewing clock.
  const now = Math.max(d.lastTime, cameraTime);
  d.lastTime = now;
  const point = (id: string) => {
    const player = state.players.find((p) => p.id === id);
    if (!player) return undefined;
    const position = minerPosition(player, time);
    return { x: (position.x + 0.5) * 80, y: (position.y + 0.5) * 80 };
  };
  if (follow || !automatic) {
    Object.assign(d, createMineDirector());
    return follow ? point(follow) : undefined;
  }
  const current = state.players.find((p) => p.id === d.targetId);
  const active = state.players.filter(
    (p) => p.alive && (p.job || p.cargo || p.crown || (p.venomUntil && p.venomUntil > time)),
  );
  if (current && active.includes(current)) d.lastActiveAt = now;
  const important = mineHighlight(state.events, time);
  const major = (kind: string) => ['crown', 'crown-bank', 'eliminated'].includes(kind);
  if (important && important.id > d.lastEvent) {
    d.lastEvent = important.id;
    // Keep a highlight through the current shot, instead of cutting on arrival.
    if (!d.pending || major(important.kind) || !major(d.pending.kind)) d.pending = important;
  }
  if (d.pending && (time - d.pending.at > 15_000 || d.pending.agentId === d.targetId))
    d.pending = undefined;

  const select = (id?: string, spot?: Point) => {
    if (d.selectedAt !== -Infinity && id === d.targetId && !spot && !d.eventSpot) {
      // Renew the lease without restarting the zoom/pan for the same subject.
      d.arrivedAt = now;
      return;
    }
    d.targetId = id;
    d.eventSpot = spot;
    d.overview = !id && !spot;
    d.selectedAt = now;
    d.arrivedAt = undefined;
    d.lastActiveAt = now;
  };
  const settled = d.arrivedAt !== undefined;
  const held = settled ? now - d.arrivedAt! : 0;
  const expired = settled && held >= SHOT_MS;
  const pending = d.pending;
  const eventPlayer = pending && state.players.find((p) => p.id === pending.agentId);
  // Do not cut while widening, travelling or settling. Major events get a
  // cooldown too; a cluster of discoveries must not create rapid-fire shots.
  if (
    settled &&
    pending &&
    eventPlayer &&
    (expired || (major(pending.kind) && held >= MAJOR_EVENT_MS))
  ) {
    select(eventPlayer.id);
    d.pending = undefined;
  } else if (
    d.selectedAt === -Infinity ||
    (d.overview && settled && held >= IDLE_GRACE_MS && active.length) ||
    (!d.overview && settled && (expired || (!current?.alive && held >= MAJOR_EVENT_MS)))
  ) {
    const score = (p: MineState['players'][number]) =>
      (p.crown ? 100 : 0) +
      (p.venomUntil && p.venomUntil > time ? 70 : 0) +
      (p.job?.phase === 'inspect' ? 25 : 0) +
      (p.job?.phase === 'work' ? 30 : 0) +
      (p.job?.phase === 'dig' ? 40 : 0) +
      (p.job?.phase === 'walk' ? 20 : 0) +
      Math.min(p.cargo, 19);
    const candidates = active.slice().sort((a, b) => score(b) - score(a));
    const rival = candidates.find((p) => p.id !== d.targetId);
    const chosen =
      current?.alive && active.includes(current) && (!rival || score(rival) < score(current) * 0.8)
        ? current
        : (rival ?? candidates[0]);
    if (chosen) select(chosen.id);
    else if (!current?.alive || now - d.lastActiveAt >= IDLE_GRACE_MS) select();
  }
  return (
    (d.targetId && point(d.targetId)) ||
    d.eventSpot ||
    (d.overview ? { x: 960, y: 960 } : undefined)
  );
}

export function moveCamera(camera: Camera, target: Point, dt: number) {
  const dx = target.x - camera.x,
    dy = target.y - camera.y;
  const distance = Math.hypot(dx, dy);
  const ease = 1 - Math.exp(-Math.max(0, dt) / 180);
  // Never teleport across the map when selecting another shot.
  const step = Math.min(distance * ease, (1100 * Math.max(0, dt)) / 1000);
  if (distance > 0) {
    camera.x += (dx / distance) * step;
    camera.y += (dy / distance) * step;
  }
}

// Reserve the HUD edges and frame a miner's complete body, label and cargo.
export function broadcastArea(viewport: Viewport) {
  const left = Math.min(32, viewport.width * 0.08);
  const right = viewport.width > 900 ? 254 : viewport.width > 600 ? 190 : 20;
  const top = Math.min(110, viewport.height * 0.22);
  const bottom = Math.min(viewport.width > 600 ? 160 : 210, viewport.height * 0.28);
  return { left, right: viewport.width - right, top, bottom: viewport.height - bottom };
}
export function framedCenter(target: Point, zoom: number, viewport: Viewport): Point {
  const area = broadcastArea(viewport);
  return {
    x: target.x - ((area.left + area.right) / 2 - viewport.width / 2) / zoom,
    y: target.y - ((area.top + area.bottom) / 2 + 24 * zoom - viewport.height / 2) / zoom,
  };
}
export function subjectVisible(camera: Camera, target: Point, viewport: Viewport) {
  const area = broadcastArea(viewport);
  const x = viewport.width / 2 + (target.x - camera.x) * camera.zoom;
  const y = viewport.height / 2 + (target.y - camera.y) * camera.zoom;
  return (
    x - 60 * camera.zoom >= area.left &&
    x + 60 * camera.zoom <= area.right &&
    y - 90 * camera.zoom >= area.top &&
    y + 75 * camera.zoom <= area.bottom
  );
}

export function broadcastCamera(
  d: MineDirector,
  camera: Camera,
  target: Point,
  viewport: Viewport,
  time: number,
  dt: number,
  _state: MineState,
) {
  const area = broadcastArea(viewport);
  const zoomLimit = Math.max(
    0.15,
    Math.min(
      maxArenaZoom(viewport),
      (area.right - area.left) / 330,
      (area.bottom - area.top) / 220,
    ),
  );
  const overview = Math.max(
    0.15,
    Math.min((area.right - area.left) / 2040, (area.bottom - area.top) / 2040),
  );
  if (d.shotAt !== d.selectedAt) {
    const distance = Math.hypot(target.x - camera.x, target.y - camera.y);
    d.shotAt = d.selectedAt;
    d.transitionAt = time;
    d.wideZoom = overview;
    d.closeZoom = d.overview ? overview : Math.min(1.35, zoomLimit);
    d.phase = !d.overview && distance > 500 ? 'out' : 'close';
  }
  const ease = 1 - Math.exp(-Math.max(0, dt) / 240);
  if (d.phase === 'out') {
    camera.zoom += (d.wideZoom - camera.zoom) * ease;
    // Widen around the mine before crossing it, so the journey has visible context.
    moveCamera(camera, framedCenter({ x: 960, y: 960 }, camera.zoom, viewport), dt);
    if (Math.abs(camera.zoom - d.wideZoom) < 0.025 || time - d.transitionAt > 1200)
      d.phase = 'travel';
  } else {
    const desiredZoom = d.phase === 'travel' ? d.wideZoom : Math.min(d.closeZoom, zoomLimit);
    camera.zoom += (desiredZoom - camera.zoom) * ease;
    const destination = framedCenter(target, camera.zoom, viewport);
    moveCamera(camera, destination, dt);
    if (d.phase === 'travel' && Math.hypot(destination.x - camera.x, destination.y - camera.y) < 90)
      d.phase = 'close';
    // Tracking a walking miner only pans. Never restart the wide shot because
    // a packet advanced its position or its body briefly crossed the safe area.
    if (
      d.phase === 'close' &&
      d.arrivedAt === undefined &&
      Math.abs(camera.zoom - desiredZoom) < 0.035 &&
      Math.hypot(destination.x - camera.x, destination.y - camera.y) < 30 &&
      subjectVisible(camera, target, viewport)
    )
      d.arrivedAt = time;
  }
  camera.zoom = Math.min(maxArenaZoom(viewport), Math.max(0.15, camera.zoom));
  // Automatic shots may extend beyond the board edge to keep edge miners centred.
  // Manual navigation retains its separate map boundary clamp.
}
