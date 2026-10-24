// src/textures.js — Critter Battle Tower 3D: procedural Minecraft-style pixel art.
// Owner: Voxel Art builder. Interface (spec section 9):
//   export function createTextures(THREE) -> { blocks, sprites, icons, ...extras }
// Everything is generated at startup from a seeded RNG (identical on every load).
// Block textures are 16x16 tileable pixel grids, sprites are small transparent pixel grids,
// icons are 96x96 PNG data URLs upscaled with smoothing off. No letters are drawn anywhere.
//
// Extra fields (optional, used by src/models.js, safe to ignore):
//   skins   { hero, zombie, skeleton, stray, spider, caveSpider, redSpider, creeper, breeze, golem, chest }
//           -> { width, height, rects, map, friendMap, glowMap, friendGlowMap, canvas, friendCanvas }
//   items   { diamond, goldenApple, cookie, emerald, poppy, trophy, bow0..bow3, heart7, star5 } -> { pix, canvas, texture }
//   blocks also has extras: mossyCobble2, mossyCobble3, stoneBricksMossy, chestInside, chestBottom,
//           windowSunsetTop, windowSunsetBottom, leaves, floweringLeaves, flowerPink, windBand, black
//   icons also has: handUp
//   Pix, mulberry32 helpers are exported for models.js.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tiny RGBA pixel buffer. Colors are 0xRRGGBB ints.
export class Pix {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Uint8ClampedArray(w * h * 4); }
  inb(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  set(x, y, c, a = 255) {
    x |= 0; y |= 0;
    if (c === null || c === undefined || !this.inb(x, y)) return;
    const i = (y * this.w + x) * 4, d = this.d;
    d[i] = (c >> 16) & 255; d[i + 1] = (c >> 8) & 255; d[i + 2] = c & 255; d[i + 3] = a;
  }
  get(x, y) { const i = (y * this.w + x) * 4, d = this.d; return (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; }
  a(x, y) { return this.inb(x, y) ? this.d[(y * this.w + x) * 4 + 3] : 0; }
  clear(x, y) { if (this.inb(x, y)) this.d[(y * this.w + x) * 4 + 3] = 0; }
  fill(x, y, w, h, c, a = 255) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c, a); }
  blit(src, sx, sy, w, h, dx, dy) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      if (!src.inb(sx + i, sy + j) || !this.inb(dx + i, dy + j)) continue;
      const si = ((sy + j) * src.w + sx + i) * 4, di = ((dy + j) * this.w + dx + i) * 4;
      for (let k = 0; k < 4; k++) this.d[di + k] = src.d[si + k];
    }
  }
  grid(rows, legend, ox = 0, oy = 0, rng = null) {
    for (let j = 0; j < rows.length; j++) {
      const row = rows[j];
      for (let i = 0; i < row.length; i++) {
        const v = legend[row[i]];
        if (v === undefined) continue;
        if (v === null) { this.clear(ox + i, oy + j); continue; }
        this.set(ox + i, oy + j, Array.isArray(v) ? v[((rng ? rng() : 0.5) * v.length) | 0] : v);
      }
    }
    return this;
  }
  outline(c, diag = false) {
    const add = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.a(x, y) > 0) continue;
      let hit = this.a(x - 1, y) || this.a(x + 1, y) || this.a(x, y - 1) || this.a(x, y + 1);
      if (!hit && diag) hit = this.a(x - 1, y - 1) || this.a(x + 1, y - 1) || this.a(x - 1, y + 1) || this.a(x + 1, y + 1);
      if (hit) add.push(x, y);
    }
    for (let k = 0; k < add.length; k += 2) this.set(add[k], add[k + 1], c);
    return this;
  }
  flipY() { const P = new Pix(this.w, this.h); P.blitFlip(this); return P; }
  blitFlip(src) { for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) { const si = (y * src.w + x) * 4, di = ((src.h - 1 - y) * this.w + x) * 4; for (let k = 0; k < 4; k++) this.d[di + k] = src.d[si + k]; } }
  clone() { const P = new Pix(this.w, this.h); P.d.set(this.d); return P; }
  toCanvas() {
    const cv = document.createElement('canvas'); cv.width = this.w; cv.height = this.h;
    const ctx = cv.getContext('2d'); const img = ctx.createImageData(this.w, this.h);
    img.data.set(this.d); ctx.putImageData(img, 0, 0); return cv;
  }
}

// Smooth tileable value noise in [0,1].
function tileNoise(w, h, cell, rng) {
  const gw = Math.max(1, Math.round(w / cell)), gh = Math.max(1, Math.round(h / cell));
  const L = new Float32Array(gw * gh); for (let i = 0; i < L.length; i++) L[i] = rng();
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const fx = (x / w) * gw, fy = (y / h) * gh, x0 = Math.floor(fx), y0 = Math.floor(fy);
    let tx = fx - x0, ty = fy - y0; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const r0 = (y0 % gh) * gw, r1 = ((y0 + 1) % gh) * gw, c0 = x0 % gw, c1 = (x0 + 1) % gw;
    const a = L[r0 + c0], b = L[r0 + c1], c = L[r1 + c0], d = L[r1 + c1];
    out[y * w + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }
  return out;
}

// Fill a rect with a clustered-noise palette (pal dark -> light).
function fillNoise(P, x0, y0, w, h, pal, rng, o = {}) {
  const cell = o.cell || 3, mix = o.mix === undefined ? 0.55 : o.mix;
  const lo = o.lo || 0, hi = o.hi === undefined ? pal.length - 1 : o.hi;
  const N = tileNoise(w, h, cell, rng);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    let v = N[j * w + i] * mix + rng() * (1 - mix);
    if (o.grad) v += o.grad * (0.5 - j / Math.max(1, h - 1));
    P.set(x0 + i, y0 + j, pal[clamp(Math.floor(lo + v * (hi - lo + 1)), lo, hi)]);
  }
}

// ---------------------------------------------------------------- blocks
const STONE = [0x5f5f5f, 0x6f6f6f, 0x808080, 0x909090, 0xa2a2a2, 0xb4b4b4];
const MORTAR = [0x3e3e3e, 0x494949, 0x535353];
const MOSS = [0x34501f, 0x4a6b2f, 0x5a7a3a, 0x6b8f3e, 0x80a64b];

function genCobble(rng, mossAmt) {
  const W = 16, H = 16, P = new Pix(W, H);
  const pts = [];
  for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 3; gx++)
    pts.push([(gx + 0.18 + rng() * 0.64) * W / 3, (gy + 0.18 + rng() * 0.64) * H / 3]);
  pts.push([rng() * W, rng() * H]);
  const base = pts.map(() => 1.3 + rng() * 2.4);
  const cell = new Int16Array(W * H), mortar = new Uint8Array(W * H), idx = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let d1 = 1e9, d2 = 1e9, i1 = 0, ox = 0, oy = 0;
    for (let i = 0; i < pts.length; i++) {
      let dx = x + 0.5 - pts[i][0], dy = y + 0.5 - pts[i][1];
      dx -= W * Math.round(dx / W); dy -= H * Math.round(dy / H);
      const d = Math.sqrt(dx * dx * 0.8 + dy * dy * 1.2);
      if (d < d1) { d2 = d1; d1 = d; i1 = i; ox = dx; oy = dy; } else if (d < d2) d2 = d;
    }
    const k = y * W + x;
    cell[k] = i1; mortar[k] = d2 - d1 < 0.9 ? 1 : 0;
    idx[k] = base[i1] - (ox + oy) * 0.17 + (rng() - 0.5) * 0.8;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x; if (mortar[k]) continue;
    const up = ((y + H - 1) % H) * W + x, lf = y * W + (x + W - 1) % W, dn = ((y + 1) % H) * W + x, rt = y * W + (x + 1) % W;
    if (mortar[up] || cell[up] !== cell[k]) idx[k] += 1.3;
    if (mortar[lf] || cell[lf] !== cell[k]) idx[k] += 0.6;
    if (mortar[dn] || cell[dn] !== cell[k]) idx[k] -= 1.1;
    if (mortar[rt] || cell[rt] !== cell[k]) idx[k] -= 0.5;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x;
    if (mortar[k]) P.set(x, y, MORTAR[rng() < 0.6 ? 1 : rng() < 0.5 ? 0 : 2]);
    else P.set(x, y, STONE[clamp(Math.round(idx[k]), 0, 5)]);
  }
  if (mossAmt > 0) addMoss(P, rng, mossAmt, mortar);
  return P;
}

function addMoss(P, rng, amt, pref) {
  const W = P.w, H = P.h, mask = new Uint8Array(W * H);
  const target = Math.round(W * H * amt);
  let count = 0, guard = 0;
  while (count < target && guard++ < 500) {
    let x = (rng() * W) | 0, y = (rng() * H) | 0;
    for (let t = 0; t < 8 && pref && !pref[y * W + x]; t++) { x = (rng() * W) | 0; y = (rng() * H) | 0; }
    const steps = 6 + ((rng() * 18) | 0);
    for (let s = 0; s < steps && count < target; s++) {
      const k = y * W + x;
      if (!mask[k]) { mask[k] = 1; count++; }
      const r = rng();
      if (r < 0.32) x = (x + 1) % W; else if (r < 0.64) x = (x + W - 1) % W; else if (r < 0.86) y = (y + 1) % H; else y = (y + H - 1) % H;
    }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x; if (!mask[k]) continue;
    const up = mask[((y + H - 1) % H) * W + x], dn = mask[((y + 1) % H) * W + x];
    let i = 2 + (rng() < 0.3 ? 1 : 0) - (rng() < 0.25 ? 1 : 0);
    if (!up) i += 1; if (!dn) i -= 1;
    P.set(x, y, MOSS[clamp(i, 0, 4)]);
  }
}

