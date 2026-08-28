export function renderHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>災後需求雷達｜關懷優先排序 × 志工智慧媒合</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Sans+TC:wght@400;500;700&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --bg: #10151d;
    --panel: #161d29;
    --panel-2: #1c2432;
    --line: #2a3444;
    --ink: #e9edf3;
    --ink-dim: #93a1b5;
    --amber: #e2a23b;
    --amber-dim: #4a3a20;
    --teal: #4fb0a3;
    --red: #d9634a;
  }
  *{ box-sizing:border-box; }
  body{
    margin:0; background:var(--bg); color:var(--ink);
    font-family:"IBM Plex Sans TC", system-ui, sans-serif;
  }
  header{
    padding:20px 24px 14px; border-bottom:1px solid var(--line);
    display:flex; align-items:baseline; gap:14px; flex-wrap:wrap;
  }
  header h1{
    font-family:"Space Grotesk", "IBM Plex Sans TC", sans-serif;
    font-size:20px; font-weight:700; margin:0; letter-spacing:0.02em;
  }
  header p{ margin:0; color:var(--ink-dim); font-size:13px; }
  .layout{ display:grid; grid-template-columns: 420px 1fr; height:calc(100vh - 66px); }
  @media (max-width: 900px){ .layout{ grid-template-columns: 1fr; height:auto; } #map{ height:420px; } }

  .list-panel{ overflow-y:auto; border-right:1px solid var(--line); }
  .toggle-row{ display:flex; gap:8px; padding:14px; border-bottom:1px solid var(--line); }
  .toggle-btn{
    flex:1; padding:9px 8px; border-radius:8px; border:1px solid var(--line);
    background:var(--panel-2); color:var(--ink-dim); font-size:13px; cursor:pointer;
    font-family:"IBM Plex Sans TC", sans-serif;
  }
  .toggle-btn.active{ background:var(--amber-dim); color:var(--amber); border-color:var(--amber); }
  .hint{ padding:0 14px 10px; color:var(--ink-dim); font-size:12px; line-height:1.6; }

  .card{
    margin:10px 14px; padding:12px 14px; background:var(--panel);
    border:1px solid var(--line); border-radius:10px; cursor:pointer;
    transition:border-color .15s;
  }
  .card:hover{ border-color:var(--amber); }
  .card.full{ opacity:0.55; }
  .card-top{ display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }
  .rank{ font-family:"IBM Plex Mono", monospace; color:var(--ink-dim); font-size:12px; }
  .score{ font-family:"IBM Plex Mono", monospace; font-size:22px; font-weight:600; color:var(--amber); }
  .score-label{ font-size:10px; color:var(--ink-dim); text-align:right; }
  .summary{ font-size:13.5px; margin:8px 0 6px; line-height:1.5; }
  .tags{ display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px; }
  .tag{ font-size:11px; padding:2px 8px; border-radius:100px; border:1px solid var(--line); color:var(--ink-dim); }
  .tag.warn{ color:var(--red); border-color:var(--red); }
  .tag.ok{ color:var(--teal); border-color:var(--teal); }

  .bars{ display:flex; height:6px; border-radius:4px; overflow:hidden; background:var(--panel-2); margin-bottom:8px; }
  .bar-v{ background:#c85fbf; } .bar-s{ background:var(--red); }
  .bar-u{ background:var(--amber); } .bar-r{ background:var(--teal); }

  .claim-row{ display:flex; gap:6px; align-items:center; font-size:12px; }
  .claim-row input{
    flex:1; background:var(--panel-2); border:1px solid var(--line); border-radius:6px;
    color:var(--ink); padding:6px 8px; font-size:12px; font-family:inherit;
  }
  .claim-row button{
    padding:6px 12px; border-radius:6px; border:1px solid var(--teal); background:transparent;
    color:var(--teal); font-size:12px; cursor:pointer; white-space:nowrap;
  }
  .claim-row button:disabled{ opacity:0.4; cursor:default; }
  .slots{ font-family:"IBM Plex Mono", monospace; font-size:12px; color:var(--ink-dim); }

  .addr-row{ margin-top:8px; }
  .addr-row button{
    padding:5px 10px; border-radius:6px; border:1px solid var(--amber); background:transparent;
    color:var(--amber); font-size:12px; cursor:pointer; font-family:inherit;
  }
  /* 取消認領是相對負面的動作：用中性的邊框與次要文字色，明顯低於旁邊兩顆
     琥珀色按鈕的視覺重量，不鼓勵優先點擊。 */
  .addr-row button.cancel-btn{
    border-color:var(--line); color:var(--ink-dim);
  }
  .addr-out:not(:empty){
    margin-top:6px; padding:7px 9px; border-radius:6px; background:var(--panel-2);
    font-size:12px; color:var(--ink); line-height:1.6; word-break:break-all;
  }

  .score-breakdown-text{ font-size:11px; color:var(--ink-dim); margin-bottom:8px; }

  .review-panel{
    margin:10px 14px; padding:10px 12px; border:1px solid var(--amber);
    background:var(--amber-dim); border-radius:8px;
  }
  .review-title{
    font-size:12px; color:var(--amber); font-weight:700;
    margin-bottom:6px; line-height:1.5;
  }
  .review-row{
    font-size:12px; display:flex; gap:8px; align-items:baseline; padding:3px 0;
  }
  .review-wait{
    font-family:"IBM Plex Mono", monospace; color:var(--amber); white-space:nowrap;
  }

  #map{ height:100%; }
  .leaflet-popup-content{ font-family:"IBM Plex Sans TC", sans-serif; font-size:13px; }
</style>
</head>
<body>
<header>
  <h1>災後需求雷達</h1>
  <p>關懷優先排序（Care Score）× 志工智慧媒合 — MVP Demo</p>
</header>
<div class="layout">
  <div class="list-panel">
    <div class="toggle-row">
      <button class="toggle-btn" data-sort="latest">最新回報排序</button>
      <button class="toggle-btn active" data-sort="care_score">Care Score 排序</button>
    </div>
    <div class="hint" id="hint"></div>
    <div id="review-panel"></div>
    <div id="list"></div>
  </div>
  <div id="map"></div>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const HINTS = {
  latest: "模擬社群媒體式排序：只看誰最新發文，不知道案件其實已經有沒有人幫。額滿的案件（灰色）仍然會排在很前面。",
  care_score: "依關懷優先指數排序，額滿案件會自動從清單移除、志工自動被導向仍缺人的案件。",
};

const map = L.map('map').setView([22.972, 120.258], 15);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let markers = [];
let currentSort = 'care_score';

function scoreTierColor(score){
  if (score >= 55) return '#d9634a';
  if (score >= 35) return '#e2a23b';
  return '#4fb0a3';
}

/**
 * 瀏覽器端的 HTML 逸出。這份 script 是內嵌在頁面裡送到瀏覽器執行的，
 * 沒辦法 import 伺服器端 admin.ts 那份 escapeHtml，所以另外寫一份。
 *
 * 用原生 DOM 做逸出（textContent 進、innerHTML 出）而不是手寫正則替換 ——
 * 由瀏覽器自己決定哪些字元需要跳脫，不會漏掉邊界情況。
 * 注意：這樣不會逸出引號，所以只能用在「文字內容」位置，不能拿去填
 * HTML 屬性值。目前所有呼叫點都是文字內容。
 */
function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/**
 * 注意結尾的 "|| t"：對照表查不到時會把原值原樣回傳。need_types 來自模型
 * 輸出，而 extractFields 只檢查它是不是陣列、沒有比對 enum，所以這裡的
 * 回傳值不保證永遠是寫死的中文字串 —— 呼叫端必須當成不可控內容逸出。
 */
function needTypeLabel(t){
  return ({
    debris_removal: '清淤', furniture_moving: '搬家具', drinking_water: '飲用水',
    cleaning_supplies: '清潔用品', water_electricity_repair: '水電', other: '其他'
  })[t] || t;
}

async function loadCases(sort){
  const includeFull = sort === 'latest' ? '&include_full=1' : '';
  const res = await fetch('/api/cases?sort=' + sort + includeFull);
  return res.json();
}

function renderList(cases){
  const list = document.getElementById('list');
  list.innerHTML = '';
  cases.forEach((c, i) => {
    const needTypes = (c.need_types_parsed || []).map(needTypeLabel).join(' · ');
    const isFull = c.status === 'full';
    // 已完成的案件視覺上比照額滿（半透明），但不再提供任何互動 —— 案件結案了。
    const isCompleted = c.status === 'completed';
    const b = c.score_breakdown;
    // 用「加權後的貢獻值」畫比例，不是未加權的原始分量 —— 否則畫面上的
    // 比例會跟這四項對總分的實際貢獻不一致，等於畫一張會騙人的圖。
    const totalForBar = Math.max(
      b.vulnerability_contribution + b.severity_contribution +
      b.urgency_contribution + b.resource_gap_contribution, 1);
    const claimToken = readClaimToken(c.id);
    const card = document.createElement('div');
    card.className = 'card' + (isFull || isCompleted ? ' full' : '');
    card.innerHTML = \`
      <div class="card-top">
        <div>
          <span class="rank">#\${i + 1}</span>
          <div class="summary">\${escapeHtml(c.summary || '（尚無摘要）')}</div>
          <div class="tags">
            \${isCompleted ? '<span class="tag ok">已完成</span>' : ''}
            \${isFull ? '<span class="tag ok">已額滿</span>' : ''}
            \${c.needs_human_verification ? '<span class="tag warn">資訊待複核</span>' : ''}
            \${needTypes ? '<span class="tag">' + escapeHtml(needTypes) + '</span>' : ''}
          </div>
        </div>
        <div style="text-align:right">
          <div class="score">\${b.total.toFixed(1)}</div>
          <div class="score-label">CARE SCORE</div>
        </div>
      </div>
      <div class="bars">
        <div class="bar-v" style="width:\${(b.vulnerability_contribution/totalForBar)*100}%"></div>
        <div class="bar-s" style="width:\${(b.severity_contribution/totalForBar)*100}%"></div>
        <div class="bar-u" style="width:\${(b.urgency_contribution/totalForBar)*100}%"></div>
        <div class="bar-r" style="width:\${(b.resource_gap_contribution/totalForBar)*100}%"></div>
      </div>
      <div class="score-breakdown-text">脆弱程度 +\${b.vulnerability_contribution.toFixed(1)} · 災害程度 +\${b.severity_contribution.toFixed(1)} · 等待時間 +\${b.urgency_contribution.toFixed(1)} · 人力缺口 +\${b.resource_gap_contribution.toFixed(1)}</div>
      <div class="claim-row">
        <span class="slots">志工 \${c.volunteers_assigned}/\${c.volunteers_needed}</span>
        \${isCompleted ? '' : '<input type="text" placeholder="你的稱呼（選填）" id="name-' + c.id + '"' + (isFull ? ' disabled' : '') + '/><button data-id="' + c.id + '"' + (isFull ? ' disabled' : '') + '>我要認領</button>'}
      </div>
      \${claimToken && !isCompleted ? '<div class="addr-row"><button class="addr-btn">查看精確地址</button><button class="complete-btn">回報完成</button><button class="cancel-btn">取消認領</button><div class="addr-out" id="addr-' + c.id + '"></div></div>' : ''}
    \`;
    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      if (c.public_lat) map.setView([c.public_lat, c.public_lng], 17);
    });
    card.querySelector('button')?.addEventListener('click', () => claimCase(c.id));
    card.querySelector('.addr-btn')?.addEventListener('click', () => showAddress(c.id));
    card.querySelector('.complete-btn')?.addEventListener('click', () => completeCase(c.id));
    card.querySelector('.cancel-btn')?.addEventListener('click', () => cancelClaim(c.id));
    list.appendChild(card);
  });
}

function hoursWaited(reportedAt){
  // D1 的 datetime('now') 是 UTC，補 Z 才不會被當成本地時間解析。
  const t = new Date(reportedAt + 'Z').getTime();
  return Math.round(((Date.now() - t) / 3600000) * 10) / 10;
}

function renderReviewPanel(cases){
  const panel = document.getElementById('review-panel');
  if (!panel) return;
  panel.innerHTML = '';

  const pending = cases
    .filter(c => c.status === 'open' && c.needs_human_verification)
    .sort((a, b) =>
      new Date(a.reported_at + 'Z').getTime() - new Date(b.reported_at + 'Z').getTime()
    );

  // 沒有待複核案件時安靜地不佔位置：這個面板出現在志工每天都會看的主畫面，
  // 沒事的時候不該用一句「目前沒有」去佔掉版面。
  if (!pending.length) return;

  const box = document.createElement('div');
  box.className = 'review-panel';

  const title = document.createElement('div');
  title.className = 'review-title';
  title.textContent = '\u26A0\uFE0F 待人工複核（資訊不足，並非優先度低，需盡快電話確認）';
  box.appendChild(title);

  pending.forEach(c => {
    const row = document.createElement('div');
    row.className = 'review-row';
    const wait = document.createElement('span');
    wait.className = 'review-wait';
    wait.textContent = '已等待 ' + hoursWaited(c.reported_at).toFixed(1) + ' 小時';
    const text = document.createElement('span');
    // 用 textContent：summary 是使用者通報衍生的自由文字。
    // raw_text 不在公開 API 回應裡，所以 fallback 用固定字串而不是原文。
    text.textContent = c.summary || '（尚無摘要）';
    row.appendChild(wait);
    row.appendChild(text);
    box.appendChild(row);
  });

  panel.appendChild(box);
}

function renderMarkers(cases){
  markers.forEach(m => map.removeLayer(m));
  markers = [];
  cases.forEach(c => {
    if (!c.public_lat || !c.public_lng) return;
    const color = (c.status === 'full' || c.status === 'completed')
      ? '#3d4758' : scoreTierColor(c.score_breakdown.total);
    const marker = L.circleMarker([c.public_lat, c.public_lng], {
      radius: 9, color, fillColor: color, fillOpacity: 0.75, weight: 2,
    }).addTo(map);
    marker.bindPopup(
      '<b>Care Score: ' + c.score_breakdown.total.toFixed(1) + '</b><br>' +
      escapeHtml(c.summary || '（尚無摘要）') +
      '<br>志工 ' + c.volunteers_assigned + '/' + c.volunteers_needed
    );
    markers.push(marker);
  });
}

async function refresh(){
  document.getElementById('hint').textContent = HINTS[currentSort];
  const cases = await loadCases(currentSort);
  renderList(cases);
  renderReviewPanel(cases);
  renderMarkers(cases);
}

async function claimCase(id){
  const nameInput = document.getElementById('name-' + id);
  const name = nameInput ? nameInput.value : '';
  const res = await fetch('/api/cases/' + id + '/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name || '匿名志工' }),
  });
  if (res.status === 409) {
    alert('慢了一步 —— 這個案件的志工名額剛好被別人搶走了，已經自動幫你換一個案件看看。');
  } else if (!res.ok) {
    alert('認領失敗，請稍後再試。');
  } else {
    // claim_token 只會在這一次回應裡出現，錯過就換不回精確地址了。
    const data = await res.json();
    if (data.claim_token) writeClaimToken(id, data.claim_token);
  }
  refresh();
}

function readClaimToken(id){
  try { return localStorage.getItem('claim_token_' + id); } catch { return null; }
}

function writeClaimToken(id, token){
  try { localStorage.setItem('claim_token_' + id, token); } catch {}
}

function clearClaimToken(id){
  try { localStorage.removeItem('claim_token_' + id); } catch {}
}

async function cancelClaim(id){
  const token = readClaimToken(id);
  if (!token) return;
  if (!confirm('確定要取消認領嗎？名額會還給其他志工。')) return;
  const res = await fetch('/api/cases/' + id + '/cancel-claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    alert('取消失敗，可能是認領憑證已失效，或這個案件已經結案了。');
    return;
  }
  // 認領紀錄已刪除，這組 token 從此無效，本機留著沒有用途。
  clearClaimToken(id);
  refresh();
}

async function completeCase(id){
  const token = readClaimToken(id);
  if (!token) return;
  if (!confirm('確定這個案件已經處理完成了嗎？')) return;
  const res = await fetch('/api/cases/' + id + '/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    alert('回報失敗，可能是認領憑證已失效，或這個案件已經結案了。');
    return;
  }
  // 案件結案了，本機留著 token 也沒有用途。
  clearClaimToken(id);
  refresh();
}

async function showAddress(id){
  const token = readClaimToken(id);
  const out = document.getElementById('addr-' + id);
  if (!token || !out) return;
  out.textContent = '查詢中…';
  const res = await fetch(
    '/api/cases/' + id + '/address?token=' + encodeURIComponent(token)
  );
  if (!res.ok) {
    out.textContent = '無法取得精確地址（認領憑證已失效）。';
    return;
  }
  const a = await res.json();
  const coords = (a.exact_lat != null && a.exact_lng != null)
    ? a.exact_lat.toFixed(6) + ', ' + a.exact_lng.toFixed(6)
    : '（無精確座標）';
  // 用 textContent 而不是 innerHTML：location_text 來自使用者通報的自由文字。
  out.textContent = (a.location_text || '（無地址文字）') + '\\n精確座標：' + coords;
  out.style.whiteSpace = 'pre-line';
}

document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSort = btn.dataset.sort;
    refresh();
  });
});

refresh();
setInterval(refresh, 15000);
</script>
</body>
</html>`;
}
