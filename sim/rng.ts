/**
 * 手寫的帶種子 PRNG。結果可由種子完全重現：不使用 Math.random()，
 * 也不依賴任何外部套件。
 */
export type Rng = () => number;

/** mulberry32：32 位元狀態，回傳 [0,1) 的均勻亂數。 */
export function mulberry32(seed: number): Rng {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * 由 (種子, 用途標籤) 衍生出獨立的子流。
 * 每個用途各自一條流，抽取次數不隨情境參數而變，
 * 所以不同情境、不同政策之間共用同一批底層亂數（配對設計）。
 */
export function stream(seed: number, label: string): Rng {
  return mulberry32(fmix32((Math.imul(seed, 0x9e3779b1) ^ fnv1a(label)) >>> 0));
}

/** Box–Muller：固定消耗 2 個均勻亂數，回傳一個標準常態。 */
export function gauss(rng: Rng): number {
  const u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);
}
