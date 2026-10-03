import { computeCareScore } from "../src/care_score";
import {
  POLICIES,
  assertVisible,
  currentWeightsSnapshot,
  policyByName,
  simulate,
  withJitteredWeights,
  type PolicySpec,
} from "./engine";
import { METRICS, SCENARIOS, computeMetrics, runExperiment } from "./experiment";
import {
  BASE_SEED,
  DEFAULTS,
  T_HORIZON,
  formatReportedAt,
  generateWorld,
  hoursToDate,
  makeCaseRow,
  type Household,
  type Observed,
  type Params,
  type World,
} from "./model";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
}
function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/** 手工組一個家戶（只填測試需要的欄位，其餘給中性預設）。 */
function mkHousehold(id: number, over: Omit<Partial<Household>, "obs"> & { obs?: Partial<Observed> }): Household {
  const reportT = over.reportT ?? 0;
  const base: Household = {
    id,
    x: 5,
    y: 5,
    age: 40,
    livesAlone: false,
    mobility: false,
    young: false,
    depth: 20,
    noWater: false,
    noElec: false,
    vulnerable: false,
    severe: false,
    needed: 2,
    reportT,
    reportedAt: formatReportedAt(reportT),
    visibility: 1,
    obs: { age: null, livesAlone: null, mobility: null, young: 0, depth: null, noWater: 0, noElec: 0 },
  };
  const { obs, ...rest } = over;
  return { ...base, ...rest, reportedAt: formatReportedAt(reportT), obs: { ...base.obs, ...obs } };
}

