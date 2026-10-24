// Pooled particle FX: one InstancedMesh of camera-facing quads per sprite texture
// (frustumCulled = false, zero per-frame allocations, struct-of-arrays storage).
// Also owns the love-meter hearts above grumpy mobs and the golem slam marker.
import { clamp } from './util.js';

const F_HOME = 1;   // XP orb: homes to the hero, calls onCollect
const F_ORBIT = 2;  // dizzy star: orbits the hero's head
const F_FLOOR = 4;  // lands on the floor (stops falling)

export function createFX(G) {
  const { THREE, scene, tex, camera } = G;
  const S = tex.sprites;
  const plane = new THREE.PlaneGeometry(1, 1);
  const owned = [plane];
  const pools = {};
  const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion();
  const _qz = new THREE.Quaternion(), _z = new THREE.Vector3(0, 0, 1), _col = new THREE.Color();
  const rnd = G.vrng;

  function makePool(name, map, max, additive) {
    const mat = new THREE.MeshBasicMaterial({
      map, transparent: true, depthWrite: !additive, alphaTest: additive ? 0.02 : 0.4,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: false, toneMapped: false,
    });
    const mesh = new THREE.InstancedMesh(plane, mat, max);
    mesh.frustumCulled = false;
    mesh.renderOrder = additive ? 4 : 3;
    mesh.castShadow = false; mesh.receiveShadow = false;
    _col.setRGB(1, 1, 1);
    for (let i = 0; i < max; i++) mesh.setColorAt(i, _col);   // create instanceColor up front (no recompiles)
    mesh.count = 0;
    scene.add(mesh);
    owned.push(mat);
    const P = {
      name, mesh, max, n: 0, additive,
      px: new Float32Array(max), py: new Float32Array(max), pz: new Float32Array(max),
      vx: new Float32Array(max), vy: new Float32Array(max), vz: new Float32Array(max),
      life: new Float32Array(max), maxLife: new Float32Array(max), s0: new Float32Array(max), s1: new Float32Array(max),
      rot: new Float32Array(max), vrot: new Float32Array(max), grav: new Float32Array(max), drag: new Float32Array(max),
      cr: new Float32Array(max), cg: new Float32Array(max), cb: new Float32Array(max), flags: new Uint8Array(max),
      floorY: new Float32Array(max),
    };
    pools[name] = P;
    return P;
  }
  makePool('heart', S.heart, 220, false);
  makePool('smoke', S.smoke, 200, false);
  makePool('confetti', S.confetti, 200, false);
  makePool('star', S.star, 60, false);
  makePool('flower', tex.blocks.flowerRed, 40, false);
  makePool('flower2', tex.blocks.flowerYellow, 40, false);
  makePool('sparkle', S.sparkle, 260, true);
  makePool('xp', S.xpOrb, 60, true);
  makePool('flame', S.flame, 120, true);
  makePool('wind', S.windSwirl, 160, true);

  let onCollect = null;

  /** Spawn one particle (recycles a random slot when the pool is full). */
  function emit(name, x, y, z, vx, vy, vz, life, s0, s1, r = 1, g = 1, b = 1, grav = 0, drag = 0, flags = 0, rot = 0, vrot = 0) {
    const P = pools[name];
    let i = P.n;
    if (i >= P.max) i = Math.floor(rnd() * P.max); else P.n++;
    P.px[i] = x; P.py[i] = y; P.pz[i] = z; P.vx[i] = vx; P.vy[i] = vy; P.vz[i] = vz;
    P.life[i] = life; P.maxLife[i] = life; P.s0[i] = s0; P.s1[i] = s1;
    P.cr[i] = r; P.cg[i] = g; P.cb[i] = b; P.grav[i] = grav; P.drag[i] = drag; P.flags[i] = flags;
    P.rot[i] = rot; P.vrot[i] = vrot; P.floorY[i] = G.floorY ? G.floorY() + 0.06 : -999;
    return i;
  }
  function kill(P, i) {
    const j = --P.n;
    if (i === j) return;
    P.px[i] = P.px[j]; P.py[i] = P.py[j]; P.pz[i] = P.pz[j]; P.vx[i] = P.vx[j]; P.vy[i] = P.vy[j]; P.vz[i] = P.vz[j];
    P.life[i] = P.life[j]; P.maxLife[i] = P.maxLife[j]; P.s0[i] = P.s0[j]; P.s1[i] = P.s1[j]; P.rot[i] = P.rot[j];
    P.vrot[i] = P.vrot[j]; P.grav[i] = P.grav[j]; P.drag[i] = P.drag[j]; P.cr[i] = P.cr[j]; P.cg[i] = P.cg[j];
    P.cb[i] = P.cb[j]; P.flags[i] = P.flags[j]; P.floorY[i] = P.floorY[j];
  }

  let xpStaggerT = 0;
  let xpCollectCd = 0;

  function updatePool(P, dt, hx, hy, hz) {
    const camQ = camera.quaternion;
    let i = 0;
    while (i < P.n) {
      P.life[i] -= dt;
      if (P.life[i] <= 0) { kill(P, i); continue; }
      const f = P.flags[i];
      if (f & F_HOME) {
        const age = P.maxLife[i] - P.life[i];
        if (age > 0.35) {
          const dx = hx - P.px[i], dy = hy + 0.9 - P.py[i], dz = hz - P.pz[i];
          const d = Math.hypot(dx, dy, dz) || 1e-4;
          if (d < 0.4) {
            if (xpCollectCd <= 0) {
              kill(P, i);
              xpCollectCd = 0.055;
              if (onCollect) onCollect(false);
              continue;
            }
            P.px[i] = hx; P.py[i] = hy + 0.9; P.pz[i] = hz;
            P.vx[i] = P.vy[i] = P.vz[i] = 0;
            P.life[i] = Math.max(P.life[i], 0.3);
          } else {
            const sp = 4 + age * 9;
            P.vx[i] = dx / d * sp; P.vy[i] = dy / d * sp; P.vz[i] = dz / d * sp;
            P.life[i] = Math.max(P.life[i], 0.3);
          }
        } else { P.vy[i] -= 9 * dt; }
      } else if (f & F_ORBIT) {
        P.rot[i] += P.vrot[i] * dt;
        P.px[i] = hx + Math.cos(P.rot[i]) * 0.42; P.pz[i] = hz + Math.sin(P.rot[i]) * 0.42;
        P.py[i] = hy + 2.15 + Math.sin(P.rot[i] * 2) * 0.05;
      } else {
        P.vy[i] -= P.grav[i] * dt;
        const dr = 1 - clamp(P.drag[i] * dt, 0, 1);
        P.vx[i] *= dr; P.vy[i] *= dr; P.vz[i] *= dr;
        P.rot[i] += P.vrot[i] * dt;
      }
      if (!(f & F_ORBIT)) { P.px[i] += P.vx[i] * dt; P.py[i] += P.vy[i] * dt; P.pz[i] += P.vz[i] * dt; }
      if ((f & F_FLOOR) && P.py[i] < P.floorY[i]) { P.py[i] = P.floorY[i]; P.vy[i] = 0; P.vx[i] *= 0.8; P.vz[i] *= 0.8; P.vrot[i] *= 0.8; }
      i++;
    }
    for (let k = 0; k < P.n; k++) {
      const t = clamp(1 - P.life[k] / P.maxLife[k], 0, 1);
      const size = P.s0[k] + (P.s1[k] - P.s0[k]) * t;
      _p.set(P.px[k], P.py[k], P.pz[k]);
      _qz.setFromAxisAngle(_z, P.rot[k]);
      _q.copy(camQ).multiply(_qz);
      _s.set(size, size, size);
      _m.compose(_p, _q, _s);
      P.mesh.setMatrixAt(k, _m);
      if (P.additive) {
        const fade = 1 - t * t;
        _col.setRGB(P.cr[k] * fade, P.cg[k] * fade, P.cb[k] * fade);
      } else _col.setRGB(P.cr[k], P.cg[k], P.cb[k]);
      P.mesh.setColorAt(k, _col);
    }
    P.mesh.count = P.n;
    P.mesh.instanceMatrix.needsUpdate = true;
    if (P.mesh.instanceColor) P.mesh.instanceColor.needsUpdate = true;
  }

  // ---------------- love meters (flat golden-pink pixel progress ring on the floor under grumpy mobs) ----------------
  // IMPORTANT: Never render a floating heart above grumpy mobs' heads — the overhead floating red heart is reserved
  // strictly for befriended allies (m.isFriend === true, rig.heart).
  const loveRingTex = (() => {
    const c = document.createElement('canvas'); c.width = 32; c.height = 32;
    const x = c.getContext('2d');
    for (let j = 0; j < 32; j++) {
      for (let i = 0; i < 32; i++) {
        const d = Math.hypot(i + 0.5 - 16, j + 0.5 - 16);
        if (d < 10.5 || d > 15.2) continue;
        const a = Math.atan2(j + 0.5 - 16, i + 0.5 - 16);
        const seg = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 12);
        x.fillStyle = d > 12.8 ? (seg % 2 === 0 ? 'rgba(255,215,110,0.95)' : 'rgba(255,130,185,0.92)') : 'rgba(255,175,210,0.45)';
        x.fillRect(i, j, 1, 1);
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const _qFlat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const _qSpin = new THREE.Quaternion(), _yAxis = new THREE.Vector3(0, 1, 0);
  const meterMat = new THREE.MeshBasicMaterial({ map: loveRingTex, transparent: true, depthWrite: false, alphaTest: 0.1, fog: false, toneMapped: false });
  const meter = new THREE.InstancedMesh(plane, meterMat, 64);
  meter.frustumCulled = false; meter.renderOrder = 2; meter.count = 0;
  _col.setRGB(1, 1, 1); for (let i = 0; i < 64; i++) meter.setColorAt(i, _col);
  scene.add(meter); owned.push(meterMat, loveRingTex);
  let meterN = 0;
  function meterBegin() { meterN = 0; }
  function meterAdd(x, y, z, frac, pulse, radius = 0.4) {
    if (meterN >= 64) return;
    const size = Math.max(0.85, radius * 2.2) * (0.82 + 0.32 * frac + pulse * 0.14);
    _p.set(x, y, z); _s.set(size, size, 1);
    _qSpin.setFromAxisAngle(_yAxis, G.time * 1.8 + meterN * 0.7).multiply(_qFlat);
    _m.compose(_p, _qSpin, _s);
    meter.setMatrixAt(meterN, _m);
    _col.setRGB(0.85 + 0.15 * frac, 0.55 + 0.4 * frac, 0.75 + 0.25 * (1 - frac));
    meter.setColorAt(meterN, _col);
    meterN++;
  }
  function meterEnd() {
    meter.count = meterN;
    meter.instanceMatrix.needsUpdate = true;
    if (meter.instanceColor) meter.instanceColor.needsUpdate = true;
  }

  // ---------------- golem slam marker: red pixel circle growing on the floor ----------------
  const ringTex = (() => {
    const c = document.createElement('canvas'); c.width = 32; c.height = 32;
    const x = c.getContext('2d');
    for (let j = 0; j < 32; j++) {
      for (let i = 0; i < 32; i++) {
        const d = Math.hypot(i + 0.5 - 16, j + 0.5 - 16);
        if (d > 15.5) continue;
        x.fillStyle = d > 13.5 ? 'rgba(255,40,40,1)' : ((i + j) % 4 === 0 ? 'rgba(255,90,90,0.55)' : 'rgba(255,60,60,0.32)');
        x.fillRect(i, j, 1, 1);
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const slamMat = new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, fog: false, toneMapped: false });
  const slamMesh = new THREE.Mesh(plane, slamMat);
  slamMesh.rotation.x = -Math.PI / 2; slamMesh.visible = false; slamMesh.renderOrder = 2;
  scene.add(slamMesh); owned.push(slamMat, ringTex);
  function slamMarker(x, y, z, radius, pulse) {
    slamMesh.visible = radius > 0.01;
    slamMesh.position.set(x, y + 0.03, z);
    slamMesh.scale.set(radius * 2, radius * 2, 1);
    slamMat.opacity = 0.75 + 0.25 * pulse;
  }

  // ---------------- effect helpers (world coordinates) ----------------
  const fx = {
    pools, emit,
    setCollect(fn) { onCollect = fn; },
    heartBurst(x, y, z, n = 8, speed = 3) {
      for (let k = 0; k < n; k++) {
        const a = rnd() * Math.PI * 2, u = rnd();
        emit('heart', x, y, z, Math.cos(a) * speed * (0.4 + u), 1.5 + rnd() * speed, Math.sin(a) * speed * (0.4 + u),
          0.7 + rnd() * 0.5, 0.32 + rnd() * 0.18, 0.06, 1, 1, 1, 6, 1.2, 0, 0, (rnd() - 0.5) * 3);
      }
    },
    smoke(x, y, z, n = 6, spread = 0.4, size = 0.5) {
      for (let k = 0; k < n; k++) {
        const g = 0.75 + rnd() * 0.25;
        emit('smoke', x + (rnd() - 0.5) * spread, y + rnd() * spread, z + (rnd() - 0.5) * spread,
          (rnd() - 0.5) * 1.2, 0.6 + rnd() * 0.9, (rnd() - 0.5) * 1.2, 0.5 + rnd() * 0.5, size * (0.7 + rnd() * 0.6), size * 0.15,
          g, g, g, -0.5, 1.5, 0, rnd() * 6, (rnd() - 0.5) * 2);
      }
    },
    sparkle(x, y, z, n = 6, r = 1, g = 0.95, b = 0.6, spread = 0.5) {
      for (let k = 0; k < n; k++) {
        emit('sparkle', x + (rnd() - 0.5) * spread, y + (rnd() - 0.5) * spread, z + (rnd() - 0.5) * spread,
          (rnd() - 0.5) * 1.5, 0.5 + rnd() * 1.5, (rnd() - 0.5) * 1.5, 0.4 + rnd() * 0.5, 0.28 + rnd() * 0.2, 0.05, r, g, b, 1.5, 1.0);
      }
    },
    flames(x, y, z, n = 2, spread = 0.35) {
      for (let k = 0; k < n; k++) {
        emit('flame', x + (rnd() - 0.5) * spread, y + rnd() * 0.3, z + (rnd() - 0.5) * spread,
          (rnd() - 0.5) * 0.3, 0.8 + rnd() * 0.8, (rnd() - 0.5) * 0.3, 0.35 + rnd() * 0.3, 0.3 + rnd() * 0.15, 0.05, 1, 0.9, 0.7, -0.5, 1);
      }
    },
    swirl(x, y, z, n = 6, spread = 0.5) {
      for (let k = 0; k < n; k++) {
        emit('wind', x + (rnd() - 0.5) * spread, y + (rnd() - 0.5) * spread, z + (rnd() - 0.5) * spread,
          (rnd() - 0.5) * 2, 0.4 + rnd() * 1.2, (rnd() - 0.5) * 2, 0.4 + rnd() * 0.4, 0.3 + rnd() * 0.3, 0.7, 0.75, 0.95, 1,
          0, 2, 0, rnd() * 6, 6 + rnd() * 6);
      }
    },
    confettiPop(x, y, z) {
      const cols = [[1, 0.35, 0.45], [1, 0.85, 0.3], [0.45, 0.85, 1], [0.6, 1, 0.45], [0.85, 0.55, 1]];
      for (let k = 0; k < 46; k++) {
        const c = cols[k % cols.length], a = rnd() * Math.PI * 2, s = 2 + rnd() * 4;
        emit('confetti', x, y, z, Math.cos(a) * s, 3 + rnd() * 5, Math.sin(a) * s, 1.4 + rnd() * 0.8, 0.22, 0.12,
          c[0], c[1], c[2], 7, 1.6, F_FLOOR, rnd() * 6, (rnd() - 0.5) * 14);
      }
      for (let k = 0; k < 14; k++) {
        const a = rnd() * Math.PI * 2, s = 1.5 + rnd() * 3;
        emit(k % 2 ? 'flower' : 'flower2', x, y, z, Math.cos(a) * s, 3 + rnd() * 3, Math.sin(a) * s, 2.2 + rnd() * 0.6, 0.55, 0.3,
          1, 1, 1, 8, 1.2, F_FLOOR, 0, (rnd() - 0.5) * 4);
      }
      fx.smoke(x, y, z, 8, 0.8, 0.8);
    },
    ring(name, x, y, z, radius, n, speed, size, r = 1, g = 1, b = 1, life = 0.6) {
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const cx = Math.cos(a), sz = Math.sin(a);
        emit(name, x + cx * radius, y, z + sz * radius, cx * speed, 0.3, sz * speed, life, size, size * 0.3, r, g, b, 0, 1.5);
      }
    },
    dizzy(n = 3) {
      for (let k = 0; k < n; k++) emit('star', 0, 0, 0, 0, 0, 0, 0.85, 0.3, 0.22, 1, 1, 1, 0, 0, F_ORBIT, (k / n) * Math.PI * 2, 7);
    },
    xpOrbs(x, y, z, n = 3) {
      for (let k = 0; k < n; k++) {
        const a = rnd() * Math.PI * 2;
        const idx = emit('xp', x, y, z, Math.cos(a) * 2, 3 + rnd() * 2, Math.sin(a) * 2, 4, 0.34, 0.3, 1, 1, 1, 0, 0, F_HOME);
        if (idx >= 0) {
          pools.xp.life[idx] = pools.xp.maxLife[idx] + xpStaggerT;
          xpStaggerT += 0.075;
        }
      }
    },
    collectAllXp() {
      const P = pools.xp;
      if (!P || P.n <= 0) return 0;
      const count = P.n;
      P.n = 0;
      P.mesh.count = 0;
      P.mesh.instanceMatrix.needsUpdate = true;
      xpStaggerT = 0;
      if (onCollect) {
        const playFirst = xpCollectCd <= 0;
        if (playFirst) xpCollectCd = 0.055;
        for (let k = 0; k < count; k++) onCollect(!(playFirst && k === 0));
      }
      return count;
    },
    firework(x, y, z, r, g, b) {
      for (let k = 0; k < 44; k++) {
        const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u), sp = 4 + rnd() * 2.5;
        emit('sparkle', x, y, z, Math.cos(a) * s * sp, u * sp, Math.sin(a) * s * sp, 1.1 + rnd() * 0.5, 0.42, 0.1, r, g, b, 2.5, 1.2);
      }
      for (let k = 0; k < 10; k++) {
        const a = rnd() * Math.PI * 2, sp = 2 + rnd() * 2;
        emit('heart', x, y, z, Math.cos(a) * sp, rnd() * 2, Math.sin(a) * sp, 1.4, 0.4, 0.1, 1, 1, 1, 3, 1);
      }
    },
    meterBegin, meterAdd, meterEnd, slamMarker,
    update(dt) {
      xpStaggerT = Math.max(0, xpStaggerT - dt);
      xpCollectCd = Math.max(0, xpCollectCd - dt);
      const h = G.hero;
      const hx = h ? h.x : 0, hz = h ? h.z : 0, hy = h ? G.floorY() + h.y : 0;
      for (const k in pools) updatePool(pools[k], dt, hx, hy, hz);
    },
    clear() {
      for (const k in pools) { pools[k].n = 0; pools[k].mesh.count = 0; }
      xpStaggerT = 0; xpCollectCd = 0;
      meter.count = 0; slamMesh.visible = false;
    },
    count() { let n = 0; for (const k in pools) n += pools[k].n; return n; },
    dispose() { for (const k in pools) pools[k].mesh.dispose(); meter.dispose(); for (const o of owned) o.dispose(); },
  };
  return fx;
}