function genSmoothStone(rng) {
  const P = new Pix(16, 16);
  const C = [0xb5b5b5, 0xbcbcbc, 0xc3c3c3, 0xc8c8c8, 0xcecece, 0xd5d5d5];
  const N = tileNoise(16, 16, 4, rng);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const v = N[y * 16 + x] * 0.55 + rng() * 0.45;
    let i = 1 + Math.floor(v * 4);
    if (x === 1 || y === 1) i = 5; else if (x === 15 || y === 15) i = 0;
    P.set(x, y, C[clamp(i, 0, 5)]);
    if (x === 0 || y === 0) P.set(x, y, rng() < 0.7 ? 0x9b9b9b : rng() < 0.5 ? 0x949494 : 0xa2a2a2);
  }
  return P;
}

function genStoneBricks(rng, mossAmt, crack) {
  const P = new Pix(16, 16);
  const B = [0x666666, 0x727272, 0x7e7e7e, 0x8a8a8a, 0x969696, 0xa4a4a4];
  const isM = (x, y) => y === 7 || y === 15 || (y < 7 && x === 15) || (y > 7 && y < 15 && x === 7);
  const mortar = new Uint8Array(256);
  const N = tileNoise(16, 16, 4, rng);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (isM(x, y)) { mortar[y * 16 + x] = 1; P.set(x, y, rng() < 0.7 ? 0x4e4e4e : 0x585858); continue; }
    let v = 1.6 + N[y * 16 + x] * 1.6 + (rng() - 0.5) * 0.9;
    if (isM(x, (y + 15) % 16)) v += 1.4; if (isM((x + 15) % 16, y)) v += 0.7;
    if (isM(x, (y + 1) % 16)) v -= 1.2; if (isM((x + 1) % 16, y)) v -= 0.6;
    P.set(x, y, B[clamp(Math.round(v), 0, 5)]);
  }
  if (crack) {
    let x = 3 + ((rng() * 9) | 0), y = 1 + ((rng() * 4) | 0);
    for (let s = 0; s < 6; s++) { if (!isM(x, y)) P.set(x, y, 0x4a4a4a); x += rng() < 0.5 ? 1 : 0; y += 1; }
  }
  if (mossAmt) addMoss(P, rng, mossAmt, mortar);
  return P;
}

function genPlanks(rng) {
  const P = new Pix(16, 16);
  const O = [0x7a5c34, 0x9a7b48, 0xa8854f, 0xb8945f, 0xc29d62, 0xcda86d];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) P.set(x, y, O[2 + ((rng() * 3) | 0)]);
  for (let b = 0; b < 4; b++) {
    const y0 = b * 4, end = (rng() * 16) | 0;
    for (let r = 0; r < 3; r++) {
      let x = 0;
      while (x < 16) { const len = 2 + ((rng() * 5) | 0), c = O[rng() < 0.5 ? 1 : (rng() < 0.6 ? 4 : 3)]; for (let k = 0; k < len && x < 16; k++, x++) if (rng() < 0.8) P.set(x, y0 + r, c); x += (rng() * 3) | 0; }
      P.set(end, y0 + r, O[0]);
    }
    for (let x = 0; x < 16; x++) P.set(x, y0 + 3, rng() < 0.85 ? O[0] : 0x6b5030);
    if (b % 2 === 0) { P.set(end + 1, y0 + 1, 0x5f4528); } // nail/knot
  }
  return P;
}

const CH_WOOD = [0x7d4c1d, 0x8f5a24, 0xa3692c, 0xb57937, 0xc48a43, 0xd19b52];
const CH_FRAME = [0x2a1a0b, 0x3a2512, 0x4a311a];
function chestWood(P, rng, x0, y0, w, h, pal = CH_WOOD) {
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) { const len = 2 + ((rng() * 6) | 0), c = pal[1 + ((rng() * 4) | 0)]; for (let k = 0; k < len && x < w; k++, x++) P.set(x0 + x, y0 + y, rng() < 0.85 ? c : pal[2]); }
  }
}
function genChestFaces(rng) {
  const frame = (P, x0, y0, w, h) => { for (let x = 0; x < w; x++) { P.set(x0 + x, y0, CH_FRAME[1]); P.set(x0 + x, y0 + h - 1, CH_FRAME[0]); } for (let y = 0; y < h; y++) { P.set(x0, y0 + y, CH_FRAME[1]); P.set(x0 + w - 1, y0 + y, CH_FRAME[0]); } };
  const side = new Pix(16, 16); chestWood(side, rng, 0, 0, 16, 16); frame(side, 0, 0, 16, 5); frame(side, 0, 5, 16, 11);
  for (let x = 1; x < 15; x++) side.set(x, 1, CH_WOOD[5]);
  const front = side.clone();
  front.grid(['.KK.', 'KWLK', 'KLDK', 'KLDK', 'KDDK', '.KK.'], { K: 0x1e1e1e, W: 0xf2f2f2, L: 0xc8c8c8, D: 0x8a8a8a }, 6, 2);
  const top = new Pix(16, 16); chestWood(top, rng, 0, 0, 16, 16); frame(top, 0, 0, 16, 16);
  for (let x = 1; x < 15; x++) top.set(x, 1, CH_WOOD[5]);
  const bottom = new Pix(16, 16); chestWood(bottom, rng, 0, 0, 16, 16, [0x4a2c10, 0x5a3614, 0x67401a, 0x744a1f, 0x7f5224, 0x8a5a28]); frame(bottom, 0, 0, 16, 16);
  const inside = new Pix(16, 16); chestWood(inside, rng, 0, 0, 16, 16, [0x2e1a08, 0x3a210b, 0x45280e, 0x4f2f12, 0x583515, 0x603a18]); frame(inside, 0, 0, 16, 16);
  return { side, front, top, bottom, inside };
}

function genSpawner(rng) {
  const P = new Pix(16, 16);
  const C = [0x111316, 0x1b1e22, 0x262a2f, 0x343a40, 0x4a535b, 0x66717b];
  const bar = (x, y) => x <= 1 || x >= 14 || y <= 1 || y >= 14 || x === 5 || x === 10 || y === 5 || y === 10;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (!bar(x, y)) continue;
    let i = 2 + (rng() < 0.3 ? 1 : 0) - (rng() < 0.2 ? 1 : 0);
    if (!bar(x, y - 1) || !bar(x - 1, y) || y === 0 || x === 0) i += 2;
    if (!bar(x, y + 1) || !bar(x + 1, y) || y === 15 || x === 15) i -= 1;
    if ((x === 5 || x === 10) && (y === 5 || y === 10)) i = 5;
    P.set(x, y, C[clamp(i, 0, 5)]);
  }
  return P;
}

function genLadder(rng) {
  const P = new Pix(16, 16);
  const L = [0x5a4122, 0x7a5a32, 0x94703f, 0xab8550, 0xc19a62];
  for (let y = 0; y < 16; y++) for (const x0 of [2, 12]) {
    P.set(x0, y, L[2 + (rng() < 0.4 ? 1 : 0)]); P.set(x0 + 1, y, L[1 + (rng() < 0.3 ? 1 : 0)]);
  }
  for (const y0 of [1, 5, 9, 13]) for (let x = 4; x < 12; x++) { P.set(x, y0, L[3 + (rng() < 0.4 ? 1 : 0)]); P.set(x, y0 + 1, L[1 + (rng() < 0.5 ? 1 : 0)]); }
  return P;
}

function genCobweb(rng) {
  const P = new Pix(16, 16);
  const C = [0xc9c9c9, 0xe4e4e4, 0xf7f7f7];
  for (let i = 0; i < 16; i++) {
    if (rng() < 0.85) P.set(i, i, C[(rng() * 3) | 0], 235);
    if (rng() < 0.85) P.set(15 - i, i, C[(rng() * 3) | 0], 235);
    if (rng() < 0.7) P.set(7 + (i % 2), i, C[(rng() * 3) | 0], 220);
    if (rng() < 0.7) P.set(i, 7 + (i % 2), C[(rng() * 3) | 0], 220);
  }
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const r = Math.abs(x - 7.5) + Math.abs(y - 7.5);
    if ((Math.abs(r - 4) < 0.6 || Math.abs(r - 9) < 0.6) && rng() < 0.65) P.set(x, y, C[1 + ((rng() * 2) | 0)], 230);
  }
  P.fill(7, 7, 2, 2, 0xffffff);
  return P;
}

