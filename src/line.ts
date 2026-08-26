import type { Env } from "./types";
import { extractFields, geocode, fuzzLocation } from "./structuring";
import { insertCase } from "./db";

interface LineEvent {
  type: string;
  replyToken?: string;
  source?: { type: string; userId?: string };
  message?: { type: string; text?: string };
}
interface LineWebhookBody {
  destination: string;
  events: LineEvent[];
}

/** 常數時間比對，避免 timing attack 洩漏簽章資訊。 */
function timingSafeEqual(a: string, b: string): boolean {
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

async function replyMessage(env: Env, replyToken: string, text: string) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return;
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

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
      if (event.type !== "message" || event.message?.type !== "text") {
        continue; // 圖片/貼圖/位置訊息：MVP 先不處理，未來可用照片提升 confidence
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

      const created = await insertCase(env, {
        source: "line",
        reporterLineUserId: userId,
        rawText: text,
        fields,
        exact,
        fuzzed,
      });

      if (event.replyToken) {
        await replyMessage(
          env,
          event.replyToken,
          buildConfirmationText(
            created.summary ?? fields.summary,
            created.confidence_score ?? 0,
            created.needs_human_verification === 1
          )
        );
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
