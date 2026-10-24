// Critter Battle Tower 3D: Heart Mob Climb! — boot, renderer, lights, main loop and test hooks.
// Art + audio come from the Voxel Art / Audio builders' modules (spec section 9 interfaces):
//   real:     './textures.js'                './models.js'                './audio.js'
//   fallback: './stubs/textures_stub.js'     './stubs/models_stub.js'     './stubs/audio_stub.js'
// Swapping between them = change the three import lines below.
import * as THREE from '../vendor/three.module.min.js';
import { createTextures } from './textures.js';
import { createModelKit } from './models.js';
import { GameAudio } from './audio.js';

import { VERSION, FLOOR_H, PHYS_DT, MAX_DT, FLOORS, ROOF, XP_MAX, MOB_KINDS } from './config.js';
import { makeRng } from './util.js';
import { createWorld } from './world.js';
import { createFX } from './fx.js';
import { createHeroSystem } from './hero.js';
import { createMobSystem } from './mobs.js';
import { createProjectiles } from './projectiles.js';
import { createLoot } from './loot.js';
import { createGame } from './game.js';
import { createCameraRig } from './camera.js';
import { createInput } from './input.js';
import { createUI } from './ui.js';
import { loadSave, writeSave } from './save.js';

const canvas = document.getElementById('c');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
} catch (e) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
}
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.3, 600);

// sunset sky dome (colour by elevation: orange horizon -> indigo zenith, warm sunset glow across pitched play frustum)
// + matching horizon fog so the far ground melts into the sunset
const SKY_STOPS_UP = [[0, 0xffa466], [0.08, 0xf08a6e], [0.2, 0xc8607a], [0.42, 0x5a3a78], [1, 0x1c1640]];
const SKY_STOPS_DOWN = [[0, 0xffa466], [0.32, 0xffb86a], [0.56, 0xff9256], [0.76, 0xe26462], [0.90, 0x9c4674], [1, 0x422658]];
const sky = (() => {
  const geo = new THREE.SphereGeometry(420, 32, 20);
  const pos = geo.attributes.position, col = new Float32Array(pos.count * 3), c = new THREE.Color(), c2 = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 420, stops = y >= 0 ? SKY_STOPS_UP : SKY_STOPS_DOWN, a = Math.abs(y);
    let k = 0;
    while (k < stops.length - 2 && a > stops[k + 1][0]) k++;
    const t = Math.min(1, Math.max(0, (a - stops[k][0]) / (stops[k + 1][0] - stops[k][0])));
    c.setHex(stops[k][1]); c2.setHex(stops[k + 1][1]); c.lerp(c2, t);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false, toneMapped: false }));
  m.renderOrder = -10; m.frustumCulled = false;
  return m;
})();
scene.add(sky);
scene.background = new THREE.Color(0x1c1640);
scene.fog = new THREE.Fog(0xe8907a, 40, 140);

// ---------- lights: fixed count forever (no shader recompiles when floors change) ----------
const hemi = new THREE.HemisphereLight(0xd6dcff, 0x6a4a3c, 1.15);
const dir = new THREE.DirectionalLight(0xffd2a0, 2.3);
dir.castShadow = true;
dir.shadow.mapSize.set(1024, 1024);
dir.shadow.bias = -0.0005;
dir.shadow.normalBias = 0.035;
scene.add(hemi, dir, dir.target);
const torchLights = [0, 1, 2].map(() => { const l = new THREE.PointLight(0xffa04a, 0, 14, 2); scene.add(l); return l; });

const save = loadSave();
const G = {
  THREE, renderer, scene, camera, audio: GameAudio, save, writeSave,
  rng: makeRng(1234), vrng: makeRng(987),
  time: 0, acc: 0, paused: false, rafId: 0, viewW: window.innerWidth, viewH: window.innerHeight,
  screen: 'title', fs: null, run: null, hero: null, mobs: [], followers: [],
  helperT: 2, cheerT: 0, finale: null, gift: null,
};
G.floorY = () => (G.fs ? G.fs.index * FLOOR_H : 0);

G.tex = createTextures(THREE);
G.kit = createModelKit(THREE, G.tex);
G.world = createWorld(G);
G.fx = createFX(G);
G.heroSys = createHeroSystem(G);
G.mobSys = createMobSystem(G);
G.proj = createProjectiles(G);
G.loot = createLoot(G);
G.game = createGame(G);
G.cam = createCameraRig(G);
G.input = createInput(G);
G.ui = createUI(G);
G.fx.setCollect(() => G.game.onXP());
GameAudio.setMuted(!!save.muted);

