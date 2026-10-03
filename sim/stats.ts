import { stream } from "./rng";

export const BOOTSTRAP_B = 2000;
const BOOTSTRAP_SEED = 20261003;

/** 一組固定種子的重抽索引（B × R），所有指標與比較共用，保留配對結構。 */
export function makeBootstrapIndices(R: number, B: number = BOOTSTRAP_B): Int32Array {
  const rng = stream(BOOTSTRAP_SEED, "bootstrap");
  const idx = new Int32Array(B * R);
  for (let i = 0; i < idx.length; i++) idx[i] = Math.min(R - 1, Math.floor(rng() * R));
  return idx;
}

export function mean(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return s / x.length;
}

export interface Interval {
  mean: number;
  lo: number;
  hi: number;
}

/** percentile bootstrap：排序後取第 floor(0.025·B) 與第 ceil(0.975·B)−1 個。 */
export function bootstrapMeanCI(x: ArrayLike<number>, idx: Int32Array, B: number = BOOTSTRAP_B): Interval {
  const R = x.length;
  const means = new Float64Array(B);
  for (let b = 0; b < B; b++) {
    let s = 0;
    const off = b * R;
    for (let k = 0; k < R; k++) s += x[idx[off + k]];
    means[b] = s / R;
  }
  means.sort();
  return {
    mean: mean(x),
    lo: means[Math.floor(0.025 * B)],
    hi: means[Math.ceil(0.975 * B) - 1],
  };
}

export function pairedDiff(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const d = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) d[i] = a[i] - b[i];
  return d;
}