function f64Equal(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

export function runChecks(): CheckResult[] {
  results.length = 0;
  const weightsBefore = currentWeightsSnapshot();

  // 1. 黃金測試：走模擬用的包裝層（makeCaseRow + formatReportedAt + hoursToDate），
  //    README 案例 1 必須是 36.7。
  {
    const h = mkHousehold(0, {
      reportT: 5.5,
      needed: 2,
      obs: { age: 76, livesAlone: 1, mobility: 0, young: 0, depth: 60, noWater: 1, noElec: 0 },
    });
    const b = computeCareScore(makeCaseRow(h, 0), hoursToDate(5.5 + 10));
    const ok =
      Math.abs(b.total - 36.7) < 1e-9 &&
      Math.abs(b.vulnerability_contribution - 18.0) < 1e-9 &&
      Math.abs(b.severity_contribution - 11.7) < 1e-9 &&
      Math.abs(b.urgency_contribution - 6.0) < 1e-9 &&
      Math.abs(b.resource_gap_contribution - 1.0) < 1e-9;
    check("黃金測試：README 案例 1 → 36.7（18.0 + 11.7 + 6.0 + 1.0）", ok, `total=${b.total}`);
  }

  // 2. 同一個種子跑兩次，結果逐位元相同（含 S9 的權重抖動），且權重已還原。
  {
    const sub = SCENARIOS.filter((s) => s.id === "S1" || s.id === "S9");
    const a = runExperiment(sub, 6);
    const b = runExperiment(sub, 6);
    let same = true;
    for (const sc of sub) {
      for (const pol of POLICIES) {
        for (const m of METRICS) {
          if (!f64Equal(a[sc.id][pol.name][m], b[sc.id][pol.name][m])) same = false;
        }
      }
    }
    check("同一個種子跑兩次，結果逐位元相同（S1、S9 各 6 次重複、全部政策與指標）", same);
    check("S9 抖動結束後 CARE_SCORE_WEIGHTS 已還原", currentWeightsSnapshot() === weightsBefore);
  }

  // 3. 飽和：ratio 很大且 p = 1 時，所有政策最終都服務到所有家戶。
  {
    let bad = "";
    for (const origin of ["hub", "local"] as const) {
      const params: Params = { ...DEFAULTS, ratio: 20, pBase: 1, origin };
      for (let r = 0; r < 4 && !bad; r++) {
        const world = generateWorld(BASE_SEED + r, params);
        for (const pol of POLICIES) {
          const run = simulate(world, pol, params);
          world.households.forEach((h, i) => {
            if (run.assigned[i] !== h.needed) bad ||= `${pol.name}/${origin}/seed${r}: hh${i} assigned ${run.assigned[i]}/${h.needed}`;
            if (!(run.firstArrival[i] <= T_HORIZON)) bad ||= `${pol.name}/${origin}/seed${r}: hh${i} 未在 T 內被服務`;
          });
        }
      }
    }
    check("飽和：ratio 20、p = 1 → 所有政策服務到所有家戶（人力全補滿、T 內抵達）", !bad, bad);
  }

  // 4 & 5. 不變量（志工守恆、認領數、非負時間）＋ p = 1 的政策無效認領必為 0。
  {
    let bad = "";
    let perfectInvalid = 0;
    let checked = 0;
    for (const sc of SCENARIOS) {
      for (let r = 0; r < 4; r++) {
        const seed = BASE_SEED + r;
        const world = generateWorld(seed, sc.params);
        const body = () => {
          for (const pol of POLICIES) {
            const run = simulate(world, pol, sc.params);
            checked++;
            const tag = `${sc.id}/${pol.name}/seed${r}`;
            const M = world.volunteers.length;
            if (run.validClaims + run.invalidClaims + run.noCandidate !== M) bad ||= `${tag}: 志工不守恆`;
            let sumAssigned = 0;
            for (let i = 0; i < world.households.length; i++) {
              const h = world.households[i];
              sumAssigned += run.assigned[i];
              if (run.assigned[i] > h.needed) bad ||= `${tag}: hh${i} 認領數超過需求`;
              if (run.arrivalsInT[i] > run.assigned[i]) bad ||= `${tag}: hh${i} T 內抵達數超過認領數`;
              if (run.firstArrival[i] !== Infinity && run.firstArrival[i] < h.reportT) bad ||= `${tag}: hh${i} 抵達早於通報（負等待）`;
            }
            if (sumAssigned !== run.validClaims) bad ||= `${tag}: 認領總數不一致`;
            if (run.validClaims > M) bad ||= `${tag}: 認領數超過志工人數`;
            if (run.commuteHoursSum < 0) bad ||= `${tag}: 負的通勤時間`;
            const m = computeMetrics(world, run);
            if (m.median_wait_vulnerable < 0 || m.median_wait_severe < 0) bad ||= `${tag}: 負的等待時間`;
            if (pol.fill === "perfect") perfectInvalid += run.invalidClaims;
          }
        };
        if (sc.params.jitter) withJitteredWeights(seed, body);
        else body();
      }
    }
    check(`不變量：志工守恆、認領數 ≤ 需求與志工人數、抵達不早於通報、無負的時間（${checked} 次執行）`, !bad, bad);
    check("p = 1 的政策（coordinated_*、care_score*）無效認領為 0", perfectInvalid === 0, `無效認領總數=${perfectInvalid}`);

    // 正向對照：p < 1 的基準確實會產生無效認領（證明計數器有在運作）。
    let baseInvalid = 0;
    for (let r = 0; r < 10; r++) {
      const world = generateWorld(BASE_SEED + r, DEFAULTS);
      baseInvalid += simulate(world, policyByName("latest"), DEFAULTS).invalidClaims;
    }
    check("對照：p = 0.5 的 latest 在 S1 有無效認領（計數器有效）", baseInvalid > 0, `10 次重複共 ${baseInvalid} 次`);
  }

  // 6. 政策語意與「看不到尚未通報案件」：手工小世界。
  {
    const A = mkHousehold(0, { reportT: 1, x: 3, y: 2, needed: 3, obs: { age: 30, depth: 5 } }); // 最近、需求低
    const B = mkHousehold(1, { reportT: 2, x: 9, y: 9, needed: 3, obs: { age: 85, livesAlone: 1, mobility: 1, depth: 140, noWater: 1, noElec: 1 } }); // 最遠、需求最高
    const D = mkHousehold(2, { reportT: 3, x: 6, y: 5, needed: 3, obs: { age: 50, depth: 40 } }); // 最新
    const C = mkHousehold(3, { reportT: 50, x: 2, y: 2, needed: 3, obs: { age: 90, livesAlone: 1, mobility: 1, depth: 150, noWater: 1, noElec: 1 } }); // 尚未通報，卻最近、最高分
    const hs = [A, B, D, C];
    const world: World = {
      seed: 1,
      households: hs,
      volunteers: [{ id: 0, t: 10, x: 2, y: 2 }],
      byReport: Int32Array.from([0, 1, 2, 3]),
    };
    const pickOf = (pol: PolicySpec, params: Params = DEFAULTS): number => {
      const run = simulate(world, pol, params);
      return run.assigned.findIndex((x) => x > 0);
    };
    const now = hoursToDate(10);
    const sA = computeCareScore(makeCaseRow(A, 0), now).total;
    const sB = computeCareScore(makeCaseRow(B, 0), now).total;
    const sD = computeCareScore(makeCaseRow(D, 0), now).total;
    const expectedCare = sB > sA && sB > sD ? 1 : -1;
    const P1: Params = { ...DEFAULTS, pBase: 1 };
    check("語意：latest 挑最新通報者（排除尚未通報的 C）", pickOf(policyByName("latest"), P1) === 2);
    check("語意：nearest 挑最近者（尚未通報的 C 雖然最近也不會被挑）", pickOf(policyByName("nearest"), P1) === 0);
    check("語意：care_score 挑 Care Score 最高者（尚未通報的 C 雖然分數最高也不會被挑）",
      expectedCare === 1 && pickOf(policyByName("care_score_full_compliance"), P1) === 1,
      `A=${sA} B=${sB} D=${sD}`);
    let leaked = false;
    for (let seed = 1; seed <= 200; seed++) {
      const w2: World = { ...world, seed };
      for (const pol of POLICIES) {
        const run = simulate(w2, pol, DEFAULTS);
        if (run.assigned[3] > 0) leaked = true;
      }
    }
    check("政策不會看到尚未通報的案件（9 個政策 × 200 個種子，C 從未被認領）", !leaked);
    check("防線本身有效：assertVisible 對尚未通報的案件會丟錯", throws(() => assertVisible(C, 10)));

    // 額滿判定：A 需求 1、已被前一位志工認領 → p=1 的政策不會再挑到 A。
    const A1 = mkHousehold(0, { reportT: 1, x: 3, y: 2, needed: 1, obs: { age: 30, depth: 5 } });
    const w3: World = {
      seed: 2,
      households: [A1, D],
      volunteers: [{ id: 0, t: 10, x: 2, y: 2 }, { id: 1, t: 11, x: 2, y: 2 }],
      byReport: Int32Array.from([0, 1]),
    };
    const run3 = simulate(w3, policyByName("coordinated_nearest"), DEFAULTS);
    check("額滿導流：A 額滿後，第二位志工改挑別案（無效認領 0、D 被認領 1 次）",
      run3.assigned[0] === 1 && run3.assigned[1] === 1 && run3.invalidClaims === 0);
  }

  // 7. 消融臂的一致性：極限情況下兩個政策必須完全相同。
  {
    let same = true;
    for (let r = 0; r < 5; r++) {
      const w = generateWorld(BASE_SEED + r, DEFAULTS);
      const c0: Params = { ...DEFAULTS, c: 0 };
      const c1: Params = { ...DEFAULTS, c: 1 };
      const a0 = simulate(w, policyByName("care_score"), c0);
      const b0 = simulate(w, policyByName("coordinated_nearest"), c0);
      const a1 = simulate(w, policyByName("care_score"), c1);
      const b1 = simulate(w, policyByName("care_score_full_compliance"), c1);
      for (let i = 0; i < w.households.length; i++) {
        if (a0.assigned[i] !== b0.assigned[i] || a1.assigned[i] !== b1.assigned[i]) same = false;
      }
    }
    check("極限一致：care_score(c=0) ≡ coordinated_nearest；care_score(c=1) ≡ care_score_full_compliance", same);
  }

  // 8. 權重抖動：cap 不動、其餘確實改變、結束後還原。
  {
    const before = currentWeightsSnapshot();
    let capsOk = true;
    let changed = false;
    withJitteredWeights(BASE_SEED, () => {
      const after = currentWeightsSnapshot();
      changed = after !== before;
      const a = JSON.parse(before);
      const b = JSON.parse(after);
      for (const k of ["vulnerability", "severity", "urgency", "resourceGap"] as const) {
        if (a[k].cap !== b[k].cap) capsOk = false;
      }
      if (a.severity.floodDepthCapCm !== b.severity.floodDepthCapCm) capsOk = false;
    });
    check("權重抖動：cap 與 floodDepthCapCm 不動、其餘權重確實改變、結束後還原",
      capsOk && changed && currentWeightsSnapshot() === before);
  }

  check("全部檢查後 CARE_SCORE_WEIGHTS 仍與起始值相同", currentWeightsSnapshot() === weightsBefore);
  return [...results];
}
