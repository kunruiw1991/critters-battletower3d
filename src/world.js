// World builder: every floor of the Battle Tower (InstancedMesh per block material per floor),
// the exterior shell + hill + clouds for the title/roof, and the per-floor collision grids.
// Everything is built ONCE at boot and only toggled visible, so GPU memory is stable across
// floor transitions and replays.
import { FLOOR_H, ROOM, WALL_H, NUM_FLOORS, ROOF, FLOORS, floorLayout } from './config.js';
import { makeRng } from './util.js';

const TITLE_PEEKERS = [ // open south windows on the exterior with friendly mobs peeking out
  { floor: 1, x: 3, kind: 'zombie' }, { floor: 2, x: 9, kind: 'creeper' },
  { floor: 3, x: 3, kind: 'skeleton' }, { floor: 4, x: 9, kind: 'breeze' },
];

export function createWorld(G) {
  const { THREE, scene, tex, kit } = G;
  const BT = tex.blocks;
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const crossGeo = makeCrossGeometry(THREE);
  const owned = [boxGeo, crossGeo];       // geometries/materials/textures we must dispose
  const mats = new Map();
  const m4 = new THREE.Matrix4();

  // ---------- materials (shared per block key) ----------
  const texFor = (k) => BT[k] || BT.cobble || BT.mossyCobble;
  function material(key) {
    if (mats.has(key)) return mats.get(key);
    let m;
    if (key === 'grass') {
      const side = new THREE.MeshLambertMaterial({ map: texFor('grassSide') });
      m = [side, side, new THREE.MeshLambertMaterial({ map: texFor('grassTop') }),
        new THREE.MeshLambertMaterial({ map: texFor('dirt') }), side, side];
      owned.push(...new Set(m));
    } else if (key.startsWith('window')) {
      m = new THREE.MeshLambertMaterial({ map: texFor(key), emissive: 0xffffff, emissiveMap: texFor(key),
        emissiveIntensity: key === 'windowSky' ? 0.8 : 1.0 });
      owned.push(m);
    } else if (key === 'cobweb' || key === 'flowerRed' || key === 'flowerYellow') {
      m = new THREE.MeshLambertMaterial({ map: texFor(key), alphaTest: 0.5, side: THREE.DoubleSide });
      owned.push(m);
    } else {
      m = new THREE.MeshLambertMaterial({ map: texFor(key) });
      owned.push(m);
    }
    mats.set(key, m);
    return m;
  }

  // ---------- instanced block collector ----------
  function collector() {
    const map = new Map();
    return {
      add(key, x, y, z, sx = 1, sy = 1, sz = 1) {
        let a = map.get(key);
        if (!a) map.set(key, a = []);
        a.push(x, y, z, sx, sy, sz);
      },
      build(group, geo = boxGeo, opts = {}) {
        for (const [key, arr] of map) {
          const n = arr.length / 6;
          const mesh = new THREE.InstancedMesh(geo, material(key), n);
          for (let k = 0; k < n; k++) {
            m4.makeScale(arr[6 * k + 3], arr[6 * k + 4], arr[6 * k + 5]);
            m4.setPosition(arr[6 * k] + 0.5, arr[6 * k + 1] + 0.5, arr[6 * k + 2] + 0.5);
            mesh.setMatrixAt(k, m4);
          }
          mesh.instanceMatrix.needsUpdate = true;
          mesh.computeBoundingSphere();
          mesh.castShadow = opts.cast !== false;
          mesh.receiveShadow = true;
          mesh.name = key;
          group.add(mesh);
        }
      },
    };
  }

  // wall block mix: mostly mossy cobblestone (with variants when the texture set has them) + plain cobble
  const MOSSY = ['mossyCobble', BT.mossyCobble2 ? 'mossyCobble2' : 'mossyCobble', BT.mossyCobble3 ? 'mossyCobble3' : 'mossyCobble'];
  const wallKey = (rng) => { const r = rng(); return r < 0.72 ? MOSSY[Math.floor(r / 0.24)] : 'cobble'; };
  const isWinRow = (r) => r === 2 || r === 3;
  // 2-tall windows: bottom/top variants when available
  const winFor = (base, r) => {
    if (base === 'windowSunset' && BT.windowSunsetTop && BT.windowSunsetBottom) return r === 3 ? 'windowSunsetTop' : 'windowSunsetBottom';
    return base;
  };
  const NWIN = [3, 9];   // north/south window columns (x)
  const SWIN = [4, 9];   // side window rows (z)

  // ---------- one floor ----------
  function buildFloor(i) {
    const L = floorLayout(i), def = FLOORS[i], base = i * FLOOR_H;
    const g = new THREE.Group(); g.name = 'floor' + i; g.visible = false; scene.add(g);
    const rng = makeRng(1000 + i * 77);
    const col = collector(), deco = collector();
    const solid = new Uint8Array(ROOM * ROOM), slow = new Uint8Array(ROOM * ROOM), blockH = new Float32Array(ROOM * ROOM);
    const cell = (x, z) => z * ROOM + x;

    // grass patches (Creeper Garden): random-walk blobs on the slab
    const grass = new Set();
    if (def.grass) {
      for (let p = 0; p < 4; p++) {
        let x = 1 + Math.floor(rng() * 11), z = 1 + Math.floor(rng() * 11);
        for (let s = 0; s < 14; s++) {
          grass.add(x + ',' + z);
          x = Math.max(0, Math.min(12, x + Math.floor(rng() * 3) - 1));
          z = Math.max(0, Math.min(12, z + Math.floor(rng() * 3) - 1));
        }
      }
    }
    // slab (this floor's ground): 15x15 incl. the wall ring, minus the arrival hole
    const slabKey = i === ROOF ? 'stoneBricks' : 'smoothStone';
    for (let x = -1; x <= ROOM; x++) {
      for (let z = -1; z <= ROOM; z++) {
        if (L.hole && x === L.hole.x && z === L.hole.z) continue;
        col.add(grass.has(x + ',' + z) ? 'grass' : slabKey, x, base - 1, z);
      }
    }
    if (i !== ROOF) {
      const winKey = def.skyWindows ? 'windowSky' : 'windowSunset';
      for (let y = base; y < base + WALL_H; y++) {
        const r = y - base;
        for (let x = -1; x <= ROOM; x++) {
          // north wall (backdrop with recessed windows + cobblestone top lintel); corners are plain cobble pillars
          if (isWinRow(r) && (NWIN.includes(x) || (def.skyWindows && (x === 4 || x === 8)))) {
            if (r === 2) col.add(winFor(winKey, r), x, y, -1, 1, 1, 0.38);
            else {
              col.add(winFor(winKey, r), x, y - 0.11, -1, 1, 0.78, 0.38);
              col.add(wallKey(rng), x, y + 0.39, -1, 1, 0.22, 1);
            }
          } else col.add(x === -1 || x === ROOM ? 'cobble' : wallKey(rng), x, y, -1);
          // south wall: cut down to a 1-block rim so the camera sees in (door gap on floor 1)
          if (r === 0 && !(i === 0 && x === 6)) col.add(x === -1 || x === ROOM ? 'cobble' : wallKey(rng), x, y, ROOM);
        }
        for (let z = 0; z < ROOM; z++) {
          const win = isWinRow(r) && SWIN.includes(z);
          if (win) {
            if (r === 2) {
              col.add(winFor(winKey, r), -1, y, z, 0.38, 1, 1);
              col.add(winFor(winKey, r), ROOM, y, z, 0.38, 1, 1);
            } else {
              col.add(winFor(winKey, r), -1, y - 0.11, z, 0.38, 0.78, 1);
              col.add(wallKey(rng), -1, y + 0.39, z, 1, 0.22, 1);
              col.add(winFor(winKey, r), ROOM, y - 0.11, z, 0.38, 0.78, 1);
              col.add(wallKey(rng), ROOM, y + 0.39, z, 1, 0.22, 1);
            }
          } else {
            col.add(wallKey(rng), -1, y, z);
            col.add(wallKey(rng), ROOM, y, z);
          }
        }
      }
    } else {
      // roof parapet: 1-block ring + alternating merlons (crenellations)
      for (let x = -1; x <= ROOM; x++) {
        for (let z = -1; z <= ROOM; z++) {
          if (x !== -1 && x !== ROOM && z !== -1 && z !== ROOM) continue;
          col.add('mossyCobble', x, base, z);
          if ((x + z) % 2 === 0) col.add(BT.crenel ? 'crenel' : 'stoneBricks', x, base + 1, z);
        }
      }
    }
    // pillars (Skeleton Gallery): 3 blocks tall arrow cover, short enough not to hide the hero
    for (const p of L.pillars) {
      for (let y = 0; y < 3; y++) col.add(y === 2 ? 'mossyCobble' : 'cobble', p.x, base + y, p.z);
      solid[cell(p.x, p.z)] = 1; blockH[cell(p.x, p.z)] = 3;
    }
    // chests on smooth-stone blocks
    const chests = [];
    L.chests.forEach((c, k) => {
      col.add('smoothStone', c.x, base, c.z);
      const ch = kit.makeChest();
      ch.group.position.set(c.x + 0.5, base + 1, c.z + 0.5);
      ch.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      g.add(ch.group);
      solid[cell(c.x, c.z)] = 1; blockH[cell(c.x, c.z)] = 1.9;
      chests.push({ floor: i, x: c.x + 0.5, z: c.z + 0.5, cx: c.x, cz: c.z, group: ch.group, lid: ch.lid, openAngle: ch.openAngle,
        loot: (def.loot[k] || def.loot[0]).slice(), opened: false, openT: 0 });
    });
    // spawners (solid cell, cage block)
    const spawners = L.spawners.map((s) => {
      const sp = kit.makeSpawner();
      sp.group.position.set(s.x + 0.5, base, s.z + 0.5);
      sp.setMob(def.start[0]);
      g.add(sp.group);
      solid[cell(s.x, s.z)] = 1; blockH[cell(s.x, s.z)] = 1.0;
      return { x: s.x + 0.5, z: s.z + 0.5, cx: s.x, cz: s.z, obj: sp };
    });
    // arrival hole (walk-blocking, the ladder top from below pokes through it)
    if (L.hole) solid[cell(L.hole.x, L.hole.z)] = 1;
    // ladder on the north wall
    let ladder = null;
    if (L.ladder) {
      const lad = kit.makeLadder(FLOOR_H);
      lad.position.set(L.ladder.x + 0.5, base, 0.02);
      g.add(lad);
      ladder = { x: L.ladder.x + 0.5, z: 0.62, cx: L.ladder.x, obj: lad };
    }
    // torches (models only; the 3 global torch lights are moved here when this floor is shown).
    // makeTorch({wall:true}) = pre-tilted toward +z with its origin on the wall surface; we yaw it per wall.
    const torchLights = [], torchObjs = [];
    for (const t of L.torches) {
      const tt = kit.makeTorch({ wall: true });
      if (tt.light && tt.light.parent) tt.light.parent.remove(tt.light);   // keep a fixed light count
      const grp = tt.group;
      const wx = t.wall === 'E' ? ROOM : t.wall === 'W' ? 0 : t.x, wz = t.wall === 'N' ? 0 : t.z;
      grp.position.set(wx, base + 2.85, wz);
      grp.rotation.y = t.wall === 'E' ? -Math.PI / 2 : t.wall === 'W' ? Math.PI / 2 : 0;
      g.add(grp);
      torchObjs.push(tt);
      const ox = t.wall === 'E' ? -0.5 : t.wall === 'W' ? 0.5 : 0;
      const oz = t.wall === 'N' ? 0.5 : 0;
      torchLights.push({ x: wx + ox, y: base + 3.3, z: wz + oz });
    }
    // arrival hole: a dark shaft below the opening + the top of the ladder we climbed up
    if (L.hole) {
      const shaft = new THREE.Mesh(shaftGeo, shaftMat);
      shaft.position.set(L.hole.x + 0.5, base - 1.6, L.hole.z + 0.5);
      g.add(shaft);
      const stub = kit.makeLadder(1);
      stub.position.set(L.hole.x + 0.5, base - 0.75, 0.02);
      g.add(stub);
    }
    // cobwebs (Spider Den): slow the hero to 40%
    for (const c of L.cobwebs) { deco.add('cobweb', c.x, base, c.z); slow[cell(c.x, c.z)] = 1; }
    // flowers on grass patches (walkable decor)
    if (def.grass) {
      for (const k of grass) {
        const [x, z] = k.split(',').map(Number);
        if (solid[cell(x, z)] || rng() > 0.45) continue;
        deco.add(rng() < 0.6 ? 'flowerRed' : 'flowerYellow', x, base, z);
      }
    }
    // roof flag on the NE merlon
    if (i === ROOF) g.add(makeFlag(base));
    col.build(g);
    deco.build(g, crossGeo, { cast: false });
    return { index: i, base, group: g, layout: L, def, solid, slow, blockH, spawners, chests, ladder,
      entry: L.entry, torchLights, torchObjs };
  }
  const shaftGeo = new THREE.BoxGeometry(0.98, 1.2, 0.98);
  const shaftMat = new THREE.MeshBasicMaterial({ color: 0x07060a });
  owned.push(shaftGeo, shaftMat);

  let flagMesh = null;
  function makeFlag(base) {
    const grp = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.12, 4.2, 0.12), new THREE.MeshLambertMaterial({ map: texFor('planks') }));
    pole.position.set(ROOM + 0.5, base + 2 + 2.1, -0.5);
    pole.castShadow = true;
    const c = document.createElement('canvas'); c.width = 16; c.height = 10;
    const x = c.getContext('2d');
    x.fillStyle = '#c8283a'; x.fillRect(0, 0, 16, 10);
    x.fillStyle = '#9a1a2a'; x.fillRect(0, 9, 16, 1); x.fillRect(15, 0, 1, 10);
    x.fillStyle = '#ffd0da';
    for (const [px, py] of [[5, 2], [6, 2], [9, 2], [10, 2], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3], [9, 3], [10, 3], [11, 3],
      [5, 4], [6, 4], [7, 4], [8, 4], [9, 4], [10, 4], [6, 5], [7, 5], [8, 5], [9, 5], [7, 6], [8, 6]]) x.fillRect(px, py, 1, 1);
    const ft = new THREE.CanvasTexture(c);
    ft.magFilter = THREE.NearestFilter; ft.minFilter = THREE.NearestFilter; ft.colorSpace = THREE.SRGBColorSpace;
    const flag = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 0.06), new THREE.MeshLambertMaterial({ map: ft }));
    flag.position.set(ROOM + 0.5 - 0.86, base + 5.6, -0.5);
    flag.castShadow = true;
    grp.add(pole, flag);
    owned.push(pole.geometry, pole.material, flag.geometry, flag.material, ft);
    flagMesh = flag;
    return grp;
  }

  // ---------- exterior shell (sliced per storey so lower tower shaft shows beneath Floors 2-7) ----------
  const extFloors = [];
  let hillGround = null;
  function buildExterior() {
    const g = new THREE.Group(); g.name = 'exterior'; g.visible = false; scene.add(g);
    const rng = makeRng(4242);
    const open = new Set(TITLE_PEEKERS.map((p) => p.floor + ':' + p.x));
    const innerGeo = new THREE.BoxGeometry(ROOM - 0.04, FLOOR_H - 0.98, ROOM - 0.04);
    const innerMat = new THREE.MeshBasicMaterial({ color: 0x0d0a12 });
    owned.push(innerGeo, innerMat);
    for (let f = 0; f < ROOF; f++) {
      const fg = new THREE.Group(); fg.name = 'extFloor' + f; g.add(fg);
      const bg = new THREE.Group(); bg.name = 'extBand' + f; fg.add(bg);
      const col = collector(), bandCol = collector();
      const base = f * FLOOR_H;
      for (let r = 0; r < FLOOR_H; r++) {
        const y = base + r;
        const band = r === FLOOR_H - 1;   // floor line between storeys
        const target = band ? bandCol : col;
        const key = () => (band ? 'stoneBricks' : wallKey(rng));
        for (let x = -1; x <= ROOM; x++) {
          const corner = x === -1 || x === ROOM;
          // north face
          if (!corner && isWinRow(r) && NWIN.includes(x)) target.add(winFor('windowSunset', r), x, y, -1, 1, 1, 0.38);
          else target.add(corner && !band ? 'cobble' : key(), x, y, -1);
          // south face (door + windows + open peek windows)
          if (f === 0 && x === 6 && r < 2) continue;
          if (!corner && NWIN.includes(x) && open.has(f + ':' + x) && r >= 1 && r <= 3) continue;
          if (!corner && isWinRow(r) && NWIN.includes(x)) target.add(winFor('windowSunset', r), x, y, ROOM, 1, 1, 0.38);
          else target.add(corner && !band ? 'cobble' : key(), x, y, ROOM);
        }
        for (let z = 0; z < ROOM; z++) {
          const win = isWinRow(r) && SWIN.includes(z);
          target.add(win ? winFor('windowSunset', r) : key(), -1, y, z, win ? 0.38 : 1, 1, 1);
          target.add(win ? winFor('windowSunset', r) : key(), ROOM, y, z, win ? 0.38 : 1, 1, 1);
        }
      }
      col.build(fg);
      bandCol.build(bg);
      const inner = new THREE.Mesh(innerGeo, innerMat);
      inner.position.set(ROOM / 2, base + (FLOOR_H - 1) / 2, ROOM / 2);
      fg.add(inner);
      extFloors.push({ group: fg, band: bg });
    }
    return g;
  }

  // ---------- grassy hill + far ground ----------
  function buildHill() {
    const g = new THREE.Group(); g.name = 'hill'; scene.add(g);
    const rng = makeRng(777);
    const col = collector(), deco = collector();
    for (let i = -27; i <= 39; i++) {
      for (let j = -27; j <= 39; j++) {
        if (i >= -1 && i <= ROOM && j >= -1 && j <= ROOM) continue;
        const d = Math.hypot(i + 0.5 - 6.5, j + 0.5 - 6.5);
        const h = d < 12.5 ? 0 : d < 16.5 ? -1 : d < 20.5 ? -2 : d < 25 ? -3 : null;
        if (h === null) continue;
        const path = i === 6 && j > ROOM && j < 22;
        col.add(path ? 'cobble' : 'grass', i, h - 1, j);
        if (!path && rng() < 0.05) deco.add(rng() < 0.5 ? 'flowerRed' : 'flowerYellow', i, h, j);
      }
    }
    col.build(g);
    deco.build(g, crossGeo, { cast: false });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshLambertMaterial({ color: 0x4a7a30 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(6.5, -3.02, 6.5);
    ground.receiveShadow = true;
    g.add(ground);
    hillGround = ground;
    owned.push(ground.geometry, ground.material);
    return g;
  }

  // ---------- pixel clouds + sun ----------
  const cloudData = [];
  function buildClouds() {
    const rng = makeRng(99);
    const per = 5;
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffb89a, emissiveIntensity: 0.42, fog: false });
    // 10 high/far cloud clusters (for title view) + 18 mid-altitude sunset cloud clusters visible in upper-floor / Roof / Finale frustum
    const totalClusters = 28;
    const mesh = new THREE.InstancedMesh(boxGeo, mat, totalClusters * per);
    mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
    for (let c = 0; c < 10; c++) {
      const cx = -70 + rng() * 150, cy = 42 + rng() * 16, cz = -65 - rng() * 55;
      for (let k = 0; k < per; k++) {
        cloudData.push({ x: cx + (rng() - 0.5) * 12, y: cy + (rng() - 0.5) * 1.5, z: cz + (rng() - 0.5) * 8,
          sx: 6 + rng() * 8, sy: 1.5 + rng() * 0.8, sz: 4 + rng() * 6, wrap: 90, span: 170 });
      }
    }
    const roofClusters = [
      [-14, 31, -16], [-3, 33, -20], [8, 32, -18], [19, 30, -16], [28, 28, -22],
      [-22, 26, -12], [-12, 24, -26], [3, 27, -28], [15, 25, -25], [26, 24, -14],
      [-18, 29, -4], [24, 29, -3], [-20, 22, 6], [26, 22, 5],
      [-8, 35, -14], [12, 36, -13], [2, 38, -22], [22, 34, -11],
    ];
    for (let c = 0; c < roofClusters.length; c++) {
      const [cx, cy, cz] = roofClusters[c];
      for (let k = 0; k < per; k++) {
        cloudData.push({ x: cx + (rng() - 0.5) * 5.5, y: cy + (rng() - 0.5) * 1.1, z: cz + (rng() - 0.5) * 3.5,
          sx: 3.4 + rng() * 4.2, sy: 1.0 + rng() * 0.55, sz: 2.4 + rng() * 3.0, wrap: 42, span: 76 });
      }
    }
    owned.push(mat);
    mesh.visible = false;
    scene.add(mesh);
    clouds = mesh;
    updateClouds(0);
    return mesh;
  }
  function updateClouds(dt) {
    for (let k = 0; k < cloudData.length; k++) {
      const c = cloudData[k];
      c.x += dt * 0.45;
      if (c.x > c.wrap) c.x -= c.span;
      // Keep side-flank clouds outside the 15x15 tower column so they never pass through indoor rooms
      if (c.z > -5.5 && c.x > -5.5 && c.x < 18.5) c.x = 18.6;
      m4.makeScale(c.sx, c.sy, c.sz); m4.setPosition(c.x, c.y, c.z);
      clouds.setMatrixAt(k, m4);
    }
    if (clouds) clouds.instanceMatrix.needsUpdate = true;
  }
  function buildSun() {
    const c = document.createElement('canvas'); c.width = 16; c.height = 16;
    const x = c.getContext('2d');
    x.fillStyle = '#ff9a3a'; x.fillRect(0, 0, 16, 16);
    x.fillStyle = '#ffd25a'; x.fillRect(2, 2, 12, 12);
    x.fillStyle = '#fff2a0'; x.fillRect(4, 4, 8, 8);
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, fog: false, toneMapped: false }));
    sp.scale.set(26, 26, 1);
    sp.position.set(-95, 24, -150);
    sp.visible = false;
    scene.add(sp);
    owned.push(t, sp.material);
    return sp;
  }

  // ---------- title peekers (friend mobs with hearts in open windows) ----------
  function buildTitleMobs() {
    const g = new THREE.Group(); g.visible = false; scene.add(g);
    const list = TITLE_PEEKERS.map((p, k) => {
      const rig = kit.makeMob(p.kind);
      rig.setFriend(true);
      const holder = new THREE.Group();
      holder.add(rig.root);
      holder.position.set(p.x + 0.5, p.floor * FLOOR_H + 1 + (p.kind === 'breeze' ? 0.2 : 0), ROOM + 0.5);
      g.add(holder);
      return { rig, holder, st: { t: k * 0.7, speed: 0, windup: 0, fuse: 0, isFriend: true, happy: 0, airborne: false,
        climbing: false, throwing: 0, dizzy: false, onWall: false, kneel: 0 } };
    });
    return { group: g, list };
  }

  const floors = [];
  for (let i = 0; i < NUM_FLOORS; i++) floors.push(buildFloor(i));
  const exterior = buildExterior();
  const hill = buildHill();
  let clouds = null;
  clouds = buildClouds();
  const sun = buildSun();
  const titleMobs = buildTitleMobs();

  // ---------- view switching ----------
  let viewTitle = true;
  function setView(mode, a = -1, b = -1) {
    viewTitle = mode === 'title';
    for (let k = 0; k < floors.length; k++) {
      floors[k].group.visible = viewTitle ? k === ROOF : (k === a || k === b);
    }
    const topFloor = b >= 0 ? Math.min(a, b) : a;
    exterior.visible = viewTitle || topFloor > 0;
    for (let f = 0; f < extFloors.length; f++) {
      extFloors[f].group.visible = viewTitle || f < topFloor;
      extFloors[f].band.visible = viewTitle || (f + 1 !== a && f + 1 !== b);
    }
    titleMobs.group.visible = viewTitle;
    clouds.visible = viewTitle || a >= 3 || b >= 3;
    sun.visible = viewTitle;
    // Lower floors (1-4) show the voxel grass hill at the tower base; upper floors (5-7 & Finale) open onto the sunset sky & clouds
    hill.visible = viewTitle || (topFloor >= 0 && topFloor <= 3);
    if (hillGround) hillGround.visible = viewTitle || (topFloor >= 0 && topFloor <= 1);
  }

  function resetForRun() {
    for (const f of floors) {
      for (const c of f.chests) { c.opened = false; c.openT = 0; c.lid.rotation.x = 0; }
      for (const s of f.spawners) s.obj.setBloomed(false);
    }
  }

  let flagT = 0;
  function update(dt) {
    flagT += dt;
    if (clouds.visible) updateClouds(dt);
    for (let k = 0; k < floors.length; k++) {
      const f = floors[k];
      if (!f.group.visible) continue;
      for (const s of f.spawners) s.obj.update(dt);
      for (const t of f.torchObjs) if (t.update) t.update(dt);
    }
    if (flagMesh && floors[ROOF].group.visible) flagMesh.rotation.y = Math.sin(flagT * 2.2) * 0.12;
    if (titleMobs.group.visible) {
      for (const m of titleMobs.list) {
        m.st.t += dt; m.st.happy = Math.max(0, Math.sin(m.st.t * 1.3)) * 0.8;
        m.rig.animate(m.st, dt);
      }
    }
  }

  // ---------- collision queries (floor-local cell grid) ----------
  function cellIndex(x, z) {
    const cx = Math.floor(x), cz = Math.floor(z);
    if (cx < 0 || cz < 0 || cx >= ROOM || cz >= ROOM) return -1;
    return cz * ROOM + cx;
  }
  function solidCell(f, cx, cz) {
    if (cx < 0 || cz < 0 || cx >= ROOM || cz >= ROOM) return true;
    return floors[f].solid[cz * ROOM + cx] === 1;
  }
  function isSlow(f, x, z) { const c = cellIndex(x, z); return c >= 0 && floors[f].slow[c] === 1; }
  function blockHeight(f, x, z) { const c = cellIndex(x, z); return c < 0 ? 99 : floors[f].blockH[c]; }

  function dispose() {
    for (const f of floors) f.group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    exterior.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    hill.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    if (clouds) clouds.dispose();
    for (const o of owned) o.dispose && o.dispose();
    for (const m of titleMobs.list) m.rig.dispose();
  }

  return { floors, exterior, extFloors, hill, get hillGround() { return hillGround; }, clouds, sun, titleMobs, setView, resetForRun, update,
    solidCell, isSlow, blockHeight, dispose, get viewTitle() { return viewTitle; } };
}

