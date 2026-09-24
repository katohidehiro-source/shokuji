'use strict';
/* 食事きろく — 写真から食事を記録するPWA
 * データ: このブラウザの IndexedDB（食事・体重）と localStorage（設定）
 * AI:     設定で Gemini / OpenAI / Claude を切り替え（ブラウザから各社APIを直接呼び出し）
 */

// ================= 共通ユーティリティ =================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const num = v => { const n = parseFloat(String(v ?? '').replace(/[^\d.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const r0 = n => Math.round(n);
const r1 = n => Math.round(n * 10) / 10;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const MEAL_TYPES = ['朝食', '昼食', '夕食', '間食'];
const NUTRI = [
  { k: 'kcal', label: 'カロリー', unit: 'kcal', round: r0 },
  { k: 'protein', label: 'たんぱく質', unit: 'g', round: r1, color: 'var(--p)', t: 'p' },
  { k: 'fat', label: '脂質', unit: 'g', round: r1, color: 'var(--f)', t: 'f' },
  { k: 'carbs', label: '炭水化物', unit: 'g', round: r1, color: 'var(--c)', t: 'c' },
  { k: 'salt', label: '塩分', unit: 'g', round: r1, color: 'var(--salt)', t: 'salt' },
];

function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// ================= 設定（localStorage） =================
const PROVIDERS = {
  gemini: {
    name: 'Gemini', defaultModel: 'gemini-flash-latest',
    hint: 'Google AI Studio（aistudio.google.com）で無料のAPIキーを発行できます。無料枠では送信内容がGoogleの改善に使われる場合があります。',
  },
  openai: {
    name: 'OpenAI', defaultModel: 'gpt-5-mini',
    hint: 'platform.openai.com でAPIキーを発行します（従量課金・前払い）。',
  },
  claude: {
    name: 'Claude', defaultModel: 'claude-haiku-4-5',
    hint: 'console.anthropic.com でAPIキーを発行します（従量課金・前払い）。Claudeのチームプラン等のサブスクリプションとは別契約です。',
  },
};
const DEFAULT_SETTINGS = {
  provider: 'gemini',
  keys: { gemini: '', openai: '', claude: '' },
  models: { gemini: PROVIDERS.gemini.defaultModel, openai: PROVIDERS.openai.defaultModel, claude: PROVIDERS.claude.defaultModel },
  target: { kcal: 2000, p: 75, f: 55, c: 300, salt: 7.5 },
};
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('settings') || '{}');
    return {
      ...DEFAULT_SETTINGS, ...s,
      keys: { ...DEFAULT_SETTINGS.keys, ...(s.keys || {}) },
      models: { ...DEFAULT_SETTINGS.models, ...(s.models || {}) },
      target: { ...DEFAULT_SETTINGS.target, ...(s.target || {}) },
    };
  } catch { return structuredClone(DEFAULT_SETTINGS); }
}
let settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem('settings', JSON.stringify(settings)); } catch (e) { toast('設定を保存できませんでした'); }
}

// ================= データベース（IndexedDB） =================
const DB_NAME = 'shokuji-kiroku';
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      const meals = d.createObjectStore('meals', { keyPath: 'id' });
      meals.createIndex('date', 'date');
      d.createObjectStore('weights', { keyPath: 'date' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => res(result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const DB = {
  mealsByDate: date => tx('meals', 'readonly', s => reqP(s.index('date').getAll(date))),
  mealsInRange: (from, to) => tx('meals', 'readonly', s => reqP(s.index('date').getAll(IDBKeyRange.bound(from, to)))),
  allMeals: () => tx('meals', 'readonly', s => reqP(s.getAll())),
  putMeal: m => tx('meals', 'readwrite', s => reqP(s.put(m))),
  delMeal: id => tx('meals', 'readwrite', s => reqP(s.delete(id))),
  allWeights: () => tx('weights', 'readonly', s => reqP(s.getAll())),
  putWeight: w => tx('weights', 'readwrite', s => reqP(s.put(w))),
  clearAll: async () => { await tx('meals', 'readwrite', s => reqP(s.clear())); await tx('weights', 'readwrite', s => reqP(s.clear())); },
};

// ================= 画像処理 =================
function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('画像を読み込めませんでした（HEIC形式の場合はJPEGで保存してください）')); };
    img.src = url;
  });
}
function resize(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(img, 0, 0, w, h);
  return cv.toDataURL('image/jpeg', quality);
}