// torches + sun placement per view
const torchBase = [0, 0, 0];
G.setTorches = (i) => {
  const f = i >= 0 ? G.world.floors[i] : null;
  for (let k = 0; k < 3; k++) {
    const p = f && f.torchLights[k];
    if (p) { torchLights[k].position.set(p.x, p.y, p.z); torchBase[k] = 22; } else { torchLights[k].position.set(6.5, -50, 6.5); torchBase[k] = 0; }
  }
  const sc = dir.shadow.camera;
  if (i < 0) {
    dir.position.set(6.5 - 34, 40, 6.5 + 26); dir.target.position.set(6.5, 16, 6.5);
    sc.left = -30; sc.right = 30; sc.top = 32; sc.bottom = -30; sc.near = 1; sc.far = 120;
    dir.intensity = 2.3; hemi.intensity = 1.2;
  } else {
    const base = i * FLOOR_H;
    dir.position.set(6.5 - 7, base + 16, 6.5 + 8); dir.target.position.set(6.5, base, 6.5);
    sc.left = -12; sc.right = 12; sc.top = 12; sc.bottom = -12; sc.near = 1; sc.far = 45;
    dir.intensity = i === ROOF ? 2.6 : 2.2; hemi.intensity = i === ROOF ? 1.25 : 1.1;
  }
  sc.updateProjectionMatrix();
  dir.target.updateMatrixWorld();
};
function flickerTorches() {
  const t = G.time;
  for (let k = 0; k < 3; k++) {
    torchLights[k].intensity = torchBase[k] * (0.86 + 0.08 * Math.sin(t * 13 + k * 2.1) + 0.06 * Math.sin(t * 29.7 + k));
  }
}

// ---------- loop ----------
function physics(dt) {
  G.heroSys.step(dt);
  G.mobSys.step(dt);
  G.proj.step(dt);
  G.loot.step(dt);
  G.game.step(dt);
}
function update(dt) {
  G.time += dt;
  G.input.update();
  if (G.screen !== 'title' && G.fs) {
    G.acc += dt;
    let n = 0;
    while (G.acc >= PHYS_DT && n < 12) { physics(PHYS_DT); G.acc -= PHYS_DT; n++; }
    if (n >= 12) G.acc = 0;
  }
  G.world.update(dt);
  if (G.screen !== 'title') {
    G.heroSys.animate(dt);
    G.mobSys.animate(dt);
    G.proj.animate(dt);
    G.loot.animate(dt);
    G.game.frame(dt);
  }
  G.fx.update(dt);
  flickerTorches();
  G.cam.update(dt);
  sky.position.copy(camera.position);
  G.ui.update(dt);
}
function render() {
  G.ui.positionHints();
  renderer.render(scene, camera);
}
let last = performance.now();
function frame(now) {
  if (G.paused) return;
  G.rafId = requestAnimationFrame(frame);
  const dt = Math.min(MAX_DT, Math.max(0, (now - last) / 1000));
  last = now;
  update(dt);
  render();
}

function resize() {
  const W = Math.max(1, window.innerWidth), H = Math.max(1, window.innerHeight);
  G.viewW = W; G.viewH = H;
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse && Math.min(W, H) < 600 ? 1.5 : 2));
  renderer.setSize(W, H, false);
  G.cam.resize(W, H, false);
  G.ui.layout();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 150));
document.addEventListener('pointerdown', () => GameAudio.unlock(), true);
document.addEventListener('touchstart', () => GameAudio.unlock(), { capture: true, passive: true });
document.addEventListener('keydown', () => GameAudio.unlock(), true);
document.addEventListener('visibilitychange', () => { last = performance.now(); });