// Two crossed vertical quads (Minecraft "cross" plants / cobwebs), 1x1 block, centred at origin.
function makeCrossGeometry(THREE) {
  const a = new THREE.PlaneGeometry(1, 1); a.rotateY(Math.PI / 4);
  const b = new THREE.PlaneGeometry(1, 1); b.rotateY(-Math.PI / 4);
  const g = new THREE.BufferGeometry();
  const cat = (name, n) => {
    const out = new Float32Array((a.attributes[name].count + b.attributes[name].count) * n);
    out.set(a.attributes[name].array, 0); out.set(b.attributes[name].array, a.attributes[name].array.length);
    return new THREE.BufferAttribute(out, n);
  };
  g.setAttribute('position', cat('position', 3));
  g.setAttribute('normal', cat('normal', 3));
  g.setAttribute('uv', cat('uv', 2));
  const ia = a.index.array, ib = b.index.array, off = a.attributes.position.count;
  const idx = new Uint16Array(ia.length + ib.length);
  idx.set(ia, 0);
  for (let k = 0; k < ib.length; k++) idx[ia.length + k] = ib[k] + off;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  // point normals up so the quads light like the floor (Minecraft-style flat foliage lighting)
  const nrm = g.attributes.normal.array;
  for (let k = 0; k < nrm.length; k += 3) { nrm[k] = 0; nrm[k + 1] = 1; nrm[k + 2] = 0; }
  a.dispose(); b.dispose();
  g.computeBoundingSphere();
  return g;
}