function genWindow(rng, kind) {
  const P = new Pix(16, 16);
  if (kind === 'sky') {
    const S = [0x6c9cf2, 0x78a7f6, 0x84b1fa, 0x92bcff];
    fillNoise(P, 0, 0, 16, 16, S, rng, { cell: 8, mix: 0.8 });
    for (let c = 0; c < 2; c++) {
      const cy = 3 + c * 7 + ((rng() * 2) | 0), cx = (rng() * 16) | 0, len = 6 + ((rng() * 5) | 0);
      for (let i = 0; i < len; i++) { P.set((cx + i) % 16, cy, 0xffffff); if (i > 1 && i < len - 2) P.set((cx + i) % 16, cy - 1, 0xf2f6ff); P.set((cx + i) % 16, cy + 1, 0xd5e2f6); }
    }
    return P;
  }
  const S = [0xb8401c, 0xd2521f, 0xe66526, 0xf27a2c, 0xf98f34, 0xfda544, 0xffbf5e, 0xffdc94];
  for (let y = 0; y < 16; y++) {
    const g = kind === 'sunsetTop' ? 5.2 - y / 8 : kind === 'sunsetBottom' ? 3.2 - y / 7 : 3.6 - y / 16;
    for (let x = 0; x < 16; x++) P.set(x, y, S[clamp(Math.round(g + (rng() - 0.5) * 0.9), 0, 7)]);
  }
  for (let c = 0; c < 3; c++) {
    const cy = 2 + c * 5 + ((rng() * 2) | 0), cx = (rng() * 16) | 0, len = 4 + ((rng() * 6) | 0);
    const col = c === 1 ? S[1] : S[6];
    for (let i = 0; i < len; i++) P.set((cx + i) % 16, cy, col);
  }
  if (kind === 'sunsetTop') { P.fill(9, 9, 4, 4, 0xfff3c4); P.fill(10, 8, 2, 6, 0xfff3c4); P.fill(8, 10, 6, 2, 0xfff3c4); P.fill(10, 10, 2, 2, 0xffffff); }
  return P;
}

const GRASS = [0x3d6a22, 0x4a7d2a, 0x579032, 0x64a13a, 0x74b345];
const DIRT = [0x5a3c25, 0x6b4a2f, 0x79573a, 0x866244, 0x94704f];
function genGrassTop(rng) { const P = new Pix(16, 16); fillNoise(P, 0, 0, 16, 16, GRASS, rng, { cell: 4, mix: 0.4 }); return P; }
function genDirt(rng) {
  const P = new Pix(16, 16); fillNoise(P, 0, 0, 16, 16, DIRT, rng, { cell: 4, mix: 0.4 });
  for (let k = 0; k < 7; k++) { const x = (rng() * 16) | 0, y = (rng() * 16) | 0; P.set(x, y, 0x9a8a78); P.set(x + 1, y, 0x7f7062); }
  return P;
}
function genGrassSide(rng) {
  const P = genDirt(rng);
  for (let x = 0; x < 16; x++) {
    const d = 2 + ((rng() * 2.4) | 0) + (rng() < 0.2 ? 2 : 0);
    for (let y = 0; y < d; y++) P.set(x, y, GRASS[clamp(3 - y + ((rng() * 2) | 0) - 1, 0, 4)]);
  }
  return P;
}

function genTorch() {
  const P = new Pix(16, 16);
  for (let y = 8; y < 16; y++) { P.set(7, y, y % 3 === 0 ? 0x9a7642 : 0x8a6a3a); P.set(8, y, y % 4 === 1 ? 0x5a4122 : 0x6b4f2a); }
  P.grid(['YW', 'OY'], { W: 0xffffff, Y: 0xffe27a, O: 0xffa830 }, 7, 6);
  return P;
}

function genFlower(rng, kind) {
  const P = new Pix(16, 16);
  const G = [0x2f6b1c, 0x3f8a26, 0x56a832];
  for (let y = 7; y < 16; y++) P.set(7 + (y > 12 ? 1 : 0), y, G[(y % 2) + 1]);
  P.grid(['GG.', '.GG'], { G: G[1] }, 4, 10); P.grid(['.GG', 'GG.'], { G: G[2] }, 9, 12);
  if (kind === 'yellow') {
    P.grid(['.YYY.', 'YYWYY', 'YWOWY', 'YYWYY', '.YYY.'], { Y: 0xf5c71a, W: 0xfff59a, O: 0xffe53b }, 5, 3);
  } else if (kind === 'pink') {
    P.grid(['.P.P.', 'PLPLP', 'PPWPP', '.PPP.', '..P..'], { P: 0xe86aa6, L: 0xffa9d0, W: 0xfff0f7 }, 5, 3);
  } else {
    P.grid(['.RR.RR.', 'RLRRRRR', 'RRRKRRD', '.RRRRD.', '..RRD..'], { R: 0xe0242a, L: 0xff6a6a, D: 0xa8161c, K: 0x2a1408 }, 4, 2);
  }
  return P;
}

function genLeaves(rng, flowering) {
  const P = new Pix(16, 16);
  const L = [0x24561a, 0x2f6a20, 0x3b7f28, 0x4a9431, 0x5aa83a];
  fillNoise(P, 0, 0, 16, 16, L, rng, { cell: 3, mix: 0.5 });
  for (let k = 0; k < 18; k++) P.clear((rng() * 16) | 0, (rng() * 16) | 0);
  if (flowering) {
    const spots = [[2, 2], [9, 1], [12, 7], [4, 9], [10, 12], [1, 13], [7, 5]];
    spots.forEach(([x, y], i) => P.grid(['P.P', 'PPP', '.P.'], { P: i % 3 === 2 ? 0xe0303a : (i % 2 ? 0xf47fb3 : 0xff9ccc) }, x, y));
    spots.forEach(([x, y]) => P.set(x, y, 0xffd0e6));
  }
  return P;
}

function genWindBand(rng) {
  const P = new Pix(16, 8);
  for (let s = 0; s < 10; s++) {
    const y = (rng() * 8) | 0, x0 = (rng() * 16) | 0, len = 5 + ((rng() * 7) | 0);
    for (let i = 0; i < len; i++) P.set((x0 + i) % 16, (y + (i > len / 2 ? 1 : 0)) % 8, i === 0 ? 0xc8d8ff : rng() < 0.55 ? 0x6278d8 : 0x4252a8, 225);
  }
  return P;
}

// ---------------------------------------------------------------- shapes, sprites, items
// Rasterize an inside(x,y) predicate with top-left lighting shading and an optional outline.
function shapePix(w, h, inside, pal, outline = 0x1a1a1a, light = 1) {
  const P = new Pix(w, h);
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x + 0.5, y + 0.5)) { sx += x; sy += y; n++; }
  if (!n) return P;
  const cx = sx / n, cy = sy / n; let md = 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x + 0.5, y + 0.5)) md = Math.max(md, Math.abs(x - cx) + Math.abs(y - cy));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!inside(x + 0.5, y + 0.5)) continue;
    const l = (-(x - cx) - (y - cy) * 1.1) / md * light;
    let k = Math.round((l * 0.5 + 0.5) * (pal.length - 1) * 0.95 + 0.35);
    if (!inside(x + 1.5, y + 0.5) || !inside(x + 0.5, y + 1.5)) k -= 1;
    P.set(x, y, pal[clamp(k, 0, pal.length - 1)]);
  }
  if (outline !== null) P.outline(outline);
  return P;
}
const inPoly = (pts) => (x, y) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
function starPts(cx, cy, R, r) { const p = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r : R; p.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]); } return p; }
const heartIn = (cx, cy, s) => (x, y) => { const X = (x - cx) / s, Y = -(y - cy) / s; const q = X * X + Y * Y - 1; return q * q * q - X * X * Y * Y * Y <= 0; };

const HEART7 = ['.LR.RR.', 'RWRRRRR', 'RRRRRRD', '.RRRRD.', '..RRD..', '...D...'];
const HEART7_COL = { L: 0xf0464e, R: 0xe3262e, D: 0xa8141c, W: 0xffb6c4 };
function heart7() { return new Pix(7, 6).grid(HEART7, HEART7_COL); }
function heartSprite() { const P = new Pix(9, 9); P.grid(HEART7, HEART7_COL, 1, 1); P.outline(0x5a0a10); return P; }

function windSwirl() {
  const P = new Pix(16, 16);
  for (let t = 0; t < 10.4; t += 0.04) {
    const r = 0.5 + t * 0.66, x = 7.5 + Math.cos(t) * r, y = 7.5 + Math.sin(t) * r * 0.92;
    P.set(Math.round(x), Math.round(y), r < 2.6 ? 0xffffff : r < 4.8 ? 0xcdeeff : 0x8fd0ff);
  }
  return P;
}
function smokeSprite() {
  return new Pix(8, 8).grid(['..aaaa..', '.abbbba.', 'abbccbba', 'abccccba', 'abccccba', 'abbccbba', '.abbbba.', '..aaaa..'], { a: 0x6e6e6e, b: 0x9a9a9a, c: 0xc4c4c4 });
}
function sparkleSprite() {
  return new Pix(7, 7).grid(['...w...', '...y...', '..wyw..', 'wyyWyyw', '..wyw..', '...y...', '...w...'], { w: 0xfff6c8, y: 0xffe873, W: 0xffffff });
}
function starPix(pal, outline) { return shapePix(16, 16, inPoly(starPts(7.5, 8.4, 7.6, 3.2)), pal, outline); }
function xpOrb() {
  return new Pix(8, 8).grid(['..KKKK..', '.KLLGGK.', 'KLWLGGGK', 'KLLGGGDK', 'KGGGGGDK', 'KGGGGDDK', '.KGDDDK.', '..KKKK..'], { K: 0x2c5a07, W: 0xffffc0, L: 0xd8ff6a, G: 0x9be52a, D: 0x5fae12 });
}
function flameSprite() {
  return new Pix(8, 8).grid(['...w....', '...wy...', '..wyy...', '..yyoy..', '.yyooy..', '.yoorry.', '.yorrro.', '..oorr..'], { w: 0xfffbd0, y: 0xffd84a, o: 0xff9a2a, r: 0xe8501a });
}
function confettiSprite() { return new Pix(4, 4).grid(['WWWw', 'WWWw', 'WWWw', 'wwwg'], { W: 0xffffff, w: 0xe6e6e6, g: 0xc8c8c8 }); }

