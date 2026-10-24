// Input: pointer press-and-hold walks the hero toward the finger's floor point every frame; a quick tap
// (< 250 ms, < 12 px) throws at the nearest grumpy mob within a generous screen radius, else walks to the
// tapped chest / ladder / gift / floor. Keyboard: WASD/arrows (screen-relative), Space throws, Enter/E interacts.
import { ROOM } from './config.js';

const TAP_MS = 400, TAP_PX = 24, HOLD_MS = 260, PICK_PX = 76;

export function createInput(G) {
  const { THREE } = G;
  const el = G.renderer.domElement;
  const st = {
    down: false, id: -1, sx: 0, sy: 0, x0: 0, y0: 0, t0: 0, moved: 0,
    holding: false, holdValid: false, holdX: 0, holdZ: 0, botHolding: false,
    downOnTarget: false, keyX: 0, keyZ: 0, keys: new Set(),
  };
  const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3();
  const _s = { x: 0, y: 0, z: 0 };
  const hp = { x: 0, z: 0 };

  function hitHint(id, sx, sy, pad = 18) {
    const e = document.getElementById(id);
    if (!e || e.classList.contains('hidden')) return false;
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    return sx >= r.left - pad && sx <= r.right + pad && sy >= r.top - pad && sy <= r.bottom + pad;
  }

  /** Ray from the camera through screen point (CSS px) hits the current floor plane (floor-local x/z). */
  function screenToFloor(sx, sy, out) {
    const cam = G.camera;
    const nx = (sx / G.viewW) * 2 - 1, ny = -(sy / G.viewH) * 2 + 1;
    _o.setFromMatrixPosition(cam.matrixWorld);
    _d.set(nx, ny, 0.5).unproject(cam).sub(_o).normalize();
    const planeY = G.floorY();
    if (Math.abs(_d.y) < 1e-4) return false;
    const t = (planeY - _o.y) / _d.y;
    if (t <= 0) return false;
    out.x = _o.x + _d.x * t; out.z = _o.z + _d.z * t;
    return true;
  }
  function worldToScreen(x, y, z, out) {
    _p.set(x, y, z).project(G.camera);
    out.x = (_p.x + 1) / 2 * G.viewW; out.y = (1 - _p.y) / 2 * G.viewH; out.z = _p.z;
    return out;
  }

  // ---------------- pointer + touch (iPad Safari safe) ----------------
  let secId = -1, secX0 = 0, secY0 = 0, secT0 = 0;
  function beginPrimary(id, cx, cy) {
    st.down = true; st.id = id;
    st.sx = st.x0 = cx; st.sy = st.y0 = cy; st.t0 = performance.now(); st.moved = 0;
    st.holding = false; st.holdValid = false;
    st.downOnTarget = !!(G.screen === 'play' && G.fs && (
      pickGrumpy(st.x0, st.y0) ||
      hitHint('hint-gift', st.x0, st.y0, 18) ||
      hitHint('hint-arrow', st.x0, st.y0, 18)
    ));
  }
  function movePrimary(cx, cy) {
    st.sx = cx; st.sy = cy;
    st.moved = Math.max(st.moved, Math.hypot(st.sx - st.x0, st.sy - st.y0));
  }
  function endPrimary(isTapCandidate) {
    const dt = performance.now() - st.t0;
    const tapMs = st.downOnTarget ? 450 : TAP_MS;
    const tapPx = st.downOnTarget ? 28 : TAP_PX;
    const tx = st.sx, ty = st.sy, moved = st.moved;
    st.down = false; st.holding = false; st.holdValid = false; st.downOnTarget = false;
    if (isTapCandidate && dt < tapMs && moved < tapPx) tap(tx, ty);
  }
  el.addEventListener('pointerdown', (e) => {
    G.audio.unlock();
    if (st.down && e.pointerId !== st.id) {
      // Allow a second finger on iPad to tap-throw while the first finger holds to walk
      secId = e.pointerId; secX0 = e.clientX; secY0 = e.clientY; secT0 = performance.now();
      e.preventDefault();
      return;
    }
    beginPrimary(e.pointerId, e.clientX, e.clientY);
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    if (!st.down || e.pointerId !== st.id) return;
    movePrimary(e.clientX, e.clientY);
  });
  const up = (e) => {
    if (e.pointerId === secId) {
      const dt = performance.now() - secT0;
      const moved = Math.hypot(e.clientX - secX0, e.clientY - secY0);
      secId = -1;
      if (e.type === 'pointerup' && dt < TAP_MS && moved < TAP_PX) tap(e.clientX, e.clientY);
      return;
    }
    if (!st.down || e.pointerId !== st.id) return;
    endPrimary(e.type === 'pointerup');
  };
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  if (!window.PointerEvent) {
    el.addEventListener('touchstart', (e) => {
      G.audio.unlock();
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      if (!st.down || (e.touches && e.touches.length === 1)) {
        beginPrimary(t.identifier, t.clientX, t.clientY);
      } else {
        secId = t.identifier; secX0 = t.clientX; secY0 = t.clientY; secT0 = performance.now();
      }
      e.preventDefault();
    }, { passive: false });
    window.addEventListener('touchmove', (e) => {
      if (!st.down || !e.changedTouches) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === st.id) { movePrimary(t.clientX, t.clientY); break; }
      }
    }, { passive: true });
    const touchUp = (e) => {
      if (!e.changedTouches) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === secId) {
          const dt = performance.now() - secT0;
          const moved = Math.hypot(t.clientX - secX0, t.clientY - secY0);
          secId = -1;
          if (e.type === 'touchend' && dt < TAP_MS && moved < TAP_PX) tap(t.clientX, t.clientY);
        } else if (st.down && t.identifier === st.id) {
          movePrimary(t.clientX, t.clientY);
          endPrimary(e.type === 'touchend');
        }
      }
    };
    window.addEventListener('touchend', touchUp, { passive: true });
    window.addEventListener('touchcancel', touchUp, { passive: true });
  }
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------------- keyboard ----------------
  const DIRS = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };
  function recomputeKeys() {
    let x = 0, z = 0;
    for (const k of st.keys) { const d = DIRS[k]; if (d) { x += d[0]; z += d[1]; } }
    st.keyX = Math.sign(x); st.keyZ = Math.sign(z);
  }
  window.addEventListener('keydown', (e) => {
    G.audio.unlock();
    if (DIRS[e.code]) { st.keys.add(e.code); recomputeKeys(); e.preventDefault(); return; }
    if (e.repeat) return;
    if (e.code === 'Space') { e.preventDefault(); if (G.screen === 'play') G.heroSys.tryThrow(null, false); }
    else if (e.code === 'Enter' || e.code === 'KeyE') {
      e.preventDefault();
      if (G.screen === 'play') interact();
      else if (G.screen === 'title') G.game.startGame(G.save.unlocked, { fresh: false });
    }
  });
  window.addEventListener('keyup', (e) => { if (DIRS[e.code]) { st.keys.delete(e.code); recomputeKeys(); } });
  function resetInputState() {
    st.keys.clear();
    recomputeKeys();
    st.down = false;
    st.holding = false;
    st.holdValid = false;
    st.downOnTarget = false;
  }
  window.addEventListener('blur', resetInputState);
  document.addEventListener('visibilitychange', resetInputState);

  // ---------------- per frame ----------------
  function update() {
    if (st.botHolding) return;
    if (!st.down || G.screen !== 'play') { st.holding = false; st.holdValid = false; return; }
    const holdMs = st.downOnTarget ? 450 : HOLD_MS;
    const holdPx = st.downOnTarget ? 28 : TAP_PX;
    const held = performance.now() - st.t0 > holdMs || st.moved > holdPx;
    if (!held) return;
    st.holding = true;
    st.holdValid = screenToFloor(st.sx, st.sy, hp);
    if (st.holdValid) {
      if (G.run && G.run.hintDragShown && !G.run.hintDragDone && st.moved > 10) G.run.hintDragDone = true;
      st.holdX = Math.max(0.2, Math.min(ROOM - 0.2, hp.x)); st.holdZ = Math.max(0.2, Math.min(ROOM - 0.2, hp.z));
    }
  }

  // ---------------- tap picking ----------------
  function pickGrumpy(sx, sy) {
    const base = G.floorY();
    let best = null, bestD = 1e9;
    for (const m of G.mobs) {
      if (m.removed || m.isFriend || m.hidden) continue;
      worldToScreen(m.cx, base + m.cy, m.cz, _s);
      if (_s.z > 1) continue;
      const cx = _s.x, cy = _s.y;
      worldToScreen(m.cx, base + m.cy + m.height * 0.45, m.cz, _s);
      const hx = _s.x, hy = _s.y;
      const halfPx = Math.abs(cy - hy);
      const d = Math.min(Math.hypot(cx - sx, cy - sy), Math.hypot(hx - sx, hy - sy));
      const r = Math.max(PICK_PX, halfPx + 38);
      if (d < r && d < bestD) { bestD = d; best = m; }
    }
    if (!best && hitHint('hint-hand', sx, sy, 18)) {
      if (G.ui && G.ui.hintMob && !G.ui.hintMob.removed && !G.ui.hintMob.isFriend && !G.ui.hintMob.hidden) return G.ui.hintMob;
      return G.mobSys.nearestGrumpy(G.hero.x, G.hero.z, 99, false);
    }
    return best;
  }
  function near(x, y, z, sx, sy, r) { worldToScreen(x, y, z, _s); return Math.hypot(_s.x - sx, _s.y - sy) < r; }

  function tap(sx, sy) {
    if (G.fs && (G.fs.phase === 'finale' || G.fs.phase === 'end' || G.screen === 'end')) {
      if (screenToFloor(sx, sy, hp)) G.game.tapFirework(hp.x, hp.z);
      else G.game.tapFirework(6.5 + (G.vrng() - 0.5) * 6, 6.5 + (G.vrng() - 0.5) * 6);
      return 'firework';
    }
    if (G.screen !== 'play' || !G.fs) return false;
    const h = G.hero;
    if (h.state !== 'play') return false;
    const fs = G.fs, base = G.floorY();
    const m = pickGrumpy(sx, sy);
    if (m) { G.heroSys.tryThrow(m, true); return 'throw'; }
    if (G.gift && (near(G.gift.x, base + 0.8, G.gift.z, sx, sy, 96) || hitHint('hint-gift', sx, sy, 18))) {
      G.heroSys.setAuto(G.gift.x, G.gift.z, 'gift', G.gift); return 'gift';
    }
    for (const c of fs.floor.chests) {
      if (!c.opened && near(c.x, base + 1.4, c.z, sx, sy, 84)) { G.heroSys.setAuto(c.x, c.z, 'chest', c); return 'chest'; }
    }
    const lad = fs.floor.ladder;
    if (fs.phase === 'cleared' && lad && (near(lad.x, base + 1.2, 0.3, sx, sy, 84) || near(lad.x, base + 3.2, 0.3, sx, sy, 84) || hitHint('hint-arrow', sx, sy, 18))) {
      G.heroSys.setAuto(lad.x, lad.z, 'ladder', lad); return 'ladder';
    }
    if (screenToFloor(sx, sy, hp)) {
      G.heroSys.setAuto(Math.max(0.4, Math.min(ROOM - 0.4, hp.x)), Math.max(0.4, Math.min(ROOM - 0.4, hp.z)), 'floor', null);
      G.fx.sparkle(hp.x, base + 0.15, hp.z, 3, 1, 1, 1, 0.3);
      return 'walk';
    }
    return false;
  }

  function interact() {
    const fs = G.fs, h = G.hero;
    if (!fs || h.state !== 'play') return;
    if (G.gift) { G.heroSys.setAuto(G.gift.x, G.gift.z, 'gift', G.gift); return; }
    if (fs.phase === 'cleared' && fs.floor.ladder) { G.heroSys.setAuto(fs.floor.ladder.x, fs.floor.ladder.z, 'ladder', fs.floor.ladder); return; }
    let best = null, bd = 1e9;
    for (const c of fs.floor.chests) {
      if (c.opened) continue;
      const d = Math.hypot(c.x - h.x, c.z - h.z);
      if (d < bd) { bd = d; best = c; }
    }
    if (best) G.heroSys.setAuto(best.x, best.z, 'chest', best);
  }

  st.update = update;
  st.tap = tap;
  st.interact = interact;
  st.screenToFloor = screenToFloor;
  st.worldToScreen = worldToScreen;
  /** test hook: simulate a held finger at floor point (x, z); null releases. */
  st.botHold = (x, z) => {
    if (x == null) { st.holding = false; st.holdValid = false; st.botHolding = false; return; }
    st.holding = true; st.holdValid = true; st.holdX = x; st.holdZ = z; st.botHolding = true;
  };
  return st;
}
