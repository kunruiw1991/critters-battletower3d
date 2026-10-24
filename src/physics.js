// Collision helpers in floor-local coordinates (x, z in blocks; interior = [0, 13]^2).
import { ROOM } from './config.js';

/**
 * Circle vs room walls + solid cells with full-normal depenetration (positions only).
 * Returns a bitmask: 1 = touched the room wall, 2 = touched a solid cell.
 */
export function collideCircle(world, f, e, r) {
  let hit = 0;
  const lo = r, hi = ROOM - r;
  if (e.x < lo) { e.x = lo; hit |= 1; } else if (e.x > hi) { e.x = hi; hit |= 1; }
  if (e.z < lo) { e.z = lo; hit |= 1; } else if (e.z > hi) { e.z = hi; hit |= 1; }
  const solid = world.floors[f].solid;
  const i0 = Math.max(0, Math.floor(e.x - r)), i1 = Math.min(ROOM - 1, Math.floor(e.x + r));
  const j0 = Math.max(0, Math.floor(e.z - r)), j1 = Math.min(ROOM - 1, Math.floor(e.z + r));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (solid[j * ROOM + i] !== 1) continue;
      const cx = e.x < i ? i : e.x > i + 1 ? i + 1 : e.x;
      const cz = e.z < j ? j : e.z > j + 1 ? j + 1 : e.z;
      const dx = e.x - cx, dz = e.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-10) {
        const d = Math.sqrt(d2), push = (r - d) / d;
        e.x += dx * push; e.z += dz * push;
      } else {
        // centre inside the cell: leave along the shortest interior axis (never outward through a room wall or into another solid cell)
        const l = (i > 0 && solid[j * ROOM + (i - 1)] !== 1) ? e.x - i : 1e9;
        const rr = (i < ROOM - 1 && solid[j * ROOM + (i + 1)] !== 1) ? i + 1 - e.x : 1e9;
        const t = (j > 0 && solid[(j - 1) * ROOM + i] !== 1) ? e.z - j : 1e9;
        const b = (j < ROOM - 1 && solid[(j + 1) * ROOM + i] !== 1) ? j + 1 - e.z : 1e9;
        const m = Math.min(l, rr, t, b);
        if (m === l) e.x = i - r; else if (m === rr) e.x = i + 1 + r; else if (m === t) e.z = j - r; else e.z = j + 1 + r;
      }
      hit |= 2;
    }
  }
  if (e.x < lo) { e.x = lo; hit |= 1; } else if (e.x > hi) { e.x = hi; hit |= 1; }
  if (e.z < lo) { e.z = lo; hit |= 1; } else if (e.z > hi) { e.z = hi; hit |= 1; }
  return hit;
}

/** Line of sight between two floor points: false if a block taller than minH is in the way. */
export function hasLOS(world, f, ax, az, bx, bz, minH = 1.1) {
  const dx = bx - ax, dz = bz - az;
  const d = Math.hypot(dx, dz);
  const n = Math.ceil(d / 0.25);
  for (let k = 1; k < n; k++) {
    const t = k / n;
    if (world.blockHeight(f, ax + dx * t, az + dz * t) > minH) return false;
  }
  return true;
}

/** True if the circle at (x, z) with radius r overlaps no solid cell. */
export function freeAt(world, f, x, z, r = 0.3) {
  if (x < r || z < r || x > ROOM - r || z > ROOM - r) return false;
  const solid = world.floors[f].solid;
  const i0 = Math.floor(x - r), i1 = Math.floor(x + r), j0 = Math.floor(z - r), j1 = Math.floor(z + r);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    if (i < 0 || j < 0 || i >= ROOM || j >= ROOM) return false;
    if (solid[j * ROOM + i] === 1) return false;
  }
  return true;
}
