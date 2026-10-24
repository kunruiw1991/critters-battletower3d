// HUD + screens (all icons, zero text): hearts + diamonds (top-left), floor tower + mob-face pips
// (top-centre), sound + home (top-right), XP bar ending in the Heart-Bomb (bottom-right), title buttons,
// floor-clear stars, end card, and the zero-text hints positioned over world objects every frame.
import { XP_MAX, NUM_FLOORS, FLOORS } from './config.js';
import { clamp } from './util.js';

let TOTAL_DIA = 0, TOTAL_EM = 0;
for (const f of FLOORS) for (const c of f.loot) for (const item of c) {
  if (item === 'diamond') TOTAL_DIA++;
  else if (item === 'emerald') TOTAL_EM++;
}

function pixelIcon(rows, pal, size = 64) {
  const h = rows.length, w = rows[0].length;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  const s = Math.floor(size / Math.max(w, h));
  const ox = Math.floor((size - w * s) / 2), oy = Math.floor((size - h * s) / 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ch = rows[y][x];
    if (ch === '.') continue;
    g.fillStyle = pal[ch];
    g.fillRect(ox + x * s, oy + y * s, s, s);
  }
  return c.toDataURL('image/png');
}
const TOWER_ICON = pixelIcon(['K.K.K.K.K', 'KGKGKGKGK', 'KGGGGGGGK', 'KGgGYGgGK', 'KGGGYGGGK', 'KgGGGGGgK', 'KGGGGGgGK', 'KGgGYGGGK',
  'KGGGYGGGK', 'KGGGGGgGK', 'KGGBBBGGK', 'KGGBBBGGK', 'KKKKKKKKK'],
{ K: '#1c1c1c', G: '#8a8a8a', g: '#5a7a3a', Y: '#ffb04a', B: '#2a1a12' });
const TROPHY_ICON = pixelIcon(['.KKKKKKK.', 'KYYYYYYYK', 'KYWYYYYYK', '.KYYYYYK.', '..KYYYK..', '...KYK...', '...KYK...', '..KYYYK..', '.KKKKKKK.'],
  { K: '#3a2a00', Y: '#ffcc33', W: '#fff4b0' });

