// Game constants, mob stats and the floor table (spec sections 4-6).
// Pure data + tiny layout helpers; no THREE here.

export const VERSION = '1.0.0-r1';
export const SAVE_KEY = 'critters-battletower3d-v1';

export const FLOOR_H = 6;        // floor f slab top at y = f * 6
export const ROOM = 13;          // interior cells x, z in [0, 12]
export const WALL_H = 5;         // walls are 5 blocks tall
export const NUM_FLOORS = 7;     // floors 1-6 + roof
export const ROOF = 6;           // floor index of the roof (Golem Crown)
export const PHYS_DT = 1 / 120;  // fixed physics substep
export const MAX_DT = 0.05;      // frame dt clamp
export const XP_MAX = 12;        // orbs that fill the bar and arm the Heart-Bomb
export const MAX_FOLLOWERS = 12; // friends physically following (older ones wait downstairs)
export const FINALE_CROWD = 26;  // max friend rigs dancing in the finale

export const HERO_CFG = {
  speed: 3.6, radius: 0.35, maxHp: 5,
  invuln: 1.2, knock: 4, dizzy: 0.8, respawnDelay: 1.2,
  gravity: 13, cobwebSlow: 0.4, frostSlow: 0.6, frostTime: 1.5,
};

export const HEART_CFG = { speed: 10, peak: 1.2, cooldown: 0.3, maxInFlight: 4 };
export const BOMB_RADIUS = 20.0; // room-wide shockwave radius (covers full 13x13 diagonal = 18.4 blocks)

// speed in blocks/s, love = hearts needed to befriend. radius/height are fallbacks if a rig omits them.
export const MOB_DEFS = {
  zombie:     { speed: 1.1, love: 2,  radius: 0.34, height: 1.95, chase: 5.0 },
  spider:     { speed: 2.0, love: 2,  radius: 0.55, height: 0.9,  chase: 5.5 },
  caveSpider: { speed: 2.6, love: 1,  radius: 0.4,  height: 0.6,  chase: 5.5 },
  skeleton:   { speed: 1.4, love: 2,  radius: 0.3,  height: 1.95, chase: 9.0, ranged: true },
  stray:      { speed: 1.2, love: 3,  radius: 0.3,  height: 1.95, chase: 9.0, ranged: true, frost: true },
  creeper:    { speed: 1.3, love: 1,  radius: 0.32, height: 1.65, chase: 5.5 },
  breeze:     { speed: 2.2, love: 3,  radius: 0.38, height: 1.6,  chase: 8.0 },
  golem:      { speed: 0.9, love: 14, radius: 0.85, height: 3.2,  chase: 99 },
};
export const MOB_KINDS = Object.keys(MOB_DEFS);

// Floor table (spec section 6). waves spawn at the spawner(s) with a 0.8 s smoke + flame telegraph.
// A wave is released when waveGap seconds passed AND fewer than maxGrumpy grumpy mobs remain
// (or immediately-ish when the room is empty) so a slow child is never swamped.
export const FLOORS = [
  { key: 'zombieHall', start: ['zombie', 'zombie'], waves: [['zombie'], ['zombie']], waveGap: 6, maxGrumpy: 3,
    loot: [['cookie', 'cookie', 'goldenApple']] },
  { key: 'spiderDen', start: ['spider', 'spider'], startOnWall: true, waves: [['caveSpider', 'caveSpider'], ['spider']],
    waveGap: 6, maxGrumpy: 3, loot: [['diamond', 'goldenApple']], cobwebs: true },
  { key: 'skeletonGallery', start: ['skeleton', 'skeleton', 'zombie'], waves: [['skeleton'], ['skeleton']], waveGap: 7,
    maxGrumpy: 4, loot: [['diamond', 'emerald']], pillars: true },
  { key: 'creeperGarden', start: ['creeper', 'creeper', 'zombie', 'zombie'], waves: [['creeper'], ['creeper', 'zombie']],
    waveGap: 7, maxGrumpy: 4, loot: [['goldenApple', 'goldenApple', 'diamond']], grass: true },
  { key: 'breezeLoft', start: ['breeze', 'breeze', 'stray'], waves: [['breeze'], ['stray', 'stray']], waveGap: 7,
    maxGrumpy: 4, loot: [['diamond', 'emerald', 'cookie']], skyWindows: true, wind: true },
  { key: 'bigSwarm', start: ['zombie', 'zombie', 'skeleton'],
    waves: [['zombie', 'spider'], ['caveSpider', 'skeleton'], ['creeper', 'stray'], ['zombie', 'caveSpider'], ['spider']],
    waveGap: 5, maxGrumpy: 5, loot: [['goldenApple', 'diamond'], ['goldenApple', 'diamond']] },
  { key: 'roof', start: ['golem'], waves: [], waveGap: 0, maxGrumpy: 1, loot: [['diamond', 'diamond', 'trophy']], roof: true },
];

export function floorMobTotal(i) {
  const d = FLOORS[i];
  return d.start.length + d.waves.reduce((n, w) => n + w.length, 0);
}

// Ladders alternate corners so the arrival hole never sits under the next ladder:
// floors 1, 3, 5 climb in the NE corner, floors 2, 4, 6 in the NW corner (both on the north wall).
function ladderCell(i) { return i % 2 === 0 ? { x: 12, z: 0 } : { x: 0, z: 0 }; }

/** Static cell layout of floor i (cells are integer interior coordinates 0..12). */
export function floorLayout(i) {
  const ladder = i < ROOF ? ladderCell(i) : null;
  const hole = i > 0 ? ladderCell(i - 1) : null;          // where the ladder from below arrives
  const entry = i === 0 ? { x: 6.5, z: 11.9 } : { x: hole.x + 0.5, z: 1.7 };
  let chests;
  if (i === 5) chests = [{ x: 0, z: 12 }, { x: 12, z: 12 }];
  else if (i === ROOF) chests = [{ x: 12, z: 12 }];
  else chests = [i % 2 === 0 ? { x: 0, z: 12 } : { x: 12, z: 12 }];
  const spawners = i === 5 ? [{ x: 3, z: 6 }, { x: 9, z: 6 }] : i === ROOF ? [] : [{ x: 6, z: 6 }];
  const pillars = FLOORS[i].pillars ? [{ x: 3, z: 3 }, { x: 9, z: 3 }, { x: 3, z: 9 }, { x: 9, z: 9 }] : [];
  const cobwebs = FLOORS[i].cobwebs ? [{ x: 0, z: 11 }, { x: 0, z: 12 }, { x: 1, z: 12 }, { x: 11, z: 11 }, { x: 11, z: 12 }, { x: 12, z: 11 }] : [];
  // torches: north wall centre, north wall on the side away from the ladder, side wall near the ladder
  const torches = [];
  if (i < ROOF) {
    torches.push({ x: 6.5, z: 0, wall: 'N' });
    torches.push({ x: ladder.x === 12 ? 1.5 : 11.5, z: 0, wall: 'N' });
    torches.push(ladder.x === 12 ? { x: ROOM, z: 6.5, wall: 'E' } : { x: 0, z: 6.5, wall: 'W' });
  }
  return { ladder, hole, entry, chests, spawners, pillars, cobwebs, torches };
}
