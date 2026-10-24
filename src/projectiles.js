// Projectiles (floor-local coordinates, rendered at floorY + y):
//  heart  - hero throw: parabolic arc, lead prediction, mild steering only for tapped targets
//  farrow - friend skeleton heart-arrow: homing, +1 love
//  arrow  - skeleton/stray arrow: slow straight shot (5 b/s) with a trail, 1 heart (+frost for strays)
//  wind   - breeze wind charge (4 b/s, spiral trail): launches the hero, no damage
//  puff   - friend breeze puff (a small wind charge): pushes a grumpy mob back
// Objects are pooled (created up front / lazily, never disposed during play). Pillars/blocks stop everything.
import { HEART_CFG, ROOM } from './config.js';
import { clamp } from './util.js';

export function createProjectiles(G) {
  const { kit } = G;
  const list = [];

  function make(type) {
    let obj;
    if (type === 'heart') obj = kit.makeHeart3D(0.42);
    else if (type === 'arrow') obj = kit.makeArrow(false);
    else if (type === 'farrow') obj = kit.makeArrow(true);
    else obj = kit.makeWindCharge();
    obj.visible = false;
    obj.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    G.scene.add(obj);
    const s = { type, type2: type, obj, active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0, ex: 0, ey: 0, ez: 0,
      t: 0, T: 1, peak: 1, falling: false, target: null, homing: false, owner: null, life: 0, trailT: 0, frost: false, spin: 0 };
    list.push(s);
    return s;
  }
  // pre-create the pool so shaders compile at boot (renderer.compile) and nothing allocates mid-play
  for (let i = 0; i < 6; i++) make('heart');
  for (let i = 0; i < 8; i++) make('arrow');
  for (let i = 0; i < 6; i++) make('farrow');
  for (let i = 0; i < 8; i++) make('wind');

  function get(type) {
    for (let i = 0; i < list.length; i++) if (!list[i].active && list[i].type === type) return list[i];
    let oldest = null;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.type !== type) continue;
      if (!oldest) { oldest = s; continue; }
      if (type === 'heart' ? (s.t > oldest.t) : (s.life < oldest.life)) oldest = s;
    }
    if (oldest) {
      deactivate(oldest, false);
      return oldest;
    }
    return make(type);
  }
  function heartsInFlight() { let n = 0; for (const s of list) if (s.active && s.type === 'heart') n++; return n; }
  function canThrowHeart() { return heartsInFlight() < HEART_CFG.maxInFlight; }

  // lead prediction toward where the target will be after T seconds (clamped inside the room)
  function aimPoint(target, T, out) {
    out.x = clamp(target.cx + target.vx * T * 0.85, 0.2, ROOM - 0.2);
    out.z = clamp(target.cz + target.vz * T * 0.85, 0.2, ROOM - 0.2);
    out.y = target.cy;
  }
  const _a = { x: 0, y: 0, z: 0 };

  function throwHeart(h, target, homing) {
    const s = get('heart');
    s.active = true; s.t = 0; s.falling = false; s.target = target; s.homing = !!(homing && target); s.spin = 0;
    s.sx = h.x + Math.sin(h.facing) * 0.32; s.sz = h.z + Math.cos(h.facing) * 0.32; s.sy = h.y + 1.3;
    if (target) {
      let d = Math.hypot(target.cx - s.sx, target.cz - s.sz);
      let T = Math.max(0.1, d / HEART_CFG.speed);
      aimPoint(target, T, _a);
      d = Math.hypot(_a.x - s.sx, _a.z - s.sz);
      T = Math.max(0.1, d / HEART_CFG.speed);
      aimPoint(target, T, _a);
      s.ex = _a.x; s.ey = _a.y; s.ez = _a.z; s.T = T;
      s.peak = Math.min(HEART_CFG.peak, 0.3 + d * 0.12);
    } else {
      s.ex = s.sx + Math.sin(h.facing) * 5; s.ez = s.sz + Math.cos(h.facing) * 5; s.ey = 0.3;
      s.T = 0.5; s.peak = 0.9;
    }
    s.x = s.sx; s.y = s.sy; s.z = s.sz;
    s.obj.visible = true;
  }

  function shootArrow(m, target, friendly) {
    const s = get(friendly ? 'farrow' : 'arrow');
    s.active = true; s.owner = m; s.target = target; s.life = friendly ? 3 : 4.2; s.trailT = 0; s.frost = m.kind === 'stray';
    s.x = m.x + Math.sin(m.facing) * 0.35; s.z = m.z + Math.cos(m.facing) * 0.35; s.y = 1.15;
    const sp = friendly ? 8 : 5;
    const tvx = target.vx || 0, tvz = target.vz || 0;
    const lead = friendly ? 0 : Math.hypot(target.x - s.x, target.z - s.z) / sp * 0.5;
    const dx = target.x + tvx * lead - s.x, dz = target.z + tvz * lead - s.z;
    const d = Math.hypot(dx, dz) || 1;
    s.vx = dx / d * sp; s.vz = dz / d * sp; s.vy = 0;
    s.obj.visible = true;
    G.audio.play('arrowShoot', { pitch: friendly ? 1.25 : 1 });
  }

  function shootWind(m, target, friendly) {
    const s = get('wind');
    s.active = true; s.owner = m; s.target = target; s.life = friendly ? 2.5 : 4; s.trailT = 0; s.homing = friendly;
    s.type2 = friendly ? 'puff' : 'wind';
    s.x = m.x + Math.sin(m.facing) * 0.4; s.z = m.z + Math.cos(m.facing) * 0.4; s.y = 1.05;
    const sp = friendly ? 6 : 4;
    const dx = target.x - s.x, dz = target.z - s.z, d = Math.hypot(dx, dz) || 1;
    s.vx = dx / d * sp; s.vz = dz / d * sp; s.vy = 0;
    s.obj.visible = true; s.obj.scale.setScalar(friendly ? 0.75 : 1);
    G.audio.play('breezeShoot', { pitch: friendly ? 1.3 : 1, volume: friendly ? 0.6 : 1 });
  }

  function deactivate(s, poof) {
    s.active = false; s.obj.visible = false; s.target = null; s.owner = null;
    if (poof) {
      const base = G.floorY();
      if (s.type === 'heart') G.fx.heartBurst(s.x, base + Math.max(0.15, s.y), s.z, 3, 1.4);
      else if (s.type === 'wind') G.fx.swirl(s.x, base + s.y, s.z, 6, 0.4);
      else G.fx.smoke(s.x, base + s.y, s.z, 2, 0.2, 0.3);
    }
  }

  function blocked(s) {
    if (s.x < 0.02 || s.z < 0.02 || s.x > ROOM - 0.02 || s.z > ROOM - 0.02) return true;
    return G.world.blockHeight(G.fs.index, s.x, s.z) > s.y;
  }

  // any grumpy mob counts (the targeted one is tested first)
  function hitGrumpy(s, r) {
    const mobs = G.mobs;
    const t = s.target;
    if (t && !t.removed && !t.isFriend && !t.hidden && overlaps(s, t, r)) return t;
    for (let k = 0; k < mobs.length; k++) {
      const m = mobs[k];
      if (m === t || m.removed || m.isFriend || m.hidden || m.state === 'pop') continue;
      if (overlaps(s, m, r)) return m;
    }
    return null;
  }
  function overlaps(s, m, r) {
    const dx = s.x - m.cx, dz = s.z - m.cz, rr = m.radius + r;
    if (dx * dx + dz * dz > rr * rr) return false;
    return Math.abs(s.y - m.cy) < m.height * 0.5 + r + 0.1;
  }

  function step(dt) {
    const h = G.hero;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s.active) continue;
      if (s.type === 'heart') stepHeart(s, dt);
      else if (s.type === 'arrow' || s.type === 'farrow') stepArrow(s, dt, h);
      else stepWind(s, dt, h);
    }
  }

  function stepHeart(s, dt) {
    s.t += dt;
    const t = s.target;
    if (!s.falling) {
      const u = s.t / s.T;
      if (s.homing && t && !t.removed && !t.isFriend) {
        // mild steering toward where the tapped mob now is
        const remain = Math.max(0, s.T - s.t);
        aimPoint(t, remain, _a);
        const k = Math.min(1, 7 * dt);
        s.ex += (_a.x - s.ex) * k; s.ez += (_a.z - s.ez) * k; s.ey += (_a.y - s.ey) * k;
      }
      if (u < 1) {
        const px = s.x, py = s.y, pz = s.z;
        s.x = s.sx + (s.ex - s.sx) * u; s.z = s.sz + (s.ez - s.sz) * u;
        s.y = s.sy + (s.ey - s.sy) * u + 4 * s.peak * u * (1 - u);
        s.vx = (s.x - px) / dt; s.vy = (s.y - py) / dt; s.vz = (s.z - pz) / dt;
      } else {
        s.falling = true;
      }
    } else {
      s.vy -= 20 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      if (s.y <= 0.1 || s.t > 3) { deactivate(s, true); return; }
    }
    s.spin += dt * 9;
    const m = hitGrumpy(s, 0.32);
    if (m) {
      const d = Math.hypot(s.vx, s.vz) || 1;
      const kb = (m.lastHeartHit && G.time - m.lastHeartHit < 0.5) ? 0.35 : 0.85;
      m.lastHeartHit = G.time;
      m.kx += s.vx / d * kb; m.kz += s.vz / d * kb;
      G.mobSys.addLove(m, 1, 'heart');
      deactivate(s, false);
      if (G.run && !G.run.hintTapDone) G.run.hintTapDone = true;
      return;
    }
    if (blocked(s)) { deactivate(s, true); return; }
    if ((s.trailT -= dt) <= 0) { s.trailT = 0.05; G.fx.sparkle(s.x, G.floorY() + s.y, s.z, 1, 1, 0.55, 0.7, 0.1); }
  }

  function stepArrow(s, dt, h) {
    s.life -= dt;
    if (s.life <= 0) { deactivate(s, true); return; }
    const friendly = s.type === 'farrow';
    if (friendly) {
      const t = s.target;
      if (!t || t.removed || t.isFriend) { deactivate(s, true); return; }
      const dx = t.cx - s.x, dz = t.cz - s.z, d = Math.hypot(dx, dz) || 1;
      const k = Math.min(1, 10 * dt);
      s.vx += (dx / d * 8 - s.vx) * k; s.vz += (dz / d * 8 - s.vz) * k;
      s.y += (t.cy - s.y) * Math.min(1, 4 * dt);
    }
    s.x += s.vx * dt; s.z += s.vz * dt;
    if (friendly) {
      const m = hitGrumpy(s, 0.25);
      if (m) { G.mobSys.addLove(m, 1, 'arrow'); deactivate(s, false); return; }
    } else if (h.state === 'play') {
      const dx = s.x - h.x, dz = s.z - h.z;
      if (dx * dx + dz * dz < 0.42 * 0.42 && s.y > h.y - 0.1 && s.y < h.y + 1.9) {
        G.heroSys.hurt(1, s.x - s.vx * 0.2, s.z - s.vz * 0.2, { frost: s.frost, knock: 0.6 });
        deactivate(s, true);
        return;
      }
    }
    if (blocked(s)) { deactivate(s, true); return; }
    if ((s.trailT -= dt) <= 0) {
      s.trailT = 0.045;
      const base = G.floorY();
      if (friendly) G.fx.emit('heart', s.x, base + s.y, s.z, 0, 0.3, 0, 0.35, 0.18, 0.04);
      else if (s.frost) G.fx.emit('sparkle', s.x, base + s.y, s.z, 0, 0.1, 0, 0.4, 0.22, 0.05, 0.6, 0.85, 1);
      else G.fx.emit('sparkle', s.x, base + s.y, s.z, 0, 0.1, 0, 0.3, 0.16, 0.04, 0.85, 0.8, 0.7);
    }
  }

  function stepWind(s, dt, h) {
    s.life -= dt;
    if (s.life <= 0) { deactivate(s, true); return; }
    const friendly = s.type2 === 'puff';
    if (friendly) {
      const t = s.target;
      if (!t || t.removed || t.isFriend) { deactivate(s, true); return; }
      const dx = t.cx - s.x, dz = t.cz - s.z, d = Math.hypot(dx, dz) || 1;
      const k = Math.min(1, 8 * dt);
      s.vx += (dx / d * 6 - s.vx) * k; s.vz += (dz / d * 6 - s.vz) * k;
      s.y += (t.cy - s.y) * Math.min(1, 6 * dt);
    }
    s.x += s.vx * dt; s.z += s.vz * dt;
    s.spin += dt * 12;
    if (friendly) {
      const m = hitGrumpy(s, 0.3);
      if (m) {
        // push the grumpy mob away from the hero and make it dizzy for a moment
        const dx = m.x - h.x, dz = m.z - h.z;
        const d = Math.hypot(dx, dz) || 1;
        m.kx += dx / d * 3.6; m.kz += dz / d * 3.6; m.dizzyT = 0.7;
        if (m.fuseSfx) G.mobSys.stopFuse(m, true);
        if (m.state === 'windup' || m.state === 'fuse' || m.state === 'crouch' || m.state === 'draw' || m.state === 'charge') G.mobSys.setState(m, 'recover');
        m.fuse = 0;
        G.fx.swirl(m.cx, G.floorY() + m.cy, m.cz, 10, 0.6);
        G.fx.emit('star', m.cx, G.floorY() + m.cy + 0.8, m.cz, 0, 1, 0, 0.6, 0.3, 0.2);
        deactivate(s, false);
        return;
      }
    } else if (h.state === 'play') {
      const dx = s.x - h.x, dz = s.z - h.z, dy = s.y - (h.y + 0.9);
      if (dx * dx + dz * dz + dy * dy < 0.72 * 0.72) {
        const d = Math.hypot(s.vx, s.vz) || 1;
        G.heroSys.launch(s.vx / d * 3, 7, s.vz / d * 3);
        G.fx.swirl(s.x, G.floorY() + s.y, s.z, 14, 0.8);
        deactivate(s, false);
        return;
      }
    }
    if (blocked(s)) { deactivate(s, true); return; }
    if ((s.trailT -= dt) <= 0) {
      s.trailT = 0.05;
      G.fx.emit('wind', s.x, G.floorY() + s.y, s.z, -s.vx * 0.15, 0.2, -s.vz * 0.15, 0.5, 0.42, 0.9, 0.8, 0.95, 1, 0, 1, 0, s.spin, 8);
    }
  }

  // per frame: place pooled objects
  function animate(dt) {
    const base = G.floorY();
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s.active) continue;
      s.obj.position.set(s.x, base + s.y, s.z);
      if (s.type === 'heart') { s.obj.rotation.set(0, s.spin, Math.sin(s.spin * 0.5) * 0.3); }
      else if (s.type === 'arrow' || s.type === 'farrow') s.obj.rotation.set(0, Math.atan2(s.vx, s.vz), 0);
      else if (s.obj.update) s.obj.update(dt || 0.016);   // kit wind charge spins itself
      else s.obj.rotation.set(s.spin * 0.6, s.spin, 0);
    }
  }

  function clear() { for (const s of list) if (s.active) deactivate(s, false); }
  function activeCount() { let n = 0; for (const s of list) if (s.active) n++; return n; }

  return { throwHeart, shootArrow, shootWind, step, animate, clear, canThrowHeart, heartsInFlight, activeCount };
}
