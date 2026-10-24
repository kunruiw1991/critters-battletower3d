// localStorage save: { unlocked, stars[7], diamonds, ... }. Every access is guarded (private mode etc.).
import { SAVE_KEY, NUM_FLOORS, MOB_KINDS } from './config.js';

function fresh() {
  return { unlocked: 0, stars: new Array(NUM_FLOORS).fill(0), diamonds: 0, emeralds: 0,
    floorDiamonds: new Array(NUM_FLOORS).fill(0), floorEmeralds: new Array(NUM_FLOORS).fill(0),
    friendKinds: [], trophy: false, muted: false };
}

export function loadSave() {
  const s = fresh();
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return s;
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return s;
    if (Number.isFinite(d.unlocked)) s.unlocked = Math.max(0, Math.min(NUM_FLOORS - 1, d.unlocked | 0));
    if (Array.isArray(d.stars)) for (let i = 0; i < NUM_FLOORS; i++) s.stars[i] = Math.max(0, Math.min(3, d.stars[i] | 0));
    if (Array.isArray(d.floorDiamonds)) for (let i = 0; i < NUM_FLOORS; i++) s.floorDiamonds[i] = Math.max(0, d.floorDiamonds[i] | 0);
    if (Array.isArray(d.floorEmeralds)) for (let i = 0; i < NUM_FLOORS; i++) s.floorEmeralds[i] = Math.max(0, d.floorEmeralds[i] | 0);
    s.diamonds = s.floorDiamonds.reduce((a, b) => a + b, 0) || Math.max(0, d.diamonds | 0);
    s.emeralds = s.floorEmeralds.reduce((a, b) => a + b, 0);
    if (Array.isArray(d.friendKinds)) {
      s.friendKinds = d.friendKinds.filter((k) => typeof k === 'string' && MOB_KINDS.includes(k) && k !== 'golem').slice(-80);
    }
    s.trophy = !!d.trophy;
    s.muted = !!d.muted;
  } catch (e) { /* corrupted or blocked storage: start fresh */ }
  return s;
}

export function writeSave(s) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch (e) { /* storage blocked */ }
}
