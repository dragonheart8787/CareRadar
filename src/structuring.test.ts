import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractFields,
  looksLikeAPlaceName,
  normalizeBoundedInt,
  rejectHallucinatedLocation,
} from "./structuring.ts";

// ---------------------------------------------------------------------------
// normalizeBoundedInt
//
// 這個函式是「模型回傳的數字」進入系統的唯一關卡。它擋掉的不是會讓程式
// 崩潰的值，而是會安靜地扭曲 Care Score 排序的值 —— 所以邊界要測到。
// ---------------------------------------------------------------------------

test("範圍內的整數原樣通過", () => {
  assert.equal(normalizeBoundedInt(76, 0, 130), 76);
  assert.equal(normalizeBoundedInt(60, 0, Infinity), 60);
  assert.equal(normalizeBoundedInt(3, 1, Infinity), 3);
});

test("剛好等於下限或上限都算在範圍內", () => {
  assert.equal(normalizeBoundedInt(0, 0, 130), 0);
  assert.equal(normalizeBoundedInt(130, 0, 130), 130);
  assert.equal(normalizeBoundedInt(1, 1, 50), 1);
  assert.equal(normalizeBoundedInt(50, 1, 50), 50);
});

test("低於下限回傳 null", () => {
  assert.equal(normalizeBoundedInt(-5, 0, 130), null);
  assert.equal(normalizeBoundedInt(-100, 0, Infinity), null);
  assert.equal(normalizeBoundedInt(0, 1, Infinity), null);
});

test("高於上限回傳 null", () => {
  assert.equal(normalizeBoundedInt(131, 0, 130), null);
  assert.equal(normalizeBoundedInt(100000, 1, 50), null);
});

test("小數會先四捨五入再判斷範圍", () => {
  assert.equal(normalizeBoundedInt(2.5, 1, Infinity), 3);
  assert.equal(normalizeBoundedInt(2.4, 1, Infinity), 2);
  assert.equal(normalizeBoundedInt(12.7, 0, Infinity), 13);
  assert.equal(normalizeBoundedInt(-0.4, 0, 130), 0, "-0.4 四捨五入成 0，落在範圍內");
});

test("四捨五入之後才判斷範圍，不是之前", () => {
  // 130.4 本身超出上限，但四捨五入後是 130，應該被接受。
  assert.equal(normalizeBoundedInt(130.4, 0, 130), 130);
  // 0.6 四捨五入成 1，對下限 1 而言是合法的。
  assert.equal(normalizeBoundedInt(0.6, 1, Infinity), 1);
});

test("非 number 型別一律回傳 null", () => {
  assert.equal(normalizeBoundedInt("76", 0, 130), null);
  assert.equal(normalizeBoundedInt(null, 0, 130), null);
  assert.equal(normalizeBoundedInt(undefined, 0, 130), null);
  assert.equal(normalizeBoundedInt(true, 0, 130), null);
  assert.equal(normalizeBoundedInt([76], 0, 130), null);
  assert.equal(normalizeBoundedInt({ value: 76 }, 0, 130), null);
});

test("NaN 與 Infinity 回傳 null，即使上限是 Infinity", () => {
  assert.equal(normalizeBoundedInt(NaN, 0, 130), null);
  // 1e999 是合法 JSON，JSON.parse 會把它變成 Infinity；沒有這道關卡的話
  // 上限為 Infinity 的欄位會讓它整個穿過去。
  assert.equal(normalizeBoundedInt(Infinity, 0, Infinity), null);
  assert.equal(normalizeBoundedInt(-Infinity, 0, Infinity), null);
  assert.equal(normalizeBoundedInt(JSON.parse('{"n":1e999}').n, 1, Infinity), null);
});

// ---------------------------------------------------------------------------
// looksLikeAPlaceName
//
// 擋的是「在原文裡、但不是地名」的值（實測 id=39：「家裡」）。啟發式刻意從嚴。
// ---------------------------------------------------------------------------

test("looksLikeAPlaceName：指涉性用語不是地名", () => {
  for (const text of ["家裡", "我家", "這裡", "附近", "那邊"]) {
    assert.equal(looksLikeAPlaceName(text), false, text);
  }
});

test("looksLikeAPlaceName：沒有地名單位字的口語地名判為 false（已知的刻意取捨）", () => {
  // 「台南仁德」是真地名，但整串沒有縣市區鄉鎮村里路街巷弄號段…任何單位字，
  // 所以會被誤殺。這是設計上接受的代價：誤殺只是少一組座標、多問一句地址，
  // 放過「家裡」之類的詞則會墊高信心分數、抑制追問、還可能被拿去地理編碼。
  // 如果未來要放寬這一條，這個測試會失敗，提醒要重新評估兩邊的代價。
  assert.equal(looksLikeAPlaceName("台南仁德"), false);
});

