import { POLICIES, policyByName, simulate, withJitteredWeights } from "./engine";
import { SCENARIOS } from "./experiment";
import {
  ALL_METRIC_NAMES,
  DEFAULT_RETRY_DELAY_H,
  runRetryCell,
  simulateRetry,
  type RetryRunResult,
} from "./retry";
import { BASE_SEED, DEFAULTS, T_HORIZON, formatReportedAt, generateWorld, type Household, type Observed, type Params, type World } from "./model";
import type { CheckResult } from "./checks";

const results: CheckResult[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
}

function mkHousehold(id: number, over: Omit<Partial<Household>, "obs"> & { obs?: Partial<Observed> }): Household {
  const reportT = over.reportT ?? 0;
  const base: Household = {
    id, x: 5, y: 5, age: 40, livesAlone: false, mobility: false, young: false, depth: 20,
    noWater: false, noElec: false, vulnerable: false, severe: false, needed: 2, reportT,
    reportedAt: formatReportedAt(reportT), visibility: 1,
    obs: { age: null, livesAlone: null, mobility: null, young: 0, depth: null, noWater: 0, noElec: 0 },
  };
  const { obs, ...rest } = over;
  return { ...base, ...rest, reportedAt: formatReportedAt(reportT), obs: { ...base.obs, ...obs } };
}

function sameArr(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}
/** T 內可見的第一次抵達（T 之後的抵達對所有 T 內指標沒有影響）。 */
const withinT = (a: Float64Array) => Float64Array.from(a, (x) => (x <= T_HORIZON ? x : Infinity));

