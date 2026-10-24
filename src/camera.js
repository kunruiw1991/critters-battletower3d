// Camera rig: Minecraft-Dungeons-style fixed-yaw 3/4 top-down follow camera (looks north, -z).
// The play fit bisects the camera distance so the interior floor (plus the hero's head on the far row)
// fits between the HUD bands, then re-centres it. Title mode orbits the exterior tower.
// Shake is positional only (<= 0.10 units, fast exponential decay) and moves position + target together.
import { FLOOR_H } from './config.js';
import { clamp, damp, smoothstep } from './util.js';

const PITCH = 54 * Math.PI / 180;
const TITLE_PITCH = 0.14;
const MIN_HERO_PX = 18;   // projected (foreshortened) hero height below which we zoom in + follow

export function createCameraRig(G) {
  const { THREE, camera } = G;
  const st = {
    mode: 'title', t: 0,
    fitD: 22, fitTX: 6.5, fitTZ: 7.2, follow: false, slackX: 0, slackZ: 0,
    tx: 6.5, ty: 0, tz: 7.2, floor: 0, climb: null,
    zoom: 1, zoomTarget: 1, shake: 0,
    play: { top: 100, bottom: 60, left: 8, right: 8 },
    title: { top: 10, bottom: 10, left: 10, right: 10 },
    titleD: 70, titleTX: 6.5, titleTY: 19, titleTZ: 6.5,
  };
  const _v = new THREE.Vector3();
  const box = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  // fit points (floor-local, y relative to the floor base): near floor edge incl. the rim + front corner chests, far row at head height
  const PLAY_PTS = [[-0.35, 0, 13.4], [13.35, 0, 13.4], [-0.35, 1.8, 13.2], [13.35, 1.8, 13.2], [-0.2, 2.3, 0.1], [13.2, 2.3, 0.1], [6.5, 3.4, -0.2]];
  const TITLE_PTS = [];
  for (const x of [-1, 14]) for (const y of [-1.5, 43]) for (const z of [-1, 14]) TITLE_PTS.push([x, y, z]);

  function dirFor(mode, yaw) {
    if (mode === 'title') return [Math.sin(yaw) * Math.cos(TITLE_PITCH), Math.sin(TITLE_PITCH), Math.cos(yaw) * Math.cos(TITLE_PITCH)];
    return [0, Math.sin(PITCH), Math.cos(PITCH)];
  }
  function place(tx, ty, tz, D, d) {
    camera.position.set(tx + d[0] * D, ty + d[1] * D, tz + d[2] * D);
    camera.lookAt(tx, ty, tz);
    camera.updateMatrixWorld(true);
  }
  function measure(pts) {
    box.minX = box.minY = 1e9; box.maxX = box.maxY = -1e9; box.ok = true;
    const inv = camera.matrixWorldInverse;
    for (const p of pts) {
      // reject points behind / too close to the camera: their projection is meaningless
      _v.set(p[0], p[1], p[2]).applyMatrix4(inv);
      if (_v.z > -camera.near * 2) { box.ok = false; box.minX = box.minY = -1e9; box.maxX = box.maxY = 1e9; return box; }
      _v.set(p[0], p[1], p[2]).project(camera);
      if (_v.x < box.minX) box.minX = _v.x; if (_v.x > box.maxX) box.maxX = _v.x;
      if (_v.y < box.minY) box.minY = _v.y; if (_v.y > box.maxY) box.maxY = _v.y;
    }
    return box;
  }
  function bandNdc(b) {
    const W = Math.max(1, G.viewW), H = Math.max(1, G.viewH);
    return { L: -1 + 2 * b.left / W, R: 1 - 2 * b.right / W, T: 1 - 2 * b.top / H, B: -1 + 2 * b.bottom / H };
  }

  /** Generic fit: bisect distance so pts fit the band size, then Newton-centre the target in the band.
   *  upAxis = centre vertically by moving the look-at height (near-horizontal title camera) instead of
   *  sliding along the ground (steep play camera). */
  function fit(pts, band, d, tx, ty, tz, minD, upAxis = false) {
    const N = bandNdc(band);
    const bw = Math.max(0.2, N.R - N.L), bh = Math.max(0.2, N.T - N.B);
    const cxB = (N.L + N.R) / 2, cyB = (N.T + N.B) / 2;
    const tx0 = tx, ty0 = ty, tz0 = tz;
    const step = (v) => clamp(v, -6, 6);   // Newton steps are clamped so a bad sample can never fling the target away
    let D = 30;
    for (let pass = 0; pass < 3; pass++) {
      let lo = minD, hi = 400;
      for (let k = 0; k < 34; k++) {
        D = (lo + hi) / 2;
        place(tx, ty, tz, D, d);
        const m = measure(pts);
        if (m.ok && m.maxX - m.minX <= bw && m.maxY - m.minY <= bh) hi = D; else lo = D;
      }
      D = hi;
      for (let k = 0; k < 2; k++) {
        const gx = upAxis ? 0 : -d[0], gy = upAxis ? 1 : 0, gz = upAxis ? 0 : -d[2], gl = Math.hypot(gx, gy, gz) || 1;
        place(tx, ty, tz, D, d);
        let m = measure(pts);
        if (!m.ok) break;
        const ey = (m.minY + m.maxY) / 2 - cyB;
        place(tx + gx / gl, ty + gy / gl, tz + gz / gl, D, d);
        m = measure(pts);
        if (!m.ok) break;
        const dy = (m.minY + m.maxY) / 2 - cyB - ey;
        if (Math.abs(dy) > 1e-4) { const s = step(-ey / dy); tx += gx / gl * s; ty += gy / gl * s; tz += gz / gl * s; }
        // horizontal: slide along the ground-projected right vector
        const rx = d[2], rz = -d[0], rl = Math.hypot(rx, rz) || 1;
        place(tx, ty, tz, D, d);
        m = measure(pts);
        if (!m.ok) break;
        const ex = (m.minX + m.maxX) / 2 - cxB;
        place(tx + rx / rl, ty, tz + rz / rl, D, d);
        m = measure(pts);
        if (!m.ok) break;
        const dx = (m.minX + m.maxX) / 2 - cxB - ex;
        if (Math.abs(dx) > 1e-4) { const s = step(-ex / dx); tx += rx / rl * s; tz += rz / rl * s; }
      }
      tx = clamp(tx, tx0 - 20, tx0 + 20); ty = clamp(ty, ty0 - 20, ty0 + 20); tz = clamp(tz, tz0 - 20, tz0 + 20);
    }
    return { D, tx, ty, tz };
  }

  function refit() {
    if (!G.viewW) return;
    const d = dirFor('play');
    const r = fit(PLAY_PTS, st.play, d, 6.5, 0, 7.0, 6);
    st.fitD = r.D; st.fitTX = r.tx; st.fitTZ = r.tz; st.follow = false; st.slackX = st.slackZ = 0;
    // keep the hero readable: portrait phones zoom in a little and follow her; any layout where she would be
    // smaller than MIN_HERO_PX zooms in further. The follow target is clamped so the room never leaves the band.
    place(st.fitTX, 0, st.fitTZ, st.fitD, d);
    const a = _v.set(6.5, 0, 6.5).project(camera).y, b = _v.set(6.5, 1.8, 6.5).project(camera).y;
    const px = (b - a) * G.viewH / 2;
    const isPortrait = G.viewW / G.viewH < 0.8;
    let zoomIn = isPortrait ? 1.07 : 1;
    if (px * zoomIn < MIN_HERO_PX) zoomIn = MIN_HERO_PX / Math.max(1, px);
    if (zoomIn > 1.001) {
      st.fitD /= zoomIn;
      st.follow = true;
      place(st.fitTX, 0, st.fitTZ, st.fitD, d);
      const N = bandNdc(st.play);
      const m = measure(PLAY_PTS);
      const w0 = m.maxX - m.minX, h0 = m.maxY - m.minY, c0x = (m.minX + m.maxX) / 2, c0y = (m.minY + m.maxY) / 2;
      const ox = Math.max(0, w0 - (N.R - N.L)) / 2, oy = Math.max(0, h0 - (N.T - N.B)) / 2;
      place(st.fitTX + 1, 0, st.fitTZ, st.fitD, d);
      const m2 = measure(PLAY_PTS);
      const kx = Math.abs((m2.minX + m2.maxX) / 2 - c0x) || 0.1;
      place(st.fitTX, 0, st.fitTZ + 1, st.fitD, d);
      const m3 = measure(PLAY_PTS);
      const kz = Math.abs((m3.minY + m3.maxY) / 2 - c0y) || 0.1;
      st.slackX = isPortrait ? Math.min(0.25, ox / kx) : ox / kx;
      st.slackZ = isPortrait ? Math.max(0.55, oy / kz) : oy / kz;
    }
    // title
    const rt = fit(TITLE_PTS, st.title, dirFor('title', -0.42), 6.5, 19, 6.5, 30, true);
    st.titleD = rt.D; st.titleTX = rt.tx; st.titleTY = rt.ty; st.titleTZ = rt.tz;
  }

  function resize(W, H, doRefit = true) {
    const aspect = W / H;
    camera.aspect = aspect;
    camera.fov = aspect < 0.8 ? 50 : aspect < 1.25 ? 46 : 40;
    camera.updateProjectionMatrix();
    if (doRefit) refit();
  }

  function setBands(play, title) {
    st.play = play;
    st.title = title;
    refit();
    if (st.mode === 'play' && !st.climb && !st.focus) {
      st.tx = targetX();
      st.tz = targetZ();
      st.ty = st.floor * FLOOR_H;
      update(0);
    } else if (st.mode === 'title') {
      update(0);
    }
  }
  function setMode(mode) { st.mode = mode; st.zoom = st.zoomTarget = 1; st.pitch = PITCH; st.climb = null; st.focus = null; if (mode === 'play') snap(); }
  function setFloor(i, doSnap) { st.floor = i; st.climb = null; if (doSnap) { st.pitch = i === 6 ? 49 * Math.PI / 180 : PITCH; snap(); } }
  function beginClimb(from, to) { st.climb = { from, to, t: 0 }; }
  function setZoom(z) { st.zoomTarget = z; if (z === 1) { st.zoom = 1; st.focus = null; } }
  /** Finale: frame a world point (floor-local x/z) instead of the room. */
  function setFocus(x, z) { st.focus = st.focus || { x, z }; st.focus.x = x; st.focus.z = z; }
  function addShake(a) { st.shake = Math.min(0.1, Math.max(st.shake, a)); }
  function snap() { st.tx = targetX(); st.tz = targetZ(); st.ty = st.floor * FLOOR_H; }
  function targetX() {
    if (!st.follow || !G.hero) return st.fitTX;
    return st.fitTX + clamp(G.hero.x - 6.5, -st.slackX, st.slackX);
  }
  function targetZ() {
    if (!st.follow || !G.hero) return st.fitTZ;
    return st.fitTZ + clamp(G.hero.z - 6.5, -st.slackZ, st.slackZ);
  }

  function update(dt) {
    st.t += dt;
    const fog = G.scene.fog;
    if (st.mode === 'title') {
      const yaw = -0.42 + Math.sin(st.t * 0.12) * 0.1;
      place(st.titleTX, st.titleTY, st.titleTZ, st.titleD, dirFor('title', yaw));
      if (fog) { fog.near = st.titleD * 1.2; fog.far = st.titleD * 6; }
      return;
    }
    let ty = st.floor * FLOOR_H;
    if (st.climb) {
      st.climb.t += dt;
      const u = smoothstep(st.climb.t / 1.6);
      ty = (st.climb.from + (st.climb.to - st.climb.from) * u) * FLOOR_H;
    }
    const pitchTarget = st.focus ? (42 * Math.PI / 180) : (st.floor === 6 ? (49 * Math.PI / 180) : PITCH);
    st.pitch = damp(st.pitch == null ? PITCH : st.pitch, pitchTarget, 3.0, dt);
    st.tx = damp(st.tx, st.focus ? st.focus.x : targetX(), st.focus ? 2.5 : 5, dt);
    // finale focus: aim at the golem's shoulder/hero height (~2.1 up)
    st.tz = damp(st.tz, st.focus ? st.focus.z - 1.7 : targetZ(), st.focus ? 2.5 : 5, dt);
    st.ty = st.climb ? ty : damp(st.ty, ty, 8, dt);
    st.zoom = damp(st.zoom, st.zoomTarget, 2.5, dt);
    const D = st.fitD * st.zoom;
    // positional shake (no rotation, no FOV change)
    let sx = 0, sy = 0, sz = 0;
    if (st.shake > 0.0005) {
      const t = st.t;
      sx = st.shake * (Math.sin(t * 61.3) * 0.6 + Math.sin(t * 37.9) * 0.4);
      sy = st.shake * (Math.sin(t * 53.1 + 1.3) * 0.6 + Math.sin(t * 29.7) * 0.4) * 0.6;
      sz = st.shake * (Math.sin(t * 47.7 + 2.1) * 0.6 + Math.sin(t * 33.3) * 0.4) * 0.5;
      st.shake *= Math.exp(-6 * dt);
    } else st.shake = 0;
    const d = [0, Math.sin(st.pitch), Math.cos(st.pitch)];
    camera.position.set(st.tx + d[0] * D + sx, st.ty + d[1] * D + sy, st.tz + d[2] * D + sz);
    camera.lookAt(st.tx + sx, st.ty + sy, st.tz + sz);
    camera.updateMatrixWorld(true);
    if (fog) { fog.near = D + 14; fog.far = D + 90; }
  }

  return { st, resize, refit, setBands, setMode, setFloor, beginClimb, setZoom, setFocus, addShake, update, snap };
}