const GEM_D = { K: 0x0d3b3c, W: 0xffffff, L: 0xb9fbf6, C: 0x4ae3dd, D: 0x1d9e9a };
function diamondPix() {
  return new Pix(16, 16).grid(['', '', '', '....KKKKKKKK', '...KWWLLLLCCK', '..KWLLLCCCCCDK', '.KLLCCCCCCCCDDK', '.KCCCCCCCCCDDDK', '..KCCCCCCCCDDK', '...KCCCCCCDDK', '....KCCCCDDK', '.....KCCDDK', '......KCDK', '.......KK'], GEM_D);
}
function emeraldPix() {
  return new Pix(16, 16).grid(['', '......KKKK', '.....KWLLGK', '....KWLGGGGK', '....KLGGGGGK', '...KLGGGGGGDK', '...KLGGGGGGDK', '...KGGGGGGGDK', '...KGGGGGGDDK', '...KGGGGGGDDK', '....KGGGGGDK', '....KGGGGDDK', '.....KGGDDK', '......KKKK'], { K: 0x0a3a19, W: 0xeaffef, L: 0x8df5a7, G: 0x2ccf5d, D: 0x138a3b });
}
function goldenApplePix() {
  const lobe = (cx, cy, r) => (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
  const A = lobe(6, 9, 4.6), B = lobe(10, 9, 4.6), C = lobe(8, 10.5, 4.6);
  const P = shapePix(16, 16, (x, y) => (A(x, y) || B(x, y) || C(x, y)) && !(y < 6 && Math.abs(x - 8) < 1.2), [0x8a5400, 0xc98a08, 0xf2bd1c, 0xffdc3c, 0xfff07a], null);
  P.set(5, 7, 0xffffd8); P.set(5, 8, 0xffffd8); P.set(6, 7, 0xfff7b0);
  P.grid(['.K', 'KB', 'KB', 'KB'], { K: 0x3a2410, B: 0x6b4423 }, 7, 1);
  P.grid(['.GG', 'GGL', 'GG.'], { G: 0x3f9a2a, L: 0x7fd14a }, 9, 2);
  P.outline(0x4a2f00); return P;
}
function cookiePix(rng) {
  const P = shapePix(16, 16, (x, y) => (x - 8) * (x - 8) + (y - 8) * (y - 8) <= 42, [0x9c5f24, 0xc07a35, 0xd6944a, 0xe6ab61], null, 0.6);
  [[5, 5], [9, 4], [11, 8], [6, 10], [9, 11], [4, 8], [8, 7]].forEach(([x, y]) => { P.set(x, y, 0x3a1d0c); if (rng() < 0.6) P.set(x + 1, y, 0x4e2a12); });
  P.outline(0x4a2810); return P;
}
function trophyPix() {
  const cup = (x, y) => (y >= 2 && y < 9.5 && Math.abs(x - 8) <= 5.2 - (y - 2) * 0.32) || (y >= 9.5 && y < 12 && Math.abs(x - 8) < 1.2) || (y >= 12 && y < 15 && Math.abs(x - 8) < 4.2 - (y - 12) * -0.2);
  const handle = (x, y) => { for (const cx of [2.6, 13.4]) { const d = Math.hypot(x - cx, y - 5); if (d < 2.6 && d > 1.2 && Math.abs(x - 8) > 4.5) return true; } return false; };
  const P = shapePix(16, 16, (x, y) => cup(x, y) || handle(x, y), [0x8a5400, 0xc98a08, 0xf2bd1c, 0xffdc3c, 0xfff6a8], null);
  P.set(5, 3, 0xffffff); P.set(5, 4, 0xfffbe0); P.fill(4, 12, 8, 1, 0x7a4a10);
  P.outline(0x4a2f00); return P;
}
function bowPix(stage) {
  const P = new Pix(16, 16);
  const W = [0x3c2612, 0x5e3e1e, 0x80582c, 0xa47a44];
  let prev = null;
  for (let y = 1; y <= 14; y++) {
    const t = (y - 1) / 13, x = Math.round(9.4 - 5.4 * Math.sin(Math.PI * t));
    const xa = prev === null ? x : Math.min(x, prev), xb = prev === null ? x : Math.max(x, prev);
    for (let xx = xa; xx <= xb; xx++) { P.set(xx, y, W[1]); P.set(xx + 1, y, W[3]); }
    prev = x;
  }
  for (let y = 6; y <= 9; y++) { P.set(4, y, W[0]); P.set(5, y, 0x2a1a0c); P.set(6, y, W[0]); }
  const pull = stage === 0 ? 0 : stage + 1;
  const line = (x0, y0, x1, y1) => { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); for (let i = 0; i <= n; i++) P.set(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), 0xdedede); };
  line(10, 1, 10 + pull, 7); line(10 + pull, 8, 10, 14);
  if (stage > 0) {
    for (let x = 2; x < 10 + pull; x++) P.set(x, 7, 0x7a5530);
    P.grid(['.L', 'LDD', '.L'], { L: 0xdadada, D: 0x9a9a9a }, 0, 6);
    P.set(9 + pull, 6, 0xffffff); P.set(9 + pull, 8, 0xe0e0e0); P.set(8 + pull, 6, 0xf0f0f0); P.set(8 + pull, 8, 0xcfcfcf);
  }
  return P;
}
function star5() { return new Pix(5, 5).grid(['..Y..', '.YWY.', 'YYYYY', '.YYY.', '.Y.Y.'], { Y: 0xffd23a, W: 0xfff8c0 }); }