export function runRetryChecks(): CheckResult[] {
  results.length = 0;

  // 1. 回歸（單戶層級）：retry_max = 0 必須與已 commit 的原引擎完全相同。
  {
    let bad = "";
    let n = 0;
    for (const sc of SCENARIOS) {
      for (let r = 0; r < 4 && !bad; r++) {
        const seed = BASE_SEED + r;
        const world = generateWorld(seed, sc.params);
        const body = () => {
          for (const pol of POLICIES) {
            const a = simulate(world, pol, sc.params);
            const b = simulateRetry(world, pol, sc.params, { retryMax: 0, delayH: DEFAULT_RETRY_DELAY_H });
            n++;
            const same =
              sameArr(a.assigned, b.assigned) && sameArr(a.arrivalsInT, b.arrivalsInT) &&
              sameArr(a.firstArrival, b.firstArrival) && a.validClaims === b.validClaims &&
              a.invalidClaims === b.invalidClaims && a.noCandidate === b.noCandidate &&
              Object.is(a.commuteHoursSum, b.commuteHoursSum);
            if (!same) bad ||= `${sc.id}/${pol.name}/seed${r}`;
          }
        };
        if (sc.params.jitter) withJitteredWeights(seed, body);
        else body();
      }
    }
    check(`回歸（單戶層級）：retry_max = 0 ≡ 原引擎（11 情境 × 9 政策 × 4 種子 = ${n} 次，逐位元）`, !bad, bad);
  }

  // 2. 志工守恆與時間：retry_max ∈ {1,5}。
  {
    let bad = "";
    let n = 0;
    for (const sc of SCENARIOS.filter((s) => ["S1", "S4", "S6", "S10"].includes(s.id))) {
      for (const retryMax of [1, 5]) {
        for (let r = 0; r < 3; r++) {
          const world = generateWorld(BASE_SEED + r, sc.params);
          for (const pol of POLICIES) {
            const run = simulateRetry(world, pol, sc.params, { retryMax, delayH: DEFAULT_RETRY_DELAY_H });
            n++;
            const tag = `${sc.id}/${pol.name}/retry${retryMax}/seed${r}`;
            const M = world.volunteers.length;
            if (run.validClaims + run.invalidClaims + run.noCandidate !== M) bad ||= `${tag}: 志工不守恆`;
            if (run.invalidAttempts < run.invalidClaims) bad ||= `${tag}: 作廢數大於 409 次數`;
            if (run.timeRegressions !== 0) bad ||= `${tag}: 時間倒退`;
            let sum = 0;
            world.households.forEach((h, i) => {
              sum += run.assigned[i];
              if (run.assigned[i] > h.needed) bad ||= `${tag}: hh${i} 認領超過需求`;
              if (run.firstArrival[i] !== Infinity && run.firstArrival[i] < h.reportT) bad ||= `${tag}: hh${i} 抵達早於通報`;
            });
            if (sum !== run.validClaims) bad ||= `${tag}: 認領總數不一致`;
            for (let k = 1; k < run.claimTimes.length; k++) {
              if (run.claimTimes[k] < run.claimTimes[k - 1]) bad ||= `${tag}: 認領時間未依序`;
            }
          }
        }
      }
    }
    check(`志工守恆：成功 + 作廢 + 找不到案件 = 志工人數；認領 ≤ 需求；時間不倒退（${n} 次）`, !bad, bad);
  }

  // 3. p = 1 的政策從不撞到額滿案件，結果必須與 retry_max 無關。
  {
    let bad = "";
    for (const sc of SCENARIOS.filter((s) => ["S1", "S4", "S6", "S10"].includes(s.id))) {
      for (let r = 0; r < 3; r++) {
        const world = generateWorld(BASE_SEED + r, sc.params);
        for (const pol of POLICIES.filter((p) => p.fill === "perfect")) {
          const base = simulateRetry(world, pol, sc.params, { retryMax: 0, delayH: DEFAULT_RETRY_DELAY_H });
          for (const retryMax of [1, 5]) {
            const x = simulateRetry(world, pol, sc.params, { retryMax, delayH: DEFAULT_RETRY_DELAY_H });
            if (!sameArr(base.assigned, x.assigned) || !sameArr(base.firstArrival, x.firstArrival) || x.invalidAttempts !== 0) {
              bad ||= `${sc.id}/${pol.name}/retry${retryMax}/seed${r}`;
            }
          }
        }
      }
    }
    check("p = 1 的政策（coordinated_*、care_score*）：retry_max 1、5 與 0 逐位元相同，且從不撞到額滿", !bad, bad);
  }

  // 4. retry_delay 極大：重挑不會讓時間倒退，而且全部排在所有第一次嘗試之後 ——
  //    因此所有「T 內」的結果必須與 retry_max = 0 完全相同。
  {
    let bad = "";
    let sawLateRetry = false;
    for (const sc of SCENARIOS.filter((s) => ["S1", "S4", "S6", "S10"].includes(s.id))) {
      for (let r = 0; r < 3; r++) {
        const world = generateWorld(BASE_SEED + r, sc.params);
        for (const pol of POLICIES) {
          const base = simulateRetry(world, pol, sc.params, { retryMax: 0, delayH: 1e6 });
          const big: RetryRunResult = simulateRetry(world, pol, sc.params, { retryMax: 5, delayH: 1e6 });
          const tag = `${sc.id}/${pol.name}/seed${r}`;
          if (big.timeRegressions !== 0) bad ||= `${tag}: 時間倒退`;
          if (!sameArr(base.arrivalsInT, big.arrivalsInT) || !sameArr(withinT(base.firstArrival), withinT(big.firstArrival))) {
            bad ||= `${tag}: T 內結果與 retry_max=0 不同（重挑的時間沒有被延後）`;
          }
          for (let k = 1; k < big.claimTimes.length; k++) {
            if (big.claimTimes[k] < big.claimTimes[k - 1]) bad ||= `${tag}: 認領時間倒退`;
          }
          if (big.claimTimes.some((t) => t >= 1e6)) sawLateRetry = true;
        }
      }
    }
    check("retry_delay = 1e6 小時：不會時間倒退，且 T 內的所有結果與 retry_max = 0 逐位元相同", !bad, bad);
    check("對照：retry_delay = 1e6 時確實有重挑發生（認領時間 ≥ 1e6）", sawLateRetry);
  }

  // 5. 手工小世界：排除、延遲、交錯順序、作廢。
  {
    const P: Params = { ...DEFAULTS, pBase: 0 }; // p = 0：志工完全不知道誰額滿，會一直撞
    const nearest = policyByName("nearest");
    const A = mkHousehold(0, { reportT: 1, x: 3, y: 2, needed: 1 }); // 離集散點 (2,2) 最近、只需 1 人
    const B = mkHousehold(1, { reportT: 1, x: 9, y: 9, needed: 5 }); // 很遠、需 5 人
    const vol = (id: number, t: number, x = 2, y = 2) => ({ id, t, x, y });
    const mk = (hs: Household[], vs: ReturnType<typeof vol>[]): World => ({
      seed: 7, households: hs, volunteers: vs, byReport: Int32Array.from(hs.map((h) => h.id)),
    });
    const dB = Math.hypot(9 - 2, 9 - 2) / 15;

    // 排除 + 延遲：v1 撞到 A，0.5 小時後重挑，A 被排除所以改選 B。
    const r1 = simulateRetry(mk([A, B], [vol(0, 10), vol(1, 10.001)]), nearest, P, { retryMax: 5, delayH: 0.5 });
    check("重挑：撞到額滿後排除該戶並改選別戶（A 額滿 → 改選 B，1 次 409、0 次作廢）",
      r1.assigned[0] === 1 && r1.assigned[1] === 1 && r1.invalidAttempts === 1 && r1.invalidClaims === 0,
      `assigned=[${r1.assigned}] 409=${r1.invalidAttempts} void=${r1.invalidClaims}`);
    check("重挑：成功認領的時間 = 第一次嘗試 + retry_delay（抵達時間精確相符）",
      Math.abs(r1.firstArrival[1] - (10.001 + 0.5 + dB)) < 1e-9 && Math.abs(r1.claimTimes[1] - 10.501) < 1e-9,
      `firstArrival[B]=${r1.firstArrival[1]} 預期 ${10.001 + 0.5 + dB}`);

    // retry_max = 0：同一個情況，v1 的認領作廢。
    const r0 = simulateRetry(mk([A, B], [vol(0, 10), vol(1, 10.001)]), nearest, P, { retryMax: 0, delayH: 0.5 });
    check("retry_max = 0：同一個情況下 v1 的認領作廢（B 沒人認領）", r0.assigned[1] === 0 && r0.invalidClaims === 1);

    // 交錯：v2 從 B 旁邊出發（最近的是 B，第一次就成功），在 v1 的重挑（10.501）之前上線，必須先被處理。
    const r2 = simulateRetry(mk([A, B], [vol(0, 10), vol(1, 10.001), vol(2, 10.2, 9, 9)]), nearest, P, { retryMax: 5, delayH: 0.5 });
    check("重挑事件與其他志工依時間交錯處理（v2 在 10.2 先認領，v1 的重挑在 10.501）",
      r2.claimTimes.join(",") === "10,10.2,10.501" && r2.assigned[1] === 2, `claimTimes=${r2.claimTimes.join(",")}`);

    // 只有一戶：重挑時已沒有可選案件 → 作廢。
    const r3 = simulateRetry(mk([A], [vol(0, 10), vol(1, 10.001)]), nearest, P, { retryMax: 5, delayH: 0.5 });
    check("重挑時沒有任何可選案件：認領作廢（不算「找不到案件」）",
      r3.invalidClaims === 1 && r3.noCandidate === 0 && r3.invalidAttempts === 1);

    // 連撞兩戶：已撞過的「每一戶」都要排除（只排除最近一次，v2 會在 A、B 之間來回撞）。
    // v0 認領 A2；v1 撞 A2（1 次 409）後重挑改選 B2；v2 撞 A2 後重挑又撞到已額滿的 B2（共 2 次 409），
    // 第三次嘗試時 A2、B2 都被排除，只剩 C2。全部 409 共 3 次。
    const A2 = mkHousehold(0, { reportT: 1, x: 3, y: 2, needed: 1 });
    const B2 = mkHousehold(1, { reportT: 1, x: 4, y: 2, needed: 1 });
    const C2 = mkHousehold(2, { reportT: 1, x: 9, y: 9, needed: 5 });
    const r4 = simulateRetry(mk([A2, B2, C2], [vol(0, 10), vol(1, 10.001), vol(2, 10.002)]), nearest, P, { retryMax: 5, delayH: 0.1 });
    check("連撞兩戶後，已撞過的每一戶都被排除（v2 先撞 A、再撞 B，第三次嘗試改選 C；共 3 次 409、0 次作廢）",
      r4.assigned[0] === 1 && r4.assigned[1] === 1 && r4.assigned[2] === 1 && r4.invalidAttempts === 3 && r4.invalidClaims === 0,
      `assigned=[${r4.assigned}] 409=${r4.invalidAttempts} void=${r4.invalidClaims}`);
  }

  // 6. 無效認領比例（最終結果基準）隨 retry_max 單調不增（各政策的 R=30 平均）。
  {
    let bad = "";
    const detail: string[] = [];
    for (const sc of SCENARIOS.filter((s) => ["S1", "S4", "S6", "S10"].includes(s.id))) {
      const byRetry = [0, 1, 5].map((k) => runRetryCell(sc.id, sc.params, POLICIES, k, DEFAULT_RETRY_DELAY_H, 30));
      for (const pol of POLICIES) {
        const means = byRetry.map((cell) => {
          const v = cell[pol.name].invalid_claim_frac;
          return v.reduce((s, x) => s + x, 0) / v.length;
        });
        if (!(means[1] <= means[0] + 1e-12 && means[2] <= means[1] + 1e-12)) bad ||= `${sc.id}/${pol.name}: ${means.map((m) => m.toFixed(4)).join(" → ")}`;
        if (sc.id === "S1" && pol.name === "latest") detail.push(`S1 latest: ${means.map((m) => m.toFixed(3)).join(" → ")}`);
      }
    }
    check("無效認領比例隨 retry_max 0 → 1 → 5 單調不增（S1、S4、S6、S10 × 9 政策，R = 30 平均）", !bad, bad || detail.join("；"));
  }

  check("指標清單完整（14 個指標都有計算）", ALL_METRIC_NAMES.length === 14);
  return [...results];
}
