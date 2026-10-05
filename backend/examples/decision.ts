import type { MiningCommand } from '../src/mining.js';
/** Replace this baseline with any model provider. It receives only the agent's API observation. */
export function decide(observation: any, style = 0): MiningCommand {
  const self = observation.self;
  if (self.venomUntil) return { type: 'treat' };
  if (observation.snakes.some((s: any) => Math.abs(s.x-self.x)+Math.abs(s.y-self.y) <= 2)) return { type:'repel' };
  if (self.cargo >= 8 + style*2 || self.cargo && (self.sequence >= 17 || observation.elapsedMs > 190000)) return { type: 'bank' };
  if (self.sequence >= 19) return { type:'wait' };
  const candidates = observation.terrain.flatMap((n: number, i: number) => {
    const x=i%24, y=Math.floor(i/24), key=`${x},${y}`;
    if (n>=16 || Math.floor(n/4)%4 === 0 || observation.excavations[key]?.depleted || observation.excavations[key]?.rubble) return [];
    return [{ x,y,score:Math.abs(x-self.x)+Math.abs(y-self.y)+(style ? Math.abs(x-12)*0.3 : 0) }];
  }).sort((a:any,b:any) => a.score-b.score);
  return candidates.length ? { type: 'mine', target: { x:candidates[0].x,y:candidates[0].y } } : {type:'wait'};
}
