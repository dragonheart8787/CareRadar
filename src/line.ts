import type { Env } from "./types";
import { extractFields, geocode, fuzzLocation } from "./structuring";
import { describeMissingFields, getMissingFieldKeys } from "./care_score";
import {
  findPendingSupplementCase,
  insertCase,
  supplementCase,
  supplementCaseLocation,
} from "./db";

interface LineEvent {
  type: string;
  replyToken?: string;
  source?: { type: string; userId?: string };
  message?: {
    type: string;
    text?: string;
    latitude?: number;
    longitude?: number;
    address?: string;
  };
}
/** LINE Quick Reply 的一顆按鈕：按下去等同使用者自己輸入了 text。 */
interface QuickReplyItem {
  label: string;
  text: string;
}

interface LineWebhookBody {
  destination: string;
  events: LineEvent[];
}

/** 常數時間比對，避免 timing attack 洩漏簽章資訊。 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyLineSignature(
  channelSecret: string,
  rawBody: string,
  signatureHeader: string | null
): Promise<boolean> {
  if (!signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody)
  );
  const computed = arrayBufferToBase64(sigBuf);
  return timingSafeEqual(computed, signatureHeader);
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function replyMessage(
  env: Env,
  replyToken: string,
  text: string,
  quickReplyItems?: QuickReplyItem[]
) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return;

  const message: Record<string, unknown> = { type: "text", text };
  // 刻意檢查 length 而不只是「有沒有傳」：LINE 規定 quickReply.items 至少 1 筆，
  // 送空陣列整則訊息會被退回 —— 那會讓追問訊息整個發不出去。缺的欄位剛好
  // 只有「所在地區」時 buildQuickReplyItemsForMissingFields 就會回空陣列。
  if (quickReplyItems?.length) {
    message.quickReply = {
      items: quickReplyItems.map((item) => ({
        type: "action",
        action: { type: "message", label: item.label, text: item.text },
      })),
    };
  }

  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [message] }),
  });
}

/**
 * 「答案可以窮舉成幾個選項」的關鍵欄位 → 對應的快速回覆按鈕。
 * 按鈕的 text 是使用者按下去等同送出的自然語言句子，會走跟手動打字
 * 完全一樣的 AI 結構化流程，後端不需要任何解析按鈕點擊的邏輯。
 *
 * location_text 刻意不在表內 —— 地址沒辦法窮舉成按鈕，維持自由輸入。
 */
const MISSING_FIELD_QUICK_REPLIES: Record<string, QuickReplyItem[]> = {
  age: [
    { label: "65歲以下", text: "我年齡在65歲以下" },
    { label: "65-79歲", text: "我年齡65到79歲之間" },
    { label: "80歲以上", text: "我年齡80歲以上" },
  ],
  lives_alone: [
    { label: "獨居", text: "我一個人住，是獨居" },
    { label: "非獨居", text: "家裡不只我一個人住" },
  ],
  mobility_impaired: [
    { label: "行動不便", text: "我行動不便" },
    { label: "行動方便", text: "我行動方便，沒有特別的行動限制" },
  ],
  flood_depth_cm: [
    { label: "約30公分以下", text: "家裡淹水大約30公分以下，膝蓋以下" },
    { label: "約30-80公分", text: "家裡淹水大約30到80公分，膝蓋到腰部之間" },
    { label: "超過80公分", text: "家裡淹水超過80公分，腰部以上" },
  ],
  volunteers_needed: [
    { label: "1人", text: "需要1位志工協助" },
    { label: "2人", text: "需要2位志工協助" },
    { label: "3人以上", text: "需要3位以上志工協助" },
  ],
};

/**
 * 把「還缺哪些欄位」換成快速回覆按鈕，依 missingFieldKeys 的順序串接。
 *
 * 假設：LINE 的 quickReply.items 上限是 13 顆，這裡不做裁切。
 * 對照表五個欄位全展開是 3+2+2+3+3 = 13 顆，剛好貼齊上限；而實務上
 * volunteers_needed 在 schema 是 NOT NULL DEFAULT 1、永遠不會被判定為缺漏，
 * 所以實際送得出去的最多是 10 顆。
 * 之後若讓 volunteers_needed 可為 null、往對照表新增欄位、或把任一欄位的
 * 選項加多，總數就可能超過 13 而被 LINE 退件，屆時必須在這裡補上裁切。
 */
function buildQuickReplyItemsForMissingFields(
  missingFieldKeys: string[]
): QuickReplyItem[] {
  const items: QuickReplyItem[] = [];
  for (const key of missingFieldKeys) {
    const forField = MISSING_FIELD_QUICK_REPLIES[key];
    if (forField) items.push(...forField);
  }
  return items;
}

