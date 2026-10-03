export interface Camera {
  x: number;
  y: number;
  zoom: number;
}
export interface Viewport {
  width: number;
  height: number;
}
export function maxArenaZoom(viewport: Viewport) {
  return Math.max(0.15, Math.min(2.3, (viewport.height - 70) / 160));
}

// Keep room for edge miners, their labels, and the controls over the playfield.
export function clampCamera(camera: Camera, viewport: Viewport, boardSize = 1920) {
  camera.zoom = Math.min(camera.zoom, maxArenaZoom(viewport));
  const clampAxis = (position: number, dimension: number, margin: number) => {
    const half = dimension / camera.zoom / 2;
    const padding = Math.min(margin, dimension * 0.4) / camera.zoom;
    const minimum = half - padding;
    const maximum = boardSize - half + padding;
    return minimum > maximum ? boardSize / 2 : Math.max(minimum, Math.min(maximum, position));
  };
  camera.x = clampAxis(camera.x, viewport.width, viewport.width < 640 ? 160 : 280);
  camera.y = clampAxis(camera.y, viewport.height, viewport.width < 640 ? 280 : 210);
}

// Anchor is in CSS pixels relative to the viewport. The world point under it stays put.
export function zoomCamera(
  camera: Camera,
  value: number,
  viewport: Viewport,
  anchor?: { x: number; y: number },
) {
  const next = Math.min(maxArenaZoom(viewport), Math.max(0.15, value));
  if (anchor) {
    camera.x += (anchor.x - viewport.width / 2) * (1 / camera.zoom - 1 / next);
    camera.y += (anchor.y - viewport.height / 2) * (1 / camera.zoom - 1 / next);
  }
  camera.zoom = next;
}

export interface ArenaWheel {
  deltaX: number;
  deltaY: number;
  deltaMode?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

// A normal mouse wheel scrolls the field. Only an explicit modifier (including
// the Ctrl wheel events emitted by trackpad pinch) changes magnification.
export function scrollCamera(
  camera: Camera,
  viewport: Viewport,
  event: ArenaWheel,
  anchor: { x: number; y: number },
): 'pan' | 'zoom' {
  const unitY = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1;
  if (event.ctrlKey || event.metaKey) {
    zoomCamera(camera, camera.zoom * Math.exp(-event.deltaY * unitY * 0.0015), viewport, anchor);
    clampCamera(camera, viewport);
    return 'zoom';
  }
  const horizontal = event.shiftKey ? event.deltaX || event.deltaY : event.deltaX;
  const vertical = event.shiftKey ? 0 : event.deltaY;
  const unitX = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.width : 1;
  camera.x += (horizontal * unitX) / camera.zoom;
  camera.y += (vertical * unitY) / camera.zoom;
  clampCamera(camera, viewport);
  return 'pan';
}

export function arenaPixelRatio(viewport: Viewport, deviceRatio: number) {
  // Bound fill-rate in fullscreen and on high-DPI screens, independently of zoom.
  return Math.min(
    2,
    deviceRatio || 1,
    Math.sqrt(6_000_000 / Math.max(1, viewport.width * viewport.height)),
  );
}

export function arenaTime(elapsed: number, age: number, rate: number, duration: number) {
  return Math.min(duration, elapsed + Math.max(0, age) * rate);
}
