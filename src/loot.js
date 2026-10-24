// Chests + loot: lid opens when the hero arrives, 3D voxel items fountain out, bounce, then magnet
// to the hero after 0.6 s. The finale poppy is a stationary "gift" item. Item objects are pooled per kind.
import { ROOM } from './config.js';
import { clamp, easeOutBack } from './util.js';

export function createLoot(G) {
  const items = [];
  const queue = [];
  const pool = {};
  const KINDS = ['diamond', 'goldenApple', 'cookie', 'emerald', 'poppy', 'trophy'];

  function getObj(kind) {
    const p = pool[kind] || (pool[kind] = []);
    let o = p.pop();
    if (!o) {
      o = G.kit.makeItem(kind);
      o.traverse((c) => { if (c.isMesh) c.castShadow = true; });
      G.scene.add(o);
    }
    o.visible = true;
    o.scale.setScalar(1);
    return o;
  }
  function releaseObj(kind, o) {
    o.visible = false;
    if (o.parent !== G.scene) G.scene.add(o);   // a held poppy may be parented to the hero's hand
    (pool[kind] || (pool[kind] = [])).push(o);
  }
  // warm one object per kind for shader compilation at boot
  for (const k of KINDS) releaseObj(k, getObj(k));

  function openChest(chest) {
    if (chest.opened) return;
    chest.opened = true; chest.openT = 0;
    G.audio.play('chestOpen');
    const base = G.floorY();
    G.fx.sparkle(chest.x, base + 1.8, chest.z, 14, 1, 0.9, 0.5, 0.8);
    chest.loot.forEach((kind, k) => queue.push({ kind, t: 0.25 + k * 0.2, chest }));
    if (G.run) G.run.chests++;
  }

  function spawnItem(kind, chest) {
    const o = getObj(kind);
    // fountain toward the room centre with some spread
    const cx = 6.5 - chest.x, cz = 6.5 - chest.z, cl = Math.hypot(cx, cz) || 1;
    const a = Math.atan2(cx / cl, cz / cl) + (G.rng() - 0.5) * 1.3;
    const sp = 1.2 + G.rng() * 1.3;
    const it = { kind, obj: o, x: chest.x, y: 1.9, z: chest.z, vx: Math.sin(a) * sp, vy: 5.2 + G.rng() * 1.2,
      vz: Math.cos(a) * sp, t: 0, gift: false, spin: G.rng() * 6 };
    items.push(it);
    G.fx.sparkle(chest.x, G.floorY() + 2, chest.z, 4, 1, 1, 0.7, 0.4);
    G.audio.play('pickup', { pitch: 0.7 + items.length * 0.05, volume: 0.35 });
    return it;
  }

  function spawnGift(kind, x, z) {
    const o = getObj(kind);
    const it = { kind, obj: o, x, y: 0.2, z, vx: 0, vy: 0, vz: 0, t: 0, gift: true, spin: 0 };
    items.push(it);
    G.fx.sparkle(x, G.floorY() + 0.8, z, 12, 1, 0.5, 0.5, 0.7);
    return it;
  }

  function step(dt) {
    const h = G.hero;
    const fs = G.fs;
    // proximity auto-open + subtle golden sparkle on unopened chests
    if (fs && h.state === 'play') {
      const base = G.floorY();
      for (const c of fs.floor.chests) {
        if (!c.opened) {
          if ((h.x - c.x) ** 2 + (h.z - c.z) ** 2 < 1.45 * 1.45) openChest(c);
          else if (Math.floor((G.time + c.x * 0.17) * 3.0) !== Math.floor((G.time - dt + c.x * 0.17) * 3.0)) {
            G.fx.sparkle(c.x, base + 1.45, c.z, 2, 1, 0.9, 0.45, 0.75);
          }
        }
      }
    }
    for (let k = queue.length - 1; k >= 0; k--) {
      const q = queue[k];
      q.t -= dt;
      if (q.t <= 0) { queue.splice(k, 1); spawnItem(q.kind, q.chest); }
    }
    for (let k = items.length - 1; k >= 0; k--) {
      const it = items[k];
      it.t += dt; it.spin += dt * 2.6;
      if (it.gift) {
        if (h.state === 'play' && (h.x - it.x) ** 2 + (h.z - it.z) ** 2 < 0.95 * 0.95) G.game.pickPoppy();
        continue;
      }
      const flying = h.state === 'play' || h.state === 'finale';   // loot also flies to her on the golem's shoulder
      if (it.t < 0.6 || !flying) {
        it.vy -= 14 * dt;
        it.x += it.vx * dt; it.y += it.vy * dt; it.z += it.vz * dt;
        it.x = clamp(it.x, 0.3, ROOM - 0.3); it.z = clamp(it.z, 0.3, ROOM - 0.3);
        if (it.y < 0.06) { it.y = 0.06; it.vy = Math.abs(it.vy) * 0.35; it.vx *= 0.6; it.vz *= 0.6; }
      } else {
        const dx = h.x - it.x, dy = (h.y + 0.6) - it.y, dz = h.z - it.z;
        const d = Math.hypot(dx, dy, dz) || 1e-4;
        if (d < 0.55) { collect(it); items.splice(k, 1); continue; }
        const sp = Math.min(12, 3 + (it.t - 0.6) * 14);
        it.x += dx / d * sp * dt; it.y += dy / d * sp * dt; it.z += dz / d * sp * dt;
      }
    }
  }

  function collect(it) {
    releaseObj(it.kind, it.obj);
    G.game.onPickup(it.kind, it.x, it.y, it.z);
  }

  /** Give the effect of every item still flying (used when leaving a floor). */
  function collectAll() {
    for (const q of queue) G.game.onPickup(q.kind, q.chest.x, 1, q.chest.z);
    queue.length = 0;
    for (const it of items) { if (it.gift) { releaseObj(it.kind, it.obj); continue; } collect(it); }
    items.length = 0;
  }

  function removeGifts() {
    for (let k = items.length - 1; k >= 0; k--) if (items[k].gift) { releaseObj(items[k].kind, items[k].obj); items.splice(k, 1); }
  }

  function animate(dt) {
    const base = G.floorY();
    for (const it of items) {
      const bob = it.gift ? Math.sin(it.t * 3) * 0.12 : 0;
      it.obj.position.set(it.x, base + it.y + bob, it.z);
      it.obj.rotation.set(0, it.spin, 0);
      const s = it.gift ? 1.35 + Math.sin(it.t * 5) * 0.08 : 1;
      it.obj.scale.setScalar(s);
      if (it.gift && Math.floor(it.t * 10) !== Math.floor((it.t - dt) * 10)) G.fx.sparkle(it.x, base + 1.0, it.z, 1, 1, 0.6, 0.6, 0.6);
    }
    const fs = G.fs;
    if (fs) {
      for (const c of fs.floor.chests) {
        if (!c.opened) continue;
        c.openT += dt;
        c.lid.rotation.x = (c.openAngle || -1.3) * Math.min(1.08, easeOutBack(Math.min(1, c.openT / 0.35)));
      }
    }
  }

  function clear() {
    for (const it of items) releaseObj(it.kind, it.obj);
    items.length = 0; queue.length = 0;
  }

  return { openChest, spawnGift, step, animate, clear, collectAll, removeGifts, getObj, releaseObj, items };
}