// ---------------------------------------------------------------- HUD icons (96x96 PNG data URLs)
function iconURL(P, size = 96) {
  const s = Math.max(1, Math.floor(size / Math.max(P.w, P.h)));
  const cv = document.createElement('canvas'); cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
  ctx.drawImage(P.toCanvas(), Math.floor((size - P.w * s) / 2), Math.floor((size - P.h * s) / 2), P.w * s, P.h * s);
  return cv.toDataURL('image/png');
}
const HEART9 = ['.KK...KK.', 'KHHK.KRRK', 'KHRRKRRRK', 'KRRRRRRDK', '.KRRRRRDK', '..KRRRDK.', '...KRDK..', '....KK...'];
const OUT = 0x1c1c24;
function makeIcons(rng) {
  const I = {};
  I.heartFull = iconURL(new Pix(9, 8).grid(HEART9, { K: 0x2a0508, H: 0xffc0c8, R: 0xe8262e, D: 0xa8141c }));
  I.heartEmpty = iconURL(new Pix(9, 8).grid(HEART9, { K: 0x1a1a1a, H: 0x5a5a5a, R: 0x3c3c3c, D: 0x2e2e2e }));
  I.diamond = iconURL(diamondPix());
  I.emerald = iconURL(emeraldPix());
  I.star = iconURL(starPix([0xc8860c, 0xf0b020, 0xffd640, 0xffe880, 0xfff6c0], 0x6a4000));
  I.starEmpty = iconURL(starPix([0x3a3a3a, 0x4a4a4a, 0x5a5a5a, 0x6a6a6a], 0x1a1a1a));
  const spk = new Pix(16, 16).grid(['', '......KK', '.....KWK', '....KWWK', '.KKKWWWK', 'KWWWWWWK', 'KWWWWWWK', 'KWWWWWWK', 'KWWWWWWK', 'KGGGWWWK', '.KKKGWWK', '....KGWK', '.....KGK', '......KK'], { K: OUT, W: 0xffffff, G: 0xc8cdd8 }, 0, 1);
  const on = spk.clone();
  for (let y = 0; y < 16; y++) for (let x = 8; x < 16; x++) { const dx = x + 0.5 - 6.5, dy = y + 0.5 - 8, r = Math.hypot(dx, dy), a = Math.abs(Math.atan2(dy, dx)); if (a < 0.78 && ((r > 3.6 && r < 5.0) || (r > 6.6 && r < 8.0))) on.set(x, y, 0xffffff); }
  I.speakerOn = iconURL(on.outline(OUT));
  const off = spk.clone();
  for (let i = 0; i < 9; i++) { off.set(8 + i * 0.85, 3 + i * 1.15, 0xe8323a); off.set(9 + i * 0.85, 3 + i * 1.15, 0xff5a5a); }
  I.speakerOff = iconURL(off.outline(OUT));
  I.home = iconURL(new Pix(16, 16).grid(['', '.......KK', '......KLRK', '.....KLRRRK', '....KLRRRRRK', '...KLRRRRRRRK', '..KLRRRRRRRRRK', '.KKKKKKKKKKKKKK', '..KWWWWWWWWWWK', '..KWWBBBWWSSWK', '..KWWBBBWWSSWK', '..KWWBYBWWWWWK', '..KWWBBBWWWWWK', '..KWWBBBWWWWWK', '..KKKKKKKKKKKK'], { K: OUT, L: 0xf07060, R: 0xd8443a, W: 0xf4ead8, B: 0x8a5a2b, Y: 0xffd040, S: 0x9fd8ff }));
  I.play = iconURL(shapePix(16, 16, inPoly([[4.2, 1.6], [14, 8], [4.2, 14.4]]), [0xb8c0d0, 0xdde2ea, 0xffffff, 0xffffff], OUT));
  const head = inPoly([[12.2, 3.6], [8.4, -0.2], [7.4, 6.0]]);
  const rs = shapePix(16, 16, (x, y) => { const dx = x - 7.5, dy = y - 8.3, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx); return (r >= 4.0 && r <= 6.3 && !(a > -1.4 && a < -0.2)) || head(x, y); }, [0xb8c0d0, 0xdde2ea, 0xffffff, 0xffffff], null);
  I.restart = iconURL(rs.outline(OUT));
  const hb = shapePix(16, 16, heartIn(8, 7.6, 6.6), [0xa0102a, 0xd8203e, 0xf04466, 0xff7a96, 0xffb0c4], OUT);
  hb.grid(['.W.', 'WWW', '.W.'], { W: 0xffffff }, 4, 4);
  [[0, 0], [13, 0], [0, 13], [13, 13]].forEach(([x, y]) => hb.grid(['.Y.', 'YWY', '.Y.'], { Y: 0xffd23a, W: 0xffffff }, x, y));
  I.heartBomb = iconURL(hb);
  const hand = new Pix(16, 16).grid(['......KKK', '.....KWWWK', '.....KWWWK', '.....KWWWK', '.....KWWWKKK', '.....KWWWKWWKK', '.KK..KWWWKWWKWK', 'KWWK.KWWWKWWKWWK', 'KWWWKKWWWWWWWWWK', '.KWWWWWWWWWWWWWK', '..KWWWWWWWWWWWGK', '...KWWWWWWWWWWGK', '...KWWWWWWWWWGK', '....KWWWWWWWGK', '.....KGGGGGGK', '......KKKKKK'], { K: OUT, W: 0xffffff, G: 0xc8cdd8 });
  I.handUp = iconURL(hand);
  const down = new Pix(16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const si = (y * 16 + x) * 4, di = ((15 - y) * 16 + (15 - x)) * 4; for (let k = 0; k < 4; k++) down.d[di + k] = hand.d[si + k]; }
  I.hand = iconURL(down);
  I.arrowDown = iconURL(shapePix(16, 16, inPoly([[5.5, 0.6], [10.5, 0.6], [10.5, 7.5], [14.6, 7.5], [8, 15], [1.4, 7.5], [5.5, 7.5]]), [0xb87a00, 0xe8a810, 0xffd23a, 0xffe880], 0x4a2f00));
  return I;
}

// ---------------------------------------------------------------- mob skins (Minecraft cross layout)
// Each box [name, w, h, d] gets a region (2d+2w) x (d+h):  row 0: [top w*d][bottom w*d] at x=U+d;
// row 1: [nx d*h][front pz w*h][px d*h][back nz w*h]. Orientation matches models.js box UVs.
export const SKIN_BOXES = {
  hero: [['head', 8, 8, 8], ['hair', 8, 8, 8], ['hairTail', 8, 10, 1], ['body', 8, 12, 4], ['armR', 3, 12, 4], ['armL', 3, 12, 4], ['legR', 4, 12, 4], ['legL', 4, 12, 4]],
  zombie: [['head', 8, 8, 8], ['body', 8, 12, 4], ['armR', 4, 12, 4], ['armL', 4, 12, 4], ['legR', 4, 12, 4], ['legL', 4, 12, 4]],
  skeleton: [['head', 8, 8, 8], ['body', 8, 12, 4], ['armR', 2, 12, 2], ['armL', 2, 12, 2], ['legR', 2, 12, 2], ['legL', 2, 12, 2]],
  stray: [['head', 8, 8, 8], ['body', 8, 12, 4], ['armR', 2, 12, 2], ['armL', 2, 12, 2], ['legR', 2, 12, 2], ['legL', 2, 12, 2], ['hood', 8, 8, 8], ['cloak', 8, 12, 4], ['armRRag', 2, 12, 2], ['armLRag', 2, 12, 2], ['legRRag', 2, 12, 2], ['legLRag', 2, 12, 2]],
  spider: [['head', 8, 8, 8], ['neck', 6, 6, 6], ['abdomen', 10, 8, 12], ['leg', 16, 2, 2]],
  creeper: [['head', 8, 8, 8], ['body', 8, 12, 4], ['leg', 4, 6, 4]],
  breeze: [['head', 8, 8, 8], ['rod', 2, 8, 2]],
  golem: [['head', 8, 10, 8], ['nose', 2, 4, 2], ['chest', 18, 12, 11], ['waist', 9, 5, 6], ['armR', 4, 30, 6], ['armL', 4, 30, 6], ['thighR', 6, 8, 5], ['shinR', 6, 8, 5], ['thighL', 6, 8, 5], ['shinL', 6, 8, 5]],
};
SKIN_BOXES.caveSpider = SKIN_BOXES.spider; SKIN_BOXES.redSpider = SKIN_BOXES.spider;
const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'], SIDES = ['px', 'nx', 'pz', 'nz'];

function boxFaces(U, V, w, h, d) {
  return { py: [U + d, V, w, d], ny: [U + d + w, V, w, d], nx: [U, V + d, d, h], pz: [U + d, V + d, w, h], px: [U + d + w, V + d, d, h], nz: [U + 2 * d + w, V + d, w, h] };
}
function layoutSkin(boxes, W) {
  const items = boxes.map(([name, w, h, d]) => ({ name, w, h, d, rw: 2 * (d + w), rh: d + h })).sort((a, b) => b.rh - a.rh);
  let x = 0, y = 0, sh = 0;
  const rects = {};
  for (const it of items) {
    if (x + it.rw > W) { x = 0; y += sh; sh = 0; }
    rects[it.name] = { U: x, V: y, w: it.w, h: it.h, d: it.d, faces: boxFaces(x, y, it.w, it.h, it.d) };
    x += it.rw; sh = Math.max(sh, it.rh);
  }
  let H = 16; while (H < y + sh) H *= 2;
  return { rects, W, H };
}

class SkinPainter {
  constructor(P, G, rects, rng) { this.P = P; this.G = G; this.R = rects; this.rng = rng; }
  f(b, f) { return this.R[b].faces[f]; }
  fill(b, f, pal, o = {}) { const [x, y, w, h] = this.f(b, f); fillNoise(this.P, x, y, w, h, pal, this.rng, Object.assign({ cell: 2 }, o)); }
  fillBox(b, pal, o) { for (const f of FACES) this.fill(b, f, pal, o); }
  px(b, f, i, j, c, a = 255) { const [x, y, w, h] = this.f(b, f); if (i >= 0 && j >= 0 && i < w && j < h) this.P.set(x + i, y + j, c, a); }
  glow(b, f, i, j, c) { const [x, y] = this.f(b, f); this.G.set(x + i, y + j, c); }
  clearPx(b, f, i, j) { const [x, y, w, h] = this.f(b, f); if (i >= 0 && j >= 0 && i < w && j < h) this.P.clear(x + i, y + j); }
  clearBox(b) { for (const f of FACES) { const [x, y, w, h] = this.f(b, f); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.P.clear(x + i, y + j); } }
  rows(b, f, j0, j1, pal) { const [, , w] = this.f(b, f); for (let j = j0; j <= j1; j++) for (let i = 0; i < w; i++) this.px(b, f, i, j, pal[(this.rng() * pal.length) | 0]); }
  grid(b, f, rows, legend, oi = 0, oj = 0) {
    for (let j = 0; j < rows.length; j++) for (let i = 0; i < rows[j].length; i++) {
      const v = legend[rows[j][i]];
      if (v === undefined) continue;
      if (v === null) { this.clearPx(b, f, oi + i, oj + j); continue; }
      this.px(b, f, oi + i, oj + j, Array.isArray(v) ? v[(this.rng() * v.length) | 0] : v);
    }
  }
  each(b, f, fn) { const [, , w, h] = this.f(b, f); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const c = fn(i, j, w, h); if (c === null) this.clearPx(b, f, i, j); else if (c !== undefined) this.px(b, f, i, j, c); } }
  speckle(b, cols, p) { for (const f of FACES) this.each(b, f, () => (this.rng() < p ? cols[(this.rng() * cols.length) | 0] : undefined)); }
}

const pick = (rng, a) => a[(rng() * a.length) | 0];

