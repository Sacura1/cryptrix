let cacheGeneration = 0;
export const artGeneration = () => cacheGeneration;
export function resetArtCaches() {
  cacheGeneration++;
  terrainCache = undefined;
}
// Source atlases are large. Resize each frame once, never inside the animation loop.
export type AtlasImage = HTMLImageElement | ImageBitmap;
export type ArenaSurface = HTMLCanvasElement | OffscreenCanvas;
export type ArenaContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export const atlasWidth = (image: AtlasImage) =>
  'naturalWidth' in image ? image.naturalWidth : image.width;
const atlasHeight = (image: AtlasImage) =>
  'naturalHeight' in image ? image.naturalHeight : image.height;
export function arenaSurface(width: number, height: number): ArenaSurface {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
export function createSpriteCache<T>(
  makeFrame: (image: AtlasImage, index: number, rows: number, cols: number, halo: boolean) => T,
) {
  let images = new WeakMap<AtlasImage, Map<string, T>>();
  let generation = cacheGeneration;
  return (image: AtlasImage, index: number, rows = 4, cols = 4, halo = false): T => {
    if (generation !== cacheGeneration) {
      images = new WeakMap();
      generation = cacheGeneration;
    }
    let frames = images.get(image);
    if (!frames) images.set(image, (frames = new Map()));
    const key = `${index}:${rows}:${cols}:${halo}`;
    let frame = frames.get(key);
    if (frame === undefined) {
      frame = makeFrame(image, index, rows, cols, halo);
      frames.set(key, frame);
    }
    return frame;
  };
}

// Locate the boot baseline in opaque central pixels, excluding the pickaxe tip
// and glow. Generated atlas rows have slightly different transparent margins.
export function minerGroundOffset(
  data: Uint8ClampedArray,
  width: number,
  detail: number,
  padding: number,
) {
  const left = padding + Math.floor(detail * 0.18),
    right = padding + Math.ceil(detail * 0.8);
  for (let y = padding + detail - 1; y >= padding + Math.floor(detail * 0.55); y--)
    for (let x = left; x < right; x++)
      if (data[(y * width + x) * 4 + 3] > 160) return (detail - (y - padding + 1)) / detail;
  return 0;
}

export const spriteFrame = createSpriteCache((image, index, rows, cols, halo) => {
  const detail = halo || rows === 2 ? 384 : 256;
  const padding = halo ? 12 : 0;
  const frame = arenaSurface(detail + padding * 2, detail + padding * 2);
  const ctx = frame.getContext('2d') as ArenaContext;
  const width = atlasWidth(image) / cols,
    height = atlasHeight(image) / rows;
  if (halo) {
    ctx.shadowColor = '#fff1c7';
    ctx.shadowBlur = 12;
  }
  ctx.drawImage(
    image,
    (index % cols) * width,
    Math.floor(index / cols) * height,
    width,
    height,
    padding,
    padding,
    detail,
    detail,
  );
  let groundOffset = 0;
  if (halo) {
    try {
      const pixels = ctx.getImageData(0, 0, frame.width, frame.height);
      if (pixels?.data) groundOffset = minerGroundOffset(pixels.data, frame.width, detail, padding);
    } catch {
      /* A baseline hint must not prevent the game from loading. */
    }
  }
  return { image: frame, padding: padding / detail, groundOffset };
});

export interface TerrainChunk {
  image: ArenaSurface;
  x: number;
  y: number;
  size: number;
}
let terrainCache: { key: string; source: AtlasImage; chunks: TerrainChunk[] } | undefined;
export function prepareTerrain(tiles: { zone: number }[], image: AtlasImage): TerrainChunk[] {
  const key = tiles.map((tile) => tile.zone).join('');
  if (terrainCache?.key === key && terrainCache.source === image) return terrainCache.chunks;
  const chunks: TerrainChunk[] = [];
  const tileSize = 80,
    chunkTiles = 6,
    size = tileSize * chunkTiles;
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 4; col++) {
      // Ground stays detailed at zoom; individual miners retain their full sprite resolution.
      const canvas = arenaSurface(size * 2, size * 2);
      const ctx = canvas.getContext('2d', { alpha: false }) as ArenaContext;
      ctx.scale(2, 2);
      for (let y = 0; y < chunkTiles; y++)
        for (let x = 0; x < chunkTiles; x++) {
          const tile = tiles[(row * chunkTiles + y) * 24 + col * chunkTiles + x];
          const frame = spriteFrame(image, tile.zone, 2, 2);
          ctx.drawImage(frame.image, x * tileSize, y * tileSize, tileSize + 1, tileSize + 1);
          ctx.fillStyle = ['#c9a56822', '#67804622', '#bc714122', '#deca9822'][tile.zone];
          ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
        }
      chunks.push({ image: canvas, x: col * size, y: row * size, size });
    }
  terrainCache = { key, source: image, chunks };
  return chunks;
}