// ---------- test hooks ----------
function snapshot() {
  const h = G.hero, fs = G.fs, r = G.run;
  const mobs = G.mobs.filter((m) => !m.removed).map((m) => ({ id: m.id, kind: m.kind, love: m.love, loveNeeded: m.loveNeeded,
    isFriend: m.isFriend, state: m.state, x: +m.x.toFixed(2), y: +m.y.toFixed(2), z: +m.z.toFixed(2), onWall: !!m.wall, hidden: m.hidden }));
  return {
    version: VERSION, screen: G.screen, phase: fs ? fs.phase : null, floor: fs ? fs.index + 1 : 0, floorIndex: fs ? fs.index : -1,
    time: +G.time.toFixed(3),
    hero: { hp: h.hp, maxHp: h.maxHp, x: +h.x.toFixed(2), y: +h.y.toFixed(2), z: +h.z.toFixed(2), state: h.state,
      airborne: h.airborne, invuln: +Math.max(0, h.invuln).toFixed(2), slowed: h.slowT > 0 },
    mobs, grumpy: mobs.filter((m) => !m.isFriend).length,
    friends: G.followers.length, friendsTotal: r ? r.friendKinds.length : 0, waiting: r ? r.waiting.length : 0,
    xp: r ? r.xp : 0, xpMax: XP_MAX, bombReady: !!(r && r.xp >= XP_MAX),
    clear: !!fs && ['cleared', 'climb', 'gift', 'finale', 'end'].includes(fs.phase),
    waveIdx: fs ? fs.waveIdx : 0, waves: fs ? fs.def.waves.length : 0, queued: fs ? fs.queue.length : 0,
    respawns: fs ? fs.respawns.length : 0, bonks: fs ? fs.bonks : 0, poofed: fs ? fs.poofed : false, floorStars: fs ? fs.stars : 0,
    poofs: r ? r.poofs : 0, chestsOpened: fs ? fs.floor.chests.filter((c) => c.opened).length : 0,
    stars: save.stars.slice(), unlocked: save.unlocked, diamonds: save.diamonds, emeralds: save.emeralds, trophy: save.trophy,
    projectiles: G.proj.activeCount(), particles: G.fx.count(), loot: G.loot.items.length,
    mem: { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures },
    drawCalls: renderer.info.render.calls, muted: GameAudio.isMuted(),
  };
}
function visibleControls() {
  // layout size (offsetWidth/Height ignores pop-in CSS transforms), only for really visible buttons
  const out = [];
  for (const b of document.querySelectorAll('button')) {
    const r = b.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    let p = b, hidden = false;
    while (p && p !== document.body) { const cs = getComputedStyle(p); if (cs.display === 'none' || cs.visibility === 'hidden') { hidden = true; break; } p = p.parentElement; }
    if (!hidden) out.push({ id: b.id, w: b.offsetWidth, h: b.offsetHeight });
  }
  return out;
}
const _s = { x: 0, y: 0, z: 0 };
window.__game = {
  version: VERSION,
  floors: JSON.parse(JSON.stringify(FLOORS)),
  state: snapshot,
  step(dt = 1 / 60) { let rem = Math.max(0, dt); while (rem > 1e-9) { const d = Math.min(MAX_DT, rem); update(d); rem -= d; } return G.time; },
  pause() { G.paused = true; cancelAnimationFrame(G.rafId); },
  resume() { if (!G.paused) return; G.paused = false; last = performance.now(); G.rafId = requestAnimationFrame(frame); },
  render() { G.cam.update(0); render(); },
  /** 0-based floor index (0..6). */
  startGame(i = 0, opts = {}) { G.game.startGame(i, Object.assign({ fresh: i === 0 }, opts)); return snapshot().floor; },
  /** 1-based floor number (1..7 = floors 1-6 + roof). */
  skipToFloor(n = 1) { G.game.startGame(Math.max(0, Math.min(ROOF, (n | 0) - 1)), { fresh: false }); return snapshot().floor; },
  goTitle() { G.game.goTitle(); },
  befriendAll() {
    const fs = G.fs;
    if (!fs) return 0;
    if (fs.phase === 'intro') {
      G.game.queueStart();
      fs.phase = 'fight';
      fs.phaseT = 0;
    }
    // release remaining waves immediately (as instant spawns) so the floor can clear
    while (fs.waveIdx < fs.def.waves.length) { for (const k of fs.def.waves[fs.waveIdx]) G.mobSys.spawn(k, 6.5, 8, { instant: true }); fs.waveIdx++; }
    for (const q of fs.queue.splice(0)) G.mobSys.spawn(q.kind, q.x, q.z, { wall: q.wall, instant: true });
    fs.respawns.length = 0;
    G.mobSys.befriendAll();
    return G.mobs.filter((m) => !m.removed && m.isFriend).length;
  },
  hurtHero(n = 1) { const h = G.hero; h.invuln = 0; return G.heroSys.hurt(n, h.x + 0.5, h.z, { force: true }); },
  visibleControls,
  heartBomb() { return G.game.heartBomb(); },
  setXP(v) { if (G.run) G.run.xp = Math.max(0, Math.min(XP_MAX, v | 0)); },
  bot: {
    tapMob(id) {
      const m = G.mobs.find((q) => q.id === id && !q.removed);
      if (!m) return false;
      G.input.worldToScreen(m.cx, G.floorY() + m.cy, m.cz, _s);
      return G.input.tap(_s.x, _s.y);
    },
    tapWorld(x, z, y = 0) { G.input.worldToScreen(x, G.floorY() + y, z, _s); return G.input.tap(_s.x, _s.y); },
    tapScreen(x, y) { return G.input.tap(x, y); },
    screenOf(x, y, z) { G.input.worldToScreen(x, G.floorY() + y, z, _s); return { x: _s.x, y: _s.y }; },
    hold(x, z) { G.input.botHold(x, z); },
    release() { G.input.botHold(null); },
    key(dx, dz) { G.input.keyX = dx; G.input.keyZ = dz; },
  },
  _G: G,
};

// ---------- start ----------
resize();
G.game.goTitle();
G.cam.update(0);
G.rafId = requestAnimationFrame(frame);
