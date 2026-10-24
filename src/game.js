// Game flow: run setup, floor intro -> fight (waves, telegraphed spawns, creeper respawns) -> clear
// (bloom, group hug, stars, ladder beam) -> climb (hero + friends) -> next floor ... roof golem ->
// poppy gift -> finale (shoulder ride, friend crowd, fireworks) -> end card. Also XP / Heart-Bomb,
// loot effects and the localStorage save.
import { FLOORS, ROOF, FLOOR_H, MAX_FOLLOWERS, XP_MAX, FINALE_CROWD, ROOM, MOB_KINDS, BOMB_RADIUS } from './config.js';
import { clamp, smoothstep, lerp, TAU, angleDamp } from './util.js';
import { freeAt } from './physics.js';
import { writeSave } from './save.js';

const SPAWN_OFFS = [[0, 1.25], [1.25, 0], [-1.25, 0], [0, -1.25], [1.15, 1.15], [-1.15, 1.15], [1.15, -1.15], [-1.15, -1.15],
  [0, 2.3], [2.3, 0], [-2.3, 0], [0, -2.3]];
const FW_COLORS = [[1, 0.4, 0.55], [1, 0.85, 0.3], [0.5, 0.85, 1], [0.6, 1, 0.5], [0.9, 0.6, 1]];

