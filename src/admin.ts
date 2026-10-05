import type { VolunteerCodeSummary } from "./db";
import type { CaseRow } from "./types";

/** raw_text / summary 都是使用者自由文字，一律逸出後才進 HTML。 */
function escapeHtml(value: string | null): string {
  if (value === null) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderCaseColumn(
  label: string,
  row: CaseRow | null,
  missingText: string
): string {
  if (!row) {
    return /* html */ `<div class="col">
      <div class="col-label">${escapeHtml(label)}</div>
      <div class="missing">${escapeHtml(missingText)}</div>
    </div>`;
  }
  return /* html */ `<div class="col">
    <div class="col-label">${escapeHtml(label)}</div>
    <div class="case-id">#${row.id}</div>
    <dl>
      <dt>摘要</dt><dd>${escapeHtml(row.summary) || "（無）"}</dd>
      <dt>原始通報內容</dt><dd class="raw">${escapeHtml(row.raw_text)}</dd>
      <dt>通報時間</dt><dd>${escapeHtml(row.reported_at)} UTC</dd>
      <dt>狀態</dt><dd>${escapeHtml(row.status)}</dd>
    </dl>
  </div>`;
}

export function renderDuplicatesHtml(
  pairs: Array<{ duplicate: CaseRow; original: CaseRow | null }>
): string {
  const body = pairs.length
    ? pairs
        .map(
          (p) => /* html */ `<section class="pair">
      <h2>疑似重複：#${p.duplicate.id} ↔ #${
        p.duplicate.possible_duplicate_of ?? "?"
      }</h2>
      <div class="cols">
        ${renderCaseColumn("這筆（疑似重複）", p.duplicate, "（案件不存在）")}
        ${renderCaseColumn(
          "原始案件",
          p.original,
          "（找不到原始案件，可能已被刪除）"
        )}
      </div>
      <div class="actions">
        <button class="danger" data-id="${p.duplicate.id}" data-action="merge">
          確認合併（關閉這筆重複案件）
        </button>
        <button data-id="${p.duplicate.id}" data-action="not_duplicate">
          不是重複（保留兩筆）
        </button>
      </div>
    </section>`
        )
        .join("\n")
    : /* html */ `<p class="empty">目前沒有待複核的疑似重複案件。</p>`;

  return /* html */ `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>疑似重複案件複核｜災後需求雷達</title>
<style>
  :root{
    --bg:#10151d; --panel:#161d29; --panel-2:#1c2432; --line:#2a3444;
    --ink:#e9edf3; --ink-dim:#93a1b5; --amber:#e2a23b; --red:#d9634a; --teal:#4fb0a3;
  }
  *{ box-sizing:border-box; }
  body{
    margin:0; padding:24px; background:var(--bg); color:var(--ink);
    font-family:system-ui, "Noto Sans TC", sans-serif; line-height:1.6;
  }
  h1{ font-size:20px; margin:0 0 4px; }
  .lede{ color:var(--ink-dim); font-size:13px; margin:0 0 24px; max-width:70ch; }
  .empty{ color:var(--ink-dim); }
  .pair{
    background:var(--panel); border:1px solid var(--line); border-radius:10px;
    padding:14px 16px; margin-bottom:16px;
  }
  .pair h2{ font-size:14px; margin:0 0 12px; color:var(--amber); }
  .cols{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  @media (max-width:760px){ .cols{ grid-template-columns:1fr; } }
  .col{ background:var(--panel-2); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  .col-label{ font-size:11px; color:var(--ink-dim); text-transform:uppercase; letter-spacing:.05em; }
  .case-id{ font-family:ui-monospace, monospace; font-size:18px; color:var(--teal); margin-bottom:6px; }
  dl{ margin:0; font-size:13px; }
  dt{ color:var(--ink-dim); font-size:11px; margin-top:8px; }
  dd{ margin:0; }
  dd.raw{ white-space:pre-wrap; word-break:break-word; }
  .missing{ color:var(--ink-dim); font-style:italic; padding:8px 0; }
  .actions{ display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
  button{
    padding:8px 14px; border-radius:6px; border:1px solid var(--teal);
    background:transparent; color:var(--teal); font-size:13px; cursor:pointer;
    font-family:inherit;
  }
  button.danger{ border-color:var(--red); color:var(--red); }
  button:disabled{ opacity:.4; cursor:default; }
</style>
</head>
<body>
<h1>疑似重複案件複核</h1>
<p class="lede">
  系統只標記、不自動合併 —— 誤合併（把兩戶不同人家的需求當成一件）比留著一個
  未處理的重複案件危害更大。請比對兩筆的原始通報內容後再決定。
</p>
${body}

<script>
// 這裡刻意沒有任何金鑰：頁面靠 HTTP Basic Auth 授權，瀏覽器會自動把憑證
// 附加在同源請求上，包含下面這個 fetch。
document.querySelectorAll('button[data-id]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    document.querySelectorAll('button[data-id]').forEach(b => b.disabled = true);
    try {
      const res = await fetch('/api/admin/duplicates/' + id + '/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        alert('處理失敗（HTTP ' + res.status + '），請重新整理後再試。');
        document.querySelectorAll('button[data-id]').forEach(b => b.disabled = false);
        return;
      }
      // 重新 GET 同一個網址；Basic Auth 憑證由瀏覽器自動帶上。
      location.reload();
    } catch (err) {
      alert('連線失敗，請重新整理後再試。');
      document.querySelectorAll('button[data-id]').forEach(b => b.disabled = false);
    }
  });
});
</script>
</body>
</html>`;
}

const VOLUNTEER_STATUS_TEXT: Record<VolunteerCodeSummary["status"], string> = {
  active: "有效",
  expired: "已過期",
  revoked: "已撤銷",
};

/**
 * 志工通行碼管理頁。
 *
 * 明文通行碼**絕不**出現在伺服器端渲染的 HTML 裡 —— 這一頁根本拿不到明文
 * （資料庫只存雜湊）。建立成功之後，前端 script 用 textContent 把 API 回應裡的
 * 明文放到畫面上（不是 innerHTML，更不是字串拼接），重新整理就消失。
 *
 * 所有來自資料庫的文字（label、時間）一律走 escapeHtml。
 */
export function renderVolunteersHtml(rows: VolunteerCodeSummary[]): string {
  const body = rows.length
    ? rows
        .map(
          (r) => /* html */ `<tr>
        <td>${escapeHtml(r.label)}</td>
        <td>${escapeHtml(r.created_at)} UTC</td>
        <td>${escapeHtml(r.expires_at)} UTC</td>
        <td class="status-${escapeHtml(r.status)}">${escapeHtml(
          VOLUNTEER_STATUS_TEXT[r.status] ?? r.status
        )}</td>
        <td class="num">${r.claim_count}</td>
        <td>${
          r.revoked
            ? ""
            : /* html */ `<button class="danger" data-id="${r.id}" data-label="${escapeHtml(
                r.label
              )}">撤銷</button>`
        }</td>
      </tr>`
        )
        .join("\n")
    : /* html */ `<tr><td colspan="6" class="empty">還沒有發放任何通行碼。</td></tr>`;

  return /* html */ `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>志工通行碼管理｜災後需求雷達</title>
