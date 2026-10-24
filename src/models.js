// src/models.js — Critter Battle Tower 3D: voxel models + procedural animation.
// Owner: Voxel Art builder. Interface (spec section 9):
//   export function createModelKit(THREE, textures) -> { makeHero, makeMob, makeHeart3D, makeChest, makeSpawner,
//                                                        makeLadder, makeItem, makeTorch, makeArrow, makeWindCharge, ...extras }
// Rigs are ONE SkinnedMesh each (boxes with per-face UV-mapped Minecraft-style skins, bound rigidly to bones whose
// origins sit at real joints) => 1 draw call (+1 shadow) per mob. Geometry/textures are shared per kind; each rig owns
// only its material (for tint/flash), its skeleton (bone texture) and a few tiny Object3Ds.
// Units: 1 = 1 block. Rig origin at the feet, facing +z. parts.* are THREE.Bone (Object3D) at joints.
// Skins, items and block textures come from the `textures` object produced by src/textures.js createTextures().

const TAU = Math.PI * 2;
const FACE_ORDER = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- rig definitions (Minecraft pixels)
// bones: [name, parent, pivot[x,y,z] absolute px, restEuler?]; boxes: [bone, skinRect, from[x,y,z] px, inflatePx?]
const HUMAN_BONES = (armX, armW) => [
  ['base', null, [0, 0, 0]], ['body', 'base', [0, 12, 0]], ['head', 'body', [0, 24, 0]],
  ['armR', 'body', [-armX, 22, 0]], ['armL', 'body', [armX, 22, 0]],
  ['legR', 'base', [-2, 12, 0]], ['legL', 'base', [2, 12, 0]],
];
const SPIDER_LEG_Z = [2, 0.7, -0.7, -2], SPIDER_FAN = [0.72, 0.27, -0.27, -0.72], SPIDER_TILT = 0.6;
function spiderDef(scale, skin, height, radius) {
  const bones = [['base', null, [0, 0, 0]], ['body', 'base', [0, 9, 0]], ['head', 'body', [0, 9, 3]], ['abdomen', 'body', [0, 9, -3]]];
  const boxes = [['body', 'neck', [-3, 6, -3]], ['head', 'head', [-4, 5, 3]], ['abdomen', 'abdomen', [-5, 6, -15]]];
  for (let i = 0; i < 4; i++) {
    const z = SPIDER_LEG_Z[i];
    bones.push(['legL' + i, 'body', [3, 9, z], [0, -SPIDER_FAN[i], -SPIDER_TILT]]);
    boxes.push(['legL' + i, 'leg', [3, 8, z - 1]]);
  }
  for (let i = 0; i < 4; i++) {
    const z = SPIDER_LEG_Z[i];
    bones.push(['legR' + i, 'body', [-3, 9, z], [0, SPIDER_FAN[i], SPIDER_TILT]]);
    boxes.push(['legR' + i, 'leg', [-19, 8, z - 1]]);
  }
  return { family: 'spider', skin, scale, height, radius, bones, boxes, stride: 1.1 };
}
const DEFS = {
  hero: {
    family: 'human', skin: 'hero', scale: 0.9 / 16, height: 1.85, radius: 0.35, stride: 1.9, ampSpeed: 2.6,
    bones: HUMAN_BONES(5.5),
    boxes: [['head', 'head', [-4, 24, -4]], ['head', 'hair', [-4, 24, -4], 0.5], ['head', 'hairTail', [-4, 16, -5]],
      ['body', 'body', [-4, 12, -2]], ['armR', 'armR', [-7, 12, -2]], ['armL', 'armL', [4, 12, -2]],
      ['legR', 'legR', [-4, 0, -2]], ['legL', 'legL', [0, 0, -2]]],
  },
  zombie: {
    family: 'human', skin: 'zombie', scale: 0.92 / 16, height: 1.85, radius: 0.4, stride: 1.5, ampSpeed: 1.1,
    bones: HUMAN_BONES(6),
    boxes: [['head', 'head', [-4, 24, -4]], ['body', 'body', [-4, 12, -2]], ['armR', 'armR', [-8, 12, -2]], ['armL', 'armL', [4, 12, -2]],
      ['legR', 'legR', [-4, 0, -2]], ['legL', 'legL', [0, 0, -2]]],
  },
  skeleton: {
    family: 'human', skin: 'skeleton', scale: 0.92 / 16, height: 1.85, radius: 0.35, stride: 1.6, ampSpeed: 1.4,
    bones: [['base', null, [0, 0, 0]], ['body', 'base', [0, 12, 0]], ['head', 'body', [0, 24, 0]], ['armR', 'body', [-5, 22, 0]], ['armL', 'body', [5, 22, 0]], ['legR', 'base', [-2, 12, 0]], ['legL', 'base', [2, 12, 0]]],
    boxes: [['head', 'head', [-4, 24, -4]], ['body', 'body', [-4, 12, -2]], ['armR', 'armR', [-6, 12, -1]], ['armL', 'armL', [4, 12, -1]],
      ['legR', 'legR', [-3, 0, -1]], ['legL', 'legL', [1, 0, -1]]],
  },
  creeper: {
    family: 'creeper', skin: 'creeper', scale: 1 / 16, height: 1.65, radius: 0.32, stride: 1.2, ampSpeed: 1.3,
    bones: [['base', null, [0, 0, 0]], ['body', 'base', [0, 6, 0]], ['head', 'body', [0, 18, 0]],
      ['legFR', 'base', [-2, 6, 4]], ['legFL', 'base', [2, 6, 4]], ['legBR', 'base', [-2, 6, -4]], ['legBL', 'base', [2, 6, -4]]],
    boxes: [['body', 'body', [-4, 6, -2]], ['head', 'head', [-4, 18, -4]], ['legFR', 'leg', [-4, 0, 2]], ['legFL', 'leg', [0, 0, 2]], ['legBR', 'leg', [-4, 0, -6]], ['legBL', 'leg', [0, 0, -6]]],
  },
  spider: spiderDef(1 / 16, 'spider', 0.9, 0.75),
  caveSpider: spiderDef(0.7 / 16, 'caveSpider', 0.63, 0.52),
  redSpider: spiderDef(1 / 16, 'redSpider', 0.9, 0.75),
  breeze: {
    family: 'breeze', skin: 'breeze', scale: 1.1 / 16, height: 1.8, radius: 0.38,
    bones: [['base', null, [0, 0, 0]], ['body', 'base', [0, 12, 0]], ['head', 'body', [0, 18, 0]], ['rods', 'body', [0, 18, 0]]],
    boxes: [['head', 'head', [-4, 18, -4]], ...[0, 1, 2].map((k) => ['rods', 'rod', [6.5 * Math.cos(k * TAU / 3) - 1, 12, 6.5 * Math.sin(k * TAU / 3) - 1]])],
  },
  golem: {
    family: 'golem', skin: 'golem', scale: 3.2 / 41, height: 3.2, radius: 0.95, stride: 2.4, ampSpeed: 0.9,
    bones: [['base', null, [0, 0, 0]], ['body', 'base', [0, 16, 0]], ['head', 'body', [0, 31, 0]], ['armR', 'body', [-11, 31, 0]], ['armL', 'body', [11, 31, 0]],
      ['legR', 'base', [-4, 16, 0]], ['kneeR', 'legR', [-4, 8, 0]], ['legL', 'base', [4, 16, 0]], ['kneeL', 'legL', [4, 8, 0]]],
    boxes: [['body', 'waist', [-4.5, 16, -3]], ['body', 'chest', [-9, 21, -5.5]], ['head', 'head', [-4, 31, -1.5]], ['head', 'nose', [-1, 32, 6.5]],
      ['armR', 'armR', [-13, 3, -3]], ['armL', 'armL', [9, 3, -3]], ['legR', 'thighR', [-7, 8, -2.5]], ['kneeR', 'shinR', [-7, 0, -2.5]],
      ['legL', 'thighL', [1, 8, -2.5]], ['kneeL', 'shinL', [1, 0, -2.5]]],
  },
};
DEFS.stray = Object.assign({}, DEFS.skeleton, {
  skin: 'stray', stride: 1.5, ampSpeed: 1.2,
  boxes: DEFS.skeleton.boxes.concat([['head', 'hood', [-4, 24, -4], 0.5], ['body', 'cloak', [-4, 12, -2], 0.45],
    ['armR', 'armRRag', [-6, 12, -1], 0.35], ['armL', 'armLRag', [4, 12, -1], 0.35], ['legR', 'legRRag', [-3, 0, -1], 0.35], ['legL', 'legLRag', [1, 0, -1], 0.35]]),
});
export const MOB_KINDS = ['zombie', 'skeleton', 'spider', 'caveSpider', 'stray', 'creeper', 'breeze', 'golem'];