// 使用者第一次加好友（follow 事件）時的自我介紹訊息。
const WELCOME_TEXT =
  "哈囉，歡迎加入「災後需求雷達」！\n\n這個機器人是用來通報淹水復原期間的生活需求，幫忙媒合志工協助。\n\n請直接用一段話描述您的狀況，包含以下資訊：\n・所在地區（例如：台南仁德）\n・年齡、是否獨居、是否行動不便\n・淹水深度\n・需要幾位志工協助\n・需要的協助類型（清淤、搬家具、飲用水、清潔用品、水電）\n・目前是否缺水缺電\n\n範例：\n「我住台南仁德，76歲，一個人住，家裡淹了60公分，需要兩個人幫忙搬家具，也沒有飲用水。」\n\n打好之後直接傳送就可以了，我們會盡快協助媒合志工。";

// 歡迎訊息裡那顆「照著送一次看看」的按鈕。文字直接沿用 WELCOME_TEXT 內既有的
// 範例句子（下方有執行期以外的一致性依據：兩者必須逐字相同，改一邊就要改另一邊）。
const WELCOME_EXAMPLE_TEXT =
  "我住台南仁德，76歲，一個人住，家裡淹了60公分，需要兩個人幫忙搬家具，也沒有飲用水。";

const WELCOME_QUICK_REPLIES: QuickReplyItem[] = [
  { label: "傳送範例文字看看", text: WELCOME_EXAMPLE_TEXT },
];

// 使用者還沒發過任何文字通報就先分享位置時的回覆。
// 刻意不寫「之後會自動幫您附上」—— 這一版沒有暫存座標的機制，
// 對災民承諾一件程式其實沒做的事，比不回覆更糟。
const LOCATION_WITHOUT_CASE_TEXT =
  "已收到您分享的位置，不過目前還沒有可以對應的通報內容。\n\n麻煩先用一段文字說明您的狀況（所在地區、年齡、是否獨居、淹水深度、需要幾位志工協助），送出之後再分享一次位置，我們就能把座標附到您的案件上。";

function buildConfirmationText(
  summary: string,
  confidence: number,
  needsVerification: boolean
): string {
  let msg = `已收到您的通報：\n${summary}\n\n我們會盡快協助媒合志工。`;
  if (needsVerification) {
    msg +=
      "\n\n提醒：您提供的資訊有部分不完整，我們會請在地志工/里長協助電話確認，不會因此降低協助的優先順序。";
  }
  return msg;
}

function buildFollowUpQuestionText(missingLabels: string[]): string {
  return (
    "已經收到您的訊息，還需要以下資訊才能準確評估優先順序，麻煩直接回覆補充：\n" +
    missingLabels.join("、") +
    "\n\n即使暫時不方便補充，我們也會請在地志工/里長協助電話確認，不會因此降低協助的優先順序。"
  );
}

