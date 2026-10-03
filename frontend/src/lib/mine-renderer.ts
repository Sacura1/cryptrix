import { minerColors, minerPosition, type MineState } from './mining.ts';
import {
  artGeneration,
  atlasWidth,
  prepareTerrain,
  spriteFrame,
  type ArenaContext,
  type AtlasImage,
} from './mine-art.ts';
import type { Camera, Viewport } from './mine-camera.ts';
import { minerAnimation, drawMinerStride } from './miner-animation.ts';
const TILE = 80;

// Static ground is prepared once; only visible actors and effects are drawn each frame.
export function createMineRenderer(
  ctx: ArenaContext,
  size: Viewport,
  ratio: number,
  art: AtlasImage[],
) {
  const labelWidths = new Map<string, number>();
  let terrain: ReturnType<typeof prepareTerrain> | undefined;
  let previousTiles: MineState['tiles'] | undefined;
  let terrainKey = '';
  let generation = -1;
  const prepare = (w: MineState) => {
    if (generation !== artGeneration()) {
      terrain = undefined;
      previousTiles = undefined;
      generation = artGeneration();
    }
    if (w.tiles !== previousTiles) {
      const key = w.tiles.map((tile) => tile.zone).join('');
      if (key !== terrainKey || !terrain) {
        terrain = prepareTerrain(w.tiles, art[3]);
        terrainKey = key;
      }
      previousTiles = w.tiles;
    }
  };
  const draw = (
    w: MineState,
    t: number,
    names: Record<string, string>,
    cam: Camera,
    mini = false,
  ) => {
    const width = size.width,
      height = size.height,
      z = cam.zoom;
    const halfX = width / z / 2,
      halfY = height / z / 2;
    prepare(w);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#4b4632';
    ctx.fillRect(0, 0, width, height);
    ctx.translate(width / 2, height / 2);
    ctx.scale(z, z);
    ctx.translate(-cam.x, -cam.y);
    const collapse = w.events.find((e) => e.kind === 'collapse' && t >= e.at && t - e.at < 500);
    if (collapse) ctx.translate(Math.sin(t / 25) * 3, Math.cos(t / 31) * 2);
    ctx.imageSmoothingEnabled = true;
    for (const chunk of terrain!) {
      if (
        chunk.x > cam.x + halfX ||
        chunk.x + chunk.size < cam.x - halfX ||
        chunk.y > cam.y + halfY ||
        chunk.y + chunk.size < cam.y - halfY
      )
        continue;
      ctx.drawImage(chunk.image, chunk.x, chunk.y, chunk.size, chunk.size);
    }
    const left = Math.max(0, Math.floor((cam.x - halfX) / TILE) - 1),
      right = Math.min(23, Math.ceil((cam.x + halfX) / TILE) + 1);
    const top = Math.max(0, Math.floor((cam.y - halfY) / TILE) - 1),
      bottom = Math.min(23, Math.ceil((cam.y + halfY) / TILE) + 1);
    const sprite = (
      image: AtlasImage,
      index: number,
      x: number,
      y: number,
      scale: number,
      rows = 4,
      cols = 4,
      halo = false,
    ) => {
      if (!image || !atlasWidth(image)) return;
      const frame = spriteFrame(image, index, rows, cols, halo);
      const padding = frame.padding * scale;
      ctx.drawImage(
        frame.image,
        x - scale / 2 - padding,
        y - scale - padding + frame.groundOffset * scale,
        scale + padding * 2,
        scale + padding * 2,
      );
    };
    const props: { x: number; y: number; index: number; scale: number }[] = [];
    for (let y = top; y <= bottom; y++)
      for (let x = left; x <= right; x++) {
        const tile = w.tiles[y * 24 + x];
        if (!tile) continue;
        const px = x * TILE,
          py = y * TILE;
        const hole = w.excavations[`${x},${y}`];
        if (hole && hole.depth > 0) {
          ctx.fillStyle = '#573923';
          ctx.beginPath();
          ctx.ellipse(
            px + 40,
            py + 47,
            28 + hole.depth * 2,
            18 + hole.depth * 2,
            -0.15,
            0,
            Math.PI * 2,
          );
          ctx.fill();
          ctx.strokeStyle = '#d3a167';
          ctx.lineWidth = 7;
          ctx.stroke();
          ctx.fillStyle = '#2c221b';
          ctx.beginPath();
          ctx.ellipse(px + 40, py + 49, 22, 13 + hole.depth, 0, 0, Math.PI * 2);
          ctx.fill();
          if (hole.crackUntil && t < hole.crackUntil) {
            ctx.strokeStyle = Math.floor(t / 200) % 2 ? '#f19b46' : '#893920';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(px + 7, py + 3);
            ctx.lineTo(px + 27, py + 25);
            ctx.lineTo(px + 22, py + 55);
            ctx.lineTo(px + 63, py + 76);
            ctx.stroke();
          }
          if (hole.rubble) props.push({ x: px + 40, y: py + 76, index: 0, scale: 83 });
        } else if (tile.vein && !tile.blocked)
          props.push({
            x: px + 39,
            y: py + 64,
            index: tile.vein === 2 ? 3 : 2,
            scale: tile.vein === 2 ? 48 : 32,
          });
        if (tile.blocked)
          props.push({ x: px + 40, y: py + 76, index: tile.zone === 3 ? 1 : 0, scale: 87 });
        if (!tile.blocked && !tile.vein && !hole && (x * 19 + y * 37) % 23 === 0)
          props.push({ x: px + 40, y: py + 63, index: 15, scale: 58 });
      }
    for (const b of w.bases)
      props.push({ x: (b.x + 0.5) * TILE, y: (b.y + 1) * TILE, index: 12, scale: 120 });
    for (const b of w.clinics)
      props.push({ x: (b.x + 0.5) * TILE, y: (b.y + 1) * TILE, index: 13, scale: 100 });
    for (const b of [
      { x: 4, y: 0 },
      { x: 19, y: 23 },
    ])
      props.push({ x: (b.x + 0.5) * TILE, y: (b.y + 1) * TILE, index: 11, scale: 150 });
    for (const d of w.drops)
      props.push({
        x: (d.x + 0.5) * TILE,
        y: (d.y + 0.8) * TILE,
        index: d.crown ? 8 : 9,
        scale: d.crown ? 65 : 42,
      });
    // Props and actors share a depth order, so miners actually enter the landscape.
    const inView = (x: number, y: number) =>
      x > cam.x - halfX - 180 &&
      x < cam.x + halfX + 180 &&
      y > cam.y - halfY - 180 &&
      y < cam.y + halfY + 180;
    const actors = w.players
      .map((p, i) => {
        const pos = minerPosition(p, t);
        return { p, i, x: (pos.x + 0.5) * TILE, y: (pos.y + 0.8) * TILE };
      })
      .filter(({ x, y }) => inView(x, y));
    const layers = [
      ...props
        .filter((p) => inView(p.x, p.y))
        .map((p) => ({ y: p.y, draw: () => sprite(art[2], p.index, p.x, p.y, p.scale) })),
      ...w.snakes
        .filter((s) => inView((s.x + 0.5) * TILE, (s.y + 0.8) * TILE))
        .map((s) => ({
          y: (s.y + 0.8) * TILE,
          draw: () => {
            const x = (s.x + 0.5) * TILE,
              y = (s.y + 0.8) * TILE;
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(Math.sin(t / 180) * 0.04);
            sprite(
              art[2],
              (s.venomous ? 6 : 4) + (s.phase === 'strike' ? 1 : 0),
              0,
              0,
              s.phase === 'strike' ? 70 : 55,
            );
            ctx.restore();
            if (s.phase === 'strike') {
              ctx.fillStyle = '#ffe3a1';
              ctx.font = 'bold 24px Manrope';
              ctx.fillText('!', x, y - 62);
            }
          },
        })),
      ...actors.map(({ p, i, x, y }) => ({
        y,
        draw: () => {
          ctx.save();
          ctx.translate(x, y);
          const motion = minerAnimation(p, i, t);
          const { walking, digging, toolWork, bob, mirror } = motion;
          ctx.fillStyle = '#171d22aa';
          ctx.beginPath();
          ctx.ellipse(0, 2, 27, 12, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#fff0ce';
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.ellipse(0, 2, 30, 15, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = minerColors[i];
          ctx.lineWidth = 3;
          ctx.stroke();
          if (!p.alive) {
            ctx.globalAlpha = 0.65;
            ctx.rotate(-Math.PI / 2);
          }
          if (p.venomUntil) {
            ctx.fillStyle = '#bdea6070';
            ctx.beginPath();
            ctx.ellipse(0, -10, 35 + Math.sin(t / 150) * 3, 20, 0, 0, Math.PI * 2);
            ctx.fill();
          }
          if (mirror) ctx.scale(-1, 1);
          const paint = () => sprite(art[motion.sheet], motion.frame, 0, bob, 86, 4, 4, true);
          if (walking) {
            const frame = spriteFrame(art[motion.sheet], motion.frame, 4, 4, true);
            drawMinerStride(ctx, paint, motion.stride, bob + frame.groundOffset * 86);
          } else {
            if (toolWork) {
              ctx.save();
              // The upper-body frames provide the pickaxe swing; a slight
              // follow-through keeps its impact readable at small map scales.
              ctx.translate(0, motion.toolPhase > 340 ? 1 : 0);
              paint();
              ctx.restore();
            } else paint();
          }
          if (mirror) ctx.scale(-1, 1);
          if (digging) {
            const phase = Math.max(0, t - p.job!.started) % 680;
            if (phase > 360 && phase < 610)
              for (let n = 0; n < 6; n++) {
                const life = (phase - 360) / 250;
                ctx.fillStyle = n % 2 ? '#e3bb73aa' : '#805332cc';
                ctx.beginPath();
                ctx.arc(
                  18 + Math.cos(n * 2.4) * life * 30,
                  -7 - Math.sin(n * 1.8) * life * 25,
                  3 * (1 - life) + 1,
                  0,
                  Math.PI * 2,
                );
                ctx.fill();
              }
          }
          ctx.restore();
          if (p.job?.phase === 'inspect') {
            ctx.save();
            ctx.strokeStyle = '#e9e4a399';
            ctx.lineWidth = 2;
            const radius = 15 + ((Math.max(0, t - p.job.started) % 750) / 750) * 40;
            ctx.beginPath();
            ctx.ellipse(x, y + 3, radius, radius * 0.5, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
          if (p.job?.type === 'bank' && p.job.phase === 'work' && p.cargo) {
            const progress = Math.min(1, Math.max(0, (t - p.job.started) / p.job.duration));
            sprite(art[2], 9, x + 25, y - 10 - progress * 80, 34);
          }
          ctx.save();
          ctx.translate(x, y);
          ctx.fillStyle = '#252b24';
          ctx.strokeStyle = minerColors[i];
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(-17, -103, 34, 22, 7);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#fff4dc';
          ctx.font = 'bold 13px Manrope';
          ctx.textAlign = 'center';
          ctx.fillText(String(i + 1).padStart(2, '0'), 0, -87);
          if (!mini && z > 0.6) {
            ctx.font = 'bold 10px Manrope';
            const label = names[p.id] ?? `Miner ${i + 1}`;
            let labelWidth = labelWidths.get(label);
            if (labelWidth === undefined) {
              labelWidth = ctx.measureText(label).width + 12;
              labelWidths.set(label, labelWidth);
            }
            ctx.fillStyle = '#222b22e8';
            ctx.fillRect(-labelWidth / 2, 17, labelWidth, 17);
            ctx.fillStyle = '#fff0d1';
            ctx.fillText(label, 0, 29);
          }
          if (p.cargo) {
            ctx.fillStyle = p.crown ? '#ffe56b' : '#d6f4eb';
            ctx.font = 'bold 12px Manrope';
            ctx.fillText(`◆ ${p.cargo}`, 0, 46);
          }
          if (p.crown) {
            sprite(art[2], 8, 29, -58 + Math.sin(t / 260) * 3, 34);
          }
          if (p.venomUntil) {
            ctx.fillStyle = '#e9ff98';
            ctx.font = 'bold 12px Manrope';
            ctx.fillText(`VENOM ${Math.ceil(Math.max(0, p.venomUntil - t) / 1000)}s`, 0, -111);
          }
          if (!p.alive) {
            ctx.fillStyle = '#ffcfb1';
            ctx.font = 'bold 11px Manrope';
            ctx.fillText('OUT', 0, -61);
          }
          if (p.job && p.alive && p.job.phase !== 'walk') {
            const progress = Math.min(1, Math.max(0, (t - p.job.started) / p.job.duration));
            ctx.fillStyle = '#282d25';
            ctx.fillRect(-22, 8, 44, 4);
            ctx.fillStyle = minerColors[i];
            ctx.fillRect(-22, 8, progress * 44, 4);
          }
          ctx.restore();
        },
      })),
    ];
    layers.sort((a, b) => a.y - b.y).forEach((layer) => layer.draw());
    for (const e of w.events.filter((e) =>
      ['treasure', 'bank', 'crown', 'bite', 'treated', 'recover', 'collapse'].includes(e.kind),
    )) {
      const age = t - e.at;
      if (age < 0 || age > 2600) continue;
      if (!inView((e.x + 0.5) * TILE, (e.y + 0.5) * TILE)) continue;
      if (e.kind === 'collapse') {
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - age / 2200);
        for (let n = 0; n < 12; n++) {
          const spread = Math.min(1, age / 650),
            angle = n * 2.399;
          ctx.fillStyle = n % 2 ? '#dcc795' : '#857250';
          ctx.beginPath();
          ctx.arc(
            (e.x + 0.5) * TILE + Math.cos(angle) * spread * 64,
            (e.y + 0.6) * TILE + Math.sin(angle) * spread * 35 - Math.sin(spread * Math.PI) * 30,
            3 + (n % 4),
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
        ctx.restore();
      }
      ctx.save();
      ctx.globalAlpha = Math.min(1, (2600 - age) / 800);
      ctx.font = 'bold 18px Manrope';
      ctx.textAlign = 'center';
      ctx.strokeStyle = '#233329';
      ctx.lineWidth = 5;
      ctx.fillStyle = e.kind === 'bite' ? '#ff9d74' : '#fff5ab';
      const text =
        e.kind === 'bite'
          ? 'BITTEN!'
          : e.value
            ? `+${e.value} ◆`
            : e.kind === 'treated'
              ? 'CURED'
              : e.kind === 'collapse'
                ? 'CAVE-IN!'
                : 'CROWN!';
      const x = (e.x + 0.5) * TILE,
        y = (e.y - 0.3) * TILE - age / 60;
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
      ctx.restore();
    }
  };
  return Object.assign(draw, { prepare });
}
