import { test } from "node:test";
import assert from "node:assert/strict";
import type { CaseRow } from "./types.ts";
import {
  computeCareScore,
  computeConfidenceScore,
  needsHumanVerification,
} from "./care_score.ts";

// 固定的「現在」，讓 urgency 的計算可重現，不受實際執行時間影響。
const NOW = new Date("2026-08-27T00:00:00Z");

/** 一筆什麼都不知道的案件：所有分項都是 0，方便單獨驗證某一個因子的影響。 */
const BASE: CaseRow = {
  id: 1,
  source: "line",
  reporter_line_user_id: null,
  raw_text: "測試案件",
  location_text: null,
  exact_lat: null,
  exact_lng: null,
  public_lat: null,
  public_lng: null,
  age: null,
  lives_alone: null,
  mobility_impaired: null,
  has_young_children: null,
  household_size: null,
  flood_depth_cm: null,
  no_water: 0,
  no_electricity: 0,
  need_types: null,
  volunteers_needed: 1,
  volunteers_assigned: 1, // 預設無缺口，避免 resource_gap 干擾單因子測試
  summary: null,
  confidence_score: null,
  needs_human_verification: 0,
  possible_duplicate_of: null,
  status: "open",
  reported_at: "2026-08-27 00:00:00", // 等於 NOW，urgency = 0
  updated_at: "2026-08-27 00:00:00",
};

/**
 * 覆寫值刻意用 unknown：有些欄位在 CaseRow 型別上不可為 null
 * （例如 volunteers_needed 是 NOT NULL），但測試需要驗證函式面對 null 的行為。
 */
function makeCase(overrides: Partial<Record<keyof CaseRow, unknown>> = {}): CaseRow {
  return { ...BASE, ...overrides } as unknown as CaseRow;
}

/** 給定小時數之前的通報時間（D1 的 datetime 格式，UTC）。 */
function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

function totalOf(overrides: Partial<Record<keyof CaseRow, unknown>>): number {
  return computeCareScore(makeCase(overrides), NOW).total;
}

// ---------------------------------------------------------------------------
// computeCareScore — Vulnerability
// ---------------------------------------------------------------------------

test("80歲以上比一般成年人分數高", () => {
  assert.ok(totalOf({ age: 85 }) > totalOf({ age: 40 }));
});

test("65-79歲介於一般成年人與80歲以上之間（兩個級距都有作用）", () => {
  const general = totalOf({ age: 40 });
  const senior = totalOf({ age: 70 });
  const elderly = totalOf({ age: 85 });
  assert.ok(senior > general, "65-79 應高於一般成年人");
  assert.ok(senior < elderly, "65-79 應低於 80+");
});

test("獨居會增加分數", () => {
  assert.ok(totalOf({ lives_alone: 1 }) > totalOf({ lives_alone: 0 }));
});

test("行動不便會增加分數", () => {
  assert.ok(totalOf({ mobility_impaired: 1 }) > totalOf({ mobility_impaired: 0 }));
});

test("有幼兒會增加分數", () => {
  assert.ok(
    totalOf({ has_young_children: 1 }) > totalOf({ has_young_children: 0 })
  );
});

// ---------------------------------------------------------------------------
// computeCareScore — Severity
// ---------------------------------------------------------------------------

test("淹水越深分數越高", () => {
  assert.ok(totalOf({ flood_depth_cm: 100 }) > totalOf({ flood_depth_cm: 50 }));
});

test("淹水深度超過150cm之後不再增加（cap 生效）", () => {
  const atCap = totalOf({ flood_depth_cm: 150 });
  const overCap = totalOf({ flood_depth_cm: 400 });
  assert.equal(overCap, atCap);
  // 同時確認 cap 之下確實還在成長，避免測到一個永遠不變的常數。
  assert.ok(atCap > totalOf({ flood_depth_cm: 100 }));
});

test("缺水會增加分數", () => {
  assert.ok(totalOf({ no_water: 1 }) > totalOf({ no_water: 0 }));
});

test("缺電會增加分數", () => {
  assert.ok(totalOf({ no_electricity: 1 }) > totalOf({ no_electricity: 0 }));
});

// ---------------------------------------------------------------------------
// computeCareScore — Urgency
// ---------------------------------------------------------------------------

test("等待越久分數越高", () => {
  assert.ok(
    totalOf({ reported_at: hoursAgo(5) }) > totalOf({ reported_at: hoursAgo(1) })
  );
});

test("等待時間超過上限後不再增加（urgency cap 生效）", () => {
  const atCap = totalOf({ reported_at: hoursAgo(20) }); // 20×3 = 60 = cap
  const overCap = totalOf({ reported_at: hoursAgo(200) });
  assert.equal(overCap, atCap);
  assert.ok(atCap > totalOf({ reported_at: hoursAgo(10) }));
});

test("未來的通報時間不會產生負的 urgency", () => {
  const future = computeCareScore(
    makeCase({ reported_at: hoursAgo(-5) }), // NOW 之後 5 小時
    NOW
  );
  assert.equal(future.urgency, 0);
  assert.equal(future.urgency_contribution, 0);
  assert.ok(future.total >= 0);
});

// ---------------------------------------------------------------------------
// computeCareScore — ResourceGap
// ---------------------------------------------------------------------------

test("志工缺口越大分數越高", () => {
  const bigGap = totalOf({ volunteers_needed: 4, volunteers_assigned: 0 });
  const smallGap = totalOf({ volunteers_needed: 2, volunteers_assigned: 1 });
  assert.ok(bigGap > smallGap);
});