function paintHero(S, v) {
  const SK = [0xd99a76, 0xe6ad88, 0xf0c09d, 0xf7d2b4, 0xfce2cc];
  const HR = [0x3d1d63, 0x4f2880, 0x63349a, 0x7843b2, 0x8f5bc9];
  const ST = [0xb68be6, 0xcaa6f2, 0xdcc2fb];
  const HD = [0x7c66b5, 0x917cc7, 0xa692d6, 0xb9a7e2, 0xcbbcec, 0xdcd1f5];
  const JN = [0x1b244e, 0x232f66, 0x2c3a7c, 0x374892, 0x4457a6];
  const r = S.rng;
  S.fillBox('head', SK, { lo: 1, hi: 3, mix: 0.3 });
  S.fill('head', 'py', HR, { lo: 1, hi: 4 }); S.fill('head', 'nz', HR, { lo: 1, hi: 4 });
  for (const f of ['nx', 'px']) S.each('head', f, (i, j) => { const toBack = f === 'nx' ? i : 7 - i; return j < 3 || toBack < 4 || (j < 6 && toBack < 6) ? pick(r, HR.slice(1)) : undefined; });
  S.grid('head', 'pz', ['HHHHHHHH', 'HHSHHHSH', 'H......H', 'H......H', 'H......H', 'H......H'], { H: HR.slice(1), S: ST });
  for (let i = 0; i < 8; i++) S.px('head', 'py', 1, i, pick(r, ST)), S.px('head', 'py', 2, i, pick(r, ST.slice(0, 2)));
  for (let j = 0; j < 8; j++) S.px('head', 'nz', 6, j, pick(r, ST));
  const happy = v === 'friend';
  S.grid('head', 'pz', ['', '', '', '.kk..kk.', '.WI..IW.', '.Wi..iW.', '.b.mm.b.', happy ? '...MM...' : ''], { k: 0x3a2250, W: 0xffffff, I: 0x2a1a48, i: 0x7b52d0, b: 0xf2919e, m: happy ? 0xc0505a : 0xb5525e, M: 0xd06070 });
  S.clearBox('hair');
  S.fill('hair', 'py', HR, { lo: 1, hi: 4 }); S.fill('hair', 'nz', HR, { lo: 0, hi: 3 });
  for (const f of ['nx', 'px']) S.each('hair', f, (i, j) => { const toBack = f === 'nx' ? i : 7 - i; return j < 2 || (toBack < 3 && j < 7) ? pick(r, HR) : undefined; });
  S.grid('hair', 'pz', ['HHHHHHHH', 'H.H..H.H', 'H......H', 'H......H', 'H......H'], { H: HR });
  for (let i = 0; i < 8; i++) S.px('hair', 'py', 1, i, pick(r, ST));
  S.fillBox('hairTail', HR, { lo: 0, hi: 4 });
  S.each('hairTail', 'nz', (i, j) => (i === 6 ? pick(r, ST) : j === 9 && (i % 3 === 1) ? null : undefined));
  S.each('hairTail', 'pz', (i, j) => (j === 9 && i % 3 === 1 ? null : undefined));
  S.fillBox('body', HD, { lo: 1, hi: 4 });
  S.grid('body', 'pz', ['dddddddd', '..w..w..', '..w..w..', '.....R.R', '....RRRR', '.....RR.', '', '.pppppp.', '.p....p.', '', '', 'dddddddd'], { d: HD[1], w: 0xffffff, R: 0xe3262e, p: HD[2] });
  S.px('body', 'pz', 5, 3, 0xff8a9a);
  S.grid('body', 'nz', ['dddddddd', 'dhhhhhhd', '.dhhhhd.', '..dddd..'], { d: HD[0], h: HD[1] });
  for (const f of ['nx', 'px', 'nz']) S.rows('body', f, 11, 11, [HD[1]]);
  for (const a of ['armL', 'armR']) {
    S.fillBox(a, HD, { lo: 1, hi: 4 });
    for (const f of SIDES) { S.rows(a, f, 9, 9, [HD[1]]); S.rows(a, f, 10, 11, SK.slice(1, 4)); }
    S.fill(a, 'ny', SK, { lo: 1, hi: 3 });
  }
  for (const l of ['legL', 'legR']) {
    S.fillBox(l, JN, { lo: 1, hi: 4 });
    for (const f of SIDES) { S.rows(l, f, 10, 10, [0xf4f4f4, 0xffffff, 0xe6e6e6]); S.rows(l, f, 11, 11, [0x9a9a9a, 0x8a8a8a]); }
    S.px(l, 'pz', 1, 10, 0xd8d8d8); S.px(l, 'pz', 2, 10, 0xc0c0ff);
    S.fill(l, 'ny', [0x7a7a7a, 0x8a8a8a, 0x9a9a9a]);
  }
}

function paintZombie(S, v) {
  const G = [0x2e5a24, 0x3b6e2e, 0x4a8238, 0x579442, 0x66a64d, 0x7ab85e];
  const GD = [0x203f19, 0x2a4f20, 0x335d27];
  const C = [0x006464, 0x007a7a, 0x008f8f, 0x00a2a2, 0x14b4b4, 0x3cc8c8];
  const P = [0x262066, 0x30297c, 0x3a3292, 0x453ca6, 0x5248b8];
  const r = S.rng;
  S.fillBox('head', G, { lo: 1, hi: 4 });
  S.fill('head', 'py', GD.concat([G[1]]));
  for (const f of SIDES) S.each('head', f, (i, j) => (j === 0 || (j === 1 && r() < 0.55) ? pick(r, GD) : undefined));
  S.fill('head', 'nz', [GD[1], GD[2], G[1], G[2]], { grad: 0.6 });
  const happy = v === 'friend';
  S.grid('head', 'pz', ['', '', '', '.dd..dd.', happy ? '.WE..EW.' : '.EE..EE.', '...NN...', happy ? '.bM..Mb.' : '..MMMM..', happy ? '..MMMM..' : '..mmmm..'],
    { d: G[1], E: 0x0c140b, W: 0xffffff, N: 0x2a4f22, M: 0x203f19, m: G[2], b: 0xe0889a });
  S.fillBox('body', C, { lo: 1, hi: 4 });
  for (const f of SIDES) S.rows('body', f, 10, 11, P.slice(1, 4));
  S.fill('body', 'ny', P);
  S.grid('body', 'pz', ['..gggg..', '...gg...'], { g: G.slice(2, 5) });
  for (const a of ['armL', 'armR']) {
    S.fillBox(a, G, { lo: 1, hi: 4 });
    for (const f of SIDES) S.each(a, f, (i, j) => (j < 4 || (j === 4 && r() < 0.5) ? pick(r, C.slice(1, 5)) : undefined));
    S.fill(a, 'py', C, { lo: 1, hi: 4 });
  }
  for (const l of ['legL', 'legR']) {
    S.fillBox(l, P, { lo: 0, hi: 4 });
    for (const f of SIDES) S.rows(l, f, 10, 11, [0x3c3c3c, 0x4a4a4a, 0x575757]);
    S.fill(l, 'ny', [0x333333, 0x3c3c3c, 0x4a4a4a]);
  }
}

function paintSkeleton(S, v, B, K, stray) {
  const r = S.rng;
  S.fillBox('head', B, { lo: 2, hi: 5 });
  S.fill('head', 'py', B, { lo: 3, hi: 5 });
  const happy = v === 'friend';
  S.grid('head', 'pz', ['', '', '', '.ss..ss.', happy ? '.KW..WK.' : '.KK..KK.', '...kk...', '.tKtKtK.', happy ? '.b....b.' : ''],
    { s: B[1], K: K[0], k: K[1], W: 0xffffff, t: B[4], b: 0xe8a0b0 });
  S.fillBox('body', [K[1], K[2], K[2]], {});
  S.each('body', 'pz', (i, j) => (j === 0 || ((j === 2 || j === 4 || j === 6) && i > 0 && i < 7) || ((i === 3 || i === 4) && j < 9) || (j === 9 && i > 0 && i < 7) ? pick(r, B.slice(2, 5)) : undefined));
  S.each('body', 'nz', (i, j) => (j === 0 || ((i === 3 || i === 4) && j < 10) || ((j === 2 || j === 4 || j === 6) && i > 0 && i < 7) ? pick(r, B.slice(2, 5)) : undefined));
  for (const f of ['px', 'nx']) S.each('body', f, (i, j) => (j === 0 || j === 2 || j === 4 || j === 6 || j === 9 ? pick(r, B.slice(2, 4)) : undefined));
  S.fill('body', 'py', B, { lo: 2, hi: 4 });
  for (const p of ['armL', 'armR', 'legL', 'legR']) {
    S.fillBox(p, B, { lo: 2, hi: 5 });
    for (const f of SIDES) { S.rows(p, f, 5, 5, [B[1]]); S.rows(p, f, 11, 11, [B[1], B[2]]); }
  }
  if (!stray) return;
  const R = [0x48585f, 0x55666e, 0x62747d, 0x6f828b, 0x7c8f98], FR = [0xb4d0dc, 0xdcedf4];
  S.clearBox('hood');
  S.fill('hood', 'py', R, { lo: 1, hi: 4 }); S.fill('hood', 'nz', R, { lo: 0, hi: 3 });
  for (const f of ['px', 'nx']) S.each('hood', f, (i, j) => (j < 3 || (j < 6 + ((r() * 2) | 0) && (f === 'nx' ? i : 7 - i) < 4) ? pick(r, R) : undefined));
  S.grid('hood', 'pz', ['RRRRRRRR', 'R.R..R.R', 'R......R'], { R: R });
  S.speckle('hood', FR, 0.05);
  S.fillBox('cloak', R, { lo: 0, hi: 4 });
  for (const f of SIDES) S.each('cloak', f, (i, j) => (j >= 7 && r() < (j - 6) * 0.3 ? null : (r() < 0.06 ? pick(r, FR) : undefined)));
  S.each('cloak', 'pz', (i, j) => ((i === 3 || i === 4) && j > 1 && j < 9 ? null : undefined));
  for (const p of ['armLRag', 'armRRag', 'legLRag', 'legRRag']) {
    S.fillBox(p, R, { lo: 0, hi: 4 });
    const top = p.startsWith('arm') ? 5 : 6;
    for (const f of SIDES) S.each(p, f, (i, j) => (j > top + ((r() * 3) | 0) ? null : undefined));
    S.each(p, 'ny', () => null);
  }
}