<style>
  :root{
    --bg:#10151d; --panel:#161d29; --panel-2:#1c2432; --line:#2a3444;
    --ink:#e9edf3; --ink-dim:#93a1b5; --amber:#e2a23b; --red:#d9634a; --teal:#4fb0a3;
  }
  *{ box-sizing:border-box; }
  body{
    margin:0; padding:24px; background:var(--bg); color:var(--ink);
    font-family:system-ui, "Noto Sans TC", sans-serif; line-height:1.6;
  }
  h1{ font-size:20px; margin:0 0 4px; }
  h2{ font-size:14px; margin:0 0 10px; color:var(--amber); }
  .lede{ color:var(--ink-dim); font-size:13px; margin:0 0 24px; max-width:70ch; }
  .panel{
    background:var(--panel); border:1px solid var(--line); border-radius:10px;
    padding:14px 16px; margin-bottom:16px;
  }
  form{ display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; }
  label{ display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--ink-dim); }
  input{
    background:var(--panel-2); border:1px solid var(--line); border-radius:6px;
    color:var(--ink); padding:7px 9px; font-size:13px; font-family:inherit;
  }
  input#label{ width:260px; }
  input#validDays{ width:90px; }
  button{
    padding:8px 14px; border-radius:6px; border:1px solid var(--teal);
    background:transparent; color:var(--teal); font-size:13px; cursor:pointer;
    font-family:inherit;
  }
  button.danger{ border-color:var(--red); color:var(--red); padding:4px 10px; font-size:12px; }
  button:disabled{ opacity:.4; cursor:default; }
  #new-code{ margin-top:12px; padding:10px 12px; border:1px solid var(--amber); border-radius:8px; }
  #new-code[hidden]{ display:none; }
  #new-code-text{
    display:block; font-family:ui-monospace, monospace; font-size:22px;
    letter-spacing:.08em; color:var(--amber); margin:6px 0;
    user-select:all; word-break:break-all;
  }
  .warn{ color:var(--amber); font-size:12px; }
  table{ width:100%; border-collapse:collapse; font-size:13px; }
  th, td{ text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:middle; }
  th{ color:var(--ink-dim); font-size:11px; font-weight:600; }
  td.num{ font-family:ui-monospace, monospace; }
  td.empty{ color:var(--ink-dim); font-style:italic; }
  .status-active{ color:var(--teal); }
  .status-expired{ color:var(--ink-dim); }
  .status-revoked{ color:var(--red); }
  .table-wrap{ overflow-x:auto; }