test("已認領數超過需求數時不會產生負的缺口加分", () => {
  const over = computeCareScore(
    makeCase({ volunteers_needed: 1, volunteers_assigned: 5 }),
    NOW
  );
  assert.equal(over.resource_gap, 0);
  assert.equal(over.resource_gap_contribution, 0);
  assert.ok(over.total >= 0);
});

// ---------------------------------------------------------------------------
// 迴歸測試：資訊不足不得影響 Care Score
// ---------------------------------------------------------------------------

test("三個核心欄位全部缺漏時，total 不會得到任何加分（unknown bonus 迴歸測試）", () => {
  // 兩者的 vulnerability 都是 0，其餘欄位完全相同，
  // 所以 total 必須「完全相等」。若有人把 unknown bonus 加回來，這條會失敗。
  const allUnknown = totalOf({
    age: null,
    lives_alone: null,
    mobility_impaired: null,
  });
  const allKnownButZero = totalOf({
    age: 40,
    lives_alone: 0,
    mobility_impaired: 0,
  });
  assert.equal(
    allUnknown,
    allKnownButZero,
    "資訊不足只能由 needs_human_verification 處理，不得回饋到 Care Score"
  );
});

test("四個 contribution 相加精確等於 total（四捨五入迴歸測試）", () => {
  const samples: Array<Partial<Record<keyof CaseRow, unknown>>> = [
    {},
    { age: 76, lives_alone: 1, flood_depth_cm: 60, no_water: 1,
      volunteers_needed: 2, volunteers_assigned: 0, reported_at: hoursAgo(10) },
    { age: 82, mobility_impaired: 1, flood_depth_cm: 37, no_electricity: 1,
      volunteers_needed: 3, volunteers_assigned: 1, reported_at: hoursAgo(3) },
    { flood_depth_cm: 10, volunteers_needed: 1, volunteers_assigned: 0,
      reported_at: hoursAgo(0.0833) },
    { age: 90, lives_alone: 1, mobility_impaired: 1, has_young_children: 1,
      flood_depth_cm: 200, no_water: 1, no_electricity: 1,
      volunteers_needed: 9, volunteers_assigned: 0, reported_at: hoursAgo(50) },
    // 這組是刻意挑出來的「分歧案例」：先加總再四捨五入會得到 0.7，
    // 先各自四捨五入再相加得到 0.6。少了它，這條測試對「改回先加總」
    // 的寫法完全無感 —— 經突變測試確認過。
    { flood_depth_cm: 1, no_water: 0, no_electricity: 0,
      volunteers_needed: 1, volunteers_assigned: 0,
      reported_at: hoursAgo(3 / 60) },
  ];
  for (const overrides of samples) {
    const b = computeCareScore(makeCase(overrides), NOW);
    const sum =
      b.vulnerability_contribution +
      b.severity_contribution +
      b.urgency_contribution +
      b.resource_gap_contribution;
    // 浮點誤差容忍度遠小於顯示精度（0.1），實質等同「精確相等」。
    assert.ok(
      Math.abs(sum - b.total) < 1e-9,
      `分項相加 ${sum} 應等於 total ${b.total}（${JSON.stringify(overrides)}）`
    );
  }
});

// ---------------------------------------------------------------------------
// computeConfidenceScore
// ---------------------------------------------------------------------------

test("六個關鍵欄位全部有值時，信心分數為 1", () => {
  const complete = makeCase({
    location_text: "台南市仁德區",
    age: 76,
    lives_alone: 1,
    mobility_impaired: 0,
    flood_depth_cm: 60,
    volunteers_needed: 2,
  });
  assert.equal(computeConfidenceScore(complete), 1);
});

test("六個關鍵欄位全部缺漏時，信心分數為 0", () => {
  const empty = makeCase({
    location_text: null,
    age: null,
    lives_alone: null,
    mobility_impaired: null,
    flood_depth_cm: null,
    volunteers_needed: null,
  });
  assert.equal(computeConfidenceScore(empty), 0);
});

test("部分缺漏時信心分數介於 0 與 1 之間，且缺越多分數越低", () => {
  const threeFilled = computeConfidenceScore(
    makeCase({
      location_text: "台南市仁德區",
      age: 76,
      lives_alone: 1,
      mobility_impaired: null,
      flood_depth_cm: null,
      volunteers_needed: null,
    })
  );
  const oneFilled = computeConfidenceScore(
    makeCase({
      location_text: "台南市仁德區",
      age: null,
      lives_alone: null,
      mobility_impaired: null,
      flood_depth_cm: null,
      volunteers_needed: null,
    })
  );
  assert.ok(threeFilled > 0 && threeFilled < 1, "3/6 應介於 0 與 1 之間");
  assert.ok(oneFilled > 0 && oneFilled < 1, "1/6 應介於 0 與 1 之間");
  assert.ok(oneFilled < threeFilled, "缺越多分數應越低");
});

// ---------------------------------------------------------------------------
// needsHumanVerification
// ---------------------------------------------------------------------------

test("信心分數低於 0.5 需要人工複核", () => {
  assert.equal(needsHumanVerification(0.49), true);
  assert.equal(needsHumanVerification(0), true);
});

test("信心分數等於或高於 0.5 不需要人工複核", () => {
  assert.equal(needsHumanVerification(0.5), false);
  assert.equal(needsHumanVerification(1), false);
});