// ================= AI =================
const PROMPT = `あなたは日本の管理栄養士です。写真に写っている食事を分析し、次の形式のJSONだけを出力してください（説明文やコードブロックは不要）。
{
  "title": "食事全体の短い名前（例: 唐揚げ定食）",
  "items": [
    {"name": "料理名または食品名", "grams": 推定重量g, "kcal": エネルギーkcal, "protein": たんぱく質g, "fat": 脂質g, "carbs": 炭水化物g, "salt": 食塩相当量g}
  ],
  "confidence": "高" または "中" または "低",
  "note": "量の推定の前提や注意点を1〜2文で"
}
ルール:
- 料理・食品ごとに items を分ける（ご飯、味噌汁、主菜、副菜など）。
- 食器の大きさなどから量を推定し、見えない油・ドレッシング・調味料も含めて数値を出す。
- 栄養価は日本食品標準成分表（八訂）や一般的な料理の標準的な値を基準にする。
- 数値はすべて数値型（単位を付けない）。
- 食べ物が写っていない場合は items を空の配列にし、note に理由を書く。`;

function extractJson(text) {
  if (!text) throw new Error('AIの応答が空でした');
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('AIの応答を読み取れませんでした');
  return JSON.parse(t.slice(a, b + 1));
}
function normalizeResult(j) {
  const items = (Array.isArray(j.items) ? j.items : []).map(it => ({
    name: String(it.name || '不明な品目'),
    grams: num(it.grams),
    kcal: num(it.kcal ?? it.calories ?? it.energy),
    protein: num(it.protein),
    fat: num(it.fat),
    carbs: num(it.carbs ?? it.carbohydrate),
    salt: num(it.salt ?? it.sodium_salt),
  }));
  return { title: String(j.title || items.map(i => i.name).join('・') || ''), items, confidence: j.confidence || '', note: j.note || '' };
}

