import { HIGHER_IS_BETTER, METRICS, type MetricName, type Results } from "./experiment";
import { POLICIES } from "./engine";
import { bootstrapMeanCI, makeBootstrapIndices, pairedDiff, type Interval } from "./stats";

export type Verdict = "win" | "ci_includes_zero" | "baseline_better";

/** care_score 相對對手（差 = care_score − 對手）：CI 完全落在有利側才算 win。 */
export function verdictOf(metric: MetricName, d: Interval): Verdict {
  const higher = HIGHER_IS_BETTER[metric];
  if (higher) {
    if (d.lo > 0) return "win";
    if (d.hi < 0) return "baseline_better";
  } else {
    if (d.hi < 0) return "win";
    if (d.lo > 0) return "baseline_better";
  }
  return "ci_includes_zero";
}

export class Analysis {
  readonly R: number;
  readonly idx: Int32Array;
  private cache = new Map<string, Interval>();

  constructor(readonly results: Results, R: number) {
    this.R = R;
    this.idx = makeBootstrapIndices(R);
  }

  vec(sc: string, pol: string, m: MetricName): Float64Array {
    return this.results[sc][pol][m];
  }

  summary(sc: string, pol: string, m: MetricName): Interval {
    const key = `s|${sc}|${pol}|${m}`;
    let v = this.cache.get(key);
    if (!v) {
      v = bootstrapMeanCI(this.vec(sc, pol, m), this.idx);
      this.cache.set(key, v);
    }
    return v;
  }

  /** a − b 的配對差（以重複為單位）。 */
  diff(sc: string, a: string, b: string, m: MetricName): Interval {
    const key = `d|${sc}|${a}|${b}|${m}`;
    let v = this.cache.get(key);
    if (!v) {
      v = bootstrapMeanCI(pairedDiff(this.vec(sc, a, m), this.vec(sc, b, m)), this.idx);
      this.cache.set(key, v);
    }
    return v;
  }

  /** 任意線性組合 Σ coeff·policy 的配對 bootstrap（用於 H6 的交互作用）。 */
  combo(sc: string, m: MetricName, terms: [string, number][]): Interval {
    const out = new Float64Array(this.R);
    for (const [pol, coeff] of terms) {
      const v = this.vec(sc, pol, m);
      for (let i = 0; i < this.R; i++) out[i] += coeff * v[i];
    }
    return bootstrapMeanCI(out, this.idx);
  }
}

export const BASELINES = ["latest", "nearest", "attention", "random"] as const;
export const ABLATIONS = [
  "coordinated_latest",
  "coordinated_nearest",
  "care_score_uncoordinated",
  "care_score_full_compliance",
] as const;
export const COMPARATORS = [...BASELINES, ...ABLATIONS];

export function policyNames(): string[] {
  return POLICIES.map((p) => p.name);
}
export { METRICS };