export function createGame(G) {
  const { THREE } = G;
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.3, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false, toneMapped: false });
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1, 0.9), beamMat);
  beam.visible = false; beam.renderOrder = 6;
  G.scene.add(beam);
  const rockets = [];
  const _w = new THREE.Vector3();
  let held = null;

  // ---------------- run / floor setup ----------------
  function newFloorState(i) {
    const def = FLOORS[i];
    const kinds = def.start.concat(...def.waves);
    return { index: i, def, floor: G.world.floors[i], phase: 'intro', phaseT: 0, t: 0, waveIdx: 0, waveTimer: 0,
      queue: [], respawns: [], total: kinds.length, pipKinds: kinds, pipFriend: new Uint8Array(kinds.length),
      befriended: 0, bonks: 0, poofed: false, pops: 0, stars: 0, rr: 0, clearBannerT: 0, fromClimb: false };
  }

  function startGame(i, opts = {}) {
    i = clamp(i | 0, 0, ROOF);
    teardown();
    G.world.resetForRun();
    G.rng.reseed(opts.seed ?? (1234 + i * 101));
    const save = G.save;
    if (opts.fresh) { save.unlocked = 0; save.friendKinds = []; writeSave(save); }
    G.run = { friends: 0, friendKinds: [], initialFriendsCount: 0, waiting: [], xp: 0, poofs: 0, chests: 0, heartHits: 0, loveGiven: 0, trophy: false,
      hintTapDone: i > 0, hintDragShown: i > 0, hintDragDone: i > 0, dragDist: 0, walkDist: 0, startFloor: i, bombs: 0,
      floorDia: new Array(7).fill(0), floorEm: new Array(7).fill(0), startTime: G.time, dragHintT: 0 };
    if (!opts.fresh && i > 0 && Array.isArray(save.friendKinds) && save.friendKinds.length) {
      G.run.friendKinds = save.friendKinds.filter((k) => typeof k === 'string' && MOB_KINDS.includes(k) && k !== 'golem');
      G.run.initialFriendsCount = G.run.friendKinds.length;
      G.run.friends = G.run.friendKinds.length;
    }
    G.screen = 'play';
    G.ui.showHUD();
    G.cam.setMode('play');
    enterFloor(i, false);
    // friends from earlier floors come back: the newest follow, older ones wait for the finale
    const kinds = G.run.friendKinds;
    if (kinds.length) {
      const follow = kinds.slice(-MAX_FOLLOWERS);
      G.run.waiting = kinds.slice(0, Math.max(0, kinds.length - MAX_FOLLOWERS));
      const e = G.fs.floor.entry;
      follow.forEach((k, idx) => {
        const x = clamp(e.x + ((idx % 4) - 1.5) * 0.8, 0.6, ROOM - 0.6), z = clamp(e.z + 0.9 + Math.floor(idx / 4) * 0.75, 0.6, ROOM - 0.6);
        const m = G.mobSys.spawn(k, x, z, { friend: true });
        m.fIndex = idx;
        G.followers.push(m);
      });
    }
  }

  function enterFloor(i, fromClimb) {
    while (G.followers.length > MAX_FOLLOWERS) {
      const old = G.followers.shift();
      if (G.run) G.run.waiting.push(old.kind);
      G.mobSys.remove(old);
    }
    for (const m of G.mobs.slice()) {
      if (!m.removed && !G.followers.includes(m)) G.mobSys.remove(m);
    }
    G.followers.forEach((m, k) => { m.fIndex = k; });
    G.proj.clear();
    G.loot.clear();
    G.fs = newFloorState(i);
    G.fs.fromClimb = !!fromClimb;
    G.world.setView('play', i);
    G.setTorches(i);
    const e = G.fs.floor.entry;
    G.heroSys.place(e.x, e.z, i === 0 ? Math.PI : 0);
    const h = G.hero;
    h.state = 'play'; h.hp = h.maxHp; h.invuln = 0.8;
    G.cam.setFloor(i, !fromClimb);
    G.ui.setFloor(i);
    const save = G.save;
    if (i > save.unlocked) { save.unlocked = i; writeSave(save); }
    beam.visible = false;
    G.cheerT = 0; G.helperT = 2.0;
    G.audio.startMusic(i === ROOF ? 'boss' : 'calm');
    if (G.fs.def.wind) {
      const base = G.floorY();
      for (let w = 0; w < 18; w++) {
        G.fx.emit('wind', 1 + G.vrng() * 11, base + 0.5 + G.vrng() * 2.4, 1 + G.vrng() * 11,
          1.6 + G.vrng() * 1.6, (G.vrng() - 0.5) * 0.3, 0.5 + (G.vrng() - 0.5) * 1.2,
          1.2 + G.vrng() * 1.2, 0.38 + G.vrng() * 0.18, 0.62, 0.72, 0.88, 1.0, 0, 0.35, 0, G.vrng() * 6, 4 + G.vrng() * 4);
      }
    }
  }

  // ---------------- per physics substep ----------------
  function step(dt) {
    const fs = G.fs;
    if (!fs) return;
    fs.t += dt; fs.phaseT += dt;
    if (fs.clearBannerT > 0) fs.clearBannerT = Math.max(0, fs.clearBannerT - dt);
    processQueue(dt);
    switch (fs.phase) {
      case 'intro': {
        if (fs.fromClimb && fs.index > 0 && fs.floor.layout.hole) {
          const h = G.hero, hole = fs.floor.layout.hole, e = fs.floor.entry;
          if (fs.phaseT <= 0.28 && !h.auto.active && !G.input.holding && G.input.keyX === 0 && G.input.keyZ === 0) {
            const u = smoothstep(fs.phaseT / 0.28);
            const hx = hole.x + 0.5, hz = 0.55;
            h.x = lerp(hx, e.x, u); h.z = lerp(hz, e.z, u);
            h.y = Math.sin((fs.phaseT / 0.28) * Math.PI) * 0.65;
          } else if (fs.phaseT > 0.28 && fs.phaseT - dt <= 0.28 && !h.airborne) {
            h.y = 0;
          }
        }
        if (fs.phaseT >= 0.8) { queueStart(); fs.phase = 'fight'; fs.phaseT = 0; }
        break;
      }
      case 'fight': fightStep(dt); break;
      case 'cleared': if (ladderNear()) tryClimb(); break;
      case 'climb': climbStep(dt); break;
      case 'finale': case 'end': finaleStep(dt); break;
      default: break;
    }
  }

  function queueStart() {
    const fs = G.fs, def = fs.def;
    def.start.forEach((kind, k) => {
      if (kind === 'golem') queueSpawn(kind, 6.5, 4.2, null, null, 1.3, true);
      else if (def.startOnWall && kind === 'spider') {
        const u = k === 0 ? 5.3 : 7.7;
        queueSpawn(kind, u, 0.4, null, { side: 'N', u, h: 2.55, dropT: 2.0 + k * 0.9 }, 0.8);
      } else queueAtSpawner(kind);
    });
  }

  function queueAtSpawner(kind) {
    const fs = G.fs;
    const sps = fs.floor.spawners;
    if (!sps.length) { queueSpawn(kind, 6.5, 6.5, null, null, 0.8); return; }
    const sp = sps[fs.rr++ % sps.length];
    const h = G.hero;
    let bx = sp.x, bz = sp.z + 1.25, best = -1e9;
    for (const [ox, oz] of SPAWN_OFFS) {
      const x = sp.x + ox, z = sp.z + oz;
      if (!freeAt(G.world, fs.index, x, z, 0.42)) continue;
      let score = Math.min(5, Math.hypot(h.x - x, h.z - z)) + G.rng() * 1.5;
      for (const q of fs.queue) if ((q.x - x) ** 2 + (q.z - z) ** 2 < 0.8) score -= 4;
      for (const m of G.mobs) if (!m.removed && (m.x - x) ** 2 + (m.z - z) ** 2 < 0.6) score -= 3;
      if (score > best) { best = score; bx = x; bz = z; }
    }
    queueSpawn(kind, bx, bz, sp, null, 0.8);
  }

  function queueSpawn(kind, x, z, sp, wall, delay, big = false) {
    G.fs.queue.push({ kind, x, z, sp, wall, t: delay, fxT: 0, big });
  }

  function processQueue(dt) {
    const fs = G.fs, q = fs.queue;
    if (!q.length) return;
    const base = G.floorY();
    for (let k = q.length - 1; k >= 0; k--) {
      const e = q[k];
      e.t -= dt; e.fxT -= dt;
      if (e.fxT <= 0) {
        e.fxT = 0.08;
        if (e.wall) G.fx.smoke(e.wall.u, base + e.wall.h, 0.45, 1, 0.5, 0.45);
        else { G.fx.smoke(e.x, base + 0.3, e.z, 1, 0.6, e.big ? 1.0 : 0.5); G.fx.flames(e.x, base + 0.15, e.z, 1, 0.5); }
        if (e.sp) G.fx.flames(e.sp.x, base + 0.7, e.sp.z, 1, 0.6);
      }
      if (e.t <= 0) {
        q.splice(k, 1);
        const h = G.hero;
        const m = G.mobSys.spawn(e.kind, e.x, e.z, { wall: e.wall, facing: Math.atan2(h.x - e.x, h.z - e.z) });
        if (e.wall) G.fx.smoke(m.x, base + m.y, m.z + 0.3, 6, 0.6, 0.5);
        else G.fx.smoke(e.x, base + 0.5, e.z, e.big ? 16 : 8, e.big ? 1.6 : 0.7, e.big ? 1.0 : 0.6);
        G.audio.play('spawnPuff');
        if (e.kind === 'golem') { G.audio.play('golemStep'); G.cam.addShake(0.06); }
      }
    }
  }

  function fightStep(dt) {
    const fs = G.fs, def = fs.def;
    fs.waveTimer += dt;
    const live = G.mobSys.countGrumpy();
    const grumpy = live + fs.queue.length;
    if (fs.waveIdx < def.waves.length) {
      if ((fs.waveTimer >= def.waveGap && grumpy < def.maxGrumpy) || (grumpy === 0 && fs.waveTimer >= 2.0)) {
        for (const kind of def.waves[fs.waveIdx]) queueAtSpawner(kind);
        fs.waveIdx++; fs.waveTimer = 0;
      }
    }
    for (let k = fs.respawns.length - 1; k >= 0; k--) {
      const r = fs.respawns[k];
      r.t -= dt;
      if (r.t <= 0 && grumpy < def.maxGrumpy + 1) { fs.respawns.splice(k, 1); queueAtSpawner(r.kind); }
    }
    if (!def.roof && fs.waveIdx >= def.waves.length && !fs.queue.length && !fs.respawns.length && live === 0) floorCleared();
  }

  function syncSavedFriends(save) {
    const cur = G.run ? G.run.friendKinds : [];
    const saved = Array.isArray(save.friendKinds) ? save.friendKinds : [];
    if (cur.length >= saved.length) {
      save.friendKinds = cur.slice(-80);
    } else if (cur.length > 0 && saved.length > 0) {
      const added = cur.slice(G.run.initialFriendsCount || 0);
      save.friendKinds = saved.concat(added).slice(-80);
    }
  }

  function floorCleared() {
    const fs = G.fs, save = G.save, base = G.floorY();
    fs.phase = 'cleared'; fs.phaseT = 0;
    for (const s of fs.floor.spawners) {
      s.obj.setBloomed(true);
      G.fx.heartBurst(s.x, base + 1.2, s.z, 16, 3.5);
      G.fx.sparkle(s.x, base + 1.2, s.z, 14, 1, 0.8, 0.9, 1.0);
    }
    fs.stars = starsFor(fs);
    save.stars[fs.index] = Math.max(save.stars[fs.index] || 0, fs.stars);
    save.unlocked = Math.max(save.unlocked, Math.min(ROOF, fs.index + 1));
    syncSavedFriends(save);
    writeSave(save);
    G.cheerT = 2.8;
    G.hero.happyT = 2.2;
    fs.clearBannerT = 2.3;
    G.ui.showClearStars(fs.stars, 2.3);
    G.audio.play('floorClear');
    const lad = fs.floor.ladder;
    if (lad) {
      beam.position.set(lad.x, base + 3.2, 0.55);
      beam.scale.set(1, 6.4, 1);
      beam.visible = true;
    }
    const h = G.hero;
    for (let k = 0; k < 6; k++) G.fx.heartBurst(h.x + Math.cos(k) * 1.4, base + 1.4, h.z + Math.sin(k) * 1.4, 4, 2.5);
  }
  function starsFor(fs) { return fs.poofed ? 1 : fs.bonks <= 1 ? 3 : fs.bonks <= 3 ? 2 : 1; }

  // ---------------- climbing ----------------
  function ladderNear() {
    const lad = G.fs.floor.ladder, h = G.hero;
    return lad && h.state === 'play' && !h.airborne && (h.x - lad.x) ** 2 + (h.z - lad.z) ** 2 < 0.75 * 0.75;
  }
  function tryClimb() {
    const fs = G.fs;
    if (!fs || fs.phase !== 'cleared' || G.hero.state !== 'play' || G.hero.airborne) return false;
    startClimb();
    return true;
  }
  function startClimb() {
    const fs = G.fs, h = G.hero, lad = fs.floor.ladder;
    fs.phase = 'climb'; fs.phaseT = 0; fs.clearBannerT = 0;
    if (G.ui.hideClearStars) G.ui.hideClearStars();
    h.state = 'climb'; h.auto.active = false; h.pending = null;
    h.x = lad.x; h.z = 0.42; h.y = 0; h.facing = Math.PI; h.airborne = false; h.kx = h.kz = 0;
    G.loot.collectAll();
    if (G.fx.collectAllXp) G.fx.collectAllXp();
    G.proj.clear();
    G.world.setView('play', fs.index);
    G.cam.beginClimb(fs.index, fs.index + 1);
    G.audio.play('climb');
    beam.visible = false;
  }
  function climbStep(dt) {
    const fs = G.fs, h = G.hero;
    const u = clamp(fs.phaseT / 1.5, 0, 1);
    h.y = FLOOR_H * smoothstep(u);
    if (u >= 0.35) G.world.setView('play', fs.index, fs.index + 1);
    if (Math.floor(fs.phaseT * 3.5) !== Math.floor((fs.phaseT - dt) * 3.5)) G.audio.play('climb', { pitch: 1 + u * 0.3 });
    if (u >= 1) arrive();
  }
  function arrive() {
    const to = G.fs.index + 1;
    while (G.followers.length > MAX_FOLLOWERS) {
      const old = G.followers.shift();
      G.run.waiting.push(old.kind);
      G.mobSys.remove(old);
    }
    enterFloor(to, true);
    G.followers.forEach((m, k) => {
      m.state = 'climbIn'; m.stateT = 0; m.climbDelay = 0.15 + k * 0.24; m.hidden = true;
      m.y = 0; m.airborne = false; m.task = null; m.fIndex = k; m.kx = m.kz = 0;
    });
  }

  // ---------------- befriend / roof gift / finale ----------------
  function onBefriend(m) {
    const fs = G.fs;
    if (!fs) return;
    fs.befriended++;
    let idx = -1;
    for (let k = 0; k < fs.total; k++) if (!fs.pipFriend[k] && fs.pipKinds[k] === m.kind) { idx = k; break; }
    if (idx < 0) for (let k = 0; k < fs.total; k++) if (!fs.pipFriend[k]) { idx = k; break; }
    if (idx >= 0) fs.pipFriend[idx] = 1;
    G.ui.pipsDirty = true;
    G.run.friends++;
    G.run.friendKinds.push(m.kind);
    if (!G.run.hintDragShown && m.kind !== 'golem') { G.run.hintDragShown = true; G.run.walkDist = 0; G.run.dragHintT = G.time; }
    if (m.kind === 'golem') {
      fs.stars = starsFor(fs);
      G.save.stars[ROOF] = Math.max(G.save.stars[ROOF] || 0, fs.stars);
      fs.clearBannerT = 1.15;
      G.ui.showClearStars(fs.stars, 1.15);
    }
  }

  function onGolemKneel(g) {
    const fs = G.fs, save = G.save;
    fs.phase = 'gift'; fs.phaseT = 0; fs.clearBannerT = 0;
    if (G.ui.hideClearStars) G.ui.hideClearStars();
    const h = G.hero;
    if (h) g.facing = Math.atan2(h.x - g.x, Math.max(1.2, h.z - g.z));
    let x = g.x + Math.sin(g.facing) * 1.7, z = Math.max(g.z + 1.35, g.z + Math.cos(g.facing) * 1.7);
    x = clamp(x, 0.8, ROOM - 0.8); z = clamp(z, 0.8, ROOM - 0.8);
    if (!freeAt(G.world, fs.index, x, z, 0.3)) { x = clamp(g.x, 1, 12); z = clamp(g.z + 1.7, 1, 12); }
    G.gift = G.loot.spawnGift('poppy', x, z);
    G.audio.play('pickup', { pitch: 1.5 });
    fs.stars = starsFor(fs);
    save.stars[ROOF] = Math.max(save.stars[ROOF] || 0, fs.stars);
    syncSavedFriends(save);
    writeSave(save);
  }

  function pickPoppy() {
    const fs = G.fs;
    if (!fs || fs.phase !== 'gift') return;
    const h = G.hero;
    const golem = G.mobs.find((m) => m.kind === 'golem' && !m.removed);
    fs.phase = 'finale'; fs.phaseT = 0; fs.clearBannerT = 0;
    if (G.ui.hideClearStars) G.ui.hideClearStars();
    G.loot.removeGifts();
    if (G.fx.collectAllXp) G.fx.collectAllXp();
    G.gift = null;
    h.state = 'finale'; h.auto.active = false; h.airborne = false;
    held = G.loot.getObj('poppy');
    const sockets = h.rig.sockets || {};
    const hand = sockets.handR || (h.rig.parts && h.rig.parts.armR);
    if (hand) {
      hand.add(held);
      if (sockets.handR) { held.position.set(0, -0.05, 0.08); held.rotation.set(Math.PI / 2, 0, 0); held.scale.setScalar(0.8); } else { held.position.set(0, -0.62, 0.14); held.scale.setScalar(0.85); }
    } else { h.rig.root.add(held); held.position.set(0.3, 1.0, 0.3); }
    G.finale = { t: 0, golem, sx: h.x, sz: h.z, crowd: false, fwT: 0.4, endShown: false };
    if (golem) golem.state = 'finale';
    const save = G.save;
    save.stars[ROOF] = Math.max(save.stars[ROOF] || 0, fs.stars || starsFor(fs));
    syncSavedFriends(save);
    writeSave(save);
    G.audio.play('pickup', { pitch: 1.3 });
    G.audio.play('sparkle', { pitch: 1.15 });
    G.audio.startMusic('victory');
    G.fx.heartBurst(h.x, G.floorY() + 1.4, h.z, 14, 3);
  }

  function finaleStep(dt) {
    const F = G.finale;
    if (!F) return;
    F.t += dt;
    const h = G.hero, g = F.golem;
    if (g) {
      g.kneel = Math.max(0, 1 - smoothstep(F.t / 1.0));
      g.facing = angleDamp(g.facing, 0, 3, dt);
      g.happy = 1;
      // shoulder seat: the rig's shoulder socket when it has one, else an offset from the golem's centre
      let shX = g.x + Math.cos(g.facing) * 0.62, shZ = g.z - Math.sin(g.facing) * 0.62, shY = g.height * 0.84;
      const sock = g.rig.sockets && g.rig.sockets.shoulder;
      if (sock && F.t > 0.2) {
        g.holder.updateMatrixWorld(true);
        sock.getWorldPosition(_w);
        shX = _w.x; shZ = _w.z; shY = _w.y - G.floorY() - 0.12;
      }
      if (F.t >= 0.3 && F.t < 1.3) {
        const u = smoothstep((F.t - 0.3) / 1.0);
        h.x = lerp(F.sx, shX, u); h.z = lerp(F.sz, shZ, u);
        h.y = lerp(0, shY, u) + Math.sin(u * Math.PI) * 1.2;
        h.facing = g.facing;
      } else if (F.t >= 1.3) {
        h.x = shX; h.z = shZ; h.y = shY + Math.abs(Math.sin(G.time * 4.4)) * 0.06; h.facing = g.facing;
      } else h.facing = Math.atan2(g.x - h.x, g.z - h.z);
    }
    if (!F.crowd && F.t > 1.2) { F.crowd = true; spawnCrowd(F); }
    // the roof treasure chest pops open for the celebration (diamonds + trophy fly to the hero)
    if (!F.chests && F.t > 1.8) {
      F.chests = true;
      for (const c of G.fs.floor.chests) if (!c.opened) G.loot.openChest(c);
    }
    if (F.t > 1.35) {
      F.fwT -= dt;
      if (F.fwT <= 0) { F.fwT = 0.24 + G.vrng() * 0.22; launchRocket(); }
    }
    // camera frames the golem + hero, pulled back a little so the fireworks above them stay in view
    if (g) G.cam.setFocus(g.x, g.z);
    G.cam.setZoom(1 + 0.12 * smoothstep((F.t - 1.0) / 2.0));
    if (!F.endShown && F.t > 8.0) { F.endShown = true; showEnd(); }
  }

  function spawnCrowd(F) {
    const g = F.golem, cx = g ? g.x : 6.5, cz = g ? g.z : 6.5;
    const maxCrowd = Math.min(12, FINALE_CROWD);
    const crowd = G.followers.slice(0, maxCrowd);
    const room = Math.max(0, maxCrowd - crowd.length);
    const validWaiting = (G.run && Array.isArray(G.run.waiting))
      ? G.run.waiting.filter((k) => typeof k === 'string' && MOB_KINDS.includes(k) && k !== 'golem')
      : [];
    const extra = room > 0 ? validWaiting.slice(-room) : [];
    const fallback = ['zombie', 'spider', 'skeleton', 'creeper', 'breeze', 'caveSpider', 'stray'];
    while (crowd.length + extra.length < maxCrowd) {
      extra.push(fallback[(crowd.length + extra.length) % fallback.length]);
    }
    extra.forEach((kind, k) => {
      const th = ((k + 0.5) / Math.max(1, extra.length) - 0.5) * 0.90 * Math.PI;
      const x = clamp(cx + Math.sin(th) * 3.8, 0.8, ROOM - 0.8), z = clamp(cz + Math.max(1.0, Math.cos(th) * 3.8), 0.8, ROOM - 0.8);
      const m = G.mobSys.spawn(kind, x, z, { friend: true, state: 'dance' });
      G.fx.smoke(x, G.floorY() + 0.4, z, 4, 0.5, 0.5);
      crowd.push(m);
    });
    crowd.forEach((m, k) => {
      m.state = 'dance'; m.stateT = 0; m.hidden = false; m.task = null;
      // Distribute crowd along a front-and-side semi-circle (+z south of golem) so the hero on the golem's shoulder is never occluded
      m.danceA = ((k + 0.5) / Math.max(1, crowd.length) - 0.5) * 0.90 * Math.PI;
      m.danceR = 3.0 + (k % 2) * 1.1;
    });
    G.audio.play('befriend', { pitch: 1.2 });
  }

  function launchRocket() {
    const c = FW_COLORS[Math.floor(G.vrng() * FW_COLORS.length)];
    // burst at y ~= 2.7..3.8 inside the upper viewport above and behind the golem
    const g = G.finale && G.finale.golem, cx = g ? g.x : 6.5, cz = g ? g.z : 4;
    rockets.push({ x: clamp(cx + (G.vrng() - 0.5) * 9.5, 0.6, 12.4), z: clamp(cz - 1.0 - G.vrng() * 2.5, 0.2, 6.5), y: 0.4,
      vy: 5.2 + G.vrng() * 1.6, fuse: 0.42 + G.vrng() * 0.16, c, trail: 0 });
    G.audio.play('fireworks', { volume: 0.5, pitch: 1.4 });
  }
  function tapFirework(x, z) {
    const base = G.floorY();
    const c = FW_COLORS[Math.floor(G.vrng() * FW_COLORS.length)];
    const rx = clamp(x, 0.5, ROOM - 0.5), rz = clamp(z, 0.5, ROOM - 0.5);
    G.fx.heartBurst(rx, base + 1.2, rz, 10, 3.0);
    G.fx.sparkle(rx, base + 1.0, rz, 8, c[0], c[1], c[2], 0.9);
    rockets.push({ x: rx, z: rz, y: 0.4, vy: 5.4 + G.vrng() * 1.4, fuse: 0.40 + G.vrng() * 0.15, c, trail: 0 });
    G.audio.play('fireworks', { volume: 0.65, pitch: 1.2 + G.vrng() * 0.3 });
  }
  function updateRockets(dt) {
    const base = G.floorY();
    for (let k = rockets.length - 1; k >= 0; k--) {
      const r = rockets[k];
      r.fuse -= dt; r.y += r.vy * dt; r.vy -= 5 * dt;
      if ((r.trail -= dt) <= 0) { r.trail = 0.03; G.fx.emit('flame', r.x, base + r.y, r.z, 0, -1, 0, 0.3, 0.3, 0.05, 1, 0.8, 0.5); }
      if (r.fuse <= 0) {
        G.fx.firework(r.x, base + r.y, r.z, r.c[0], r.c[1], r.c[2]);
        G.audio.play('fireworks', { pitch: 0.8 + G.vrng() * 0.4 });
        rockets.splice(k, 1);
      }
    }
  }

  function showEnd() {
    const save = G.save;
    G.screen = 'end';
    G.fs.phase = 'end';
    save.trophy = save.trophy || G.run.trophy;
    writeSave(save);
    G.ui.showEnd({ stars: save.stars.slice(), friends: G.run.friendKinds.length, diamonds: save.diamonds,
      emeralds: save.emeralds, trophy: save.trophy });
  }

  // ---------------- XP, Heart-Bomb, loot ----------------
  function onXP(silent) {
    if (!G.run) return;
    const before = G.run.xp;
    G.run.xp = Math.min(XP_MAX, G.run.xp + 1);
    if (!silent) G.audio.play('xp', { pitch: 0.8 + G.run.xp * 0.07 });
    if (before < XP_MAX && G.run.xp >= XP_MAX) G.audio.play('sparkle', { pitch: 1.2, volume: 0.9 });
  }

  function heartBomb() {
    const h = G.hero, fs = G.fs;
    if (!fs || !G.run || G.run.xp < XP_MAX || h.state !== 'play' || !(fs.phase === 'fight' || fs.phase === 'intro')) {
      G.ui.bombNope();
      return false;
    }
    G.run.xp = 0; G.run.bombs++;
    const base = G.floorY();
    for (let k = 0; k < 5; k++) G.fx.ring('heart', h.x, base + 0.8 + k * 0.14, h.z, 0.4 + k * 0.35, 18 + k * 4, 7.5 + k * 2.2, 0.65, 1, 1, 1, 0.95);
    G.fx.ring('sparkle', h.x, base + 0.5, h.z, 0.5, 32, 13.5, 0.6, 1, 0.6, 0.85, 0.95);
    for (const m of G.mobs.slice()) {
      if (m.removed || m.isFriend || m.hidden) continue;
      const dx = m.x - h.x, dz = m.z - h.z, d = Math.hypot(dx, dz);
      if (d > BOMB_RADIUS) continue;
      m.kx += dx / (d || 1) * 3; m.kz += dz / (d || 1) * 3;
      G.mobSys.addLove(m, 2, 'bomb');
    }
    G.cam.addShake(0.07);
    G.audio.play('heartBomb');
    h.happyT = 0.8;
    return true;
  }

  function onPickup(kind) {
    const h = G.hero, save = G.save, fs = G.fs;
    const base = G.floorY();
    const i = fs ? fs.index : 0;
    switch (kind) {
      case 'goldenApple':
        h.hp = Math.min(h.maxHp, h.hp + 2);
        G.fx.heartBurst(h.x, base + h.y + 1.4, h.z, 8, 2.5);
        G.ui.bumpHearts();
        G.audio.play('heal');
        break;
      case 'diamond': case 'emerald': {
        const dia = kind === 'diamond';
        const arr = dia ? G.run.floorDia : G.run.floorEm;
        arr[i]++;
        const key = dia ? 'floorDiamonds' : 'floorEmeralds';
        save[key][i] = Math.max(save[key][i] || 0, arr[i]);
        save.diamonds = save.floorDiamonds.reduce((a, b) => a + b, 0);
        save.emeralds = save.floorEmeralds.reduce((a, b) => a + b, 0);
        writeSave(save);
        G.fx.sparkle(h.x, base + h.y + 1.5, h.z, 10, 0.5, 1, dia ? 1 : 0.6, 0.8);
        G.audio.play('pickup', { pitch: 1.35 });
        break;
      }
      case 'cookie':
        for (const m of G.followers) {
          m.happy = 1;
          if (!m.airborne && !m.wall && !m.hidden) { m.airborne = true; m.vy = 4.6; m.jx = 0; m.jz = 0; }
        }
        h.happyT = 1.0;
        G.fx.sparkle(h.x, base + 1.2, h.z, 8, 1, 0.8, 0.5, 1.2);
        G.audio.play('pickup', { pitch: 0.9 });
        break;
      case 'trophy':
        G.run.trophy = true; save.trophy = true; writeSave(save);
        G.fx.sparkle(h.x, base + h.y + 1.5, h.z, 16, 1, 0.85, 0.3, 1.0);
        G.audio.play('pickup', { pitch: 1.5 });
        break;
      default: break;
    }
  }

  // ---------------- per frame ----------------
  let windT = 0, cheerFxT = 0;
  function frame(dt) {
    if (beam.visible) beamMat.opacity = 0.22 + 0.12 * Math.sin(G.time * 5);
    if (rockets.length) updateRockets(dt);
    if (G.cheerT > 0 && G.fs && G.followers.length) {
      cheerFxT -= dt;
      if (cheerFxT <= 0) {
        cheerFxT = 0.32;
        const base = G.floorY();
        const m = G.followers[Math.floor(G.vrng() * G.followers.length)];
        if (m && !m.removed && !m.hidden) {
          G.fx.heartBurst(m.x, base + m.height + 0.35, m.z, 3, 1.8);
          G.fx.sparkle(m.x, base + m.height + 0.35, m.z, 4, 1, 0.82, 0.92, 0.7);
        }
      }
    }
    // Ambient drifting wind swirls on Breeze Loft (Floor 5, def.wind === true)
    if (G.fs && G.fs.def && G.fs.def.wind) {
      windT -= dt;
      if (windT <= 0) {
        windT = 0.065;
        const base = G.floorY();
        const fromNorth = G.vrng() < 0.55;
        const wx = fromNorth ? (2.5 + G.vrng() * 8.0) : (0.5 + G.vrng() * 3.0);
        const wz = fromNorth ? (0.4 + G.vrng() * 3.0) : (2.5 + G.vrng() * 8.0);
        const wy = base + 0.55 + G.vrng() * 2.3;
        G.fx.emit('wind', wx, wy, wz, 1.8 + G.vrng() * 1.8, (G.vrng() - 0.48) * 0.35, 0.7 + (G.vrng() - 0.35) * 1.3,
          1.4 + G.vrng() * 0.9, 0.36 + G.vrng() * 0.18, 0.64, 0.72, 0.88, 1.0, 0, 0.35, 0, G.vrng() * 6, 5 + G.vrng() * 5);
      }
    }
    // drag hint bookkeeping (walking 5 blocks or 12 s dismisses it)
    const r = G.run;
    if (r && r.hintDragShown && !r.hintDragDone) {
      if (G.hero.state === 'play') r.walkDist += G.hero.speedNow * dt;
      if (r.walkDist > 5 || G.time - (r.dragHintT || 0) > 12) r.hintDragDone = true;
    }
  }

  // ---------------- screens ----------------
  function hasProgress() { const s = G.save; return s.unlocked > 0 || s.stars.some((v) => v > 0); }

  function goTitle() {
    teardown();
    G.fs = null; G.run = null;
    G.screen = 'title';
    G.hero.state = 'off';
    G.world.setView('title');
    G.setTorches(-1);
    G.cam.setMode('title');
    G.ui.showTitle(hasProgress());
    G.audio.startMusic('calm');
  }

  function teardown() {
    G.mobSys.clearAll();
    G.proj.clear();
    G.loot.clear();
    G.fx.clear();
    if (held) { G.loot.releaseObj('poppy', held); held = null; }
    G.finale = null; G.gift = null;
    rockets.length = 0;
    beam.visible = false;
    G.cheerT = 0;
    G.cam.setZoom(1);
    G.ui.hideOverlays();
  }

  return { startGame, enterFloor, queueStart, step, frame, onBefriend, onGolemKneel, pickPoppy, onXP, onPickup, heartBomb,
    tryClimb, tapFirework, goTitle, teardown, hasProgress, starsFor };
}