function paintSpider(S, v, pal, accent, eyeBig, eyeSmall) {
  const r = S.rng;
  S.fillBox('head', pal, { lo: 1, hi: 4 });
  S.fillBox('neck', pal, { lo: 0, hi: 3 });
  S.fillBox('abdomen', pal, { lo: 1, hi: 4 });
  for (const f of ['py', 'nz']) S.each('abdomen', f, (i, j, w, h) => { const cx = Math.abs(i - (w - 1) / 2); return (cx < 1 && j % 3 !== 2) || (Math.abs(cx - j * 0.45 - 0.5) < 0.6 && j < h - 2) ? pick(r, accent) : undefined; });
  S.fillBox('leg', pal, { lo: 0, hi: 3 });
  for (const f of SIDES) S.each('leg', f, (i, j, w) => (f === 'pz' || f === 'nz' ? (i === 5 || i === 10 ? pick(r, accent) : i === 15 ? pal[0] : undefined) : undefined));
  const happy = v === 'friend';
  const E = { K: pal[0], R: eyeBig, H: happy ? 0xffffff : 0xff8a8a, e: eyeSmall, m: pal[5], b: 0xe07890 };
  const rows = ['', '', '.e.ee.e.', '.HR..HR.', '.RR..RR.', '..e..e..', happy ? '.b.mm.b.' : '..m..m..', ''];
  S.grid('head', 'pz', rows, E);
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const ch = rows[j][i]; if (ch === 'R' || ch === 'H') S.glow('head', 'pz', i, j, happy ? 0xff7aa0 : 0xff2a2a); else if (ch === 'e') S.glow('head', 'pz', i, j, 0xc01818); }
}

function paintCreeper(S, v) {
  const CR = [0x1c5c12, 0x2a7a1c, 0x3a9628, 0x4cad36, 0x63c24a, 0x86d86e], SP = [0xbcdcb0, 0xa2cf92, 0x8aa884];
  for (const b of ['head', 'body', 'leg']) { S.fillBox(b, CR, { lo: 1, hi: 5, mix: 0.45 }); S.speckle(b, SP, 0.07); }
  const K = 0x0b130b, k = 0x1d321b;
  if (v === 'friend') S.grid('head', 'pz', ['', '', '.KK..KK.', '.KW..KW.', '.b....b.', '.k....k.', '..kkkk..', ''], { K, k, W: 0xffffff, b: 0xf090a8 });
  else S.grid('head', 'pz', ['', '', '.KK..KK.', '.KK..KK.', '...kk...', '..KKKK..', '..KKKK..', '..K..K..'], { K, k });
  S.fill('leg', 'ny', [0x1a3a12, 0x24501a]);
}

function paintBreeze(S, v) {
  const BZ = [0x2a3470, 0x384692, 0x4858a8, 0x5c70c6, 0x7a92e4, 0x9cb4ff], r = S.rng;
  S.fillBox('head', BZ, { lo: 1, hi: 4, mix: 0.45 });
  for (const f of ['px', 'nx', 'py', 'nz']) S.each('head', f, (i, j) => ((i + j) % 5 === 0 ? BZ[0] : (i + j) % 5 === 1 && r() < 0.6 ? BZ[1] : undefined));
  const happy = v === 'friend';
  S.grid('head', 'pz', ['bbbbbbbb', '.hhhhhh.', '.h....h.', happy ? '.EW..WE.' : '.EE..EE.', '.EE..EE.', '', happy ? '..m..m..' : '..mmmm..', happy ? '...mm...' : ''], { b: BZ[0], h: 0x181c3c, E: 0xa8f0ff, W: 0xffffff, m: 0x1e2552 });
  if (happy) { S.px('head', 'pz', 0, 5, 0xf2a0c0); S.px('head', 'pz', 7, 5, 0xf2a0c0); }
  S.fillBox('rod', [0xffb828, 0xffdc52, 0xfff09a], {});
  for (const f of SIDES) { S.px('rod', f, 0, 0, 0xffffff); S.px('rod', f, 0, 3, 0x6ae8ff); S.px('rod', f, 1, 4, 0x6ae8ff); S.px('rod', f, 1, 7, 0xd88410); }
  for (let j = 3; j < 5; j++) { S.glow('head', 'pz', 1, j, 0x70d8ff); S.glow('head', 'pz', 2, j, 0x70d8ff); S.glow('head', 'pz', 5, j, 0x70d8ff); S.glow('head', 'pz', 6, j, 0x70d8ff); }
}

function paintGolem(S, v) {
  const GI = [0x7a7874, 0x94918b, 0xaeaba4, 0xc5c2bb, 0xdad7d0, 0xedeae4], VN = [0x2c5220, 0x3a6a29, 0x4a8233, 0x5e9a3f], r = S.rng;
  for (const b of ['head', 'nose', 'chest', 'waist', 'armR', 'armL', 'thighR', 'shinR', 'thighL', 'shinL']) {
    S.fillBox(b, GI, { lo: 2, hi: 4, mix: 0.8, cell: 3 });
    for (const f of SIDES) S.each(b, f, (i, j, w, h) => (j === h - 1 ? GI[1] : j === 0 ? GI[5] : (r() < 0.025 ? GI[1] : undefined)));
  }
  S.each('chest', 'pz', (i, j, w) => (j === 7 && i > 3 && i < w - 4 ? GI[1] : (i === 4 || i === w - 5) && j > 2 && j < 8 ? GI[2] : undefined));
  for (const b of ['chest', 'armL', 'thighL']) for (const f of ['pz', 'px', 'nz']) {
    S.each(b, f, (i, j, w, h) => (r() < 0.012 ? GI[0] : undefined));
    let x = 1 + ((r() * 4) | 0); const len = 3 + ((r() * 6) | 0);
    for (let j = 0; j < len; j++) { S.px(b, f, x, j, pick(r, VN)); if (r() < 0.25) S.px(b, f, x + 1, j, pick(r, VN)); x += r() < 0.25 ? 1 : r() < 0.25 ? -1 : 0; }
  }
  S.each('chest', 'py', (i, j) => (r() < 0.08 ? pick(r, VN) : undefined));
  const happy = v === 'friend';
  S.grid('head', 'pz', happy ? ['', '', '.bb..bb.', '', '.bEb.bEb', '..e...e.', 'p......p'] : ['', '', '', '.bbbbbbb', '.bEb.bEb', '..e...e.', ''],
    { b: 0x4e4a44, E: happy ? 0xffb347 : 0x8a1414, e: GI[1], p: 0xe8a0a0 });
  S.glow('head', 'pz', 2, 4, happy ? 0xffa040 : 0x901010); S.glow('head', 'pz', 6, 4, happy ? 0xffa040 : 0x901010);
  S.fill('nose', 'pz', GI, { lo: 2, hi: 4 });
  for (const f of SIDES) S.rows('waist', f, 0, 0, [GI[1]]);
}

function buildSkin(kind, variant, seed) {
  const boxes = SKIN_BOXES[kind];
  const { rects, W, H } = layoutSkin(boxes, kind === 'golem' ? 128 : 64);
  const P = new Pix(W, H), G = new Pix(W, H); G.fill(0, 0, W, H, 0x000000);
  const S = new SkinPainter(P, G, rects, mulberry32(seed));
  if (kind === 'hero') paintHero(S, variant);
  else if (kind === 'zombie') paintZombie(S, variant);
  else if (kind === 'skeleton') paintSkeleton(S, variant, [0x6e6e6e, 0x8a8a8a, 0xa4a4a4, 0xbdbdbd, 0xd2d2d2, 0xe4e4e4], [0x1e1e1e, 0x343434, 0x444444]);
  else if (kind === 'stray') paintSkeleton(S, variant, [0x6f8288, 0x8aa0a6, 0xa5babf, 0xbdd0d4, 0xd3e3e6, 0xe8f3f5], [0x1a2226, 0x34434a, 0x44545b], true);
  else if (kind === 'spider') paintSpider(S, variant, [0x0e0c0c, 0x181414, 0x221d1d, 0x2c2626, 0x373030, 0x5a4c4c], [0x4a4040, 0x5a4c4c], 0xd81818, 0xb01414);
  else if (kind === 'caveSpider') paintSpider(S, variant, [0x041c24, 0x082a35, 0x0d3a48, 0x134c5c, 0x1a6072, 0x3fb0c0], [0x2a8fa0, 0x3fb0c0], 0xe01c1c, 0xb81414);
  else if (kind === 'redSpider') paintSpider(S, variant, [0x3a0a0a, 0x581010, 0x751818, 0x8f2020, 0xaa2a2a, 0xd04a3a], [0xb83a2a, 0xd04a3a], 0xffd23a, 0xffb020);
  else if (kind === 'creeper') paintCreeper(S, variant);
  else if (kind === 'breeze') paintBreeze(S, variant);
  else if (kind === 'golem') paintGolem(S, variant);
  return { P, G, rects, W, H };
}

