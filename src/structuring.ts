import type { Env, ExtractedFields } from "./types";

// Qwen3 30B (MoE, function-calling + JSON schema support), 32K context,
// strong multilingual/Chinese quality. Runs on Cloudflare's own Workers AI —
// no separate API key, billed against your account's free Neuron allocation.
// https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/
const MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    location_text: { type: ["string", "null"], description: "文字中提到的地址或地區，例如「台南仁德」" },
    age: { type: ["integer", "null"] },
    lives_alone: { type: ["boolean", "null"], description: "是否獨居" },
    mobility_impaired: { type: ["boolean", "null"], description: "行動是否不便" },
    has_young_children: { type: ["boolean", "null"], description: "家中是否有幼兒" },
    household_size: { type: ["integer", "null"], description: "家中共幾人" },
    flood_depth_cm: { type: ["integer", "null"], description: "淹水深度，公分" },
    no_water: { type: "boolean", description: "是否提到沒有飲用水" },
    no_electricity: { type: "boolean", description: "是否提到停電/沒有電" },
    need_types: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "debris_removal",
          "furniture_moving",
          "drinking_water",
          "cleaning_supplies",
          "water_electricity_repair",
          "other",
        ],
      },
    },
    volunteers_needed: { type: ["integer", "null"], description: "需要幾位志工協助" },
    summary: { type: "string", description: "一句話中文摘要，給志工快速判讀" },
    emergency_signal: {
      type: "boolean",
      description:
        "文字中是否透露立即性生命危險，例如受困無法脫身、溺水、昏迷、嚴重外傷持續出血、無法呼吸、意識不清等當下需要119/110立即介入的狀況——單純淹水嚴重、等待救援時間長、家中損失嚴重，不算在這個範圍內，那些是既有的 Severity/Urgency 在處理的事",
    },
  },
  required: [
    "location_text",
    "age",
    "lives_alone",
    "mobility_impaired",
    "has_young_children",
    "household_size",
    "flood_depth_cm",
    "no_water",
    "no_electricity",
    "need_types",
    "volunteers_needed",
    "summary",
    "emergency_signal",
  ],
} as const;

const SYSTEM_PROMPT = `你是災後需求通報的結構化助手。任務是把民眾用自然語言描述的災情需求，
轉換成結構化 JSON。

務必使用繁體中文（台灣用語），絕對不要使用簡體中文回應，即使輸入內容極短或難以判讀也一樣。

規則：
- 只填寫文字中「明確提到或能直接推論」的欄位，不要用一般常識腦補沒提到的資訊。
- 不確定的欄位一律填 null，不要猜測數字（例如沒提到年齡就填 null，不要填一個「看起來合理」的數字）。
- no_water / no_electricity 沒提到就是 false，這兩個欄位不能是 null。
- need_types 只能從給定的 enum 選，請依照下面的對照表判斷，只有在真的都不符合時才用 "other"：
    debris_removal           → 例如：清淤、清理污泥、鏟土
    furniture_moving         → 例如：搬家具、搬運家具、抬桌椅、搬冰箱
    drinking_water           → 例如：飲用水、喝的水、礦泉水
    cleaning_supplies        → 例如：清潔用品、消毒、打掃用具
    water_electricity_repair → 例如：水電、修電線、通水管
    other                    → 上述都不符合時才用這個
- summary 用一句話繁體中文摘要，包含地區、人數、最急迫的需求，給志工在3秒內看懂。
- emergency_signal 只在文字透露「當下就有立即生命危險」時才填 true，例如受困無法脫身、
  溺水、昏迷、意識不清、嚴重外傷持續出血、無法呼吸，這些是需要119/110立即介入的狀況。
  請嚴格區分「嚴重」與「立即危及生命」：淹水很深、等待很久、家具全毀、停水停電、
  年紀大又獨居，這些再嚴重都不算，它們由系統既有的 Severity/Urgency 處理。
  判斷不確定時一律填 false。`;

export async function extractFields(
  env: Env,
  rawText: string
): Promise<ExtractedFields> {
  const response = (await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: rawText },
    ],
    response_format: {
      type: "json_schema",
      json_schema: EXTRACTION_SCHEMA,
    },
    temperature: 0.2,
    max_tokens: 800,
  })) as { choices?: { message?: { content?: string } }[] };

  const content = response?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Workers AI did not return structured content");
  }

  const parsed = JSON.parse(content) as Partial<ExtractedFields>;

  // 防禦性正規化：就算 schema 沒被完美遵守，也不要讓整個流程炸掉。
  // 寧可保守地把可疑欄位歸零，也不要讓一個解析錯誤變成一個隱形的 500。
  return {
    location_text: parsed.location_text ?? null,
    age: typeof parsed.age === "number" ? parsed.age : null,
    lives_alone: typeof parsed.lives_alone === "boolean" ? parsed.lives_alone : null,
    mobility_impaired:
      typeof parsed.mobility_impaired === "boolean" ? parsed.mobility_impaired : null,
    has_young_children:
      typeof parsed.has_young_children === "boolean" ? parsed.has_young_children : null,
    household_size:
      typeof parsed.household_size === "number" ? parsed.household_size : null,
    flood_depth_cm:
      typeof parsed.flood_depth_cm === "number" ? parsed.flood_depth_cm : null,
    no_water: parsed.no_water === true,
    no_electricity: parsed.no_electricity === true,
    need_types: Array.isArray(parsed.need_types) ? parsed.need_types : [],
    volunteers_needed:
      typeof parsed.volunteers_needed === "number" ? parsed.volunteers_needed : null,
    summary: typeof parsed.summary === "string" ? parsed.summary : rawText.slice(0, 60),
    // 不確定就當作沒有：預設 true 會讓每一則通報都掛上緊急提醒，
    // 警告一旦變成雜訊，真正緊急的那則就沒人看了。
    emergency_signal: parsed.emergency_signal === true,
  };
}

/**
 * 免費地理編碼：OpenStreetMap Nominatim。
 * 使用限制（務必遵守，避免被 ban）：
 *   - 一定要帶一個能識別你專案的 User-Agent
 *   - 單一來源 <= 1 request/sec
 *   - 正式上線規模變大後，應改用付費地理編碼服務或內政部門牌坐標服務
 * https://operations.osmfoundation.org/policies/nominatim/
 */
export async function geocode(
  locationText: string | null
): Promise<{ lat: number; lng: number } | null> {
  if (!locationText) return null;
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", locationText + ", 台灣");
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": "care-radar-demo/0.1 (competition project)",
      },
    });
    if (!res.ok) return null;
    const results = (await res.json()) as { lat: string; lon: string }[];
    if (!results.length) return null;
    return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  } catch {
    // 地理編碼失敗不該讓整個通報流程失敗 —— 案件仍然要被存下來，
    // 只是暫時沒有座標，之後可以在後台手動補。
    return null;
  }
}

/**
 * 位置模糊化：把精確座標「吸附」到約 300 公尺的網格上，作為公開地圖顯示用。
 * 精確座標只在志工「認領」案件後才揭露 —— 這是保護獨居/弱勢者的關鍵設計，
 * 不是事後補的功能。
 */
export function fuzzLocation(lat: number, lng: number): { lat: number; lng: number } {
  const GRID = 0.003; // 約 300 公尺
  return {
    lat: Math.round(lat / GRID) * GRID,
    lng: Math.round(lng / GRID) * GRID,
  };
}