// ---------------------------------------------------------------- geometry accumulator
function makeAcc(THREE, o = {}) {
  const A = { pos: [], nor: [], uv: o.uv ? [] : null, col: o.color ? [] : null, si: o.skin ? [] : null, sw: o.skin ? [] : null, idx: [], vc: 0 };
  const v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
  A.quad = (a, b, c, d, nrm, uvq, color, bone, mat) => {
    const base = A.vc;
    if (mat) nm.getNormalMatrix(mat);
    for (const p of [a, b, c, d]) {
      v.set(p[0], p[1], p[2]); if (mat) v.applyMatrix4(mat);
      n.set(nrm[0], nrm[1], nrm[2]); if (mat) n.applyMatrix3(nm).normalize();
      A.pos.push(v.x, v.y, v.z); A.nor.push(n.x, n.y, n.z);
    }
    if (A.uv) { const [u0, v0, u1, v1] = uvq; A.uv.push(u0, v0, u1, v0, u0, v1, u1, v1); }
    if (A.col) for (let k = 0; k < 4; k++) A.col.push(color[0], color[1], color[2]);
    if (A.si) for (let k = 0; k < 4; k++) { A.si.push(bone, 0, 0, 0); A.sw.push(1, 0, 0, 0); }
    A.idx.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
    A.vc += 4;
  };
  // Axis-aligned box; faceUV: {face: [u0,vTop,u1,vBot]}; color: [r,g,b] or (face)=>[r,g,b]; skip: {face:true}
  A.box = (x0, y0, z0, x1, y1, z1, faceUV, color, bone, mat, skip) => {
    const C = {
      pz: [[x0, y1, z1], [x1, y1, z1], [x0, y0, z1], [x1, y0, z1], [0, 0, 1]], nz: [[x1, y1, z0], [x0, y1, z0], [x1, y0, z0], [x0, y0, z0], [0, 0, -1]],
      px: [[x1, y1, z1], [x1, y1, z0], [x1, y0, z1], [x1, y0, z0], [1, 0, 0]], nx: [[x0, y1, z0], [x0, y1, z1], [x0, y0, z0], [x0, y0, z1], [-1, 0, 0]],
      py: [[x0, y1, z0], [x1, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0]], ny: [[x0, y0, z1], [x1, y0, z1], [x0, y0, z0], [x1, y0, z0], [0, -1, 0]],
    };
    for (const f of FACE_ORDER) {
      if (skip && skip[f]) continue;
      const q = C[f];
      A.quad(q[0], q[1], q[2], q[3], q[4], faceUV ? faceUV[f] : null, color ? (typeof color === 'function' ? color(f) : color) : null, bone || 0, mat);
    }
  };
  A.build = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(A.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(A.nor, 3));
    if (A.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(A.uv, 2));
    if (A.col) g.setAttribute('color', new THREE.Float32BufferAttribute(A.col, 3));
    if (A.si) { g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(A.si, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(A.sw, 4)); }
    g.setIndex(A.vc > 65535 ? new THREE.Uint32BufferAttribute(A.idx, 1) : new THREE.Uint16BufferAttribute(A.idx, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  };
  return A;
}

// ---------------------------------------------------------------- kit
export function createModelKit(THREE, textures) {
  const T = textures, owned = [], geoCache = new Map(), matCache = new Map();
  const cached = (map, key, fn) => { let v = map.get(key); if (!v) { v = fn(); map.set(key, v); owned.push(v); } return v; };
  const _col = new THREE.Color();

  // Per-material flash overlay (display-space mix after tone mapping): uFlash = (r, g, b, amount).
  // All rig materials share this exact function => one compiled program for every mob and the hero.
  const flashPatch = function (shader) {
    shader.uniforms.uFlash = this.userData.uFlash;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uFlash;')
      .replace('#include <colorspace_fragment>', '#include <colorspace_fragment>\n\tgl_FragColor.rgb = mix( gl_FragColor.rgb, uFlash.rgb, uFlash.a );');
  };
  function mobMaterial(skin) {
    const m = new THREE.MeshLambertMaterial({ map: skin.map, emissive: 0xffffff, emissiveMap: skin.glowMap || T.blocks.black, alphaTest: 0.5 });
    m.userData.uFlash = { value: new THREE.Vector4(1, 1, 1, 0) };
    m.onBeforeCompile = flashPatch;
    return m;
  }
  const faceUVs = (r, W, H) => { const o = {}, e = 0.02; for (const f of FACE_ORDER) { const [x, y, w, h] = r.faces[f]; o[f] = [(x + e) / W, 1 - (y + e) / H, (x + w - e) / W, 1 - (y + h - e) / H]; } return o; };

  function buildBones(def) {
    const s = def.scale, bones = [], byName = {}, piv = {};
    for (const [name, parent, pv, rest] of def.bones) {
      const b = new THREE.Bone(); b.name = name;
      if (!name.startsWith('legL') && !name.startsWith('legR') || def.family !== 'spider') b.rotation.order = 'YXZ';
      const pp = parent ? piv[parent] : [0, 0, 0];
      b.position.set((pv[0] - pp[0]) * s, (pv[1] - pp[1]) * s, (pv[2] - pp[2]) * s);
      if (rest) b.rotation.set(rest[0], rest[1], rest[2]);
      if (parent) byName[parent].add(b);
      bones.push(b); byName[name] = b; piv[name] = pv;
    }
    return { bones, byName, piv };
  }
  function rigGeometry(kind) {
    return cached(geoCache, 'rig:' + kind, () => {
      const def = DEFS[kind], skin = T.skins[def.skin], s = def.scale;
      const { bones, byName, piv } = buildBones(def);
      bones[0].updateMatrixWorld(true);
      const idx = {}; bones.forEach((b, i) => { idx[b.name] = i; });
      const acc = makeAcc(THREE, { uv: true, skin: true });
      for (const [bn, rn, from, inf = 0] of def.boxes) {
        const r = skin.rects[rn], pv = piv[bn];
        acc.box((from[0] - inf - pv[0]) * s, (from[1] - inf - pv[1]) * s, (from[2] - inf - pv[2]) * s,
          (from[0] + r.w + inf - pv[0]) * s, (from[1] + r.h + inf - pv[1]) * s, (from[2] + r.d + inf - pv[2]) * s,
          faceUVs(r, skin.width, skin.height), null, idx[bn], byName[bn].matrixWorld);
      }
      return acc.build();
    });
  }

  // ---------------------------------------------------------------- voxel sprites (vertex colored)
  const shadeF = { px: 0.82, nx: 0.82, py: 1, ny: 0.7, pz: 1, nz: 0.9 };
  function voxelGeometry(pix, o) {
    const acc = makeAcc(THREE, { color: true }), ps = o.px, dz = (o.depth || 1) * ps * 0.5, z0 = o.z || 0;
    const reps = o.repeatY || 1;
    for (let rep = 0; rep < reps; rep++) for (let y = 0; y < pix.h; y++) for (let x = 0; x < pix.w; x++) {
      if (pix.a(x, y) < 128) continue;
      _col.setHex(pix.get(x, y)); const c = [_col.r, _col.g, _col.b];
      const x0 = (x - o.cx) * ps, y1 = (o.cy - y) * ps + rep * pix.h * ps, y0 = y1 - ps;
      const skip = { px: pix.a(x + 1, y) >= 128, nx: pix.a(x - 1, y) >= 128, py: pix.a(x, y - 1) >= 128 || (rep < reps - 1 && y === 0 && pix.a(x, pix.h - 1) >= 128), ny: pix.a(x, y + 1) >= 128 || (rep > 0 && y === pix.h - 1 && pix.a(x, 0) >= 128) };
      acc.box(x0, y0, z0 - dz, x0 + ps, y1, z0 + dz, null, (f) => [c[0] * shadeF[f], c[1] * shadeF[f], c[2] * shadeF[f]], 0, o.mat || null, skip);
    }
    return acc.build();
  }
  const vcMat = cached(matCache, 'vc', () => new THREE.MeshLambertMaterial({ vertexColors: true }));
  const itemMat = cached(matCache, 'item', () => new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x161616 }));
  const heartMat = cached(matCache, 'heart', () => new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x5a0c14 }));
  const starMat = cached(matCache, 'star', () => new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x6a5000 }));
  const heartGeo = () => cached(geoCache, 'heart', () => voxelGeometry(T.items.heart7.pix, { px: 1 / 7, depth: 2.4, cx: 3.5, cy: 3 }));

  function makeHeart3D(size = 0.5) {
    const g = new THREE.Group(), m = new THREE.Mesh(heartGeo(), heartMat);
    m.scale.setScalar(size); m.castShadow = false; g.add(m); g.userData.size = size; g.name = 'heart3D';
    return g;
  }

  // blob contact shadow (Minecraft-style round entity shadow)
  const blobTex = cached(matCache, 'blobTex', () => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 32;
    const ctx = cv.getContext('2d'), gr = ctx.createRadialGradient(16, 16, 2, 16, 16, 16);
    gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(0.6, 'rgba(0,0,0,0.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, 32, 32);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  });
  const blobMat = cached(matCache, 'blob', () => new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.62, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const blobGeo = cached(geoCache, 'blob', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));

  // bow stages (vertical sprite baked into hand space: sprite +x -> hand +y (toward archer when aiming), sprite +y -> hand +z)
  const bowGeos = [0, 1, 2, 3].map((st) => cached(geoCache, 'bow' + st, () => {
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0));
    return voxelGeometry(T.items['bow' + st].pix, { px: 0.05, depth: 1.8, cx: 5.5, cy: 7.5, mat: m });
  }));
  const starRingGeo = () => cached(geoCache, 'starRing', () => {
    const acc = [], m = new THREE.Matrix4();
    const geos = [0, 1, 2].map((k) => { const a = (k * TAU) / 3; m.makeRotationY(-a).setPosition(Math.sin(a) * 0.3, 0, Math.cos(a) * 0.3); return voxelGeometry(T.items.star5.pix, { px: 0.05, depth: 1, cx: 2.5, cy: 2.5, mat: m.clone() }); });
    return mergeGeos(geos);
  });
  function mergeGeos(geos) {
    const out = makeAcc(THREE, { color: true });
    for (const g of geos) {
      const p = g.attributes.position.array, n = g.attributes.normal.array, c = g.attributes.color.array, ix = g.index.array, base = out.vc;
      for (let i = 0; i < p.length; i++) { out.pos.push(p[i]); out.nor.push(n[i]); out.col.push(c[i]); }
      for (let i = 0; i < ix.length; i++) out.idx.push(ix[i] + base);
      out.vc += p.length / 3; g.dispose();
    }
    return out.build();
  }
  const windTierMat = cached(matCache, 'windTier', () => {
    const t = T.blocks.windBand.clone(); t.needsUpdate = true; t.repeat.set(2, 1); owned.push(t);
    return new THREE.MeshBasicMaterial({ map: t, color: 0x6c82e0, transparent: true, opacity: 0.48, depthWrite: false, side: THREE.DoubleSide });
  });
  const windTierGeo = (i) => cached(geoCache, 'tier' + i, () => new THREE.CylinderGeometry([0.32, 0.26, 0.2][i], [0.26, 0.2, 0.12][i], 0.3, 8, 1, true));

  // ---------------------------------------------------------------- Rig
  class Rig {
    constructor(kind) {
      const def = DEFS[kind];
      if (!def) throw new Error('unknown mob kind ' + kind);
      this.kind = kind; this.def = def; this.family = def.family; this.skin = T.skins[def.skin];
      this.height = def.height; this.radius = def.radius;
      const { bones, byName } = buildBones(def);
      this.bones = bones; this.b = byName; this.p0 = bones.map((bn) => bn.position.y);
      this.material = mobMaterial(this.skin);
      const mesh = new THREE.SkinnedMesh(rigGeometry(kind), this.material);
      mesh.add(bones[0]); mesh.bind(new THREE.Skeleton(bones));
      mesh.castShadow = true; mesh.receiveShadow = false; mesh.name = 'rigMesh:' + kind;
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, def.height * 0.5, 0), def.height * 0.75 + def.radius + 0.6);
      this.mesh = mesh;
      this.root = new THREE.Group(); this.root.name = 'rig:' + kind; this.root.add(mesh);
      this.parts = { base: byName.base, head: byName.head || null, body: byName.body || null, armL: byName.armL || null, armR: byName.armR || null,
        legL: byName.legL || null, legR: byName.legR || null, legs: null, bow: null, rods: byName.rods || null };
      this.sockets = {};
      this.time = 0; this.phase = 0; this.seed = (kind.length * 1.7 + Math.random() * 6) % TAU;
      this.isFriend = false; this.flashT = 0; this.flashDur = 1; this.flashRGB = { r: 1, g: 0.4, b: 0.6 };
      this.happyW = 0; this.hopT = 0; this.hop = 0; this.spin = 0; this.spinLeft = 0; this.wasHappy = false; this.prevHappy = 0; this.squash = 0;
      this.airSpin = 0; this.heartPh = 0; this.climbPh = 0; this.prevW = 0; this.slamT = 0; this.kneelW = 0; this.wallW = 0; this.swellXZ = 1; this.swellY = 1;
      const hs = kind === 'golem' ? 0.66 : kind === 'caveSpider' ? 0.42 : 0.5;
      this.heart = makeHeart3D(hs); this.heart.visible = false; this.heartY = def.height + (kind === 'golem' ? 0.5 : 0.4);
      this.heart.position.y = this.heartY; this.root.add(this.heart);
      this.blob = new THREE.Mesh(blobGeo, blobMat); this.blob.scale.setScalar(Math.max(0.7, def.radius * 2.3)); this.blob.position.y = 0.015;
      this.blob.renderOrder = -1; this.root.add(this.blob);
      const s = def.scale;
      if (def.family === 'spider') {
        this.legs = []; for (let i = 0; i < 4; i++) this.legs.push(byName['legL' + i]); for (let i = 0; i < 4; i++) this.legs.push(byName['legR' + i]);
        this.parts.legs = this.legs; this.parts.body = byName.abdomen; this.parts.thorax = byName.body;
        this.silk = new THREE.Mesh(cached(geoCache, 'silk', () => new THREE.BoxGeometry(0.03, 1, 0.03).translate(0, 0.5, 0)), vcMatWhite());
        this.silk.visible = false; this.root.add(this.silk);
      }
      if (kind === 'skeleton' || kind === 'stray') {
        this.bowMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x000000 });
        this.bow = new THREE.Mesh(bowGeos[0], this.bowMat); this.bow.castShadow = true; this.bowStage = 0;
        this.bow.position.set(0, -9.5 * s, 0.6 * s); byName.armR.add(this.bow); this.parts.bow = this.bow;
      }
      if (def.family === 'breeze') {
        this.tiers = [0, 1, 2].map((i) => { const m = new THREE.Mesh(windTierGeo(i), windTierMat); m.position.y = (4.6 - i * 5.2) * s; byName.body.add(m); return m; });
        this.parts.wind = this.tiers;
      }
      if (def.family === 'golem') {
        this.parts.kneeL = byName.kneeL; this.parts.kneeR = byName.kneeR;
        this.sockets.hand = new THREE.Group(); this.sockets.hand.position.set(0, -27 * s, 1.5 * s); byName.armR.add(this.sockets.hand);
        this.sockets.shoulder = new THREE.Group(); this.sockets.shoulder.position.set(-11 * s, 2.5 * s, 0); byName.body.add(this.sockets.shoulder);
        this.sockets.shoulder.position.set(-11 * s, 18 * s, 0);
      }
      if (def.family === 'human') {
        this.sockets.handR = new THREE.Group(); this.sockets.handR.position.set(0, -10 * s, 0); byName.armR.add(this.sockets.handR);
        this.sockets.handL = new THREE.Group(); this.sockets.handL.position.set(0, -10 * s, 0); byName.armL.add(this.sockets.handL);
      }
      this.sockets.headTop = new THREE.Group(); this.sockets.headTop.position.set(0, (def.family === 'golem' ? 10 : 8) * s, 0); (byName.head || byName.body).add(this.sockets.headTop);
      if (kind === 'hero') { this.stars = new THREE.Mesh(starRingGeo(), starMat); this.stars.visible = false; this.root.add(this.stars); }
      this.showDizzyStars = true;
      this.animate({ t: 0, speed: 0 }, 0);
    }

    setFriend(on) {
      on = !!on; this.isFriend = on; this.heart.visible = on;
      const m = this.material, sk = this.skin;
      m.map = on && sk.friendMap ? sk.friendMap : sk.map;
      m.emissiveMap = (on ? sk.friendGlowMap : sk.glowMap) || T.blocks.black;
      m.color.setScalar(on ? 1.2 : 1);
    }
    flash(color = 0xff6b9a, seconds = 0.3) {
      _col.set(color); _col.getRGB(this.flashRGB, THREE.SRGBColorSpace);
      this.flashT = this.flashDur = Math.max(0.02, seconds);
    }
    dispose() {
      this.root.removeFromParent();
      this.material.dispose(); this.mesh.skeleton.dispose();
      if (this.bowMat) this.bowMat.dispose();
    }

    animate(s, dt) {
      s = s || {}; dt = clamp(dt || 0, 0, 0.1);
      this.time += dt;
      const t = s.t !== undefined ? s.t : this.time;
      if (this.kind !== 'hero' && typeof s.isFriend === 'boolean' && s.isFriend !== this.isFriend) this.setFriend(s.isFriend);
      const k = 1 - Math.exp(-12 * dt);
      // happy hop + spin
      const happy = clamp(s.happy || 0, 0, 1);
      this.happyW += ((happy > 0.001 ? 1 : 0) - this.happyW) * k;
      if (happy > 0.001) {
        if (!this.wasHappy || (this.prevHappy <= 0.6 && happy > 0.85)) { this.wasHappy = true; this.hopT = 0; this.spinLeft = TAU; }
        const prev = this.hopT; this.hopT += dt * 2.2;
        if (Math.floor(this.hopT) !== Math.floor(prev)) this.squash = 1;
        this.hop = Math.abs(Math.sin(Math.PI * this.hopT)) * 0.6 * happy * (this.family === 'golem' ? 0.3 : 1);
        if (this.spinLeft > 0) { const d = Math.min(this.spinLeft, dt * TAU * 2.0); this.spin += d; this.spinLeft -= d; if (this.spinLeft <= 1e-4) this.spin = 0; }
      } else {
        this.wasHappy = false; this.spinLeft = 0; this.hop = Math.max(0, this.hop - dt * 3);
        if (this.spin !== 0) { const tg = this.spin > Math.PI ? TAU : 0; this.spin += (tg - this.spin) * k; if (Math.abs(tg - this.spin) < 0.01) this.spin = 0; }
      }
      this.prevHappy = happy;
      this.squash = Math.max(0, this.squash - dt * 4.5);
      this.swellXZ = 1; this.swellY = 1;
      // family pose
      let baseY = 0;
      const f = this.family;
      if (f === 'human') baseY = this._human(s, dt, t);
      else if (f === 'spider') baseY = this._spider(s, dt, t);
      else if (f === 'creeper') baseY = this._creeper(s, dt, t);
      else if (f === 'breeze') baseY = this._breeze(s, dt, t);
      else if (f === 'golem') baseY = this._golem(s, dt, t);
      const base = this.b.base, sy = (1 - 0.16 * this.squash) * this.swellY, sxz = this.swellXZ / Math.sqrt(1 - 0.16 * this.squash);
      base.position.y = baseY + this.hop;
      base.rotation.y = this.spin + this.airSpin;
      base.scale.set(sxz, sy, sxz);
      // flash: hit flash (timed) and creeper fuse flash
      let fa = 0, fr = 1, fg = 1, fb = 1;
      if (this.flashT > 0) { this.flashT = Math.max(0, this.flashT - dt); const q = this.flashT / this.flashDur; fa = q * Math.sqrt(q) * 0.62; fr = this.flashRGB.r; fg = this.flashRGB.g; fb = this.flashRGB.b; }
      const fuse = clamp(s.fuse || 0, 0, 1);
      if (fuse > 0) { const q = (0.5 + 0.5 * Math.sin(t * (9 + 30 * fuse))) * (0.18 + 0.7 * fuse); if (q > fa) { fa = q; fr = fg = fb = 1; } }
      this.material.userData.uFlash.value.set(fr, fg, fb, fa);
      // friend heart bob + slow spin
      if (this.heart.visible) {
        // slow 360 spin that lingers face-on to the (south-facing) camera; compensates the root's facing yaw
        this.heartPh += dt * 1.15; const hp = this.heartPh;
        this.heart.position.y = this.heartY + baseY + this.hop + Math.sin(t * 2.6 + this.seed) * 0.07;
        const e = this.root.matrixWorld.elements;
        this.heart.rotation.y = hp - 0.45 * Math.sin(2 * hp) - Math.atan2(e[8], e[10]);
      }
      // blob shadow stays on the ground if the caller passes groundOffset (root height above ground)
      const go = s.groundOffset || 0;
      this.blob.position.y = 0.015 - go; this.blob.visible = !s.onWall;
      if (this.stars) {
        this.stars.visible = !!s.dizzy && this.showDizzyStars;
        if (this.stars.visible) { this.stars.position.y = this.height + 0.12 + this.hop; this.stars.rotation.y += dt * 5; }
      }
      if (this.silk) {
        const L = s.silk || 0; this.silk.visible = L > 0.01;
        if (this.silk.visible) { this.silk.scale.y = L; this.silk.position.y = 9 * this.def.scale + baseY; }
      }
    }

    _human(s, dt, t) {
      const b = this.b, kind = this.kind, d = this.def, sp = s.speed || 0;
      const amp = Math.min(1, sp / d.ampSpeed);
      this.phase += dt * sp * TAU / d.stride;
      const sw = Math.sin(this.phase) * amp, idle = 1 - amp, w = clamp(s.windup || 0, 0, 1);
      let lL = sw * 0.75, lR = -sw * 0.75, aLx = -sw * 0.65, aRx = sw * 0.65, aLy = 0, aRy = 0;
      let aLz = 0.07 + Math.sin(t * 1.4) * 0.05 * idle, aRz = -0.07 - Math.sin(t * 1.4 + 0.7) * 0.05 * idle;
      let hX = Math.sin(t * 1.1) * 0.03 * idle, hY = Math.sin(t * 0.43 + this.seed) * 0.35 * idle, hZ = 0, bX = 0, bY = 0, bZ = 0, baseY = 0;
      if (kind === 'zombie') {
        const arm = -1.45 - w * 0.95;
        aLx = arm + Math.sin(t * 2.3) * 0.06 + sw * 0.12; aRx = arm + Math.sin(t * 2.3 + 1.3) * 0.06 - sw * 0.12;
        aLz = 0.04; aRz = -0.04; hZ = Math.sin(t * 0.8 + this.seed) * 0.08; hX -= w * 0.2; bX = -w * 0.12;
      } else if (kind === 'skeleton' || kind === 'stray') {
        aRx = -0.3 + sw * 0.45;
        const e = smooth(w * 2.2);
        if (e > 0) { aRx = mix(aRx, -1.52, e); aLx = mix(aLx, -1.45, e); aLy = 0.62 * e; aRy = -0.12 * e; aLz = mix(aLz, 0, e); aRz = mix(aRz, 0, e); hY = mix(hY, 0, e); hX = mix(hX, 0.05, e); }
        const stage = w < 0.05 ? 0 : 1 + Math.min(2, Math.floor(w * 3));
        if (stage !== this.bowStage) { this.bowStage = stage; this.bow.geometry = bowGeos[stage]; }
        const g = w * w; this.bowMat.emissive.setRGB(0.9 * g, 0.55 * g, 0.15 * g);
      } else if (kind === 'hero') {
        bX = amp * 0.08;
        if (s.climbing) {
          this.climbPh += dt * 7; const c = Math.sin(this.climbPh);
          aLx = -2.55 + c * 0.45; aRx = -2.55 - c * 0.45; aLz = 0.18; aRz = -0.18;
          lL = -0.1 - 0.5 * Math.max(0, c); lR = -0.1 - 0.5 * Math.max(0, -c); hX = -0.3; hY = 0; bX = 0;
        } else if (s.airborne) {
          aLz = 2.3 + Math.sin(t * 15) * 0.35; aRz = -2.3 - Math.sin(t * 15 + 1) * 0.35; aLx = aRx = -0.2;
          lL = Math.sin(t * 13) * 0.75; lR = -lL; hX = -0.3; bX = 0;
        } else if (s.dizzy) {
          hZ = Math.sin(t * 8) * 0.24; hX = 0.12; bZ = Math.sin(t * 8 + 1) * 0.07;
          aLz = 0.45 + Math.sin(t * 7) * 0.15; aRz = -0.45 - Math.sin(t * 7 + 2) * 0.15;
        }
        const th = Math.sin(Math.PI * clamp(s.throwing || 0, 0, 1));
        if (th > 0) { aRx = mix(aRx, -2.75, th); aRz = mix(aRz, -0.12, th); bY = 0.28 * th; hY = mix(hY, 0, th); }
      }
      const hw = this.happyW;
      if (hw > 0.01) { const wv = Math.sin(t * 13) * 0.18; aLx = mix(aLx, -0.1, hw); aRx = mix(aRx, -0.1, hw); aLz = mix(aLz, 2.55 + wv, hw); aRz = mix(aRz, -2.55 + wv, hw); aLy = mix(aLy, 0, hw); aRy = mix(aRy, 0, hw); }
      b.legL.rotation.set(lL, 0, 0); b.legR.rotation.set(lR, 0, 0);
      b.armL.rotation.set(aLx, aLy, aLz); b.armR.rotation.set(aRx, aRy, aRz);
      b.head.rotation.set(hX, hY, hZ); b.body.rotation.set(bX, bY, bZ);
      return baseY;
    }

    _creeper(s, dt, t) {
      const b = this.b, d = this.def, sp = s.speed || 0, amp = Math.min(1, sp / d.ampSpeed), idle = 1 - amp;
      this.phase += dt * sp * TAU / d.stride;
      const sw = Math.sin(this.phase) * amp * 0.65;
      b.legFL.rotation.x = sw; b.legBR.rotation.x = sw; b.legFR.rotation.x = -sw; b.legBL.rotation.x = -sw;
      const w = clamp(s.windup || 0, 0, 1), f = clamp(s.fuse || 0, 0, 1);
      b.head.rotation.set(Math.sin(t * 1.2) * 0.04 * idle - w * 0.15, Math.sin(t * 0.5 + this.seed) * 0.3 * idle, 0);
      b.body.rotation.set(0, 0, Math.sin(t * 14) * 0.1 * this.happyW);
      const pulse = Math.sin(t * (10 + 26 * f)) * 0.035 * f;
      this.swellXZ = 1 + 0.24 * f + pulse; this.swellY = 1 + 0.08 * f + pulse * 0.5;
      return 0;
    }

    _spider(s, dt, t) {
      const b = this.b, d = this.def, sc = d.scale, sp = s.speed || 0, amp = Math.min(1, sp / 1.4), w = clamp(s.windup || 0, 0, 1);
      this.phase += dt * sp * TAU / d.stride;
      this.wallW += ((s.onWall ? 1 : 0) - this.wallW) * (1 - Math.exp(-10 * dt));
      const restH = 9 * sc, h = restH * (1 - 0.4 * smooth(w)) * (1 - 0.58 * this.wallW), reach = 15.2 * sc;
      for (let i = 0; i < 8; i++) {
        const side = i < 4 ? 1 : -1, j = i & 3, grp = (j + (side > 0 ? 0 : 1)) & 1, ph = this.phase + grp * Math.PI;
        const swing = Math.sin(ph) * 0.42 * amp + this.wallW * Math.sin(t * 3 + i) * 0.05;
        const lift = Math.max(0, Math.cos(ph)) * 0.36 * amp;
        const tilt = Math.asin(clamp((h - 0.6 * sc) / reach, -1, 1)) - lift;
        const fan = SPIDER_FAN[j] * (1 + 0.22 * this.wallW + 0.2 * w);
        this.legs[i].rotation.set(0, side > 0 ? -(fan + swing) : fan + swing, side > 0 ? -tilt : tilt);
      }
      b.head.rotation.set(-0.15 * w - 0.58 * this.wallW + Math.sin(t * 1.7) * 0.03, Math.sin(t * 0.7 + this.seed) * 0.15 * (1 - amp), 0);
      b.abdomen.rotation.set(Math.sin(t * 2.2) * 0.04 + 0.12 * w + 0.18 * this.wallW, 0, Math.sin(this.phase) * 0.05 * amp);
      return h - restH;
    }

    _breeze(s, dt, t) {
      const b = this.b, w = clamp(s.windup || 0, 0, 1);
      const hover = Math.sin(t * 2.3 + this.seed) * 0.07 + Math.abs(Math.sin(t * 4.4)) * 0.08 * Math.min(1, (s.speed || 0) / 2);
      b.body.position.y = this.p0[1] + hover;
      b.rods.rotation.y += dt * (2.4 + 13 * w);
      b.rods.position.y = this.p0[3] + Math.sin(t * 3) * 0.02;
      for (let i = 0; i < 3; i++) { const m = this.tiers[i]; m.rotation.y += dt * (i % 2 ? -1 : 1) * (3.5 + i * 1.5 + 11 * w); m.scale.setScalar(1 + 0.16 * w + 0.03 * Math.sin(t * 5 + i)); }
      b.head.rotation.set(-0.25 * w + Math.sin(t * 1.3) * 0.04, Math.sin(t * 0.6 + this.seed) * 0.35 * (1 - w), 0);
      return 0;
    }

    _golem(s, dt, t) {
      const b = this.b, d = this.def, sc = d.scale, sp = s.speed || 0, amp = Math.min(1, sp / d.ampSpeed), idle = 1 - amp, w = clamp(s.windup || 0, 0, 1);
      this.phase += dt * sp * TAU / d.stride;
      if (this.prevW > 0.5 && w < this.prevW - 0.12) this.slamT = 0.55;
      this.prevW = w;
      const sw = Math.sin(this.phase) * amp;
      let aL = -sw * 0.45, aR = sw * 0.45, bX = 0, hX = Math.sin(t * 0.9) * 0.03, hY = Math.sin(t * 0.37 + this.seed) * 0.25 * idle;
      let hipL = sw * 0.5, hipR = -sw * 0.5, kneeL = Math.max(0, -Math.sin(this.phase)) * 0.55 * amp, kneeR = Math.max(0, Math.sin(this.phase)) * 0.55 * amp;
      let baseY = Math.abs(Math.cos(this.phase)) * 0.04 * amp;
      const e = smooth(w);
      if (e > 0) { aL = mix(aL, -2.85, e); aR = mix(aR, -2.85, e); bX = -0.12 * e; hX -= 0.2 * e; }
      if (this.slamT > 0) {
        const p = 1 - this.slamT / 0.55, dn = smooth(p / 0.28), back = smooth((p - 0.5) / 0.5);
        if (p > 0.28 && p - dt / 0.55 <= 0.28) this.squash = 0.9;
        const arm = mix(mix(-2.85, -0.35, dn), aL, back);
        aL = arm; aR = arm; bX = mix(0.3 * dn, bX, back);
        this.slamT = Math.max(0, this.slamT - dt);
      }
      const kn = (this.kneelW += ((s.kneel ? (typeof s.kneel === 'number' ? clamp(s.kneel, 0, 1) : 1) : 0) - this.kneelW) * (1 - Math.exp(-6 * dt)));
      if (kn > 0.001) {
        hipR = mix(hipR, 0, kn); kneeR = mix(kneeR, 1.57, kn); hipL = mix(hipL, -1.45, kn); kneeL = mix(kneeL, 1.45, kn);
        baseY = mix(baseY, -8 * sc, kn); aR = mix(aR, -1.25, kn); aL = mix(aL, -0.15, kn); bX = mix(bX, 0.16, kn); hX = mix(hX, 0.3, kn); hY = mix(hY, 0, kn);
      }
      const hw = this.happyW;
      if (hw > 0.01) { const wv = Math.sin(t * 9) * 0.25; aL = mix(aL, -2.6 + wv, hw); aR = mix(aR, -2.6 - wv, hw); }
      b.armL.rotation.set(aL, 0, 0.05); b.armR.rotation.set(aR, 0, -0.05);
      b.legL.rotation.set(hipL, 0, 0); b.legR.rotation.set(hipR, 0, 0); b.kneeL.rotation.set(kneeL, 0, 0); b.kneeR.rotation.set(kneeR, 0, 0);
      b.body.rotation.set(bX, 0, 0); b.head.rotation.set(hX, hY, 0);
      return baseY;
    }
  }
  function vcMatWhite() { return cached(matCache, 'silkMat', () => new THREE.MeshBasicMaterial({ color: 0xf2f2f2, transparent: true, opacity: 0.85 })); }

  function makeHero() { return new Rig('hero'); }
  function makeMob(kind) { return new Rig(kind); }

  // ---------------------------------------------------------------- props
  const chestSkin = T.skins.chest;
  const chestMat = cached(matCache, 'chest', () => new THREE.MeshLambertMaterial({ map: chestSkin.map }));
  const chestGeos = () => cached(geoCache, 'chestGeos', () => {
    const P = 1 / 16, uv = (n) => faceUVs(chestSkin.rects[n], chestSkin.width, chestSkin.height);
    const base = makeAcc(THREE, { uv: true }); base.box(-0.5, 0, -0.5, 0.5, 11 * P, 0.5, uv('base'));
    const lid = makeAcc(THREE, { uv: true }); lid.box(-0.5, 0, 0, 0.5, 5 * P, 1, uv('lid'));
    lid.box(-1 * P, -2 * P, 1, 1 * P, 2 * P, 1 + P, uv('latch'));
    return { base: base.build(), lid: lid.build() };
  });
  // Chest: origin bottom-center, faces +z, 14/16 block. Open = negative lid.rotation.x (setOpen(0..1) helper).
  function makeChest() {
    const group = new THREE.Group(), inner = new THREE.Group(), g = chestGeos();
    inner.scale.setScalar(14 / 16); group.add(inner); group.name = 'chest';
    const base = new THREE.Mesh(g.base, chestMat); base.castShadow = base.receiveShadow = true;
    const lid = new THREE.Group(); lid.position.set(0, 11 / 16, -0.5);
    const lm = new THREE.Mesh(g.lid, chestMat); lm.castShadow = lm.receiveShadow = true; lid.add(lm);
    inner.add(base, lid);
    return { group, lid, openAngle: -1.75, setOpen(k) { lid.rotation.x = -1.75 * clamp(k, 0, 1); } };
  }

  const cageMat = cached(matCache, 'cage', () => new THREE.MeshLambertMaterial({ map: T.blocks.spawnerCage, alphaTest: 0.5, side: THREE.DoubleSide }));
  const cageGeo = cached(geoCache, 'cage', () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  const leafMat = cached(matCache, 'leaf', () => new THREE.MeshLambertMaterial({ map: T.blocks.floweringLeaves, alphaTest: 0.5, side: THREE.DoubleSide }));
  const leafGeo = cached(geoCache, 'leafCube', () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  const crossGeo = cached(geoCache, 'cross', () => { const a = new THREE.PlaneGeometry(0.62, 0.62).rotateY(Math.PI / 4), b = new THREE.PlaneGeometry(0.62, 0.62).rotateY(-Math.PI / 4); const m = mergePlain([a, b]); m.translate(0, 0.31, 0); return m; });
  function mergePlain(geos) {
    const acc = makeAcc(THREE, { uv: true });
    for (const g of geos) { const p = g.attributes.position.array, n = g.attributes.normal.array, u = g.attributes.uv.array, ix = g.index.array, b0 = acc.vc; for (let i = 0; i < p.length; i++) { acc.pos.push(p[i]); acc.nor.push(n[i]); } for (let i = 0; i < u.length; i++) acc.uv.push(u[i]); for (let i = 0; i < ix.length; i++) acc.idx.push(ix[i] + b0); acc.vc += p.length / 3; g.dispose(); }
    return acc.build();
  }
  const flowerMat = (key) => cached(matCache, 'flower:' + key, () => new THREE.MeshLambertMaterial({ map: T.blocks[key], alphaTest: 0.5, side: THREE.DoubleSide }));
  const flameSpr = cached(matCache, 'flameSpr', () => new THREE.SpriteMaterial({ map: T.sprites.flame, alphaTest: 0.5, depthWrite: true }));
  const smokeSpr = cached(matCache, 'smokeSpr', () => new THREE.SpriteMaterial({ map: T.sprites.smoke, transparent: true, opacity: 0.6, depthWrite: false }));
  const miniMats = {};
  const miniMat = (kind) => miniMats[kind] || (miniMats[kind] = cached(matCache, 'mini:' + kind, () => new THREE.MeshLambertMaterial({ map: T.skins[DEFS[kind].skin].map, alphaTest: 0.5 })));

  // Spawner: origin bottom-center of its block. update(dt) spins the mini mob, animates flames/smoke and the bloom pop.
  function makeSpawner() {
    const group = new THREE.Group(); group.name = 'spawner';
    const cage = new THREE.Mesh(cageGeo, cageMat); cage.castShadow = true; cage.receiveShadow = true;
    const spin = new THREE.Group(); spin.position.y = 0.1;
    const fx = [];
    for (let i = 0; i < 5; i++) {
      const sp = new THREE.Sprite(i < 3 ? flameSpr : smokeSpr); sp.userData = { k: i < 3 ? 0 : 1, t: i * 0.37, x: (i * 0.37) % 0.6 - 0.3, z: ((i * 0.61) % 0.6) - 0.3 };
      group.add(sp); fx.push(sp);
    }
    const bloom = new THREE.Group(); bloom.visible = false;
    const leaves = new THREE.Mesh(leafGeo, leafMat); leaves.castShadow = true; bloom.add(leaves);
    [['flowerRed', -0.22, -0.2], ['flowerPink', 0.22, -0.18], ['flowerPink', -0.2, 0.22], ['flowerRed', 0.2, 0.2]].forEach(([k, x, z], i) => {
      const f = new THREE.Mesh(crossGeo, flowerMat(k)); f.position.set(x, 1, z); f.rotation.y = i * 0.7; f.scale.setScalar(0.75 + (i % 2) * 0.2); bloom.add(f);
    });
    const bheart = makeHeart3D(0.5); bheart.position.y = 1.55; bloom.add(bheart);
    group.add(cage, spin, bloom);
    let mini = null, bloomed = false, bloomT = 1, t = 0;
    return {
      group,
      setMob(kind) {
        if (mini) { spin.remove(mini); mini = null; }
        if (!kind || !DEFS[kind]) return;
        const def = DEFS[kind], geo = rigGeometry(kind);
        if (!geo.boundingBox) geo.computeBoundingBox();
        const bb = geo.boundingBox, w = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z), h = bb.max.y - bb.min.y;
        const sc = Math.min(0.62 / h, 0.7 / w);
        mini = new THREE.Mesh(geo, miniMat(kind)); mini.scale.setScalar(sc); mini.position.y = 0.4 - (h * sc) / 2 - bb.min.y * sc;
        spin.add(mini);
      },
      setBloomed(b) { bloomed = !!b; cage.visible = spin.visible = !bloomed; for (const s of fx) s.visible = !bloomed; bloom.visible = bloomed; bloomT = 0; },
      update(dt) {
        t += dt; spin.rotation.y += dt * 3.2;
        if (!bloomed) for (const s of fx) {
          const u = s.userData; u.t = (u.t + dt * (u.k ? 0.55 : 1.4)) % 1;
          if (u.k === 0) { s.position.set(u.x * 0.8, 0.15 + u.t * 0.7, u.z * 0.8); s.scale.setScalar(0.17 * (1 - u.t * 0.7)); }
          else { s.position.set(u.x * 0.5, 1.0 + u.t * 0.7, u.z * 0.5); s.scale.setScalar(0.18 + u.t * 0.22); }
        }
        if (bloomed) {
          bloomT = Math.min(1, bloomT + dt * 2.2);
          const e = bloomT < 1 ? 1 + Math.sin(bloomT * Math.PI * 1.5) * (1 - bloomT) * 0.6 : 1;
          bloom.scale.set(e * smooth(bloomT * 3), smooth(bloomT * 3) / Math.max(0.6, e), e * smooth(bloomT * 3));
          bheart.position.y = 1.55 + Math.sin(t * 2.4) * 0.08; bheart.rotation.y += dt * 1.6;
        }
      },
      dispose() { group.removeFromParent(); },
    };
  }

  // Ladder: origin at bottom-center of the wall face, extends +y to `height`, 1/16 thick toward +z.
  function makeLadder(height = 6) {
    const n = Math.max(1, Math.round(height));
    const geo = cached(geoCache, 'ladder:' + n, () => voxelGeometry(T.items.ladder.pix, { px: 1 / 16, depth: 1, cx: 8, cy: 16, z: 0.5 / 16 + 0.004, repeatY: n }));
    const m = new THREE.Mesh(geo, vcMat); m.castShadow = true; m.receiveShadow = true; m.name = 'ladder';
    const g = new THREE.Group(); g.add(m); return g;
  }

  // Items: extruded 16x16 sprites (Minecraft held-item look). Origin at the bottom-center of the 16x16 sprite box, 0.7 blocks tall.
  function makeItem(kind) {
    const it = T.items[kind];
    if (!it) throw new Error('unknown item ' + kind);
    const geo = cached(geoCache, 'item:' + kind, () => voxelGeometry(it.pix, { px: 0.7 / 16, depth: 1.8, cx: 8, cy: 16 }));
    const m = new THREE.Mesh(geo, itemMat); m.castShadow = true;
    const g = new THREE.Group(); g.add(m); g.name = 'item:' + kind; return g;
  }

  // Torch: upright by default (origin at the stick bottom; tilt it yourself for wall mounting, e.g. rotation.x = 0.38 on a north wall).
  // makeTorch({wall:true}) returns it pre-tilted toward +z with the origin on the wall surface.
  // Returns { group, light (null unless {light:true}), flame, update(dt) } (update flickers flame + optional light).
  const torchStickMat = cached(matCache, 'torchStick', () => new THREE.MeshLambertMaterial({ color: 0x8a6a3a }));
  const torchHeadMat = cached(matCache, 'torchHead', () => new THREE.MeshBasicMaterial({ color: 0xffd36a }));
  const torchGeos = cached(geoCache, 'torch', () => ({ stick: new THREE.BoxGeometry(2 / 16, 8 / 16, 2 / 16).translate(0, 4 / 16, 0), head: new THREE.BoxGeometry(2.4 / 16, 2.4 / 16, 2.4 / 16).translate(0, 9 / 16, 0) }));
  function makeTorch(opts = {}) {
    const group = new THREE.Group(), tilt = new THREE.Group(); group.add(tilt); group.name = 'torch';
    const wall = opts.wall === true;
    if (wall) { tilt.position.set(0, -0.28, 0.12); tilt.rotation.x = 0.38; }
    const stick = new THREE.Mesh(torchGeos.stick, torchStickMat), head = new THREE.Mesh(torchGeos.head, torchHeadMat);
    stick.castShadow = true; tilt.add(stick, head);
    const flame = new THREE.Sprite(flameSpr); flame.position.y = 0.72; flame.scale.setScalar(0.2); tilt.add(flame);
    let light = null;
    if (opts.light) { light = new THREE.PointLight(0xffa64a, opts.intensity || 7, opts.distance || 9, 1.4); light.position.set(0, 0.8, 0.1); tilt.add(light); }
    let t = Math.random() * 10;
    return {
      group, light, flame,
      update(dt) {
        t += dt; const f = 0.85 + 0.1 * Math.sin(t * 13) + 0.06 * Math.sin(t * 29 + 1.3);
        flame.scale.setScalar(0.2 * f); flame.position.y = 0.72 + 0.015 * Math.sin(t * 17);
        if (light) light.intensity = (opts.intensity || 7) * f;
      },
    };
  }

  // Arrow: forward = +z (use obj.lookAt(target)). friendly = pink shaft with a voxel heart tip.
  function arrowGeo(friendly) {
    return cached(geoCache, 'arrow:' + (friendly ? 1 : 0), () => {
      const P = 0.05, acc = makeAcc(THREE, { color: true }), c = (hex) => { _col.setHex(hex); return [_col.r, _col.g, _col.b]; };
      const shaft = c(friendly ? 0xf27fb0 : 0x7a5a32), feather = c(friendly ? 0xffd0e4 : 0xeeeeee), feather2 = c(friendly ? 0xff8fc0 : 0xbdbdbd), iron = c(0xc8c8c8), dark = c(0x8a8a8a);
      acc.box(-0.6 * P, -0.6 * P, -6 * P, 0.6 * P, 0.6 * P, 6 * P, null, shaft);
      acc.box(-0.15 * P, -2 * P, -6.5 * P, 0.15 * P, 2 * P, -3.5 * P, null, feather);
      acc.box(-2 * P, -0.15 * P, -6.5 * P, 2 * P, 0.15 * P, -3.5 * P, null, feather2);
      if (!friendly) {
        acc.box(-1.5 * P, -0.4 * P, 6 * P, 1.5 * P, 0.4 * P, 7 * P, null, dark);
        acc.box(-0.4 * P, -1.5 * P, 6 * P, 0.4 * P, 1.5 * P, 7 * P, null, dark);
        acc.box(-0.8 * P, -0.8 * P, 7 * P, 0.8 * P, 0.8 * P, 8.5 * P, null, iron);
        acc.box(-0.3 * P, -0.3 * P, 8.5 * P, 0.3 * P, 0.3 * P, 9.5 * P, null, iron);
        return acc.build();
      }
      const shaftG = acc.build(), hp = T.items.heart7.pix, m = new THREE.Matrix4();
      m.makeRotationY(Math.PI / 2).setPosition(0, 0, 8.5 * P);
      const h1 = voxelGeometry(hp, { px: 0.6 * P, depth: 1.6, cx: 3.5, cy: 3, mat: m.clone() });
      m.makeRotationY(Math.PI / 2).premultiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)).setPosition(0, 0, 8.5 * P);
      const h2 = voxelGeometry(hp, { px: 0.6 * P, depth: 1.6, cx: 3.5, cy: 3, mat: m.clone() });
      return mergeGeos([shaftG, h1, h2]);
    });
  }
  function makeArrow(friendly = false) {
    const g = new THREE.Group(), m = new THREE.Mesh(arrowGeo(!!friendly), friendly ? heartMat : vcMat);
    m.castShadow = true; g.add(m); g.name = friendly ? 'arrowFriendly' : 'arrow'; return g;
  }

  // Wind charge: voxel swirl ball + two crossed spiral sprites. Call obj.update(dt) to spin (optional).
  const swirlMat = cached(matCache, 'swirl', () => new THREE.MeshBasicMaterial({ map: T.sprites.windSwirl, alphaTest: 0.4, side: THREE.DoubleSide, transparent: true, depthWrite: false }));
  const windCoreGeo = cached(geoCache, 'windCore', () => {
    const acc = makeAcc(THREE, { color: true }), P = 0.06;
    for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) {
      const r = x * x + y * y + z * z; if (r > 5) continue;
      _col.setHex(r < 2 ? 0xffffff : (x + y + z) % 2 ? 0xbfe8ff : 0x8fd0ff);
      acc.box(x * P - P / 2, y * P - P / 2, z * P - P / 2, x * P + P / 2, y * P + P / 2, z * P + P / 2, null, [_col.r, _col.g, _col.b]);
    }
    return acc.build();
  });
  const swirlGeo = cached(geoCache, 'swirlPlanes', () => { const a = new THREE.PlaneGeometry(0.62, 0.62), b = new THREE.PlaneGeometry(0.62, 0.62).rotateY(Math.PI / 2); return mergePlain([a, b]); });
  const windMat = cached(matCache, 'windCore', () => new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x2a5a7a }));
  function makeWindCharge() {
    const g = new THREE.Group(); g.name = 'windCharge';
    const core = new THREE.Mesh(windCoreGeo, windMat), sw = new THREE.Mesh(swirlGeo, swirlMat);
    g.add(core, sw);
    g.update = (dt) => { core.rotation.y += dt * 9; core.rotation.x += dt * 4; sw.rotation.y -= dt * 7; sw.rotation.z += dt * 3; };
    return g;
  }

  // Optional: compile every program variant up front (call after lights are in the scene).
  function precompile(renderer, scene, camera) {
    const tmp = new THREE.Group(), rigs = ['hero', ...MOB_KINDS].map((k) => new Rig(k));
    rigs.forEach((r, i) => { r.root.position.set(i, -50, 0); r.setFriend(i % 2 === 0); tmp.add(r.root); });
    const sp = makeSpawner(); sp.setMob('zombie'); tmp.add(sp.group, makeChest().group, makeLadder(2), makeTorch().group, makeArrow(true), makeArrow(false), makeWindCharge(), makeHeart3D());
    for (const k of ['diamond', 'goldenApple', 'cookie', 'emerald', 'poppy', 'trophy']) tmp.add(makeItem(k));
    scene.add(tmp); renderer.compile(scene, camera); scene.remove(tmp);
    rigs.forEach((r) => r.dispose());
  }

  return {
    makeHero, makeMob, makeHeart3D, makeChest, makeSpawner, makeLadder, makeItem, makeTorch, makeArrow, makeWindCharge,
    precompile, kinds: MOB_KINDS.slice(), defs: DEFS,
    dispose() { for (const o of owned) if (o && o.dispose) o.dispose(); else if (o && typeof o === 'object') for (const k in o) if (o[k] && o[k].dispose) o[k].dispose(); },
  };
}