</style>
</head>
<body>
<h1>志工通行碼管理</h1>
<p class="lede">
  志工認領案件必須帶有效的通行碼。通行碼由這裡發放、可以撤銷，撤銷立即生效：
  該碼名下所有認領憑證當場失效，還佔著名額的認領會被釋放，名額還給案件。
  公開地圖與清單不需要通行碼。
</p>

<div class="panel">
  <h2>發放新的通行碼</h2>
  <form id="create-form">
    <label>名稱（發給誰／哪個單位，1–60 字）
      <input id="label" type="text" maxlength="60" required autocomplete="off" />
    </label>
    <label>有效天數（1–90）
      <input id="validDays" type="number" min="1" max="90" step="1" value="14" required />
    </label>
    <button type="submit" id="create-btn">建立</button>
  </form>
  <div id="new-code" hidden>
    <div class="warn">只會顯示這一次，請立即複製。重新整理頁面之後就看不到了。</div>
    <code id="new-code-text"></code>
    <div class="warn" id="new-code-meta"></div>
  </div>
</div>

<div class="panel">
  <h2>所有通行碼</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>名稱</th><th>建立</th><th>到期</th><th>狀態</th><th>認領次數</th><th></th></tr>
      </thead>
      <tbody>
${body}
      </tbody>
    </table>
  </div>
</div>

<script>
// 這裡刻意沒有任何金鑰：頁面靠 HTTP Basic Auth 授權，瀏覽器會自動把憑證
// 附加在同源請求上，包含下面的 fetch。
document.getElementById('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('create-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/admin/volunteer-codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: document.getElementById('label').value,
        validDays: Number(document.getElementById('validDays').value),
      }),
    });
    if (!res.ok) {
      alert('建立失敗（HTTP ' + res.status + '），請檢查名稱與有效天數。');
      return;
    }
    const data = await res.json();
    // 明文只用 textContent 放進畫面：不進 innerHTML、不進任何字串拼接。
    document.getElementById('new-code-text').textContent = data.code;
    document.getElementById('new-code-meta').textContent = '到期時間：' + data.expires_at + ' UTC（列表重新整理後才會出現這一筆）';
    document.getElementById('new-code').hidden = false;
    document.getElementById('create-form').reset();
  } catch (err) {
    alert('連線失敗，請稍後再試。');
  } finally {
    btn.disabled = false;
  }
});

document.querySelectorAll('button[data-id]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const id = btn.dataset.id;
    const label = btn.dataset.label || '';
    if (!confirm('確定要撤銷「' + label + '」這組通行碼嗎？\\n撤銷立即生效，它名下還佔著名額的認領會被釋放，這個動作無法復原。')) return;
    document.querySelectorAll('button[data-id]').forEach((b) => (b.disabled = true));
    try {
      const res = await fetch('/api/admin/volunteer-codes/' + id + '/revoke', { method: 'POST' });
      if (res.status === 409) {
        alert('這組通行碼已經被撤銷過了。');
        location.reload();
        return;
      }
      if (!res.ok) {
        alert('撤銷失敗（HTTP ' + res.status + '），請重新整理後確認狀態。');
        document.querySelectorAll('button[data-id]').forEach((b) => (b.disabled = false));
        return;
      }
      const data = await res.json();
      alert('已撤銷，釋放了 ' + data.released + ' 筆認領。');
      location.reload();
    } catch (err) {
      alert('連線失敗，請重新整理後確認狀態。');
      document.querySelectorAll('button[data-id]').forEach((b) => (b.disabled = false));
    }
  });
});
</script>
</body>
</html>`;
}