export function createUI(G) {
  const $ = (id) => document.getElementById(id);
  const I = G.tex.icons;
  const el = {
    hud: $('hud'), hudBottom: $('hud-bottom'), hearts: $('hearts'), gems: $('gems'), tower: $('tower'), pips: $('pips'), xpbar: $('xpbar'),
    bomb: $('btn-bomb'), sound: $('btn-sound'), home: $('btn-home'), title: $('title'), play: $('btn-play'),
    restart: $('btn-restart'), sound2: $('btn-sound2'), end: $('endcard'), replay: $('btn-replay'), home2: $('btn-home2'),
    clear: $('clearstars'), hand: $('hint-hand'), drag: $('hint-drag'), arrow: $('hint-arrow'), gift: $('hint-gift'),
    endTower: $('endtower'), fade: $('fade'),
  };
  // ---------- static icons ----------
  el.bomb.querySelector('img').src = I.heartBomb;
  el.home.querySelector('img').src = I.home;
  el.home2.querySelector('img').src = I.home;
  el.replay.querySelector('img').src = I.restart;
  el.play.querySelector('img.heart').src = I.heartFull;
  el.play.querySelector('img.tri').src = I.play;
  el.restart.querySelector('img.r').src = I.restart;
  el.restart.querySelector('img.t').src = TOWER_ICON;
  el.hand.src = I.hand; el.drag.src = I.handUp || I.hand; el.arrow.src = I.arrowDown; el.gift.src = I.hand;
  $('st-friend-img').src = I.friendBadge || (I.mobFace && I.mobFace.creeper) || I.heartFull;
  $('st-dia-img').src = I.diamond;
  $('st-em-img').src = I.emerald;
  $('st-trophy-img').src = TROPHY_ICON;

  const heartImgs = [];
  for (let k = 0; k < 5; k++) { const im = document.createElement('img'); im.alt = ''; im.src = I.heartFull; el.hearts.appendChild(im); heartImgs.push(im); }
  const segs = [];
  for (let k = 0; k < NUM_FLOORS; k++) { const d = document.createElement('div'); d.className = 'seg'; el.tower.appendChild(d); segs.push(d); }
  const cap = document.createElement('div'); cap.className = 'cap'; el.tower.appendChild(cap);
  const xsegs = [];
  for (let k = 0; k < XP_MAX; k++) { const d = document.createElement('div'); d.className = 'xs'; el.xpbar.appendChild(d); xsegs.push(d); }
  const clearImgs = el.clear.querySelectorAll('img');

  // ---------- buttons ----------
  function bind(b, fn) {
    b.addEventListener('pointerdown', (e) => { e.stopPropagation(); G.audio.unlock(); });
    b.addEventListener('click', (e) => { e.stopPropagation(); G.audio.unlock(); G.audio.play('uiTap'); fn(); });
  }
  bind(el.bomb, () => G.game.heartBomb());
  bind(el.sound, toggleSound);
  bind(el.sound2, toggleSound);
  bind(el.home, () => G.game.goTitle());
  bind(el.home2, () => G.game.goTitle());
  bind(el.play, () => G.game.startGame(G.save.unlocked, { fresh: false }));
  bind(el.restart, () => G.game.startGame(0, { fresh: true }));
  bind(el.replay, () => G.game.startGame(0, { fresh: true }));

  function toggleSound() {
    const m = !G.audio.isMuted();
    G.audio.setMuted(m);
    G.save.muted = m;
    G.writeSave(G.save);
    last.muted = null;
  }

  // ---------- screens ----------
  let fadeT = 0, fadeDur = 0.25;
  function pulseFade(dur = 0.25) {
    if (!el.fade) return;
    fadeDur = Math.max(0.05, dur);
    fadeT = fadeDur;
    el.fade.style.opacity = '0.45';
  }
  function show(e, on) { e.classList.toggle('hidden', !on); }
  function showTitle(hasProgress) {
    pulseFade(0.22);
    show(el.hud, false); show(el.end, false); show(el.title, true);
    show(el.restart, !!hasProgress);
    hideClearStars();
    hideHints();
    layout();
  }
  function showHUD() {
    pulseFade(0.22);
    show(el.title, false); show(el.end, false); show(el.hud, true);
    if (el.hudBottom) show(el.hudBottom, true);
    hideClearStars();
    last.hp = last.xp = last.dia = last.floor = last.muted = null;
    api.pipsDirty = true;
    layout();
  }
  function showEnd(s) {
    hideClearStars();
    show(el.end, true);
    show(el.hud, false);
    hideHints();
    el.endTower.innerHTML = '';
    for (let f = 0; f < NUM_FLOORS; f++) {
      const row = document.createElement('div'); row.className = 'row';
      for (let k = 0; k < 3; k++) { const im = document.createElement('img'); im.alt = ''; im.src = k < (s.stars[f] || 0) ? I.star : I.starEmpty; row.appendChild(im); }
      el.endTower.appendChild(row);
    }
    const crown = document.createElement('div'); crown.className = 'crown'; el.endTower.appendChild(crown);
    const fillPips = (boxId, iconOn, iconOff, count, total) => {
      const box = $(boxId); box.innerHTML = '';
      for (let k = 0; k < total; k++) {
        const im = document.createElement('img'); im.alt = '';
        const on = k < count;
        im.src = on ? iconOn : (iconOff || iconOn);
        if (!on && !iconOff) im.className = 'dim';
        box.appendChild(im);
      }
    };
    const friendPips = s.friends > 0 ? Math.min(7, Math.max(1, Math.ceil(s.friends / 5))) : 0;
    fillPips('st-friends', I.heartFull, I.heartEmpty, friendPips, 7);
    fillPips('st-dia', I.diamond, null, Math.min(TOTAL_DIA, s.diamonds || 0), TOTAL_DIA);
    fillPips('st-em', I.emerald, null, Math.min(TOTAL_EM, s.emeralds || 0), TOTAL_EM);
    show($('st-trophy-row'), !!s.trophy);
    queueStars(3);
  }
  function hideOverlays() { starCues.length = 0; show(el.end, false); hideClearStars(); hideHints(); }

  // ---------- floor-clear stars ----------
  const STAR_PITCHES = [1, 1.12, 1.26];
  const starCues = [];
  let clearStartT = -1, clearUntil = -1;
  function queueStars(n) {
    starCues.length = 0;
    const cnt = Math.min(3, Math.max(0, n | 0));
    for (let k = 0; k < cnt; k++) {
      if (k === 0) G.audio.play('star', { pitch: STAR_PITCHES[0] });
      else starCues.push({ t: G.time + k * 0.22, pitch: STAR_PITCHES[k] });
    }
  }
  function hideClearStars() {
    clearStartT = -1; clearUntil = -1;
    el.clear.classList.remove('show', 'out');
    show(el.clear, false);
    clearImgs.forEach((im) => { im.style.opacity = '0'; im.style.transform = 'scale(0)'; });
  }
  function updateClearStarsVisual() {
    if (clearUntil < 0) return;
    const age = Math.max(0, G.time - clearStartT);
    const rem = clearUntil - G.time;
    const fadeOut = rem < 0.35 ? clamp(rem / 0.35, 0, 1) : 1;
    clearImgs.forEach((im, k) => {
      const sa = age + 0.06 - k * 0.09;
      if (sa <= 0) { im.style.opacity = '0'; im.style.transform = 'scale(0) rotate(-25deg)'; return; }
      const p = Math.min(1, sa / 0.24);
      const sc = (p < 0.65 ? (p / 0.65) * 1.22 : 1.22 - ((p - 0.65) / 0.35) * 0.22) * (0.7 + 0.3 * fadeOut);
      const rot = p < 0.65 ? (1 - p / 0.65) * -22 + 8 : (1 - (p - 0.65) / 0.35) * 8;
      im.style.opacity = (Math.min(1, sa / 0.08) * fadeOut).toFixed(3);
      im.style.transform = `scale(${sc.toFixed(3)}) rotate(${rot.toFixed(1)}deg)`;
    });
  }
  function showClearStars(n, dur = 2.3) {
    clearImgs.forEach((im, k) => { im.src = k < n ? I.star : I.starEmpty; });
    el.clear.classList.remove('out');
    el.clear.classList.add('show');
    show(el.clear, true);
    clearStartT = G.time;
    clearUntil = G.time + dur;
    updateClearStarsVisual();
    queueStars(n);
  }

  // ---------- per frame / dirty-checked HUD ----------
  const last = { hp: null, xp: null, dia: null, floor: null, muted: null };
  function setFloor() { last.floor = null; api.pipsDirty = true; }
  function bumpHearts() { heartImgs.forEach((im) => { im.classList.remove('bump'); void im.offsetWidth; im.classList.add('bump'); }); }
  let nopeT = 0;
  function bombNope() { el.bomb.classList.remove('pressed'); void el.bomb.offsetWidth; el.bomb.classList.add('pressed'); nopeT = 0.15; }

  function update(dt) {
    if (fadeT > 0 && el.fade) {
      fadeT = Math.max(0, fadeT - dt);
      el.fade.style.opacity = fadeT > 0 ? ((fadeT / fadeDur) * 0.45).toFixed(3) : '0';
    }
    for (let i = starCues.length - 1; i >= 0; i--) {
      if (G.time >= starCues[i].t) {
        const c = starCues.splice(i, 1)[0];
        G.audio.play('star', { pitch: c.pitch });
      }
    }
    if (clearUntil > 0) {
      const ph = G.fs && G.fs.phase;
      if (G.screen !== 'play' || !G.fs || ph === 'gift' || ph === 'finale' || ph === 'end' || ph === 'climb' || G.time >= clearUntil) {
        hideClearStars();
      } else {
        updateClearStarsVisual();
      }
    }
    if (nopeT > 0 && (nopeT -= dt) <= 0) el.bomb.classList.remove('pressed');
    const muted = G.audio.isMuted();
    if (muted !== last.muted) {
      last.muted = muted;
      const src = muted ? I.speakerOff : I.speakerOn;
      el.sound.querySelector('img').src = src; el.sound2.querySelector('img').src = src;
    }
    if (G.screen !== 'play' || !G.fs || !G.run) return;
    const h = G.hero;
    if (h.hp !== last.hp) {
      for (let k = 0; k < 5; k++) { heartImgs[k].src = k < h.hp ? I.heartFull : I.heartEmpty; heartImgs[k].classList.toggle('lost', k >= h.hp); }
      last.hp = h.hp;
    }
    const xp = G.run.xp;
    if (xp !== last.xp) {
      for (let k = 0; k < XP_MAX; k++) xsegs[k].classList.toggle('on', k < xp);
      last.xp = xp;
    }
    const phase = G.fs.phase;
    const hasGrumpy = G.mobs.some((m) => !m.removed && !m.isFriend && !m.hidden);
    const canBomb = xp >= XP_MAX && phase === 'fight' && hasGrumpy;
    const hideBottom = phase === 'finale' || phase === 'end';
    el.xpbar.classList.toggle('full', canBomb);
    el.bomb.classList.toggle('ready', canBomb);
    if (el.hudBottom) show(el.hudBottom, !hideBottom);
    const dia = G.save.diamonds * 100 + G.save.emeralds;
    if (dia !== last.dia) {
      last.dia = dia;
      el.gems.innerHTML = '';
      const nd = Math.min(10, G.save.diamonds), ne = Math.min(6, G.save.emeralds);
      for (let k = 0; k < nd; k++) { const im = document.createElement('img'); im.alt = ''; im.src = I.diamond; el.gems.appendChild(im); }
      for (let k = 0; k < ne; k++) { const im = document.createElement('img'); im.alt = ''; im.src = I.emerald; el.gems.appendChild(im); }
    }
    const fi = G.fs.index;
    if (fi !== last.floor) {
      last.floor = fi;
      segs.forEach((s, k) => { s.classList.toggle('done', k < fi); s.classList.toggle('cur', k === fi); });
    }
    if (api.pipsDirty) {
      api.pipsDirty = false;
      const fs = G.fs;
      if (el.pips.childElementCount !== fs.total || el.pips.dataset.floor !== String(fi)) {
        el.pips.innerHTML = '';
        el.pips.dataset.floor = String(fi);
        for (let k = 0; k < fs.total; k++) {
          const p = document.createElement('div'); p.className = 'pip';
          const face = document.createElement('img'); face.className = 'face'; face.alt = '';
          face.src = (I.mobFace && I.mobFace[fs.pipKinds[k]]) || I.heartEmpty;
          const mini = document.createElement('img'); mini.className = 'mini'; mini.alt = ''; mini.src = I.heartFull;
          p.appendChild(face); p.appendChild(mini); el.pips.appendChild(p);
        }
        layout();
      }
      const kids = el.pips.children;
      for (let k = 0; k < kids.length; k++) kids[k].classList.toggle('friend', fs.pipFriend[k] === 1);
    }
  }

  // ---------- hints over world objects (zero text) ----------
  const hs = { x: 0, y: 0, z: 0 };
  const hintOn = { hand: false, drag: false, arrow: false, gift: false };
  function setHint(name, on, x, y) {
    const e = el[name];
    if (on !== hintOn[name]) { hintOn[name] = on; show(e, on); }
    if (on) { e.style.left = x.toFixed(1) + 'px'; e.style.top = y.toFixed(1) + 'px'; }
  }
  function hideHints() { api.hintMob = null; for (const k in hintOn) setHint(k, false); }
  function positionHints() {
    const fs = G.fs, r = G.run;
    if (G.screen !== 'play' || !fs || !r) { hideHints(); return; }
    const base = G.floorY(), h = G.hero, W2S = G.input.worldToScreen;
    // 1) pulsing pointing hand over the first zombie until the first heart lands
    let showHand = false;
    api.hintMob = null;
    if (fs.index === 0 && !r.hintTapDone && fs.phase === 'fight' && h.state === 'play') {
      const m = G.mobSys.nearestGrumpy(h.x, h.z, 99, false);
      if (m) {
        api.hintMob = m;
        W2S(m.cx, base + m.cy + m.height * 0.2, m.cz, hs);
        showHand = true;
        setHint('hand', true, clamp(hs.x, 44, G.viewW - 44), clamp(hs.y, 82, G.viewH - 40));
      }
    }
    if (!showHand) setHint('hand', false);
    // 2) drag-hand loop on the open floor in front of the hero toward the room center
    if (r.hintDragShown && !r.hintDragDone && h.state === 'play' && (fs.phase === 'fight' || fs.phase === 'cleared')) {
      const dz = h.z > 6.5 ? -2.6 : 2.2;
      W2S(clamp(h.x, 3.5, 9.5), base + 0.2, clamp(h.z + dz, 3.0, 9.2), hs);
      const xb = el.xpbar.getBoundingClientRect(), bb = el.bomb.getBoundingClientRect();
      const maxDragY = Math.min(G.viewH - 96, (xb.top > 0 ? xb.top : G.viewH - 68) - 24);
      const maxDragX = Math.min(G.viewW - 104, (bb.left > 0 ? bb.left - 104 : G.viewW - 104));
      setHint('drag', true, clamp(hs.x, 104, Math.max(104, maxDragX)), clamp(hs.y, 106, Math.max(106, maxDragY)));
    } else setHint('drag', false);
    // 3) bouncing arrow over the ladder after the floor is cleared
    if (fs.phase === 'cleared' && fs.floor.ladder) {
      W2S(fs.floor.ladder.x, base + 3.2, 0.4, hs);
      setHint('arrow', true, clamp(hs.x, 44, G.viewW - 44), clamp(hs.y, 76, G.viewH - 28));
    } else setHint('arrow', false);
    // 4) pointing hand over the golem's poppy gift
    if (fs.phase === 'gift' && G.gift) {
      W2S(G.gift.x, base + 0.85, G.gift.z, hs);
      setHint('gift', true, clamp(hs.x, 44, G.viewW - 44), clamp(hs.y, 82, G.viewH - 40));
    } else setHint('gift', false);
  }

  // ---------- layout -> camera bands (HUD never covers the hero) ----------
  function layout() {
    const W = window.innerWidth, H = window.innerHeight;
    const portrait = W / H < 0.8;
    const hudHidden = el.hud.classList.contains('hidden');
    const botHidden = el.hudBottom && el.hudBottom.classList.contains('hidden');
    if (hudHidden) { el.hud.style.visibility = 'hidden'; el.hud.classList.remove('hidden'); }
    if (botHidden) { el.hudBottom.style.visibility = 'hidden'; el.hudBottom.classList.remove('hidden'); }
    const tl = $('hud-tl').getBoundingClientRect(), tc = $('hud-tc').getBoundingClientRect(), tr = $('hud-tr').getBoundingClientRect();
    const xb = el.xpbar.getBoundingClientRect(), bb = el.bomb.getBoundingClientRect();
    if (botHidden) { el.hudBottom.classList.add('hidden'); el.hudBottom.style.visibility = ''; }
    if (hudHidden) { el.hud.classList.add('hidden'); el.hud.style.visibility = ''; }
    let top, bottom;
    if (portrait) { top = Math.max(tl.bottom, tc.bottom, tr.bottom) + 8; bottom = H - Math.min(xb.top, bb.top) + 8; } else { top = tc.bottom + 8; bottom = H - xb.top + 8; }
    // title: keep the tower clear of the big buttons
    const titleHidden = el.title.classList.contains('hidden');
    if (titleHidden) { el.title.style.visibility = 'hidden'; el.title.classList.remove('hidden'); }
    const tb = $('title-btns').getBoundingClientRect(), sb = el.sound2.getBoundingClientRect();
    if (titleHidden) { el.title.classList.add('hidden'); el.title.style.visibility = ''; }
    const title = portrait ? { top: sb.bottom + 6, bottom: H - tb.top + 12, left: 10, right: 10 } : { top: 14, bottom: 14, left: 14, right: W - tb.left + 16 };
    G.cam.setBands({ top, bottom, left: 10, right: 10 }, title);
  }

  const api = { showTitle, showHUD, showEnd, hideOverlays, showClearStars, hideClearStars, pulseFade, update, positionHints, hideHints, layout,
    setFloor, bumpHearts, bombNope, pipsDirty: true, hintMob: null, el };
  return api;
}
