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

test("looksLikeAPlaceName：指涉性用語與一般用語不是地名", () => {
  for (const text of ["家裡", "我家", "這裡", "附近", "那邊", "我不知道"]) {
    assert.equal(looksLikeAPlaceName(text), false, text);
  }
});

test("looksLikeAPlaceName：縣市加區名的簡寫（沒有單位字）判為 true", () => {
  // 規則已因正式資料而改變：上一版要求必須含地名單位字，並把「台南仁德 → false」
  // 寫成已知的刻意取捨。正式資料顯示這會擋掉台灣人常用的「縣市＋區名」簡寫
  // （新北金山、新北新店、高雄鳳山、台南仁德…），結果是沒有座標、持續提示
  // 「還不知道您的所在地區」。現在改成「含縣市名，或含強單位字」，所以這些都放行。
  for (const text of ["新北金山", "新北新店", "高雄鳳山", "台南仁德", "臺南仁德"]) {
    assert.equal(looksLikeAPlaceName(text), true, text);
  }
});

test("looksLikeAPlaceName：含強單位字的值為 true", () => {
  for (const text of ["台南市仁德區", "中正路三段100號", "石汐路", "高雄鳳山區"]) {
    assert.equal(looksLikeAPlaceName(text), true, text);
  }
});

test("looksLikeAPlaceName：台／臺兩種寫法與全部縣市名都認得", () => {
  for (const name of [
    "台北", "臺北", "新北", "桃園", "台中", "臺中", "台南", "臺南", "高雄", "基隆",
    "新竹", "苗栗", "彰化", "南投", "雲林", "嘉義", "屏東", "宜蘭", "花蓮", "台東",
    "臺東", "澎湖", "金門", "連江", "馬祖",
  ]) {
    assert.equal(looksLikeAPlaceName(name), true, name);
  }
});

test("looksLikeAPlaceName：整句話塞進來的值為 false", () => {
  for (const text of ["電線泡水了要找人來修", "請問怎麼使用"]) {
    assert.equal(looksLikeAPlaceName(text), false, text);
  }
});

test("looksLikeAPlaceName：超過 40 字一律 false，即使含縣市名", () => {
  const at40 = "台南市" + "一".repeat(37);
  assert.equal([...at40].length, 40);
  assert.equal(looksLikeAPlaceName(at40), true, "剛好 40 字仍可通過");
  const at41 = at40 + "一";
  assert.equal(looksLikeAPlaceName(at41), false, "41 字視為整句話");
  assert.equal(
    looksLikeAPlaceName("我住在台南市仁德區的某個社區裡面，家裡一樓整個都淹水了，需要有人來幫忙處理一下，麻煩盡快"),
    false
  );
});

test("looksLikeAPlaceName：已移除的弱單位字不再放行", () => {
  // 道、島、港、橋、站、校、院：「道」會被「知道」誤放行，其餘太容易匹配到一般用語。
  for (const text of ["知道了", "學校", "醫院", "車站", "大橋", "港口", "小島", "報道"]) {
    assert.equal(looksLikeAPlaceName(text), false, text);
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

test("rejectHallucinatedLocation：「新北新店」在原文裡 → 保留，不記錄警告", () => {
  const { result, warns } = captureWarns(() =>
    rejectHallucinatedLocation("新北新店", "我在新北新店，家裡淹水")
  );
  assert.equal(result, "新北新店");
  assert.equal(warns.length, 0);
});

test("rejectHallucinatedLocation：整句話塞進 location_text → null（非地名）", () => {
  const raw = "電線泡水了要找人來修";
  const { result, warns } = captureWarns(() => rejectHallucinatedLocation(raw, raw));
  assert.equal(result, null);
  assert.match(warns[0], /^Rejected non-place location_text: /);
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