export async function handleLineWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!env.LINE_CHANNEL_SECRET) {
    return new Response("LINE_CHANNEL_SECRET not configured", { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");
  const valid = await verifyLineSignature(
    env.LINE_CHANNEL_SECRET,
    rawBody,
    signature
  );
  if (!valid) {
    return new Response("invalid signature", { status: 401 });
  }

  const body = JSON.parse(rawBody) as LineWebhookBody;

  // LINE 要求 webhook 在 2 秒內回應，但 AI 抽取 + 地理編碼 + 寫入 D1 + Reply API
  // 全部跑完常常超過，導致 LINE 判定逾時中斷連線、Worker 被取消（案件沒寫進去）。
  // 改成先回 200，事件處理交給 waitUntil 在背景跑完。
  ctx.waitUntil(processLineEvents(env, body.events ?? []));

  return new Response("OK", { status: 200 });
}

// 逐一處理事件；單一事件處理失敗不該讓整批 webhook 回傳非 200
// (LINE 收到非 200 會重送，可能造成重複建立案件)。
async function processLineEvents(env: Env, events: LineEvent[]) {
  for (const event of events) {
    try {
      // 加好友：回一則自我介紹說明怎麼通報。這是一次性事件，跟訊息洗版是不同的
      // 濫用情境，所以刻意不套用 LINE_RATE_LIMITER。
      if (event.type === "follow") {
        if (event.replyToken) {
          await replyMessage(
            env,
            event.replyToken,
            WELCOME_TEXT,
            WELCOME_QUICK_REPLIES
          );
        }
        continue;
      }
      // 分享位置：LINE 直接給的這組座標就是精確值，比拿文字去 Nominatim
      // 猜地址準得多，所以直接採用、跳過 geocode()。它走的仍然是既有的
      // 「補充既有案件」路徑，不是另一套平行的建案流程。
      if (event.type === "message" && event.message?.type === "location") {
        await processLocationEvent(env, event);
        continue;
      }
      if (event.type !== "message" || event.message?.type !== "text") {
        continue; // 圖片/貼圖等其他類型：MVP 先不處理，未來可用照片提升 confidence
      }
      const text = event.message.text ?? "";
      const userId = event.source?.userId ?? null;

      // 簽章驗證只能擋掉偽造請求，擋不掉合法使用者短時間狂發訊息塞爆案件清單。
      // 注意：限流 key 用 "unknown" 作為 fallback，但寫進 DB 的 reporter_line_user_id
      // 仍然維持 null —— 「不知道是誰」不該被記成一個叫 unknown 的使用者。
      const rateLimitKey = userId ?? "unknown";
      const { success } = await env.LINE_RATE_LIMITER.limit({ key: rateLimitKey });
      if (!success) {
        if (event.replyToken) {
          await replyMessage(
            env,
            event.replyToken,
            "您通報得有點頻繁，請稍後再試一次。"
          );
        }
        continue; // 跳過這則，不進入 AI 結構化跟寫入 D1
      }

      const fields = await extractFields(env, text);
      const exact = await geocode(fields.location_text);
      const fuzzed = exact ? fuzzLocation(exact.lat, exact.lng) : null;

      // 同一位使用者 15 分鐘內還有待複核的案件 → 這則當作補充，不另開新案件。
      const pending = await findPendingSupplementCase(env, userId, 15);
      const caseRow = pending
        ? await supplementCase(env, pending.id, fields, text, exact, fuzzed)
        : await insertCase(env, {
            source: "line",
            reporterLineUserId: userId,
            rawText: text,
            fields,
            exact,
            fuzzed,
          });

      if (event.replyToken) {
        // 還是資訊不足 → 明講還缺什麼並邀請補充，同時附上快速回覆按鈕讓不方便
        // 打字的使用者直接按；補齊了 → 照原本的確認訊息，不需要按鈕。
        // caseRow 可能來自「新建案件」或「supplementCase 補充後仍待複核」，
        // 兩條路徑共用這一段，所以按鈕兩者都會帶上。
        if (caseRow.needs_human_verification === 1) {
          await replyMessage(
            env,
            event.replyToken,
            buildFollowUpQuestionText(describeMissingFields(caseRow)),
            buildQuickReplyItemsForMissingFields(getMissingFieldKeys(caseRow))
          );
        } else {
          await replyMessage(
            env,
            event.replyToken,
            buildConfirmationText(
              caseRow.summary ?? fields.summary,
              caseRow.confidence_score ?? 0,
              caseRow.needs_human_verification === 1
            )
          );
        }
      }
    } catch (err) {
      console.error("Error handling LINE event", err);
      if (event.replyToken) {
        await replyMessage(
          env,
          event.replyToken,
          "抱歉，系統處理您的通報時發生問題，請稍後再試一次，或直接聯繫現場救災協調站。"
        );
      }
    }
  }
}

/**
 * 位置分享訊息。抽成獨立函式，是為了讓上面文字訊息那條主路徑一行都不用動。
 * 呼叫端已經包在 try/catch 裡，這裡丟出的例外會走同一套錯誤回覆。
 */
async function processLocationEvent(env: Env, event: LineEvent) {
  const lat = event.message?.latitude;
  const lng = event.message?.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") {
    return; // 沒有座標的位置訊息不該發生；真的發生就當作沒收到，不拿錯誤訊息去打擾使用者
  }

  const userId = event.source?.userId ?? null;

  // 位置訊息跟文字訊息共用同一個限流 key，否則同一個人可以改發位置訊息
  // 來繞過文字訊息的額度。
  const { success } = await env.LINE_RATE_LIMITER.limit({
    key: userId ?? "unknown",
  });
  if (!success) {
    if (event.replyToken) {
      await replyMessage(
        env,
        event.replyToken,
        "您通報得有點頻繁，請稍後再試一次。"
      );
    }
    return;
  }

  const pending = await findPendingSupplementCase(env, userId, 15);
  if (!pending) {
    // 還沒有任何文字描述就先分享位置：沒有需求類型、沒有人數，建不出一筆
    // 有意義的案件，這版也不做座標暫存，所以完全不寫入 D1，只回覆提示。
    if (event.replyToken) {
      await replyMessage(env, event.replyToken, LOCATION_WITHOUT_CASE_TEXT);
    }
    return;
  }

  const fuzzed = fuzzLocation(lat, lng);
  await supplementCaseLocation(
    env,
    pending.id,
    { lat, lng },
    fuzzed,
    // address 是 LINE 自己對這組座標的地址描述，不是使用者打的字。
    event.message?.address ?? "分享位置"
  );

  // 座標本身不改變「還缺哪些關鍵欄位」的判斷，所以不重跑
  // buildFollowUpQuestionText / buildConfirmationText 那套邏輯，只做簡短確認。
  if (event.replyToken) {
    await replyMessage(
      env,
      event.replyToken,
      "已收到您分享的位置，會用來協助志工找到正確地點。"
    );
  }
}
