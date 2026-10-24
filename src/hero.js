// The hero: purple-haired blocky girl. Movement (pointer hold / tap-walk / keyboard), throwing,
// bonk damage, wind launch, poof + respawn, breadcrumb trail for the friend parade.
import { HERO_CFG, HEART_CFG, ROOM } from './config.js';
import { collideCircle } from './physics.js';
import { angleDamp, clamp } from './util.js';

const TRAIL_CAP = 160;     // breadcrumb ring buffer (points every 0.2 blocks -> 32 blocks of trail)
const TRAIL_STEP = 0.2;
const DIRS8 = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414],
];

export function createHeroSystem(G) {
  const { THREE } = G;
  const rig = G.kit.makeHero();
  const holder = new THREE.Group();
  holder.rotation.order = 'YXZ';
  holder.add(rig.root);
  holder.visible = false;
  rig.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  G.scene.add(holder);

    const h = {
    rig, holder, radius: HERO_CFG.radius,
    x: 6.5, z: 11.9, y: 0, vy: 0, avx: 0, avz: 0, kx: 0, kz: 0, vx: 0, vz: 0,
    hp: HERO_CFG.maxHp, maxHp: HERO_CFG.maxHp, facing: Math.PI, state: 'off',
    invuln: 0, dizzy: 0, slowT: 0, airborne: false, tumble: 0, windTrailT: 0, throwCd: 0, throwAnim: 0,
    poofT: 0, speedNow: 0, still: 0, happyT: 0, stuckT: 0, lastDist: 0,
    auto: { active: false, x: 0, z: 0, action: 'floor', ref: null, path: [], wpIdx: 0 },
    pending: null,                 // buffered tap-throw target while on cooldown
    trail: new Float32Array(TRAIL_CAP * 2), trailHead: 0, trailN: 0, lastTX: 0, lastTZ: 0,
    anim: { t: 0, speed: 0, windup: 0, fuse: 0, isFriend: true, happy: 0, airborne: false, climbing: false,
      throwing: 0, dizzy: false, onWall: false, kneel: 0, groundOffset: 0 },
  };
  G.hero = h;

  function resetTrail() {
    h.trailHead = 0; h.trailN = 0; h.lastTX = h.x; h.lastTZ = h.z;
    pushTrail(h.x, h.z);
  }
  function pushTrail(x, z) {
    h.trail[h.trailHead * 2] = x; h.trail[h.trailHead * 2 + 1] = z;
    h.trailHead = (h.trailHead + 1) % TRAIL_CAP;
    if (h.trailN < TRAIL_CAP) h.trailN++;
    h.lastTX = x; h.lastTZ = z;
  }

  /** Place the hero at (x, z) on the current floor, full reset of transient state. */
  function place(x, z, facing = Math.PI) {
    h.x = x; h.z = z; h.y = 0; h.vy = 0; h.avx = h.avz = h.kx = h.kz = 0;
    h.airborne = false; h.tumble = 0; h.dizzy = 0; h.slowT = 0; h.facing = facing;
    h.auto.active = false; h.pending = null; h.still = 0;
    resetTrail();
  }

  /** Corner-safe 8-connected shortest path on the 13x13 floor grid around spawners, pillars, and holes. */
  function buildPath(f, sx, sz, tx, tz) {
    const W = G.world;
    const scx = clamp(Math.floor(sx), 0, ROOM - 1), scz = clamp(Math.floor(sz), 0, ROOM - 1);
    let gcx = clamp(Math.floor(tx), 0, ROOM - 1), gcz = clamp(Math.floor(tz), 0, ROOM - 1);
    // If target cell is solid (e.g. a corner chest pedestal), route to its nearest walkable neighbour cell first
    if (W.solidCell(f, gcx, gcz)) {
      let bestD = 1e9, bx = gcx, bz = gcz;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = gcx + dx, nz = gcz + dz;
          if (nx < 0 || nz < 0 || nx >= ROOM || nz >= ROOM || W.solidCell(f, nx, nz)) continue;
          const d = Math.hypot(nx + 0.5 - sx, nz + 0.5 - sz);
          if (d < bestD) { bestD = d; bx = nx; bz = nz; }
        }
      }
      gcx = bx; gcz = bz;
    }
    const N = ROOM * ROOM;
    const dist = new Float32Array(N).fill(1e9);
    const prev = new Int16Array(N).fill(-1);
    const used = new Uint8Array(N);
    const startIdx = scz * ROOM + scx, goalIdx = gcz * ROOM + gcx;
    dist[startIdx] = 0;
    for (let step = 0; step < N; step++) {
      let u = -1, best = 1e9;
      for (let i = 0; i < N; i++) if (!used[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u < 0 || u === goalIdx) break;
      used[u] = 1;
      const ux = u % ROOM, uz = (u / ROOM) | 0;
      for (const [ddx, ddz, cost] of DIRS8) {
        const nx = ux + ddx, nz = uz + ddz;
        if (nx < 0 || nz < 0 || nx >= ROOM || nz >= ROOM) continue;
        if (W.solidCell(f, nx, nz)) continue;
        // Diagonal move requires both cardinal neighbours to be open so hero radius never clips a block corner
        if (ddx !== 0 && ddz !== 0 && (W.solidCell(f, ux + ddx, uz) || W.solidCell(f, ux, uz + ddz))) continue;
        const v = nz * ROOM + nx;
        const nd = dist[u] + cost;
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; }
      }
    }
    const cells = [];
    if (dist[goalIdx] < 1e8) {
      for (let cur = goalIdx; cur !== -1 && cur !== startIdx; cur = prev[cur]) cells.push(cur);
      cells.reverse();
    }
    const wps = cells.map((idx) => ({ x: (idx % ROOM) + 0.5, z: ((idx / ROOM) | 0) + 0.5 }));
    wps.push({ x: tx, z: tz });
    return wps;
  }

  function setAuto(x, z, action, ref) {
    const f = G.fs ? G.fs.index : 0;
    h.auto.active = true; h.auto.x = x; h.auto.z = z; h.auto.action = action; h.auto.ref = ref;
    h.auto.path = buildPath(f, h.x, h.z, x, z);
    h.auto.wpIdx = 0;
    h.stuckT = 0; h.lastDist = 1e9;
  }

  // ---------------- per physics substep ----------------
  function step(dt) {
    if (h.invuln > 0) h.invuln -= dt;
    if (h.dizzy > 0) h.dizzy -= dt;
    if (h.slowT > 0) h.slowT -= dt;
    if (h.throwCd > 0) h.throwCd -= dt;
    if (h.throwAnim > 0) h.throwAnim = Math.max(0, h.throwAnim - dt / 0.3);
    if (h.happyT > 0) h.happyT -= dt;
    if (h.state === 'poof') {
      h.poofT -= dt;
      if (h.poofT <= 0) respawn();
      return;
    }
    if (h.state !== 'play') { h.speedNow = 0; return; }
    if (h.pending && h.throwCd <= 0) { const t = h.pending; h.pending = null; tryThrow(t, true); }

    const f = G.fs.index;
    const inp = G.input;
    let dx = 0, dz = 0, want = false, stopDist = 0;
    if (inp.keyX !== 0 || inp.keyZ !== 0) {
      const l = Math.hypot(inp.keyX, inp.keyZ);
      dx = inp.keyX / l; dz = inp.keyZ / l; want = true; h.auto.active = false;
    } else if (inp.holding && inp.holdValid) {
      const ddx = inp.holdX - h.x, ddz = inp.holdZ - h.z, d = Math.hypot(ddx, ddz);
      if (d > 0.2) { dx = ddx / d; dz = ddz / d; want = true; stopDist = d; }
      h.auto.active = false;
    } else if (h.auto.active) {
      const a = h.auto;
      const ddx = a.x - h.x, ddz = a.z - h.z, d = Math.hypot(ddx, ddz);
      const arrive = a.action === 'chest' ? 1.4 : a.action === 'gift' ? 0.9 : a.action === 'ladder' ? 0.45 : 0.22;
      if (d <= arrive) {
        a.active = false;
        if (a.action === 'chest' && a.ref && !a.ref.opened) G.loot.openChest(a.ref);
        else if (a.action === 'ladder') G.game.tryClimb();
        else if (a.action === 'gift') G.game.pickPoppy();
      } else {
        while (a.wpIdx < a.path.length - 1 && Math.hypot(a.path[a.wpIdx].x - h.x, a.path[a.wpIdx].z - h.z) <= 0.14) {
          a.wpIdx++;
          h.lastDist = 1e9;
        }
        const wp = a.path[a.wpIdx] || a;
        const wdx = wp.x - h.x, wdz = wp.z - h.z, wd = Math.hypot(wdx, wdz) || 1e-4;
        dx = wdx / wd; dz = wdz / wd; want = true; stopDist = d;
        // Re-path if knocked off course; only cancel if completely blocked for 3.5 s
        if (wd < h.lastDist - 0.005) {
          h.lastDist = wd; h.stuckT = 0;
        } else {
          h.stuckT += dt;
          if (h.stuckT > 0.5 && h.stuckT - dt <= 0.5) {
            a.path = buildPath(f, h.x, h.z, a.x, a.z);
            a.wpIdx = 0;
            h.lastDist = 1e9;
          } else if (h.stuckT > 3.5) {
            a.active = false;
          }
        }
      }
    }

    let speed = h.auto.active ? Math.max(HERO_CFG.speed, 6.2) : HERO_CFG.speed;
    if (G.world.isSlow(f, h.x, h.z)) speed *= HERO_CFG.cobwebSlow;
    if (h.slowT > 0) speed *= HERO_CFG.frostSlow;
    if (h.dizzy > 0) speed *= 0.55;
    if (want && stopDist > 0) speed = Math.min(speed, stopDist / dt * 0.5);

    let vx = want ? dx * speed : 0, vz = want ? dz * speed : 0;
    if (h.airborne) {
      // launched: keep the push, allow a little steering, gravity, tumble
      h.avx *= Math.exp(-0.6 * dt); h.avz *= Math.exp(-0.6 * dt);
      vx = h.avx + vx * 0.35; vz = h.avz + vz * 0.35;
      h.vy -= HERO_CFG.gravity * dt; h.y += h.vy * dt; h.tumble += dt * 9;
      h.windTrailT -= dt;
      if (h.windTrailT <= 0) {
        h.windTrailT = 0.055;
        G.fx.swirl(h.x, G.floorY() + h.y + 0.5, h.z, 2, 0.35);
      }
      if (h.y <= 0) {
        h.y = 0; h.vy = 0; h.airborne = false; h.tumble = 0; h.avx = h.avz = 0;
        G.fx.smoke(h.x, G.floorY() + 0.1, h.z, 5, 0.5, 0.45);
        G.audio.play('land');
      }
    }
    const kd = Math.exp(-7 * dt);
    h.kx *= kd; h.kz *= kd;
    vx += h.kx; vz += h.kz;
    h.x += vx * dt; h.z += vz * dt;
    collideCircle(G.world, f, h, h.radius);
    h.vx = vx; h.vz = vz;
    h.speedNow = want ? speed : Math.hypot(vx, vz) * 0.5;
    if (want) h.facing = angleDamp(h.facing, Math.atan2(dx, dz), 14, dt);
    h.still = (want || h.airborne) ? 0 : h.still + dt;
    // breadcrumbs for the conga line
    if ((h.x - h.lastTX) ** 2 + (h.z - h.lastTZ) ** 2 > TRAIL_STEP * TRAIL_STEP) pushTrail(h.x, h.z);
    if (inp.holding && want && G.run) G.run.dragDist += speed * dt;
  }

  /** Point at distance `dist` back along the breadcrumb trail (written into out[o..o+1]). */
  function trailPoint(dist, out, o) {
    let px = h.x, pz = h.z, acc = 0;
    let idx = (h.trailHead - 1 + TRAIL_CAP) % TRAIL_CAP;
    for (let k = 0; k < h.trailN; k++) {
      const tx = h.trail[idx * 2], tz = h.trail[idx * 2 + 1];
      const seg = Math.hypot(tx - px, tz - pz);
      if (acc + seg >= dist) {
        const u = seg > 1e-6 ? (dist - acc) / seg : 0;
        out[o] = px + (tx - px) * u; out[o + 1] = pz + (tz - pz) * u;
        return;
      }
      acc += seg; px = tx; pz = tz;
      idx = (idx - 1 + TRAIL_CAP) % TRAIL_CAP;
    }
    out[o] = px; out[o + 1] = pz;
  }

  // ---------------- actions ----------------
  function tryThrow(target, homing) {
    if (h.state !== 'play' || !G.fs) return false;
    if (h.throwCd > 0) { if (target && homing) h.pending = target; return false; }
    if (!G.proj.canThrowHeart()) { if (target && homing) h.pending = target; return false; }
    if (!target) { target = G.mobSys.nearestGrumpy(h.x, h.z, 99); homing = false; }
    if (target && (target.isFriend || target.removed)) return false;
    h.throwCd = HEART_CFG.cooldown;
    h.throwAnim = 1;
    if (target) h.facing = Math.atan2(target.x - h.x, target.z - h.z);
    G.proj.throwHeart(h, target, homing);
    G.audio.play('throw', { pitch: 0.95 + G.vrng() * 0.12 });
    return true;
  }

  function hurt(n, fromX, fromZ, opts = {}) {
    if (h.state !== 'play' || (h.invuln > 0 && !opts.force)) return false;
    const fs = G.fs;
    if (!fs || (!opts.force && (fs.phase === 'climb' || fs.phase === 'finale' || fs.phase === 'end' || fs.phase === 'gift' || fs.phase === 'cleared'))) return false;
    h.hp = Math.max(0, h.hp - n);
    fs.bonks++;
    let dx = h.x - fromX, dz = h.z - fromZ;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    const k = HERO_CFG.knock * (opts.knock || 1);
    h.kx = dx * k; h.kz = dz * k;
    h.dizzy = HERO_CFG.dizzy; h.invuln = HERO_CFG.invuln;
    if (h.auto.active && G.fs) {
      h.auto.path = buildPath(G.fs.index, h.x, h.z, h.auto.x, h.auto.z);
      h.auto.wpIdx = 0; h.lastDist = 1e9; h.stuckT = 0;
    }
    if (opts.frost) { h.slowT = HERO_CFG.frostTime; rig.flash(0x6fc4ff, 1.5); } else rig.flash(0xff3b3b, 0.35);
    G.cam.addShake(0.08);
    if (!rig.stars) G.fx.dizzy(3);          // rigs with built-in dizzy stars show them via state.dizzy
    G.fx.smoke(h.x, G.floorY() + 1.0, h.z, 3, 0.4, 0.35);
    G.audio.play('hurt');
    if (h.hp <= 0) poof();
    return true;
  }

  function launch(vx, vy, vz) {
    if (h.state !== 'play') return;
    h.airborne = true; h.vy = vy; h.avx = vx; h.avz = vz;
    h.y = Math.max(h.y, 0.02);
    h.auto.active = false;
    G.audio.play('windLaunch');
    G.fx.swirl(h.x, G.floorY() + 0.6, h.z, 10, 0.8);
  }

  function poof() {
    h.state = 'poof'; h.poofT = HERO_CFG.respawnDelay;
    h.auto.active = false; h.pending = null;
    G.fs.poofed = true;
    if (G.run) G.run.poofs++;
    const y = G.floorY();
    G.fx.smoke(h.x, y + 0.8, h.z, 18, 1.0, 0.9);
    G.fx.sparkle(h.x, y + 1.0, h.z, 8, 1, 1, 1, 1.0);
    G.audio.play('poof');
  }

  function respawn() {
    const e = G.fs.floor.entry;
    place(e.x, e.z, Math.PI);
    h.state = 'play'; h.hp = h.maxHp; h.invuln = 2.2;
    G.mobSys.pushAwayFrom(e.x, e.z, 4.6);
    G.fx.sparkle(h.x, G.floorY() + 1, h.z, 14, 1, 0.9, 1, 1.2);
    G.fx.heartBurst(h.x, G.floorY() + 1.2, h.z, 6, 2);
  }

  // ---------------- per frame visuals ----------------
  function animate(dt) {
    const a = h.anim;
    a.t += dt;
    a.speed = h.speedNow;
    a.throwing = h.throwAnim;
    a.airborne = h.airborne;
    a.dizzy = h.dizzy > 0;
    a.climbing = h.state === 'climb';
    a.happy = h.state === 'finale' ? 0.35 : h.happyT > 0 ? 1 : 0;
    a.groundOffset = h.state === 'finale' ? 0 : Math.max(0, h.y);
    rig.animate(a, dt);
    const base = G.floorY();
    holder.position.set(h.x, base + h.y, h.z);
    holder.rotation.set(0, h.facing + (h.airborne ? h.tumble : 0), 0);
    let vis = h.state !== 'poof' && h.state !== 'off';
    if (vis && h.invuln > 0 && h.state === 'play') vis = Math.floor(h.invuln * 12) % 2 === 0;
    holder.visible = vis;
  }

  return { h, step, animate, place, setAuto, tryThrow, hurt, launch, poof, respawn, trailPoint, resetTrail };
}