// ---------------------------------------------------------------- main factory
export function createTextures(THREE) {
  const all = [];
  const mk = (src, o = {}) => {
    const canvas = src instanceof Pix ? src.toCanvas() : src;
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = o.mips ? THREE.NearestMipmapLinearFilter : THREE.NearestFilter;
    t.generateMipmaps = !!o.mips;
    if (o.repeat !== false) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (o.mips) t.anisotropy = 4;
    t.needsUpdate = true;
    all.push(t);
    return t;
  };
  const blk = (P) => mk(P, { mips: true });
  const R = (s) => mulberry32(0xB10C0 + s * 7919);

  const ch = genChestFaces(R(9));
  const pix = {
    mossyCobble: genCobble(R(1), 0.3), mossyCobble2: genCobble(R(2), 0.18), mossyCobble3: genCobble(R(3), 0.42),
    cobble: genCobble(R(4), 0), smoothStone: genSmoothStone(R(5)), stoneBricks: genStoneBricks(R(6), 0, true),
    stoneBricksMossy: genStoneBricks(R(7), 0.22, false), planks: genPlanks(R(8)),
    chestTop: ch.top, chestSide: ch.side, chestFront: ch.front, chestInside: ch.inside, chestBottom: ch.bottom,
    spawnerCage: genSpawner(R(10)), ladder: genLadder(R(11)), cobweb: genCobweb(R(12)),
    windowSunset: genWindow(R(13), 'sunset'), windowSunsetTop: genWindow(R(14), 'sunsetTop'), windowSunsetBottom: genWindow(R(15), 'sunsetBottom'),
    windowSky: genWindow(R(16), 'sky'), grassTop: genGrassTop(R(17)), grassSide: genGrassSide(R(18)), dirt: genDirt(R(19)),
    torch: genTorch(), flowerRed: genFlower(R(20), 'red'), flowerYellow: genFlower(R(21), 'yellow'), flowerPink: genFlower(R(22), 'pink'),
    leaves: genLeaves(R(23), false), floweringLeaves: genLeaves(R(24), true), windBand: genWindBand(R(25)),
  };
  pix.crenel = pix.stoneBricksMossy;
  const blocks = {};
  for (const k in pix) blocks[k] = k === 'crenel' ? null : blk(pix[k]);
  blocks.crenel = blocks.stoneBricksMossy;
  const black = new Pix(1, 1); black.set(0, 0, 0);
  blocks.black = mk(black, { repeat: false });

  const spr = (P) => mk(P, { repeat: false });
  const starP = starPix([0xc8860c, 0xf0b020, 0xffd640, 0xffe880, 0xfff6c0], 0x6a4000);
  const sprites = {
    heart: spr(heartSprite()), windSwirl: spr(windSwirl()), smoke: spr(smokeSprite()), sparkle: spr(sparkleSprite()),
    star: spr(starP), xpOrb: spr(xpOrb()), flame: spr(flameSprite()), confetti: spr(confettiSprite()),
  };

  const itemPix = {
    diamond: diamondPix(), emerald: emeraldPix(), goldenApple: goldenApplePix(), cookie: cookiePix(R(30)), trophy: trophyPix(),
    poppy: pix.flowerRed, bow0: bowPix(0), bow1: bowPix(1), bow2: bowPix(2), bow3: bowPix(3), heart7: heart7(), star5: star5(), ladder: pix.ladder,
  };
  const items = {};
  for (const k in itemPix) items[k] = { pix: itemPix[k], canvas: null, texture: null };
  for (const k of ['diamond', 'emerald', 'goldenApple', 'cookie', 'trophy', 'poppy']) { items[k].texture = spr(itemPix[k]); items[k].canvas = items[k].texture.image; }

  const icons = makeIcons(R(40));
  const skinTex = (P) => mk(P, { repeat: false });
  const skins = {};
  const kinds = ['hero', 'zombie', 'skeleton', 'stray', 'spider', 'caveSpider', 'redSpider', 'creeper', 'breeze', 'golem'];
  const GLOW = { spider: 1, caveSpider: 1, redSpider: 1, golem: 1, breeze: 1 };
  kinds.forEach((kind, i) => {
    const a = buildSkin(kind, 'grumpy', 0x5C1 + i * 101), b = buildSkin(kind, 'friend', 0x5C1 + i * 101);
    skins[kind] = {
      width: a.W, height: a.H, rects: a.rects, pix: a.P, friendPix: b.P,
      map: skinTex(a.P), friendMap: skinTex(b.P),
      glowMap: GLOW[kind] ? skinTex(a.G) : null, friendGlowMap: GLOW[kind] ? skinTex(b.G) : null,
    };
    skins[kind].canvas = skins[kind].map.image; skins[kind].friendCanvas = skins[kind].friendMap.image;
  });
  // chest atlas built from the 16x16 chest faces: lid 16x5x16, base 16x11x16, latch 2x4x1
  {
    const L = layoutSkin([['lid', 16, 5, 16], ['base', 16, 11, 16], ['latch', 2, 4, 1]], 64);
    const P = new Pix(L.W, L.H), f = (n) => L.rects[n].faces;
    const put = (n, face, src, sy, h) => { const [x, y, w] = f(n)[face]; P.blit(src, 0, sy, w, h, x, y); };
    put('lid', 'py', ch.top, 0, 16); put('lid', 'ny', ch.inside, 0, 16);
    for (const fc of ['px', 'nx', 'pz', 'nz']) { put('lid', fc, ch.side, 0, 5); put('base', fc, ch.side, 5, 11); }
    put('base', 'py', ch.inside, 0, 16); put('base', 'ny', ch.bottom, 0, 16);
    for (const fc of FACES) { const [x, y, w, h] = f('latch')[fc]; P.fill(x, y, w, h, 0xa8a8a8); }
    P.grid(['WL', 'LD', 'LD', 'DK'], { W: 0xf2f2f2, L: 0xc8c8c8, D: 0x8a8a8a, K: 0x3a3a3a }, f('latch').pz[0], f('latch').pz[1]);
    skins.chest = { width: L.W, height: L.H, rects: L.rects, pix: P, map: skinTex(P), friendMap: null, glowMap: null, friendGlowMap: null };
  }
  // mob face icons (front of head, 1px outline), consistent with the skins
  const mobFace = {};
  for (const kind of ['zombie', 'skeleton', 'spider', 'caveSpider', 'stray', 'creeper', 'breeze', 'golem']) {
    const sk = skins[kind], [x, y, w, h] = sk.rects.head.faces.pz;
    const P = new Pix(w + 2, h + 2); P.blit(sk.pix, x, y, w, h, 1, 1);
    if (kind === 'golem') { const [nx, ny, nw, nh] = sk.rects.nose.faces.pz; P.blit(sk.pix, nx, ny, nw, nh, 4, 6); P.set(4, 9, 0x5a5650); P.set(5, 9, 0x5a5650); }
    if (kind === 'stray') { const [hx, hy] = sk.rects.hood.faces.pz; for (let j = 0; j < 3; j++) for (let i = 0; i < 8; i++) if (sk.pix.a(hx + i, hy + j)) P.set(1 + i, 1 + j, sk.pix.get(hx + i, hy + j)); }
    for (let i = 0; i < w + 2; i++) { P.set(i, 0, OUT); P.set(i, h + 1, OUT); }
    for (let j = 0; j < h + 2; j++) { P.set(0, j, OUT); P.set(w + 1, j, OUT); }
    mobFace[kind] = iconURL(P);
  }
  icons.mobFace = mobFace;
  {
    const sk = skins.creeper, [hx, hy, hw, hh] = sk.rects.head.faces.pz;
    const F = new Pix(16, 16);
    F.fill(0, 5, hw + 2, hh + 2, 0xff6f9c);
    F.blit(sk.friendPix || sk.pix, hx, hy, hw, hh, 1, 6);
    F.grid(HEART9, { K: 0x2a0508, H: 0xffc0c8, R: 0xe8262e, D: 0xa8141c }, 7, 0);
    icons.friendBadge = iconURL(F);
  }

  return {
    blocks, sprites, icons, skins, items, Pix, mulberry32,
    dispose() { for (const t of all) t.dispose(); },
  };
}