test("looksLikeAPlaceName：含地名單位字的值為 true", () => {
  for (const text of ["台南市仁德區", "中正路三段100號", "石汐路", "高雄鳳山區"]) {
    assert.equal(looksLikeAPlaceName(text), true, text);
  }
});

test("looksLikeAPlaceName：空字串與單字為 false", () => {
  assert.equal(looksLikeAPlaceName(""), false);
  assert.equal(looksLikeAPlaceName("   "), false);
  assert.equal(looksLikeAPlaceName("路"), false, "只有單位字本身、不足 2 字元");
  assert.equal(looksLikeAPlaceName("家"), false);
});

test("looksLikeAPlaceName：判斷前先 trim", () => {
  assert.equal(looksLikeAPlaceName(" 路 "), false);
  assert.equal(looksLikeAPlaceName(" 石汐路 "), true);
});

// ---------------------------------------------------------------------------
// rejectHallucinatedLocation
// ---------------------------------------------------------------------------

function captureWarns<T>(fn: () => T): { result: T; warns: string[] } {
  const original = console.warn;
  const warns: string[] = [];
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  try {
    return { result: fn(), warns };
  } finally {
    console.warn = original;
  }
}

test("rejectHallucinatedLocation：「家裡」在原文裡 → null，且用『非地名』訊息記錄", () => {
  const { result, warns } = captureWarns(() =>
    rejectHallucinatedLocation("家裡", "家裡淹水超過80公分，腰部以上")
  );
  assert.equal(result, null);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^Rejected non-place location_text: 家裡$/);
});

test("rejectHallucinatedLocation：「台南市仁德區」在原文裡 → 保留，不記錄警告", () => {
  const { result, warns } = captureWarns(() =>
    rejectHallucinatedLocation("台南市仁德區", "我住台南市仁德區，家裡淹水")
  );
  assert.equal(result, "台南市仁德區");
  assert.equal(warns.length, 0);
});

test("rejectHallucinatedLocation：原文裡沒有的地名 → 仍回傳 null，沿用既有的『幻覺』訊息", () => {
  const { result, warns } = captureWarns(() =>
    rejectHallucinatedLocation("台南市仁德區", "家裡淹水超過80公分，腰部以上")
  );
  assert.equal(result, null);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^Rejected hallucinated location_text \(not found in raw input\)/);
});

test("rejectHallucinatedLocation：null 與空白字串維持原行為", () => {
  assert.equal(rejectHallucinatedLocation(null, "任何文字"), null);
  assert.equal(rejectHallucinatedLocation("   ", "任何文字   "), null);
});

test("rejectHallucinatedLocation：前後有空白的合法地名回傳模型原字串", () => {
  assert.equal(rejectHallucinatedLocation(" 石汐路 ", "石汐路淹水"), " 石汐路 ");
});

// ---------------------------------------------------------------------------
// extractFields：被拒絕的地名要不要從 summary 清掉
//
// 「連原文都找不到」的幻覺地名要清；「在原文裡但不是地名」（家裡）不清。
// ---------------------------------------------------------------------------

function fakeEnv(modelOutput: Record<string, unknown>) {
  return {
    AI: {
      run: async () => ({
        choices: [{ message: { content: JSON.stringify(modelOutput) } }],
      }),
    },
  } as unknown as Parameters<typeof extractFields>[0];
}

test("extractFields：非地名（家裡）被拒絕 → location_text 為 null，summary 保持原樣", async () => {
  const { result } = await withQuietWarn(() =>
    extractFields(
      fakeEnv({ location_text: "家裡", summary: "家裡淹水超過80公分，需要協助" }),
      "家裡淹水超過80公分，腰部以上"
    )
  );
  assert.equal(result.location_text, null);
  assert.equal(result.summary, "家裡淹水超過80公分，需要協助");
});

test("extractFields：幻覺地名（原文沒有）被拒絕 → summary 裡的該地名被移除（既有行為不變）", async () => {
  const { result } = await withQuietWarn(() =>
    extractFields(
      fakeEnv({ location_text: "台南仁德", summary: "台南仁德一戶需協助" }),
      "家裡淹水超過80公分，腰部以上"
    )
  );
  assert.equal(result.location_text, null);
  assert.equal(result.summary, "一戶需協助");
});

test("extractFields：合法地名保留，summary 不動", async () => {
  const { result } = await withQuietWarn(() =>
    extractFields(
      fakeEnv({ location_text: "台南市仁德區", summary: "台南市仁德區一戶需協助" }),
      "我在台南市仁德區，家裡淹水"
    )
  );
  assert.equal(result.location_text, "台南市仁德區");
  assert.equal(result.summary, "台南市仁德區一戶需協助");
});

async function withQuietWarn<T>(fn: () => Promise<T>): Promise<{ result: T }> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return { result: await fn() };
  } finally {
    console.warn = original;
  }
}