async function httpJson(url, opts) {
  let res;
  try { res = await fetch(url, opts); }
  catch (e) { throw new Error('通信できませんでした。電波状況を確認してください。'); }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.type || text.slice(0, 200);
    const hints = { 400: 'リクエスト内容かモデル名を確認してください。', 401: 'APIキーが正しくありません。', 403: 'APIキーの権限を確認してください。', 404: 'モデル名が見つかりません。「モデル一覧を取得」で選び直してください。', 429: '利用回数の上限に達しました。少し待つか、プランを確認してください。', 500: 'AI側で一時的なエラーが起きました。少し待って再解析してください。', 503: 'AIが混み合っています（一時的）。少し待って再解析するか、設定でモデルを変えてください。', 529: 'AIが混み合っています（一時的）。少し待って再解析してください。' };
    const err = new Error(`AIエラー (${res.status}) ${hints[res.status] || ''}\n${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const AI = {
  async gemini({ key, model, b64, prompt }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const parts = [{ text: prompt }];
    if (b64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } });
    const data = await httpJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }),
    });
    return (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  },
  async openai({ key, model, b64, prompt }) {
    const content = [{ type: 'text', text: prompt }];
    if (b64) content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } });
    const data = await httpJson('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], response_format: { type: 'json_object' } }),
    });
    return data.choices?.[0]?.message?.content || '';
  },
  async claude({ key, model, b64, prompt }) {
    const content = [];
    if (b64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
    content.push({ type: 'text', text: prompt });
    const data = await httpJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: 2048, messages: [{ role: 'user', content }] }),
    });
    return (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  },
};

function currentAi() {
  const p = settings.provider;
  const key = (settings.keys[p] || '').trim();
  const model = (settings.models[p] || PROVIDERS[p].defaultModel).trim();
  if (!key) throw new Error(`${PROVIDERS[p].name} のAPIキーが未設定です。「設定」タブで入力してください。`);
  return { p, key, model };
}
// 混雑などの一時的なエラーのときは自動で待って再試行し、それでもだめなら予備モデルに切り替える
const RETRY_STATUS = [429, 500, 502, 503, 504, 529];
const FALLBACK_MODELS = {
  gemini: ['gemini-flash-lite-latest', 'gemini-2.5-flash'],
  openai: [],
  claude: [],
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function analyzePhoto(dataUrl, hint, onProgress = () => {}) {
  const { p, key, model } = currentAi();
  const b64 = dataUrl.split(',')[1];
  const prompt = PROMPT + (hint ? `\n\n利用者からの補足: ${hint}` : '');
  const models = [model, ...FALLBACK_MODELS[p].filter(m => m !== model)];
  const waits = [0, 2000, 5000];   // 同じモデルで最大3回
  let lastErr;
  for (let mi = 0; mi < models.length; mi++) {
    const m = models[mi];
    for (let ai = 0; ai < waits.length; ai++) {
      if (waits[ai]) {
        onProgress(`AIが混み合っています。${waits[ai] / 1000}秒待って再試行します…（${ai + 1}/${waits.length}）`);
        await sleep(waits[ai]);
      } else if (mi > 0) {
        onProgress(`混雑のため予備のモデル（${m}）で解析しています…`);
      }
      try {
        const text = await AI[p]({ key, model: m, b64, prompt });
        return { ...normalizeResult(extractJson(text)), provider: p, model: m, usedFallback: mi > 0 };
      } catch (e) {
        lastErr = e;
        if (e.status === 404 && mi > 0) break;           // 予備モデルが無ければ次へ
        if (!RETRY_STATUS.includes(e.status)) throw e;   // キー間違いなどは即終了
        if (e.status === 429 && ai >= 1) break;          // 回数上限は長く待っても無駄なので次のモデルへ
      }
    }
  }
  throw lastErr;
}

async function listModels() {
  const p = settings.provider;
  const key = (settings.keys[p] || '').trim();
  if (!key) throw new Error('先にAPIキーを入力してください');
  if (p === 'gemini') {
    const d = await httpJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    return (d.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/.test(m.name))
      .map(m => m.name.replace(/^models\//, ''));
  }
  if (p === 'openai') {
    const d = await httpJson('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + key } });
    return (d.data || []).map(m => m.id).filter(id => /^(gpt-|o\d|chatgpt)/.test(id) && !/(audio|realtime|tts|transcribe|search|image|embedding)/.test(id)).sort();
  }
  const d = await httpJson('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
  });
  return (d.data || []).map(m => m.id);
}

// ================= 集計 =================
function sumItems(items) {
  const t = { kcal: 0, protein: 0, fat: 0, carbs: 0, salt: 0 };
  for (const it of items) for (const k in t) t[k] += num(it[k]);
  return t;
}
function sumMeals(meals) { return sumItems(meals.flatMap(m => m.items || [])); }

// ================= 画面: 記録（1日） =================
let curDate = ymd(new Date());

function dateText(s) {
  const d = parseYmd(s);
  const today = ymd(new Date());
  const rel = s === today ? '今日' : s === addDays(today, -1) ? '昨日' : '';
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）${rel ? ' ' + rel : ''}`;
}

async function renderDay() {
  $('#dateLabel').textContent = dateText(curDate);
  $('#nextDay').disabled = curDate >= ymd(new Date());
  const meals = (await DB.mealsByDate(curDate)).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const tot = sumMeals(meals);
  const T = settings.target;

  $('#kcalTotal').textContent = r0(tot.kcal).toLocaleString();
  $('#kcalTarget').textContent = `/ ${num(T.kcal).toLocaleString()} kcal`;
  const ratio = T.kcal ? tot.kcal / T.kcal : 0;
  const fg = $('#ringFg');
  fg.style.strokeDashoffset = 326.7 * (1 - Math.min(1, ratio));
  fg.classList.toggle('over', ratio > 1.05);

  $('#pfcBars').innerHTML = NUTRI.slice(1).map(n => {
    const v = tot[n.k], tg = num(T[n.t]);
    const pct = tg ? Math.min(100, v / tg * 100) : 0;
    const over = tg && v > tg * 1.05;
    return `<div class="bar-row"><div class="lbl">${n.label}<span><b>${n.round(v)}</b> / ${tg}${n.unit}</span></div>
      <div class="bar"><i style="width:${pct}%;background:${over ? 'var(--over)' : n.color}"></i></div></div>`;
  }).join('');

  const list = $('#mealList');
  if (!meals.length) { list.innerHTML = '<p class="empty">まだ記録がありません。<br>食事の写真を撮ってみましょう。</p>'; return; }
  list.innerHTML = MEAL_TYPES.map(type => {
    const ms = meals.filter(m => m.type === type);
    if (!ms.length) return '';
    const k = r0(sumMeals(ms).kcal);
    return `<div class="meal-group"><h3><span>${type}</span><span>${k} kcal</span></h3>${ms.map(m => {
      const t = sumItems(m.items || []);
      return `<button class="meal" data-id="${esc(m.id)}">
        ${m.photo ? `<img src="${m.photo}" alt="">` : '<div class="noimg">🍴</div>'}
        <div class="m-body"><div class="m-name">${esc(m.title || '（名前なし）')}</div>
        <div class="m-sub">${esc(m.time || '')}　P${r0(t.protein)} F${r0(t.fat)} C${r0(t.carbs)} 塩${r1(t.salt)}</div></div>
        <div class="m-kcal">${r0(t.kcal)}<small> kcal</small></div></button>`;
    }).join('')}</div>`;
  }).join('');
}

// ================= 編集シート =================
let editing = null;   // 編集中の食事
let editingPhotoFull = null; // AI送信用の画像（保存はしない）

function guessMealType(date = new Date()) {
  const h = date.getHours();
  if (h >= 4 && h < 10) return '朝食';
  if (h >= 10 && h < 15) return '昼食';
  if (h >= 17 && h < 23) return '夕食';
  return '間食';
}

function openEditor(meal, { isNew = false } = {}) {
  editing = structuredClone(meal);
  editing._isNew = isNew;
  $('#edTitle').textContent = isNew ? '食事を記録' : '記録を編集';
  $('#edPhoto').hidden = !editing.photo;
  if (editing.photo) $('#edPhoto').src = editing.photo;
  $('#edType').value = editing.type;
  $('#edTime').value = editing.time || '';
  $('#edName').value = editing.title || '';
  $('#edHint').value = '';
  $('#edAiBox').hidden = !editingPhotoFull;
  $('#edDelete').hidden = isNew;
  setStatus('');
  $('#edNote').textContent = editing.aiNote ? `AIメモ: ${editing.aiNote}` : '';
  renderItems();
  $('#editor').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeEditor() {
  $('#editor').hidden = true;
  document.body.style.overflow = '';
  editing = null; editingPhotoFull = null;
}
function setStatus(html, err = false) {
  const s = $('#edStatus');
  s.hidden = !html; s.innerHTML = html; s.classList.toggle('err', err);
}

function renderItems() {
  const box = $('#edItems');
  box.innerHTML = editing.items.map((it, i) => `
    <div class="item" data-i="${i}">
      <div class="item-top">
        <input class="nm" data-k="name" value="${esc(it.name)}" placeholder="品目名">
        <button class="del" data-del="${i}" aria-label="削除">×</button>
      </div>
      <div class="nutri">
        <label>量 (g)<input data-k="grams" type="number" inputmode="decimal" value="${r0(it.grams)}"></label>
        <label>kcal<input data-k="kcal" type="number" inputmode="decimal" value="${r0(it.kcal)}"></label>
        <label>たんぱく質 g<input data-k="protein" type="number" inputmode="decimal" value="${r1(it.protein)}"></label>
        <label>脂質 g<input data-k="fat" type="number" inputmode="decimal" value="${r1(it.fat)}"></label>
        <label>炭水化物 g<input data-k="carbs" type="number" inputmode="decimal" value="${r1(it.carbs)}"></label>
        <label>塩分 g<input data-k="salt" type="number" inputmode="decimal" value="${r1(it.salt)}"></label>
      </div>
    </div>`).join('') || '<p class="hint">品目がありません。「＋ 品目を追加」で入力できます。</p>';
  renderEdTotals();
}
function renderEdTotals() {
  const t = sumItems(editing.items);
  $('#edTotals').innerHTML = NUTRI.map(n => `<div>${n.label}<b>${n.round(t[n.k])}</b>${n.unit}</div>`).join('') + '<div></div>';
}
function scaleItem(it, f) {
  for (const k of ['grams', 'kcal', 'protein', 'fat', 'carbs', 'salt']) it[k] = num(it[k]) * f;
}

$('#edItems').addEventListener('input', e => {
  const inp = e.target.closest('input[data-k]');
  if (!inp) return;
  const i = +inp.closest('.item').dataset.i, k = inp.dataset.k;
  const it = editing.items[i];
  if (k === 'name') { it.name = inp.value; return; }
  if (k === 'grams') {
    // 量を変えたら栄養素を比例して変える
    const old = num(it.grams), nv = num(inp.value);
    if (old > 0 && nv > 0) {
      const f = nv / old;
      for (const kk of ['kcal', 'protein', 'fat', 'carbs', 'salt']) it[kk] = num(it[kk]) * f;
      const row = inp.closest('.item');
      for (const kk of ['kcal', 'protein', 'fat', 'carbs', 'salt']) $(`input[data-k="${kk}"]`, row).value = kk === 'kcal' ? r0(it[kk]) : r1(it[kk]);
    }
    it.grams = nv;
  } else it[k] = num(inp.value);
  renderEdTotals();
});
$('#edItems').addEventListener('click', e => {
  const d = e.target.closest('[data-del]');
  if (!d) return;
  editing.items.splice(+d.dataset.del, 1);
  renderItems();
});
$('#edAddItem').addEventListener('click', () => {
  editing.items.push({ name: '', grams: 100, kcal: 0, protein: 0, fat: 0, carbs: 0, salt: 0 });
  renderItems();
  const inputs = $$('#edItems .nm'); inputs[inputs.length - 1]?.focus();
});
$$('.scale-row button').forEach(b => b.addEventListener('click', () => {
  editing.items.forEach(it => scaleItem(it, +b.dataset.s));
  renderItems();
}));
$('#edCancel').addEventListener('click', closeEditor);
$('#edSave').addEventListener('click', async () => {
  editing.type = $('#edType').value;
  editing.time = $('#edTime').value;
  editing.title = $('#edName').value.trim() || editing.items.map(i => i.name).filter(Boolean).join('・');
  editing.items = editing.items.filter(it => it.name.trim() || num(it.kcal));
  editing.updatedAt = Date.now();
  const { _isNew, ...m } = editing;
  await DB.putMeal(m);
  closeEditor();
  toast('保存しました');
  renderDay();
});
$('#edDelete').addEventListener('click', async () => {
  if (!confirm('この記録を削除しますか？')) return;
  await DB.delMeal(editing.id);
  closeEditor(); toast('削除しました'); renderDay();
});
$('#edReanalyze').addEventListener('click', () => runAnalysis($('#edHint').value.trim()));

async function runAnalysis(hint = '') {
  if (!editingPhotoFull) return;
  const btn = $('#edReanalyze');
  btn.disabled = true; $('#edSave').disabled = true;
  setStatus(`<span class="spinner"></span>${esc(PROVIDERS[settings.provider].name)} で解析中…（数秒〜20秒ほど）`);
  try {
    const r = await analyzePhoto(editingPhotoFull, hint, msg => { if (editing) setStatus(`<span class="spinner"></span>${esc(msg)}`); });
    if (!editing) return;
    editing.items = r.items;
    editing.title = r.title;
    editing.ai = { provider: r.provider, model: r.model, confidence: r.confidence };
    editing.aiNote = r.note;
    $('#edName').value = r.title;
    $('#edNote').textContent = r.note ? `AIメモ: ${r.note}` : '';
    renderItems();
    setStatus(r.items.length
      ? `推定しました（確からしさ: ${esc(r.confidence || '—')}${r.usedFallback ? `・予備モデル ${esc(r.model)} を使用` : ''}）。量や品目が違えば修正して保存してください。`
      : '食べ物を見つけられませんでした。補足を入れて再解析するか、手入力してください。', !r.items.length);
  } catch (e) {
    setStatus(esc(e.message).replace(/\n/g, '<br>'), true);
  } finally {
    btn.disabled = false; $('#edSave').disabled = false;
  }
}

async function onPhoto(file) {
  if (!file) return;
  try {
    const img = await loadImage(file);
    const full = resize(img, 1024, 0.82);
    const thumb = resize(img, 360, 0.7);
    const now = new Date();
    const fileDate = file.lastModified ? new Date(file.lastModified) : now;
    // 過去の日付を表示中ならその日に、今日なら撮影時刻で記録
    const useDate = curDate === ymd(now) ? now : fileDate;
    editingPhotoFull = full;
    openEditor({
      id: uid(), date: curDate, time: `${pad(useDate.getHours())}:${pad(useDate.getMinutes())}`,
      type: guessMealType(useDate), title: '', items: [], photo: thumb, createdAt: Date.now(),
    }, { isNew: true });
    runAnalysis();
  } catch (e) { toast(e.message, 4000); }
}
$('#cameraInput').addEventListener('change', e => { onPhoto(e.target.files[0]); e.target.value = ''; });
$('#galleryInput').addEventListener('change', e => { onPhoto(e.target.files[0]); e.target.value = ''; });
$('#manualBtn').addEventListener('click', () => {
  const now = new Date();
  editingPhotoFull = null;
  openEditor({
    id: uid(), date: curDate, time: `${pad(now.getHours())}:${pad(now.getMinutes())}`, type: guessMealType(now),
    title: '', items: [{ name: '', grams: 100, kcal: 0, protein: 0, fat: 0, carbs: 0, salt: 0 }], photo: null, createdAt: Date.now(),
  }, { isNew: true });
});
$('#mealList').addEventListener('click', async e => {
  const b = e.target.closest('.meal');
  if (!b) return;
  const meals = await DB.mealsByDate(curDate);
  const m = meals.find(x => x.id === b.dataset.id);
  if (m) { editingPhotoFull = null; openEditor(m); }
});

$('#prevDay').addEventListener('click', () => { curDate = addDays(curDate, -1); renderDay(); });
$('#nextDay').addEventListener('click', () => { if (curDate < ymd(new Date())) { curDate = addDays(curDate, 1); renderDay(); } });
$('#dateLabel').addEventListener('click', () => {
  const p = $('#datePicker');
  p.value = curDate; p.max = ymd(new Date());
  if (p.showPicker) { try { p.showPicker(); return; } catch { /* fallthrough */ } }
  p.click();
});
$('#datePicker').addEventListener('change', e => { if (e.target.value) { curDate = e.target.value; renderDay(); } });

// ================= 画面: 履歴 =================
let range = 7;
$$('#rangeSeg button').forEach(b => b.addEventListener('click', () => {
  range = +b.dataset.range;
  $$('#rangeSeg button').forEach(x => x.classList.toggle('on', x === b));
  renderHistory();
}));

async function renderHistory() {
  const to = ymd(new Date()), from = addDays(to, -(range - 1));
  const meals = await DB.mealsInRange(from, to);
  const days = [];
  for (let i = 0; i < range; i++) {
    const d = addDays(from, i);
    days.push({ d, t: sumMeals(meals.filter(m => m.date === d)) });
  }
  // 棒グラフ
  const W = 340, H = 170, L = 34, B = 22, T = 8;
  const tk = num(settings.target.kcal);
  const max = Math.max(tk * 1.2, ...days.map(x => x.t.kcal), 500);
  const bw = (W - L - 4) / range;
  const y = v => T + (H - T - B) * (1 - v / max);
  const step = max > 3000 ? 1000 : 500;
  let g = '';
  for (let v = 0; v <= max; v += step) g += `<line class="grid" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
  const bars = days.map((x, i) => {
    const bx = L + 2 + i * bw, h = (H - T - B) * x.t.kcal / max;
    const over = tk && x.t.kcal > tk * 1.05;
    const dd = parseYmd(x.d);
    const showLbl = range <= 7 || i % 5 === 0 || i === range - 1;
    return `<rect class="bar-k${over ? ' over' : ''}" x="${bx + bw * 0.15}" y="${H - B - h}" width="${bw * 0.7}" height="${Math.max(0, h)}" rx="2"><title>${x.d}: ${r0(x.t.kcal)} kcal</title></rect>` +
      (showLbl ? `<text x="${bx + bw / 2}" y="${H - 7}" text-anchor="middle">${range <= 7 ? WEEK[dd.getDay()] : `${dd.getMonth() + 1}/${dd.getDate()}`}</text>` : '');
  }).join('');
  const tl = tk ? `<line class="tline" x1="${L}" x2="${W}" y1="${y(tk)}" y2="${y(tk)}"/><text x="${W}" y="${y(tk) - 3}" text-anchor="end">目標 ${tk}</text>` : '';
  $('#kcalChart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="日別の摂取カロリー">${g}${bars}${tl}</svg>`;

  // 平均（記録のある日のみ）
  const rec = days.filter(x => x.t.kcal > 0);
  const n = rec.length || 1;
  const T2 = settings.target;
  $('#avgTable').innerHTML = rec.length
    ? `<table class="avg"><tr><td></td><td>平均</td><td>目標</td></tr>${NUTRI.map(nu => {
      const avg = rec.reduce((s, x) => s + x.t[nu.k], 0) / n;
      const tg = nu.k === 'kcal' ? T2.kcal : T2[nu.t];
      return `<tr><td>${nu.label}</td><td><b>${nu.round(avg)}</b> ${nu.unit}</td><td>${tg} ${nu.unit}</td></tr>`;
    }).join('')}</table><p class="hint">記録のある ${rec.length} 日間の平均です。</p>`
    : '<p class="hint">この期間の記録はまだありません。</p>';

  renderWeight(from, to);
}

async function renderWeight(from, to) {
  const all = (await DB.allWeights()).sort((a, b) => a.date.localeCompare(b.date));
  const today = all.find(w => w.date === ymd(new Date()));
  if (today && !$('#weightInput').value) $('#weightInput').placeholder = `今日: ${today.kg} kg`;
  const ws = all.filter(w => w.date >= from && w.date <= to);
  if (ws.length < 1) { $('#weightChart').innerHTML = '<p class="hint">体重を記録するとグラフが表示されます。</p>'; return; }
  const W = 340, H = 140, L = 34, B = 20, T = 10;
  const vals = ws.map(w => w.kg);
  let lo = Math.floor(Math.min(...vals) - 1), hi = Math.ceil(Math.max(...vals) + 1);
  const x = d => L + 6 + (W - L - 12) * ((parseYmd(d) - parseYmd(from)) / (864e5 * Math.max(1, range - 1)));
  const y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  let g = '';
  const st = Math.max(1, Math.round((hi - lo) / 4));
  for (let v = lo; v <= hi; v += st) g += `<line class="grid" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
  const pts = ws.map(w => `${x(w.date)},${y(w.kg)}`).join(' ');
  const dots = ws.map(w => `<circle class="wdot" cx="${x(w.date)}" cy="${y(w.kg)}" r="3"><title>${w.date}: ${w.kg} kg</title></circle>`).join('');
  const last = ws[ws.length - 1];
  $('#weightChart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="体重の推移">${g}<polyline class="wline" points="${pts}"/>${dots}
    <text x="${W}" y="${H - 5}" text-anchor="end">最新 ${last.kg} kg（${last.date.slice(5).replace('-', '/')}）</text></svg>`;
}
$('#weightSave').addEventListener('click', async () => {
  const kg = num($('#weightInput').value);
  if (!(kg > 20 && kg < 300)) { toast('体重を正しく入力してください'); return; }
  await DB.putWeight({ date: ymd(new Date()), kg: r1(kg) });
  $('#weightInput').value = '';
  toast('体重を記録しました');
  renderHistory();
});

// ================= 画面: 設定 =================
function renderSettings() {
  const p = settings.provider;
  $$('#providerSeg button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  $('#apiKey').value = settings.keys[p] || '';
  $('#modelName').value = settings.models[p] || PROVIDERS[p].defaultModel;
  $('#modelName').placeholder = PROVIDERS[p].defaultModel;
  $('#modelList').innerHTML = '';
  $('#providerHint').textContent = PROVIDERS[p].hint;
  const T = settings.target;
  $('#tKcal').value = T.kcal; $('#tP').value = T.p; $('#tF').value = T.f; $('#tC').value = T.c; $('#tSalt').value = T.salt;
  showStorage();
}
async function showStorage() {
  try {
    const meals = await DB.allMeals();
    let s = `記録数: ${meals.length} 件`;
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      s += ` ・ 使用容量: 約 ${(e.usage / 1024 / 1024).toFixed(1)} MB`;
    }
    if (navigator.storage?.persisted) s += (await navigator.storage.persisted()) ? ' ・ 自動削除されない設定: 有効' : '';
    $('#storageInfo').textContent = s;
  } catch { /* ignore */ }
}
$$('#providerSeg button').forEach(b => b.addEventListener('click', () => {
  settings.provider = b.dataset.p; saveSettings(); renderSettings();
}));
$('#apiKey').addEventListener('change', e => { settings.keys[settings.provider] = e.target.value.trim(); saveSettings(); toast('APIキーを保存しました'); });
$('#modelName').addEventListener('change', e => {
  settings.models[settings.provider] = e.target.value.trim() || PROVIDERS[settings.provider].defaultModel; saveSettings();
});
$('#fetchModels').addEventListener('click', async e => {
  const b = e.target; b.disabled = true;
  try {
    const ms = await listModels();
    $('#modelList').innerHTML = ms.map(m => `<option value="${esc(m)}">`).join('');
    toast(`${ms.length} 件のモデルが見つかりました。モデル名欄をタップして選べます`, 3500);
    $('#modelName').focus();
  } catch (err) { toast(err.message, 5000); }
  finally { b.disabled = false; }
});
$('#testAi').addEventListener('click', async e => {
  const b = e.target; b.disabled = true; b.textContent = 'テスト中…';
  try {
    const { p, key, model } = currentAi();
    const text = await AI[p]({ key, model, b64: null, prompt: '次のJSONだけを返してください: {"ok": true}' });
    extractJson(text);
    toast(`接続OK（${PROVIDERS[p].name} / ${model}）`, 3500);
  } catch (err) { toast(err.message, 6000); }
  finally { b.disabled = false; b.textContent = '接続テスト'; }
});
for (const [id, k] of [['tKcal', 'kcal'], ['tP', 'p'], ['tF', 'f'], ['tC', 'c'], ['tSalt', 'salt']]) {
  $('#' + id).addEventListener('change', e => { settings.target[k] = num(e.target.value); saveSettings(); });
}
$('#calcBtn').addEventListener('click', () => {
  const sex = $('#cSex').value, age = num($('#cAge').value), h = num($('#cHeight').value), w = num($('#cWeight').value);
  // 国立健康・栄養研究所の式（kcal/日）
  const bmr = (0.0481 * w + 0.0234 * h - 0.0138 * age - (sex === 'm' ? 0.4235 : 0.9708)) * 1000 / 4.186;
  const kcal = Math.round((bmr * num($('#cAct').value) + num($('#cGoal').value)) / 50) * 50;
  settings.target = {
    kcal, p: Math.round(kcal * 0.15 / 4), f: Math.round(kcal * 0.25 / 9), c: Math.round(kcal * 0.60 / 4),
    salt: sex === 'm' ? 7.5 : 6.5,
  };
  saveSettings(); renderSettings();
  toast(`基礎代謝 約${Math.round(bmr)} kcal → 目標 ${kcal} kcal に設定しました`, 4000);
});

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('#exportJson').addEventListener('click', async () => {
  const data = { app: 'shokuji-kiroku', version: 1, exportedAt: new Date().toISOString(), meals: await DB.allMeals(), weights: await DB.allWeights(), target: settings.target };
  download(`食事きろく_${ymd(new Date())}.json`, JSON.stringify(data), 'application/json');
});
$('#importJson').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'shokuji-kiroku') throw new Error('このアプリのバックアップではありません');
    for (const m of data.meals || []) await DB.putMeal(m);
    for (const w of data.weights || []) await DB.putWeight(w);
    toast(`読み込みました（食事 ${(data.meals || []).length} 件）`);
    renderSettings(); renderDay();
  } catch (err) { toast('読み込みに失敗しました: ' + err.message, 5000); }
});
$('#exportCsv').addEventListener('click', async () => {
  const meals = (await DB.allMeals()).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['日付', '時刻', '区分', 'メニュー', '品目', '量(g)', 'kcal', 'たんぱく質(g)', '脂質(g)', '炭水化物(g)', '塩分(g)'].map(q).join(',')];
  for (const m of meals) for (const it of m.items || []) {
    rows.push([m.date, m.time, m.type, m.title, it.name, r0(it.grams), r0(it.kcal), r1(it.protein), r1(it.fat), r1(it.carbs), r1(it.salt)].map(q).join(','));
  }
  download(`食事きろく_${ymd(new Date())}.csv`, '﻿' + rows.join('\r\n'), 'text/csv');
});
$('#wipeAll').addEventListener('click', async () => {
  if (!confirm('すべての食事と体重の記録を削除します。元に戻せません。よろしいですか？')) return;
  await DB.clearAll(); toast('削除しました'); renderSettings(); renderDay();
});

// ================= タブ切り替え =================
const TITLES = { day: '食事の記録', history: '履歴', settings: '設定' };
function showView(v) {
  $$('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  $('#screenTitle').textContent = TITLES[v];
  window.scrollTo(0, 0);
  if (v === 'day') renderDay();
  if (v === 'history') renderHistory();
  if (v === 'settings') renderSettings();
}
$$('.tabbar button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

// ================= 起動 =================
(async function init() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch { /* ignore */ }
  // 日付が変わったら今日に戻す
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && $('#editor').hidden && $('#view-day').classList.contains('active')) renderDay();
  });
  showView(settings.keys[settings.provider] ? 'day' : 'settings');
  if (!settings.keys[settings.provider]) toast('最初にAIのAPIキーを設定してください', 4000);
})();
