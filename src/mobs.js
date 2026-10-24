// Mobs: grumpy AI for every kind (zombie, spider wall-crawl + silk drop + pounce, cave spider zig-zag,
// skeleton/stray archers, creeper fuse/defuse/pop, breeze wind charges, iron golem slams), the befriend
// celebration, and friend behaviour (conga parade, dance ring, helper hugs, heart-arrows, wind puffs).
// All gameplay runs inside fixed 1/120 s substeps; `animate` is the per-frame visual pass.
import { MOB_DEFS, ROOM, MAX_FOLLOWERS } from './config.js';
import { clamp, TAU, angleDamp, easeOutBack, lerp } from './util.js';
import { collideCircle, hasLOS, freeAt } from './physics.js';

const VOICE = { zombie: 'zombie', skeleton: 'skeleton', stray: 'skeleton', spider: 'spider', caveSpider: 'spider' };
const SHOOTER = { skeleton: 1, stray: 1, breeze: 1 };

export function createMobSystem(G) {
  const { THREE } = G;
  const mobs = G.mobs;
  let nextId = 1;
  const silkGeo = new THREE.BoxGeometry(0.035, 1, 0.035);
  const silkMat = new THREE.MeshBasicMaterial({ color: 0xf2f2f6 });
  const silkPool = [];
  const parade = new Float32Array(MAX_FOLLOWERS * 2);
  const _mb = new THREE.Matrix4(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3();

  function setState(m, s) { m.state = s; m.stateT = 0; }

  // ---------------- lifecycle ----------------
  function spawn(kind, x, z, opts = {}) {
    if (!Object.prototype.hasOwnProperty.call(MOB_DEFS, kind)) kind = 'zombie';
    const def = MOB_DEFS[kind];
    const rig = G.kit.makeMob(kind);
    rig.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    const holder = new THREE.Group();
    holder.rotation.order = 'YXZ';
    holder.add(rig.root);
    G.scene.add(holder);
    const m = {
      id: nextId++, kind, def, rig, holder, removed: false, hidden: false,
      x, z, y: 0, vy: 0, vx: 0, vz: 0, dvx: 0, dvz: 0, kx: 0, kz: 0, jx: 0, jz: 0,
      cx: x, cy: 1, cz: z,
      facing: opts.facing !== undefined && opts.facing !== null ? opts.facing : 0, look: 0, lx: 0, lz: 0,
      radius: rig.radius || def.radius, height: rig.height || def.height,
      love: 0, loveNeeded: def.love, isFriend: false, friend: false,
      state: 'pop', stateT: 0, t: G.rng() * 10, cd: 1 + G.rng() * 1.2,
      wanderT: 0, wx: x, wz: z, strafe: G.rng() < 0.5 ? -1 : 1,
      windup: 0, fuse: 0, happy: 0, dizzyT: 0, airborne: false, kneel: 0,
      spin: 0, squash: 0, popT: opts.instant ? 1 : 0, meterPulse: 0,
      wall: null, wallSide: 'N', silk: null, rigSilk: !!rig.silk, pendingCelebrate: false,
      hopT: G.rng(), climbT: 4 + G.rng() * 4, slamT: 2.5, slamIdx: 0, sx: x, sz: z, stepT: 0,
      groanT: 2 + G.rng() * 6,
      fIndex: -1, hugCd: 0, task: null, climbDelay: 0, danceA: 0, danceR: 2,
      anim: { t: 0, speed: 0, windup: 0, fuse: 0, isFriend: false, happy: 0, airborne: false, climbing: false,
        throwing: 0, dizzy: false, onWall: false, kneel: 0, groundOffset: 0, silk: 0 },
    };
    if (opts.friend) {
      m.isFriend = true; m.friend = true; m.love = m.loveNeeded;
      rig.setFriend(true);
      m.state = opts.state || 'follow';
    }
    if (opts.wall) {
      m.wall = { side: opts.wall.side, u: opts.wall.u, h: opts.wall.h, off: 0, phase: 'crawl',
        dir: G.rng() < 0.5 ? -1 : 1, top: opts.wall.h, dropT: opts.wall.dropT !== undefined && opts.wall.dropT !== null ? opts.wall.dropT : 2.5 };
      m.state = 'wall';
      wallPos(m);
    }
    updateCenter(m);
    mobs.push(m);
    return m;
  }

  function remove(m) {
    if (m.removed) return;
    m.removed = true;
    stopFuse(m, false);
    releaseSilk(m);
    if (m.holder.parent) m.holder.parent.remove(m.holder);
    m.rig.dispose();
  }

  function sweep() {
    let w = 0;
    for (let r = 0; r < mobs.length; r++) if (!mobs[r].removed) mobs[w++] = mobs[r];
    mobs.length = w;
    const fl = G.followers;
    w = 0;
    for (let r = 0; r < fl.length; r++) {
      if (!fl[r].removed) {
        fl[r].fIndex = w;
        fl[w++] = fl[r];
      }
    }
    fl.length = w;
  }

  function clearAll() {
    for (const m of mobs) remove(m);
    mobs.length = 0;
    G.followers.length = 0;
  }

  // ---------------- silk threads (spiders dropping from the wall top) ----------------
  function attachSilk(m) {
    if (m.rigSilk || m.silk) return;      // rigs that own a silk thread draw it themselves (state.silk)
    let s = silkPool.pop();
    if (!s) { s = new THREE.Mesh(silkGeo, silkMat); G.scene.add(s); }
    s.visible = true;
    m.silk = s;
  }
  function releaseSilk(m) {
    if (!m.silk) return;
    m.silk.visible = false;
    silkPool.push(m.silk);
    m.silk = null;
  }

  // ---------------- per substep ----------------
  function step(dt) {
    const f = G.fs.index;
    computeParade();
    helperDispatch(dt);
    if (G.cheerT > 0) G.cheerT -= dt;
    for (let k = 0; k < mobs.length; k++) {
      const m = mobs[k];
      if (!m.removed) updateMob(m, dt, f);
    }
    separate(f);
    sweep();
  }

  function updateMob(m, dt, f) {
    m.t += dt; m.stateT += dt;
    if (m.cd > 0) m.cd -= dt;
    if (m.hugCd > 0) m.hugCd -= dt;
    if (m.popT < 1) m.popT = Math.min(1, m.popT + dt / 0.28);
    if (m.happy > 0 && m.state !== 'befriend') m.happy = Math.max(0, m.happy - dt * 0.8);
    m.dvx = 0; m.dvz = 0; m.look = 0;
    if (m.state === 'climbIn') { climbIn(m, dt); updateCenter(m); return; }
    if (m.wall) { wallStep(m, dt); updateCenter(m); return; }
    if (m.isFriend) friendStep(m, dt, f);
    else if (m.dizzyT > 0) { m.dizzyT -= dt; m.windup = Math.max(0, m.windup - dt * 4); }
    else grumpyStep(m, dt, f);
    integrate(m, dt, f);
    updateCenter(m);
  }

  function integrate(m, dt, f) {
    const kd = Math.exp(-6 * dt);
    m.kx *= kd; m.kz *= kd;
    let vx, vz;
    if (m.airborne) {
      vx = m.jx + m.kx; vz = m.jz + m.kz;
      m.vy -= 18 * dt; m.y += m.vy * dt;
      if (m.y <= 0) { m.y = 0; m.vy = 0; m.airborne = false; }
    } else { vx = m.dvx + m.kx; vz = m.dvz + m.kz; }
    m.x += vx * dt; m.z += vz * dt;
    collideCircle(G.world, f, m, m.radius);
    m.vx = vx; m.vz = vz;
    const h = G.hero;
    if (m.look === 1) m.facing = angleDamp(m.facing, Math.atan2(h.x - m.x, h.z - m.z), 10, dt);
    else if (m.look === 2) m.facing = angleDamp(m.facing, Math.atan2(m.lx - m.x, m.lz - m.z), 10, dt);
    else if (m.dvx * m.dvx + m.dvz * m.dvz > 0.04) m.facing = angleDamp(m.facing, Math.atan2(m.dvx, m.dvz), 9, dt);
  }

  function updateCenter(m) {
    if (m.wall && m.wall.phase !== 'drop') {
      const W = m.wall;
      const nx = W.side === 'W' ? 1 : W.side === 'E' ? -1 : 0, nz = W.side === 'N' ? 1 : 0;
      m.cx = m.x + nx * 0.3; m.cz = m.z + nz * 0.3; m.cy = m.y + 0.35;
    } else { m.cx = m.x; m.cz = m.z; m.cy = m.y + m.height * 0.5; }
  }

  // ---------------- grumpy AI ----------------
  function grumpyStep(m, dt, f) {
    const h = G.hero;
    const can = h.state === 'play' && h.invuln <= 1.15;
    const dx = h.x - m.x, dz = h.z - m.z, d = Math.hypot(dx, dz) || 1e-4;
    const reach = m.radius + h.radius + 0.3;
    if ((m.groanT -= dt) <= 0) {
      m.groanT = 4 + G.rng() * 5;
      if (d < 9 && VOICE[m.kind]) G.audio.play(VOICE[m.kind], { pitch: 0.9 + G.vrng() * 0.2 });
    }
    if (m.state === 'pop') { if (m.stateT > 0.3) setState(m, 'wander'); return; }
    switch (m.kind) {
      case 'zombie': case 'caveSpider': melee(m, dt, f, dx, dz, d, reach, can); break;
      case 'spider': spider(m, dt, f, dx, dz, d, reach, can); break;
      case 'skeleton': case 'stray': ranged(m, dt, f, dx, dz, d, can); break;
      case 'creeper': creeper(m, dt, f, dx, dz, d, can); break;
      case 'breeze': breeze(m, dt, f, dx, dz, d, can); break;
      case 'golem': golem(m, dt, f, dx, dz, d, can); break;
      default: melee(m, dt, f, dx, dz, d, reach, can);
    }
  }

  function wander(m, dt, f, mul = 0.5) {
    if (m.state !== 'wander') { setState(m, 'wander'); m.wanderT = 0; }
    m.wanderT -= dt;
    const ddx = m.wx - m.x, ddz = m.wz - m.z, dd = Math.hypot(ddx, ddz);
    if (m.wanderT <= 0 || dd < 0.3) { pickWander(m, f); return; }
    const sp = m.def.speed * mul;
    m.dvx = ddx / dd * sp; m.dvz = ddz / dd * sp;
  }
  function pickWander(m, f) {
    const h = G.hero;
    for (let k = 0; k < 8; k++) {
      let x, z;
      if (G.rng() < 0.55 && h.state === 'play') { x = h.x + (G.rng() - 0.5) * 7; z = h.z + (G.rng() - 0.5) * 7; }
      else { x = 0.8 + G.rng() * 11.4; z = 0.8 + G.rng() * 11.4; }
      if (freeAt(G.world, f, x, z, m.radius)) { m.wx = x; m.wz = z; break; }
    }
    m.wanderT = 1.8 + G.rng() * 2.4;
  }

  function melee(m, dt, f, dx, dz, d, reach, can) {
    if (m.state === 'windup') {
      m.windup = Math.min(1, m.stateT / 0.45); m.look = 1;
      if (m.stateT >= 0.45) {
        if (can && d < reach + 0.4) G.heroSys.hurt(1, m.x, m.z);
        setState(m, 'recover'); m.cd = 1.1;
      }
      return;
    }
    m.windup = Math.max(0, m.windup - dt * 5);
    if (m.state === 'recover') { if (m.stateT > 0.55) setState(m, 'chase'); return; }
    if (can && d < m.def.chase) {
      if (m.state !== 'chase') setState(m, 'chase');
      let ux = dx / d, uz = dz / d;
      if (m.kind === 'caveSpider' && d > 1.4) {
        const w = Math.sin(m.t * 6.5) * 0.85;
        const px = -uz, pz = ux;
        ux += px * w; uz += pz * w;
        const l = Math.hypot(ux, uz); ux /= l; uz /= l;
      }
      if (d > reach * 0.8) { m.dvx = ux * m.def.speed; m.dvz = uz * m.def.speed; }
      if (d < reach && m.cd <= 0) {
        setState(m, 'windup');
        G.audio.play(m.kind === 'zombie' ? 'zombie' : 'spider', { volume: 0.7, pitch: m.kind === 'zombie' ? 1 : 1.4 });
      }
    } else wander(m, dt, f);
  }

  function spider(m, dt, f, dx, dz, d, reach, can) {
    if (m.state === 'crouch') {
      m.windup = Math.min(1, m.stateT / 0.5); m.look = 1;
      if (m.stateT >= 0.5) {
        const T = 0.47, sp = Math.min(5.0, d / T);
        m.jx = dx / d * sp; m.jz = dz / d * sp; m.vy = 4.2; m.airborne = true; m.windup = 0;
        setState(m, 'pounce');
        G.audio.play('spider', { pitch: 1.1 });
        G.audio.play('hop', { pitch: 1.1 });
      }
      return;
    }
    if (m.state === 'pounce') {
      m.look = 1;
      if (!m.airborne) {
        if (can && d < reach + 0.35) G.heroSys.hurt(1, m.x, m.z);
        setState(m, 'recover'); m.cd = 1.7;
      }
      return;
    }
    if (m.state === 'recover') { if (m.stateT > 0.6) setState(m, 'chase'); return; }
    if (m.state === 'toWall') {
      const ddx = m.wx - m.x, ddz = m.wz - m.z, dd = Math.hypot(ddx, ddz);
      if (dd < 0.12 || m.stateT > 3) { startWallClimb(m); return; }
      m.dvx = ddx / dd * m.def.speed; m.dvz = ddz / dd * m.def.speed;
      if (can && d < 2.6) setState(m, 'chase');
      return;
    }
    if (can && d < m.def.chase) {
      if (m.state !== 'chase') setState(m, 'chase');
      if (d > reach * 0.85) { m.dvx = dx / d * m.def.speed; m.dvz = dz / d * m.def.speed; }
      if (d < 2.4 && m.cd <= 0) setState(m, 'crouch');
    } else {
      wander(m, dt, f);
      if ((m.climbT -= dt) <= 0) { m.climbT = 5 + G.rng() * 5; considerWall(m); }
    }
  }
  function considerWall(m) {
    const dn = m.z, dw = m.x, de = ROOM - m.x;
    let side = 'N', dist = dn;
    if (dw < dist) { side = 'W'; dist = dw; }
    if (de < dist) { side = 'E'; dist = de; }
    if (dist > 3.4 || G.rng() < 0.25) return;
    const r = m.radius + 0.02;
    if (side === 'N') { m.wx = clamp(m.x, 5.0, 8.0); m.wz = r; } else if (side === 'W') { m.wx = r; m.wz = clamp(m.z, 5.6, 8.4); } else { m.wx = ROOM - r; m.wz = clamp(m.z, 5.6, 8.4); }
    if (!freeAt(G.world, G.fs.index, m.wx, m.wz, m.radius * 0.9)) return;
    m.wallSide = side;
    setState(m, 'toWall');
  }
  function startWallClimb(m) {
    const side = m.wallSide;
    const u0 = side === 'N' ? clamp(m.x, 5.0, 8.0) : clamp(m.z, 5.6, 8.4);
    m.wall = { side, u: u0, h: 0, off: 0, phase: 'up', dir: G.rng() < 0.5 ? -1 : 1,
      top: 2.35 + G.rng() * 0.45, dropT: 2.2 + G.rng() * 2.5 };
    setState(m, 'wall');
    wallPos(m);
  }
  function wallPos(m) {
    const W = m.wall;
    if (W.side === 'N') { m.x = W.u; m.z = 0.24 + W.off; } else if (W.side === 'W') { m.x = 0.24 + W.off; m.z = W.u; } else { m.x = ROOM - 0.24 - W.off; m.z = W.u; }
    m.y = W.h;
  }
  function wallStep(m, dt) {
    const W = m.wall, h = G.hero;
    m.windup = 0; m.vx = 0; m.vz = 0;
    switch (W.phase) {
      case 'up':
        W.h += 1.7 * dt;
        if (W.h >= W.top) { W.h = W.top; W.phase = 'crawl'; }
        if (m.isFriend) W.phase = 'off';
        break;
      case 'crawl': {
        const uMin = W.side === 'N' ? 5.0 : 5.6, uMax = W.side === 'N' ? 8.0 : 8.4;
        W.u += W.dir * 1.15 * dt;
        if (W.u < uMin) { W.u = uMin; W.dir = 1; } else if (W.u > uMax) { W.u = uMax; W.dir = -1; }
        W.dropT -= dt;
        const gx = W.side === 'N' ? W.u : W.side === 'W' ? 0.64 : ROOM - 0.64;
        const gz = W.side === 'N' ? 0.64 : W.u;
        const near = h.state === 'play' && Math.hypot(h.x - gx, h.z - gz) < 3.0;
        if (W.side === 'N') m.vx = W.dir * 1.15; else m.vz = W.dir * 1.15;
        if (W.dropT <= 0 || near || m.isFriend) W.phase = 'off';
        break;
      }
      case 'off':
        W.off += 2.6 * dt;
        if (W.off >= 0.62) { W.off = 0.62; W.phase = 'drop'; attachSilk(m); G.audio.play('spider', { volume: 0.8 }); }
        break;
      case 'drop':
        W.h -= 3.4 * dt;
        if (W.h <= 0) {
          W.h = 0;
          wallPos(m);
          m.wall = null; m.y = 0;
          releaseSilk(m);
          collideCircle(G.world, G.fs.index, m, m.radius);
          G.fx.smoke(m.x, G.floorY() + 0.1, m.z, 4, 0.5, 0.4);
          if (m.isFriend) { setState(m, 'befriend'); m.pendingCelebrate = false; } else { setState(m, 'recover'); m.cd = 0.8; }
          return;
        }
        break;
      default: break;
    }
    wallPos(m);
  }

  function ranged(m, dt, f, dx, dz, d, can) {
    if (m.state === 'draw') {
      m.windup = Math.min(1, m.stateT / 0.7); m.look = 1;
      if (m.stateT >= 0.7) {
        if (can) G.proj.shootArrow(m, G.hero, false);
        setState(m, 'recover'); m.cd = 2.3 + G.rng() * 0.9;
      }
      return;
    }
    m.windup = Math.max(0, m.windup - dt * 5);
    if (m.state === 'recover') { if (m.stateT > 0.45) setState(m, 'chase'); return; }
    if (can && d < m.def.chase) {
      if (m.state !== 'chase') setState(m, 'chase');
      m.look = 1;
      keepRange(m, dx, dz, d, m.def.speed, 1, dt);
      if (m.cd <= 0 && d < 9 && hasLOS(G.world, f, m.x, m.z, G.hero.x, G.hero.z)) {
        setState(m, 'draw');
        G.audio.play('skeleton', { pitch: m.kind === 'stray' ? 0.85 : 1 });
      }
    } else wander(m, dt, f);
  }
  function keepRange(m, dx, dz, d, sp, mul, dt) {
    if (d < 4) { m.dvx = -dx / d * sp * 0.85 * mul; m.dvz = -dz / d * sp * 0.85 * mul; } else if (d > 6) { m.dvx = dx / d * sp * mul; m.dvz = dz / d * sp * mul; } else {
      m.dvx = -dz / d * sp * 0.45 * m.strafe * mul; m.dvz = dx / d * sp * 0.45 * m.strafe * mul;
      if (G.rng() < dt * 0.4) m.strafe *= -1;
    }
  }

  function stopFuse(m, defused) {
    if (m.fuseSfx) {
      if (typeof m.fuseSfx.stop === 'function') m.fuseSfx.stop(0.06);
      m.fuseSfx = null;
      if (defused) G.audio.play('defuse');
    }
  }
  function creeper(m, dt, f, dx, dz, d, can) {
    if (m.state === 'fuse') {
      m.look = 1;
      m.fuse = Math.min(1, m.fuse + dt / 1.6);
      if (Math.floor(m.t * 16) !== Math.floor((m.t - dt) * 16)) {
        const base = G.floorY();
        G.fx.flames(m.x, base + m.height + 0.1, m.z, 2, 0.35);
        G.fx.smoke(m.x, base + m.height + 0.1, m.z, 1, 0.35, 0.38);
        G.fx.sparkle(m.x, base + m.height + 0.1, m.z, 2, 1, 0.9, 0.4, 0.45);
      }
      if (!can || d > 3.6) { stopFuse(m, true); setState(m, 'chase'); return; }   // hero escaped: fuse fizzles back down
      if (m.fuse >= 1) pop(m);
      return;
    }
    if (m.fuse > 0) m.fuse = Math.max(0, m.fuse - dt / 0.7);
    if (can && d < m.def.chase) {
      if (m.state !== 'chase') setState(m, 'chase');
      m.dvx = dx / d * m.def.speed; m.dvz = dz / d * m.def.speed;
      if (d < 1.8 && m.fuse <= 0.05) { setState(m, 'fuse'); m.fuseSfx = G.audio.play('creeperFuse'); }
    } else wander(m, dt, f);
  }
  function pop(m) {
    stopFuse(m, false);
    const base = G.floorY();
    G.fx.confettiPop(m.x, base + 0.9, m.z);
    G.audio.play('creeperPop');
    G.cam.addShake(0.1);
    const h = G.hero;
    if (Math.hypot(h.x - m.x, h.z - m.z) < 2.2) G.heroSys.hurt(1, m.x, m.z, { knock: 1.4 });
    G.fs.respawns.push({ kind: 'creeper', t: 5 });
    G.fs.pops++;
    remove(m);
  }

  function breeze(m, dt, f, dx, dz, d, can) {
    m.hopT += dt;
    const hp = (m.hopT % 0.6) / 0.6;
    m.y = 0.15 + Math.sin(hp * Math.PI) * 0.45;
    const hopMul = hp < 0.75 ? 1.25 : 0.25;
    if (m.state === 'charge') {
      m.windup = Math.min(1, m.stateT / 0.6); m.look = 1;
      if (m.stateT >= 0.6) {
        if (can) G.proj.shootWind(m, G.hero, false);
        setState(m, 'recover'); m.cd = 2.8 + G.rng() * 1.0;
      }
      return;
    }
    m.windup = Math.max(0, m.windup - dt * 4);
    if (m.state === 'recover') { if (m.stateT > 0.5) setState(m, 'chase'); return; }
    if (can && d < m.def.chase) {
      if (m.state !== 'chase') setState(m, 'chase');
      m.look = 1;
      keepRange(m, dx, dz, d, m.def.speed, hopMul, dt);
      if (m.cd <= 0 && d < 7.5) setState(m, 'charge');
    } else wander(m, dt, f, 0.5 * hopMul);
  }

  function golem(m, dt, f, dx, dz, d, can) {
    m.slamT -= dt;
    if (m.state === 'slam') {
      const dur = m.slamIdx === 0 ? 1.0 : 0.75;
      m.windup = Math.min(1, m.stateT / dur); m.look = 2; m.lx = m.sx; m.lz = m.sz;
      if (m.stateT >= dur) {
        slamImpact(m);
        m.windup = 0;   // a sharp windup drop makes the rig play its slam-down pose
        if (m.love >= 7 && m.slamIdx === 0) { aimSlam(m); m.slamIdx = 1; setState(m, 'slam'); } else {
          setState(m, 'recover'); m.slamIdx = 0; m.slamT = m.love >= 7 ? 3 : 4;
        }
      }
      return;
    }
    m.windup = Math.max(0, m.windup - dt * 3);
    if (m.state === 'recover') { if (m.stateT > 0.6) setState(m, 'chase'); return; }
    if (can) {
      if (m.state !== 'chase') setState(m, 'chase');
      m.look = 1;
      if (d > 2.6) {
        m.dvx = dx / d * m.def.speed; m.dvz = dz / d * m.def.speed;
        if ((m.stepT -= dt) <= 0) { m.stepT = 0.62; G.audio.play('golemStep'); }
      }
      if (m.slamT <= 0) { aimSlam(m); m.slamIdx = 0; setState(m, 'slam'); }
    } else wander(m, dt, f);
  }
  function aimSlam(m) {
    const h = G.hero;
    if (Math.hypot(h.x - m.x, h.z - m.z) < 5.5) { m.sx = h.x; m.sz = h.z; } else {
      m.sx = m.x + Math.sin(m.facing) * 2; m.sz = m.z + Math.cos(m.facing) * 2;
    }
    m.sx = clamp(m.sx, 0.6, 12.4); m.sz = clamp(m.sz, 0.6, 12.4);
  }
  function slamImpact(m) {
    const base = G.floorY();
    G.fx.ring('smoke', m.sx, base + 0.25, m.sz, 2.1, 20, 2.6, 0.75, 0.92, 0.9, 0.88, 0.7);
    G.fx.ring('sparkle', m.sx, base + 0.3, m.sz, 1.0, 16, 4.2, 0.45, 1, 0.55, 0.4, 0.5);
    G.fx.smoke(m.sx, base + 0.2, m.sz, 8, 1.2, 0.8);
    G.cam.addShake(0.1);
    G.audio.play('golemSlam');
    const h = G.hero;
    const d = Math.hypot(h.x - m.sx, h.z - m.sz);
    if (d < 2.4 && h.y < 0.6 && h.state === 'play') {
      if (G.heroSys.hurt(1, m.sx, m.sz, { knock: 1.1 })) {
        const nx = (h.x - m.sx) / (d || 1), nz = (h.z - m.sz) / (d || 1);
        G.heroSys.launch(nx * 2.4, 5, nz * 2.4);
      }
    }
  }

  // ---------------- friends ----------------
  function computeParade() {
    const fl = G.followers;
    const n = Math.min(fl.length, MAX_FOLLOWERS);
    for (let k = 0; k < fl.length; k++) fl[k].fIndex = k;
    for (let k = 0; k < n; k++) G.heroSys.trailPoint(1.0 + k * 0.9, parade, k * 2);
  }

  function helperDispatch(dt) {
    G.helperT -= dt;
    if (G.helperT > 0) return;
    G.helperT = 2.5 + G.rng() * 0.5;
    if (!G.fs || G.fs.phase !== 'fight') return;
    const fl = G.followers;
    if (!fl.length) return;
    let budget = 1 + Math.floor(fl.length / 5);
    const start = Math.floor(G.rng() * fl.length);
    for (let i = 0; i < fl.length && budget > 0; i++) {
      const m = fl[(start + i) % fl.length];
      if (m.removed || m.state !== 'follow' || m.hugCd > 0 || m.hidden) continue;
      const shooter = !!SHOOTER[m.kind];
      const t = nearestGrumpy(m.x, m.z, shooter ? 7.5 : 4.2, !shooter);
      if (!t) continue;
      m.task = t;
      setState(m, shooter ? 'aim' : 'hugGo');
      budget--;
    }
  }

  function hover(m) { return m.kind === 'breeze' ? 0.2 : 0; }

  function friendStep(m, dt, f) {
    switch (m.state) {
      case 'befriend': celebrate(m, dt); return;
      case 'kneel': m.kneel = Math.min(1, m.kneel + dt * 2); m.look = 1; return;
      case 'finale': return;   // driven by the game finale
      case 'dance': dance(m, dt); return;
      case 'hugGo': hugGo(m, dt); return;
      case 'aim': aim(m, dt); return;
      case 'hugBack': if (m.stateT > 0.4) setState(m, 'follow'); follow(m, dt); return;
      case 'pop': if (m.stateT > 0.3) setState(m, 'follow'); return;
      default: follow(m, dt);
    }
  }

  function celebrate(m, dt) {
    if (m.airborne) { m.stateT = 0; return; }
    // the rig plays the hop + 360 spin when `happy` rises; we freeze, squash a little and glow
    if (m.stateT - dt <= 0.18 && m.stateT > 0.18) G.audio.play('hop', { pitch: m.kind === 'golem' ? 0.8 : 1.05 });
    const T = m.kind === 'golem' ? 1.2 : 0.95;
    const u = Math.min(1, m.stateT / T);
    m.y = hover(m);
    m.squash = Math.sin(u * Math.PI * 2) * (1 - u) * 0.16;
    m.happy = 1;
    if (m.stateT >= T) {
      m.spin = 0; m.squash = 0; m.y = hover(m);
      if (m.kind === 'golem') { setState(m, 'kneel'); G.game.onGolemKneel(m); } else setState(m, 'follow');
    }
  }

  function follow(m, dt) {
    const h = G.hero;
    const k = m.fIndex;
    if (k < 0 || k >= MAX_FOLLOWERS) { m.y = hover(m); return; }
    const cheer = G.cheerT > 0;
    let tx, tz;
    if (cheer || h.still > 0.45 || h.state !== 'play') {
      // gather in a ring around the hero and dance (the rig hops while happy)
      const n = Math.min(G.followers.length, MAX_FOLLOWERS);
      const inner = Math.min(n, 8), outer = n - inner;
      const ring = k < 8 ? 0 : 1, idx = ring ? k - 8 : k, cnt = ring ? outer : inner;
      const R = (cheer ? 1.35 : 1.75) + ring * 0.95 + (m.radius > 0.45 ? 0.3 : 0);   // wide enough to never hide the hero
      const a = (idx / Math.max(1, cnt)) * TAU + G.time * (cheer ? 0.9 : 0.25) + ring * 0.4;
      tx = h.x + Math.cos(a) * R; tz = h.z + Math.sin(a) * R;
      m.look = 1;
      m.y = hover(m);
      m.happy = Math.max(m.happy, cheer ? 1 : 0.45);
    } else {
      tx = parade[k * 2]; tz = parade[k * 2 + 1];
      m.y = hover(m) + Math.abs(Math.sin(G.time * 8 + k * 0.9)) * 0.1;   // bouncy conga step
    }
    tx = clamp(tx, 0.45, ROOM - 0.45); tz = clamp(tz, 0.45, ROOM - 0.45);
    const ddx = tx - m.x, ddz = tz - m.z, dd = Math.hypot(ddx, ddz);
    if (dd > 0.06) {
      const sp = Math.min(5.4, dd * 4 + 0.4);
      m.dvx = ddx / dd * sp; m.dvz = ddz / dd * sp;
    }
  }

  function hugGo(m, dt) {
    const t = m.task;
    m.y = hover(m);
    if (!t || t.removed || t.isFriend || t.wall || t.hidden || m.stateT > 3.2) { m.task = null; setState(m, 'hugBack'); return; }
    const ddx = t.x - m.x, ddz = t.z - m.z, dd = Math.hypot(ddx, ddz) || 1e-4;
    if (dd < m.radius + t.radius + 0.2) {
      G.audio.play('hug');
      addLove(t, 1, 'hug');
      G.fx.heartBurst((m.x + t.x) / 2, G.floorY() + 1.2, (m.z + t.z) / 2, 6, 2);
      m.happy = 1; m.hugCd = 3; m.task = null;
      setState(m, 'hugBack');
      return;
    }
    m.dvx = ddx / dd * 3.4; m.dvz = ddz / dd * 3.4;
  }

  function aim(m, dt) {
    const t = m.task;
    m.y = hover(m);
    if (!t || t.removed || t.isFriend || t.hidden) { m.task = null; m.windup = 0; setState(m, 'follow'); return; }
    m.look = 2; m.lx = t.x; m.lz = t.z;
    m.windup = Math.min(1, m.stateT / 0.5);
    if (m.stateT >= 0.5) {
      if (m.kind === 'breeze') G.proj.shootWind(m, t, true); else G.proj.shootArrow(m, t, true);
      m.hugCd = 3; m.windup = 0; m.task = null;
      setState(m, 'follow');
    }
  }

  function climbIn(m, dt) {
    m.vx = 0; m.vz = 0;
    if (m.climbDelay > 0) { m.climbDelay -= dt; m.hidden = true; m.stateT = 0; return; }
    m.hidden = false;
    const fl = G.fs.floor, hole = fl.layout.hole;
    const hx = hole ? hole.x + 0.5 : fl.entry.x, hz = 0.5;
    const ex = clamp(fl.entry.x + ((m.fIndex % 3) - 1) * 0.7, 0.6, ROOM - 0.6), ez = fl.entry.z + 0.5 + (m.fIndex % 2) * 0.4;
    const s = Math.min(1, m.stateT / 0.5);
    m.x = lerp(hx, ex, s); m.z = lerp(hz, ez, s);
    m.y = -1.1 + 1.1 * s + 3.2 * s * (1 - s) + (s >= 1 ? hover(m) : 0);
    m.facing = Math.atan2(ex - hx, ez - hz);
    if (s >= 1) {
      m.y = hover(m);
      setState(m, 'follow');
      G.fx.smoke(m.x, G.floorY() + 0.1, m.z, 3, 0.4, 0.35);
      if (m.fIndex < 4) G.audio.play('climb', { pitch: 1.3 });
    }
  }

  function dance(m, dt) {
    const F = G.finale;
    const cx = F && F.golem ? F.golem.x : G.hero.x, cz = F && F.golem ? F.golem.z : G.hero.z;
    // Front-and-side semi-circle around +z (south) so dancers never stand behind the golem's shoulder where the hero sits
    const sway = Math.sin(G.time * 0.9 + m.id * 0.7) * 0.12;
    const theta = clamp(m.danceA + sway, -0.46 * Math.PI, 0.46 * Math.PI);
    let tx = clamp(cx + Math.sin(theta) * m.danceR, 0.75, ROOM - 0.75);
    let tz = clamp(cz + Math.max(0.95, Math.cos(theta) * m.danceR), 0.75, ROOM - 0.75);
    if (tz < cz + 0.95) tz = cz + 0.95;
    const ddx = tx - m.x, ddz = tz - m.z, dd = Math.hypot(ddx, ddz);
    if (dd > 0.06) { const sp = Math.min(4.5, dd * 3 + 0.3); m.dvx = ddx / dd * sp; m.dvz = ddz / dd * sp; }
    m.look = 2; m.lx = cx; m.lz = cz;
    m.y = hover(m);
    m.happy = 1;
  }

  // ---------------- love / befriend ----------------
  function addLove(m, n, src) {
    if (!m || m.removed || m.isFriend) return false;
    m.love = Math.min(m.loveNeeded, m.love + n);
    m.rig.flash(0xff7ab0, 0.3);
    m.meterPulse = 1;
    const base = G.floorY();
    G.fx.sparkle(m.cx, base + m.cy + 0.2, m.cz, src === 'bomb' ? 8 : 5, 1.0, 0.52, 0.82, 0.65);
    G.audio.play('heartHit', { pitch: 0.9 + 0.55 * (m.love / m.loveNeeded) });
    if (G.run) G.run.loveGiven += n;
    if (src === 'heart' && G.run) G.run.heartHits++;
    if (m.love >= m.loveNeeded) befriend(m);
    return true;
  }

  function befriend(m) {
    stopFuse(m, true);
    m.isFriend = true; m.friend = true; m.windup = 0; m.fuse = 0; m.task = null; m.dizzyT = 0;
    m.rig.setFriend(true);
    const base = G.floorY();
    G.fx.heartBurst(m.cx, base + m.cy + 0.4, m.cz, 12, 3.4);
    G.fx.sparkle(m.cx, base + m.cy + 0.4, m.cz, 10, 1, 0.75, 0.9, 0.9);
    G.fx.xpOrbs(m.cx, base + m.cy + 0.2, m.cz, 3);
    G.audio.play('befriend');
    if (m.wall) {
      if (m.wall.phase === 'up' || m.wall.phase === 'crawl') m.wall.phase = 'off';
      m.state = 'befriend'; m.stateT = 0; m.pendingCelebrate = true;
    } else setState(m, 'befriend');
    if (m.kind !== 'golem') {
      while (G.followers.length >= MAX_FOLLOWERS) {
        const old = G.followers.shift();
        if (G.run) G.run.waiting.push(old.kind);
        remove(old);
      }
      G.followers.forEach((f, idx) => { f.fIndex = idx; });
      m.fIndex = G.followers.length;
      G.followers.push(m);
    }
    G.game.onBefriend(m);
  }

  function nearestGrumpy(x, z, maxD, groundOnly) {
    let best = null, bd = maxD * maxD;
    for (let k = 0; k < mobs.length; k++) {
      const m = mobs[k];
      if (m.removed || m.isFriend || m.hidden || m.state === 'pop') continue;
      if (groundOnly && (m.wall || m.airborne)) continue;
      const d2 = (m.x - x) * (m.x - x) + (m.z - z) * (m.z - z);
      if (d2 < bd) { bd = d2; best = m; }
    }
    return best;
  }
  function countGrumpy() {
    let n = 0;
    for (let k = 0; k < mobs.length; k++) if (!mobs[k].removed && !mobs[k].isFriend) n++;
    return n;
  }
  function pushAwayFrom(x, z, r) {
    for (const m of mobs) {
      if (m.removed || m.isFriend || m.wall) continue;
      const dx = m.x - x, dz = m.z - z, d = Math.hypot(dx, dz);
      if (d >= r) continue;
      const ux = d > 1e-3 ? dx / d : 0, uz = d > 1e-3 ? dz / d : -1;
      m.x = x + ux * r; m.z = z + uz * r;
      collideCircle(G.world, G.fs.index, m, m.radius);
      stopFuse(m, true);
      setState(m, 'wander');
      m.wx = clamp(6.5 + (G.rng() - 0.5) * 6, 1.2, ROOM - 1.2);
      m.wz = clamp(5.5 + (G.rng() - 0.5) * 4, 1.5, ROOM - 2.5);
      m.wanderT = 2.0;
      m.cd = Math.max(m.cd, 1.2);
      m.fuse = 0;
    }
  }
  function befriendAll() {
    for (const m of mobs.slice()) if (!m.removed && !m.isFriend) addLove(m, m.loveNeeded, 'debug');
  }

  // ---------------- per frame visuals ----------------
  function orientOnWall(m) {
    const W = m.wall, hd = m.holder;
    if (W.phase === 'drop') { hd.rotation.set(0, 0, 0); return; }
    // Angle wall-crawling spiders downward & slightly toward the camera (+z) so their 8 glowing red eyes face the viewer
    if (W.side === 'N') {
      _u.set(0, 0.24, 0.97).normalize();
      if (W.phase === 'up') _f.set(0, -0.78, 0.62).normalize();
      else _f.set(W.dir * 0.46, -0.78, 0.42).normalize();
    } else {
      const nx = W.side === 'W' ? 1 : -1;
      _u.set(nx * 0.96, 0.22, 0.16).normalize();
      if (W.phase === 'up') _f.set(nx * 0.25, -0.78, 0.57).normalize();
      else _f.set(nx * 0.28, -0.68, W.dir * 0.68).normalize();
    }
    _r.crossVectors(_u, _f).normalize();
    _u.crossVectors(_f, _r).normalize();
    _mb.makeBasis(_r, _u, _f);
    hd.quaternion.setFromRotationMatrix(_mb);
  }

  function animate(dt) {
    const base = G.floorY();
    G.fx.meterBegin();
    let slam = false;
    for (let k = 0; k < mobs.length; k++) {
      const m = mobs[k];
      if (m.removed) continue;
      const a = m.anim;
      a.t = m.t; a.speed = Math.hypot(m.vx, m.vz); a.windup = m.windup; a.fuse = m.fuse; a.isFriend = m.isFriend;
      a.happy = m.happy; a.airborne = m.airborne; a.climbing = m.state === 'climbIn'; a.dizzy = m.dizzyT > 0;
      a.onWall = !!m.wall; a.kneel = m.kneel;
      a.groundOffset = m.wall ? 0 : Math.max(0, m.y);
      a.silk = 0;
      if (m.wall && m.wall.phase === 'drop' && m.rigSilk) a.silk = Math.max(0.05, 5 - m.y - 0.6);
      m.rig.animate(a, dt);
      const hd = m.holder;
      hd.visible = !m.hidden;
      hd.position.set(m.x, base + m.y, m.z);
      const pop = m.popT < 1 ? Math.max(0.05, easeOutBack(m.popT)) : 1;
      const sq = m.squash;
      hd.scale.set(pop * (1 - sq * 0.5), pop * (1 + sq), pop * (1 - sq * 0.5));
      if (m.wall) orientOnWall(m); else hd.rotation.set(0, m.facing + m.spin, 0);
      if (m.silk) {
        const top = base + 5, bot = base + m.y + m.height * 0.8;
        const len = Math.max(0.05, top - bot);
        m.silk.position.set(m.x, bot + len / 2, m.z);
        m.silk.scale.set(1, len, 1);
      }
      if (!m.isFriend && m.love > 0 && !m.hidden) {
        m.meterPulse = Math.max(0, m.meterPulse - dt * 3);
        const mx = clamp(m.x, 0.6, ROOM - 0.6), mz = clamp(m.z, 0.6, ROOM - 0.6);
        G.fx.meterAdd(mx, base + 0.035, mz, m.love / m.loveNeeded, m.meterPulse, m.radius);
      }
      if (m.kind === 'golem' && m.state === 'slam' && !m.isFriend) {
        G.fx.slamMarker(m.sx, base, m.sz, 2.4 * Math.min(1, m.windup * 1.1), 0.5 + 0.5 * Math.sin(m.t * 22));
        slam = true;
      } else if (m.kind === 'creeper' && m.state === 'fuse' && !m.isFriend && !slam) {
        G.fx.slamMarker(m.x, base, m.z, 2.2 * Math.min(1, 0.35 + m.fuse * 0.65), 0.5 + 0.5 * Math.sin(m.t * 26));
        slam = true;
      }
    }
    if (!slam) G.fx.slamMarker(0, 0, 0, 0, 0);
    G.fx.meterEnd();
  }

  function separate(f) {
    const n = mobs.length, h = G.hero;
    for (let i = 0; i < n; i++) {
      const a = mobs[i];
      if (a.removed || a.wall || a.hidden || a.state === 'climbIn') continue;
      if (h.state === 'play' && !h.airborne && a.kind !== 'golem') {
        const hx = a.x - h.x, hz = a.z - h.z, hmin = a.radius + h.radius, hd2 = hx * hx + hz * hz;
        if (hd2 < hmin * hmin) { const hd = Math.sqrt(hd2) || 1e-4; const p = hmin - hd; a.x += hx / hd * p; a.z += hz / hd * p; }
      }
      for (let j = i + 1; j < n; j++) {
        const b = mobs[j];
        if (b.removed || b.wall || b.hidden || b.state === 'climbIn') continue;
        const isFinaleGolem = (a.kind === 'golem' || b.kind === 'golem') && G.fs && G.fs.phase === 'finale';
        const dx = b.x - a.x, dz = b.z - a.z, min = isFinaleGolem ? Math.max(a.radius + b.radius, 2.25) : a.radius + b.radius, d2 = dx * dx + dz * dz;
        if (d2 >= min * min || d2 < 1e-10) continue;
        const d = Math.sqrt(d2), over = min - d;
        let wa = 0.5, wb = 0.5;
        if (a.kind === 'golem') { wa = 0; wb = 1; } else if (b.kind === 'golem') { wa = 1; wb = 0; } else if (a.isFriend !== b.isFriend) {
          if (a.isFriend) { wa = 0.85; wb = 0.15; } else { wa = 0.15; wb = 0.85; }
        }
        const nx = dx / d, nz = dz / d;
        a.x -= nx * over * wa; a.z -= nz * over * wa;
        b.x += nx * over * wb; b.z += nz * over * wb;
      }
    }
    const fg = G.finale && G.finale.golem;
    for (let i = 0; i < n; i++) {
      const m = mobs[i];
      if (!m.removed && !m.wall && !m.hidden && m.state !== 'climbIn') {
        if (fg && m !== fg && m.state === 'dance' && m.z < fg.z + 0.9) m.z = fg.z + 0.9;
        collideCircle(G.world, f, m, m.radius);
      }
    }
  }

  function dispose() {
    clearAll();
    for (const s of silkPool) if (s.parent) s.parent.remove(s);
    silkGeo.dispose(); silkMat.dispose();
  }

  return { spawn, remove, clearAll, step, animate, addLove, befriend, befriendAll, nearestGrumpy, countGrumpy,
    pushAwayFrom, stopFuse, setState, dispose };
}
