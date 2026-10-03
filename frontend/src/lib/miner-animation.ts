import type { Miner } from './mining.ts';
import type { ArenaContext } from './mine-art.ts';

// A public job controls whether motion is shown; the frame clock controls the
// gait. Changing packets or job phases never substitutes an idle pose mid-step.
export function minerAnimation(p: Miner, slot: number, time: number) {
  const job = p.job;
  const begun = p.alive && job && time >= job.started;
  const walking = Boolean(begun && job!.phase === 'walk' && job!.path.length && time < job!.until);
  const digging = Boolean(begun && job!.phase === 'dig');
  const toolWork =
    digging || Boolean(begun && job!.phase === 'work' && ['clear', 'repel'].includes(job!.type));
  const stepMs = p.crown ? 280 : p.cargo >= 16 ? 230 : 180;
  const walkPhase = ((time + slot * 91) / stepMs) * Math.PI;
  const stride = walking ? Math.sin(walkPhase) : 0;
  const walkFrame = Math.floor((time + slot * 91) / stepMs) % 2;
  const age = job ? Math.max(0, time - job.started) : 0;
  const toolPhase = age % 680;
  const row = toolWork ? 1 + (Math.floor(age / 340) % 2) : 0;
  return {
    walking,
    digging,
    toolWork,
    toolPhase,
    sheet: walking ? (p.cargo ? 5 : 4) : slot < 4 ? 0 : 1,
    frame: walking ? Math.floor(slot / 4) * 8 + walkFrame * 4 + (slot % 4) : row * 4 + (slot % 4),
    bob: walking
      ? -Math.abs(stride) * 1.25
      : p.alive && !toolWork
        ? Math.sin(time / 900 + slot) * 1.15
        : 0,
    stride,
    mirror: Boolean(walking && job!.path[0]?.x < p.x),
  };
}

// Art remains a cached raster. Only the lower leg regions articulate; the head,
// torso, tool and diamond backpack keep their orientation. No surfaces are
// allocated while walking. This makes the boots move even when two illustrated
// contact poses have similar silhouettes.
export function drawMinerStride(
  ctx: ArenaContext,
  paint: () => void,
  stride: number,
  originY: number,
  size = 86,
) {
  const split = 0.56 * size - size / 2;
  const left = -0.35 * size,
    right = 0.38 * size;
  const top = -0.3 * size + originY,
    height = 0.3 * size;
  const legs = [
    { x: left, width: split - left, pivot: -0.12 * size, sign: 1 },
    { x: split, width: right - split, pivot: 0.2 * size, sign: -1 },
  ];
  for (const leg of legs) {
    const swing = stride * leg.sign;
    ctx.save();
    ctx.translate(leg.pivot + swing * 3.5, top - Math.max(0, swing) * 4.5);
    ctx.rotate(swing * 0.16);
    ctx.translate(-leg.pivot, -top);
    ctx.beginPath();
    ctx.rect(leg.x, top, leg.width, height);
    ctx.clip();
    paint();
    ctx.restore();
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(-size, size * -1.5 + originY, size * 2, size * 2);
  ctx.rect(left, top, right - left, height);
  ctx.clip('evenodd');
  paint();
  ctx.restore();
}
