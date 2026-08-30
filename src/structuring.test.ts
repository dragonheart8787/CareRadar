import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBoundedInt } from "./structuring.ts";

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
