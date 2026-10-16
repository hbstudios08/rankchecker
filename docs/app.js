(() => {
const COUNTRIES = [
  ['pk','Pakistan'],['in','India'],['bd','Bangladesh'],['lk','Sri Lanka'],['np','Nepal'],
  ['ae','United Arab Emirates'],['sa','Saudi Arabia'],['qa','Qatar'],['kw','Kuwait'],['om','Oman'],['bh','Bahrain'],
  ['us','United States'],['gb','United Kingdom'],['ca','Canada'],['au','Australia'],['nz','New Zealand'],['ie','Ireland'],
  ['de','Germany'],['fr','France'],['it','Italy'],['es','Spain'],['nl','Netherlands'],['se','Sweden'],['no','Norway'],['dk','Denmark'],
  ['tr','Turkey'],['id','Indonesia'],['my','Malaysia'],['sg','Singapore'],['ph','Philippines'],['th','Thailand'],['vn','Vietnam'],
  ['jp','Japan'],['kr','South Korea'],['za','South Africa'],['ng','Nigeria'],['ke','Kenya'],['eg','Egypt'],
  ['br','Brazil'],['mx','Mexico'],['ar','Argentina']
];
const CNAME = Object.fromEntries(COUNTRIES);
const PRESETS = {
  desi: ['pk','in','bd','lk','np','ae','sa','qa','gb','us','ca','au'],
  english: ['us','gb','ca','au','nz','ie']
};
const STORE_LABEL = { ios: 'App Store', android: 'Google Play' };

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Public Cloudflare Worker used automatically. Tests can override or clear it with window.RC_DEFAULT_PROXY.
const PAGE = document.body.dataset.page || 'rank'; // rank | research | analyzer: each tab is its own page
const DEFAULT_PROXY = window.RC_DEFAULT_PROXY ?? 'https://super-voice-a15e.hbstudios08.workers.dev';

const state = {
  stores: { ios: true, android: true },
  app: { ios: null, android: null },
  keywords: [],
  countries: new Set(['us', 'pk', 'in', 'gb']),
  proxy: DEFAULT_PROXY, sameOrigin: false,
  running: false, stop: false,
  data: { ios: {}, android: {} },
  cells: { ios: {}, android: {} },
  prev: {},
  done: 0, total: 0
};

/* ---------- storage ---------- */
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('rc_settings') || 'null');
    if (!s) return;
    Object.assign(state.stores, s.stores || {});
    state.app = Object.assign({ ios: null, android: null }, s.app || {});
    state.keywords = Array.isArray(s.keywords) ? s.keywords.slice(0, 50) : [];
    if (typeof s.proxy === 'string' && s.proxy.trim()) state.proxy = s.proxy;
    if (Array.isArray(s.countries) && s.countries.length) state.countries = new Set(s.countries);
    if (s.depth && $('#depth-ios')) { if (s.depth.ios) $('#depth-ios').value = s.depth.ios; if (s.depth.android) $('#depth-android').value = s.depth.android; }
  } catch (e) { /* ignore corrupted settings */ }
}
// Pages without the depth selectors keep whatever depth the Rank check page saved.
function savedDepth() { try { return (JSON.parse(localStorage.getItem('rc_settings') || '{}') || {}).depth || {}; } catch (e) { return {}; } }
function saveSettings() {
  try {
    localStorage.setItem('rc_settings', JSON.stringify({
      stores: state.stores, app: state.app, keywords: state.keywords, proxy: state.proxy, countries: [...state.countries],
      depth: $('#depth-ios') ? { ios: $('#depth-ios').value, android: $('#depth-android').value } : savedDepth()
    }));
  } catch (e) { /* storage may be unavailable */ }
}
const loadLast = () => { try { return JSON.parse(localStorage.getItem('rc_last') || '{}'); } catch (e) { return {}; } };

/* ---------- data sources ---------- */
// App Store: Apple's public iTunes Search API, called straight from the browser with JSONP, so each
// visitor uses their own connection and rate limit. Google Play has no browser-friendly API, so it goes
// through a proxy (server.py, or the Cloudflare Worker in /worker).
// Tests can shorten the delays by defining window.RC_GAP / window.RC_BACKOFF before this script runs.
const GAP = Object.assign({ ios: 3200, android: 1200, suggest: 1000 }, window.RC_GAP || {});
const BACKOFF = window.RC_BACKOFF ?? 15000; // pause after a rate-limit style error
const lastCall = { ios: 0, android: 0, suggest: 0 };
const chain = { ios: Promise.resolve(), android: Promise.resolve(), suggest: Promise.resolve() };
function throttled(store, fn) {
  const job = chain[store].then(async () => {
    const wait = lastCall[store] + GAP[store] - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall[store] = Date.now();
    return fn();
  });
  chain[store] = job.catch(() => {});
  return job;
}

let jsonpId = 0;
function jsonp(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const name = '__rc_cb' + (++jsonpId);
    const tag = document.createElement('script');
    const done = () => { delete window[name]; tag.remove(); clearTimeout(timer); };
    const timer = setTimeout(() => { done(); reject(new Error('App Store request timed out')); }, timeoutMs);
    window[name] = data => { done(); resolve(data); };
    tag.onerror = () => { done(); reject(new Error('App Store request failed (possibly rate limited). Wait a minute and try again.')); };
    tag.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + name;
    document.head.appendChild(tag);
  });
}

async function api(url, opts = {}) {
  const headers = {};
  if (opts.body) headers['Content-Type'] = 'application/json';
  const key = localStorage.getItem('rc_key');
  if (key) headers['X-Access-Key'] = key;
  let res;
  try { res = await fetch(url, Object.assign({}, opts, { headers })); }
  catch (e) { throw new Error('Could not reach the Google Play proxy. Check its URL.'); }
  let data = {};
  try { data = await res.json(); } catch (e) { /* non-JSON error */ }
  if (res.status === 401) { $('#auth').hidden = false; const err = new Error('Access key required'); err.auth = true; throw err; }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const playAvailable = () => state.sameOrigin || !!state.proxy.trim();
const playBase = () => (state.sameOrigin ? '' : state.proxy.trim().replace(/\/+$/, ''));

async function iosSearch(term, country, limit) {
  const u = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${country}&media=software&entity=software&limit=${Math.min(limit, 200)}`;
  const data = await throttled('ios', () => jsonp(u));
  return (data.results || []).map(x => ({ id: String(x.trackId), name: x.trackName || '', developer: x.sellerName || '', icon: x.artworkUrl100 || '', ratings: x.userRatingCount || 0, rating: x.averageUserRating || 0 }));
}
async function androidSearch(term, country, limit) {
  if (!playAvailable()) throw new Error('Google Play needs a proxy. Add its URL under Advanced.');
  const r = await throttled('android', () => api(`${playBase()}/api/search?store=android&country=${country}&limit=${limit}&q=${encodeURIComponent(term)}`));
  return r.items || [];
}
const searchStore = (store, term, country, limit) => (store === 'ios' ? iosSearch : androidSearch)(term, country, limit);

/* ---------- status ---------- */
function setStatus(msg, isErr) { const s = $('#status'); if (!s) return; s.textContent = msg || ''; s.classList.toggle('err', !!isErr); }

/* ---------- stores + app pickers ---------- */
const firstCountry = () => COUNTRIES.map(c => c[0]).find(c => state.countries.has(c)) || 'us';
const pickers = {};

const isStoreLink = t => /^(https?|market):\/\//i.test(String(t).trim()) || /(apps|itunes)\.apple\.com|play\.google\.com/i.test(String(t));
const LOADING_HTML = '<div class="loading"><span class="spinner" aria-hidden="true"></span> Looking up the app…</div>';

// Looks up exactly one app by its ID, for the picker.
async function lookupApp(store, id, country) {
  if (store === 'ios') {
    const data = await throttled('ios', () => jsonp(`https://itunes.apple.com/lookup?id=${id}&country=${country}`));
    const r = (data.results || [])[0];
    if (!r) throw new Error("not found in that country's App Store");
    return { id: String(r.trackId || id), name: r.trackName || id, developer: r.sellerName || '', icon: r.artworkUrl100 || '' };
  }
  const base = state.proxy.trim().replace(/\/+$/, '');
  if (!base) throw new Error('Google Play lookups need the proxy');
  const r = await throttled('android', () => api(`${base}/api/listing?store=android&id=${encodeURIComponent(id)}&country=${country}`));
  const l = r.listing || {};
  return { id, name: l.title || id, developer: l.developer || '', icon: l.icon || '' };
}

function setupPicker(store) {
  const root = $('#app-' + store), input = $('input', root), list = $('.suggest', root), sel = $('.selected', root), field = $('.field', root);
  let timer = 0;

  const optHtml = it => `<button type="button" class="opt" data-id="${esc(it.id)}" data-name="${esc(it.name)}" data-dev="${esc(it.developer)}" data-icon="${esc(it.icon)}">` +
    (it.icon ? `<img src="${esc(it.icon)}" alt="">` : '<span class="ph"></span>') +
    `<span><strong>${esc(it.name)}</strong><small>${esc(it.developer)}${it.developer ? ' · ' : ''}${esc(it.id)}</small></span></button>`;

  function render() {
    const a = state.app[store];
    sel.hidden = !a; field.hidden = !!a; list.innerHTML = '';
    if (a) {
      sel.innerHTML = (a.icon ? `<img src="${esc(a.icon)}" alt="">` : '<span class="ph"></span>') +
        `<div><strong>${esc(a.name)}</strong><small>${esc(a.developer || '')}${a.developer ? ' · ' : ''}${esc(a.id)}</small></div>` +
        '<button type="button" class="link">Change</button>';
    }
  }
  pickers[store] = { render };

  const manualOpt = id => `<button type="button" class="opt" data-id="${esc(id)}" data-name="${esc(id)}" data-dev="" data-icon=""><span><strong>Use ${store === 'ios' ? 'Apple ID' : 'package'} ${esc(id)}</strong></span></button>`;

  // An app ID or package name (or a pasted store link, trimmed to one): look up that single app and show only it.
  async function showOne(id, cc) {
    list.innerHTML = LOADING_HTML;
    try {
      const app = await lookupApp(store, id, cc);
      if (input.value.trim() === id) list.innerHTML = optHtml(app);
    } catch (e) {
      if (input.value.trim() === id) list.innerHTML = manualOpt(id) + `<p class="hint">Could not look up the app (${esc(e.message)}). You can still use the ${store === 'ios' ? 'ID' : 'package name'}.</p>`;
    }
  }
  function resolveLink() {
    const p = anParseSource(input.value, store);
    if (p.store && p.store !== store) { list.innerHTML = `<p class="hint">That is ${p.store === 'ios' ? 'an' : 'a'} ${STORE_LABEL[p.store]} link. Paste it in the ${STORE_LABEL[p.store]} box instead.</p>`; return; }
    if (!p.id) { list.innerHTML = '<p class="hint">Could not find an app ID in that link.</p>'; return; }
    input.value = p.id; // trim the link down to the app ID or package name
    showOne(p.id, p.country || firstCountry());
  }

  input.addEventListener('input', e => {
    clearTimeout(timer);
    const q = input.value.trim();
    list.innerHTML = '';
    if (q.length < 2) return;
    const typed = /^(insertText|delete)/.test((e && e.inputType) || '');
    if (isStoreLink(q)) { if (!typed) resolveLink(); return; } // typed links are handled on "change"
    const isId = store === 'ios' ? /^\d{4,15}$/.test(q) : /^[A-Za-z]\w*(\.[A-Za-z_]\w*)+$/.test(q);
    if (isId) { timer = setTimeout(() => showOne(q, firstCountry()), 350); return; }
    timer = setTimeout(async () => {
      try {
        const items = await searchStore(store, q, firstCountry(), 8);
        if (input.value.trim() !== q) return;
        list.innerHTML = items.map(optHtml).join('') || '<p class="hint">No apps found.</p>';
      } catch (e2) { if (input.value.trim() === q) list.innerHTML = `<p class="hint">${esc(e2.message)}</p>`; }
    }, 350);
  });
  input.addEventListener('change', () => { if (isStoreLink(input.value)) resolveLink(); });
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const opts = list.querySelectorAll('button.opt');
    if (opts.length === 1) { e.preventDefault(); opts[0].click(); }
  });

  list.addEventListener('click', e => {
    const b = e.target.closest('button.opt'); if (!b) return;
    state.app[store] = { id: b.dataset.id, name: b.dataset.name, developer: b.dataset.dev, icon: b.dataset.icon };
    input.value = ''; render(); saveSettings();
  });
  sel.addEventListener('click', e => {
    if (!e.target.closest('button.link')) return;
    state.app[store] = null; render(); saveSettings(); input.focus();
  });
  render();
}

function updatePlayHint() { const h = $('#play-hint'); if (h) h.hidden = !(state.stores.android && !playAvailable()); rsNote(); }

function applyStores() {
  for (const s of ['ios', 'android']) { $('#st-' + s).checked = state.stores[s]; $('#app-' + s).hidden = !state.stores[s]; }
  updatePlayHint();
  updateEstimate();
}

/* ---------- keywords ---------- */
function renderKeywords() {
  if (!$('#kw-chips')) return;
  $('#kw-chips').innerHTML = state.keywords.map((k, i) =>
    `<span class="chip">${esc(k)} <button type="button" class="link x" data-i="${i}" aria-label="Remove ${esc(k)}">×</button></span>`).join('');
  updateEstimate();
}
function addKeywords(text) {
  text.split(/[\n,]+/).map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean).forEach(k => {
    if (state.keywords.length < 50 && !state.keywords.some(x => x.toLowerCase() === k.toLowerCase())) state.keywords.push(k.slice(0, 100));
  });
  renderKeywords(); saveSettings();
}

/* ---------- countries ---------- */
function renderCountries() {
  const f = $('#c-filter').value.trim().toLowerCase();
  $('#c-grid').innerHTML = COUNTRIES.filter(([c, n]) => !f || c.includes(f) || n.toLowerCase().includes(f)).map(([c, n]) =>
    `<button type="button" class="chip ${state.countries.has(c) ? 'on' : ''}" data-c="${c}" aria-pressed="${state.countries.has(c)}">${esc(n)} <small>${c.toUpperCase()}</small></button>`).join('');
  $('#c-count').textContent = `${state.countries.size} selected`;
  updateEstimate();
}

/* ---------- estimate ---------- */
function updateEstimate() {
  const n = state.countries.size * state.keywords.length;
  const stores = ['ios', 'android'].filter(s => state.stores[s]);
  const checks = n * stores.length;
  let secs = 0;
  if (state.stores.ios) secs = Math.max(secs, n * 3.4);
  if (state.stores.android) secs = Math.max(secs, n * 1.6);
  if (!state.running) {
    setStatus(checks ? `${checks} checks, about ${secs < 90 ? Math.round(secs) + ' sec' : Math.round(secs / 60) + ' min'}` : '');
  }
}

/* ---------- results ---------- */
const orderedCountries = () => COUNTRIES.map(c => c[0]).filter(c => state.countries.has(c));
const keyOf = (store, c, kw) => `${store}|${state.app[store].id}|${c}|${kw.toLowerCase()}`;

function deltaHtml(prev, cur) {
  if (prev === undefined) return '';
  if (prev === null && cur === null) return '';
  if (prev === null) return '<small class="d up">new</small>';
  if (cur === null) return '<small class="d down">lost</small>';
  const m = prev - cur;
  return m ? `<small class="d ${m > 0 ? 'up' : 'down'}">${m > 0 ? '▲' : '▼'}${Math.abs(m)}</small>` : '';
}

function updateCell(store, c, kw) {
  const k = `${c}|${kw}`, el = state.cells[store][k], d = state.data[store][k];
  if (!el) return;
  let cls = 'r-wait', html = '…', title = 'Waiting';
  if (d && d.error) { cls = 'r-err'; html = '!'; title = d.error; }
  else if (d) {
    const r = d.rank;
    if (r === null) { cls = 'r-none'; html = '—'; title = `Not in the top ${d.scanned}`; }
    else {
      cls = r <= 3 ? 'r-top' : r <= 10 ? 'r-good' : r <= 50 ? 'r-mid' : 'r-low';
      const pv = state.prev[keyOf(store, c, kw)];
      html = `${r}${deltaHtml(pv ? pv.rank : undefined, r)}`;
      title = `Rank ${r}`;
    }
    if (r === null) { const pv = state.prev[keyOf(store, c, kw)]; html += deltaHtml(pv ? pv.rank : undefined, null); }
  }
  el.className = 'cell ' + cls; el.innerHTML = html; el.title = title;
  summarize(store);
}

function summarize(store) {
  const vals = Object.entries(state.data[store]).filter(([, d]) => d && !d.error);
  const ranked = vals.filter(([, d]) => d.rank !== null);
  let txt = `${ranked.length} of ${vals.length} ranked`;
  if (ranked.length) {
    const [bk, bd] = ranked.reduce((a, b) => (b[1].rank < a[1].rank ? b : a));
    const i = bk.indexOf('|');
    txt += `. Best: #${bd.rank} for “${bk.slice(i + 1)}” in ${bk.slice(0, i).toUpperCase()}`;
  }
  const el = $(`#res-${store} .sum`); if (el) el.textContent = txt;
}

function buildSkeleton(stores, countries) {
  const out = $('#results'); out.innerHTML = '';
  state.cells = { ios: {}, android: {} };
  for (const store of stores) {
    const a = state.app[store];
    const head = countries.map(c => `<th scope="col" title="${esc(CNAME[c])}">${c.toUpperCase()}</th>`).join('');
    const rows = state.keywords.map(kw =>
      `<tr><td title="${esc(kw)}">${esc(kw)}</td>${countries.map(c => `<td><button type="button" class="cell r-wait" data-k="${esc(c + '|' + kw)}">…</button></td>`).join('')}</tr>`).join('');
    const sec = document.createElement('section');
    sec.className = 'card'; sec.id = 'res-' + store; sec.dataset.store = store;
    sec.innerHTML = `<div class="res-head"><h2>${STORE_LABEL[store]} results for ${esc(a.name)}</h2><span class="sum"></span></div>` +
      `<div class="scroll"><table><thead><tr><th scope="col">Keyword</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
    out.appendChild(sec);
    sec.querySelectorAll('button.cell').forEach(b => { state.cells[store][b.dataset.k] = b; });
  }
}

function showDetail(store, k) {
  const d = state.data[store][k], box = $('#detail');
  if (!d) return;
  const i = k.indexOf('|'), c = k.slice(0, i), kw = k.slice(i + 1);
  let body;
  if (d.error) body = `<p class="status err">${esc(d.error)}</p>`;
  else {
    const me = state.app[store].id;
    const rankTxt = d.rank === null ? `Not in the top ${d.scanned} results` : `Your rank: <strong>#${d.rank}</strong> of ${d.scanned} scanned`;
    body = `<p>${rankTxt}</p><small>Top results right now:</small><ol>` +
      d.top.map(t => `<li class="${t.id === me ? 'me' : ''}">${esc(t.name)} <small>${esc(t.developer)}</small></li>`).join('') + '</ol>';
  }
  box.innerHTML = `<h3>“${esc(kw)}” on ${STORE_LABEL[store]} in ${esc(CNAME[c] || c)}</h3>${body}`;
  box.hidden = false;
}

/* ---------- run ---------- */
function validate() {
  const stores = ['ios', 'android'].filter(s => state.stores[s]);
  if (!stores.length) return 'Pick at least one store.';
  for (const s of stores) if (!state.app[s]) return `Pick your ${STORE_LABEL[s]} app first.`;
  if (state.stores.android && !playAvailable()) return 'Google Play needs a proxy. Add its URL under Advanced, or untick Google Play.';
  if (!state.keywords.length) return 'Add at least one keyword.';
  if (!state.countries.size) return 'Pick at least one country.';
  return '';
}

function progress() {
  $('#bar').value = state.total ? Math.round(state.done / state.total * 100) : 0;
  setStatus(`Checking… ${state.done} of ${state.total}`);
}

async function runStore(store, countries) {
  const depth = Number($('#depth-' + store).value);
  for (const c of countries) for (const kw of state.keywords) {
    if (state.stop) return;
    const k = `${c}|${kw}`;
    try {
      const items = await searchStore(store, kw, c, depth);
      const pos = items.findIndex(it => it.id === state.app[store].id);
      state.data[store][k] = { rank: pos < 0 ? null : pos + 1, scanned: items.length, top: items.slice(0, 5) };
    } catch (e) {
      state.data[store][k] = { error: e.message };
      if (e.auth) { state.stop = true; }
      else if (/rate limit/i.test(e.message)) await sleep(BACKOFF);
    }
    updateCell(store, c, kw);
    state.done++; progress();
  }
}

async function run() {
  const err = validate();
  if (err) { setStatus(err, true); return; }
  const stores = ['ios', 'android'].filter(s => state.stores[s]);
  const countries = orderedCountries();
  state.running = true; state.stop = false; state.done = 0;
  state.total = stores.length * countries.length * state.keywords.length;
  state.data = { ios: {}, android: {} };
  state.prev = loadLast();
  $('#detail').hidden = true;
  buildSkeleton(stores, countries);
  $('#run').disabled = true; $('#stop').hidden = false; $('#export').hidden = true; $('#bar').hidden = false;
  progress();

  await Promise.all(stores.map(s => runStore(s, countries)));

  // remember this run so the next one can show changes
  const last = loadLast(), today = new Date().toISOString().slice(0, 10);
  for (const s of stores) for (const [k, d] of Object.entries(state.data[s])) {
    if (!d || d.error) continue;
    const i = k.indexOf('|');
    last[keyOf(s, k.slice(0, i), k.slice(i + 1))] = { rank: d.rank, date: today };
  }
  try { localStorage.setItem('rc_last', JSON.stringify(last)); } catch (e) { /* ignore */ }

  const stopped = state.stop;
  state.running = false; state.stop = false;
  $('#run').disabled = false; $('#stop').hidden = true; $('#bar').hidden = true; $('#export').hidden = false;
  const failed = stores.reduce((n, s) => n + Object.values(state.data[s]).filter(d => d && d.error).length, 0);
  setStatus(`${stopped ? 'Stopped' : 'Done'}: ${state.done} of ${state.total} checks${failed ? `, ${failed} failed (click a “!” cell for the reason)` : ''}`, !!failed);
}

function exportCsv() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = [['date', 'store', 'country', 'keyword', 'rank', 'scanned', 'app_id']];
  for (const s of ['ios', 'android']) for (const [k, d] of Object.entries(state.data[s])) {
    if (!d || d.error) continue;
    const i = k.indexOf('|');
    rows.push([today, s, k.slice(0, i), k.slice(i + 1), d.rank ?? '', d.scanned, state.app[s].id]);
  }
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `ranks-${today}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- keyword research ---------- */
const rs = { keywords: [], stores: ['ios', 'android'], running: false, stop: false, rows: new Map(), sort: { key: 'opp', dir: -1 }, country: 'us', done: 0, total: 0 };

const median = a => { if (!a.length) return 0; const t = [...a].sort((x, y) => x - y), m = t.length >> 1; return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2; };
const parseInstalls = v => { const n = parseInt(String(v || '').replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) ? n : 0; };
const tierOf = n => (n >= 80 ? 'Very high' : n >= 60 ? 'High' : n >= 40 ? 'Medium' : n >= 20 ? 'Low' : 'Very low');
const popClass = n => (n >= 60 ? 'r-top' : n >= 40 ? 'r-good' : n >= 20 ? 'r-mid' : 'r-low');
const diffClass = n => (n <= 30 ? 'r-top' : n <= 50 ? 'r-good' : n <= 70 ? 'r-mid' : 'r-low');
const fmtNum = n => Math.round(n).toLocaleString('en-US');

function rsNote() { const el = $('#rs-note'); if (el) el.hidden = playAvailable(); }
function setRsStatus(msg, isErr) { const el = $('#rs-status'); el.textContent = msg || ''; el.classList.toggle('err', !!isErr); }

const loadApplePop = () => { try { return JSON.parse(localStorage.getItem('rc_apple_pop') || '{}'); } catch (e) { return {}; } };
function parseApplePop(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const parts = line.split(/[,\t;]/).map(x => x.trim().replace(/^"|"$/g, ''));
    if (parts.length < 2) continue;
    const score = Number(parts[parts.length - 1]);
    const kw = parts.slice(0, -1).join(' ').trim().toLowerCase();
    if (kw && Number.isFinite(score) && score >= 1 && score <= 100) out[kw] = Math.round(score);
  }
  return out;
}
function showApplePop() {
  const m = loadApplePop()[$('#rs-country').value] || {};
  $('#rs-apple').value = Object.entries(m).map(([k, v]) => `${k}, ${v}`).join('\n');
}

function saveRs() {
  try { localStorage.setItem('rc_research', JSON.stringify({ keywords: rs.keywords, country: $('#rs-country').value,
    stores: { ios: $('#rs-ios').checked, android: $('#rs-android').checked }, expand: $('#rs-expand').checked })); } catch (e) { /* ignore */ }
}
function renderRsChips() {
  $('#rs-chips').innerHTML = rs.keywords.map((k, i) =>
    `<span class="chip">${esc(k)} <button type="button" class="link x" data-i="${i}" aria-label="Remove ${esc(k)}">×</button></span>`).join('');
}
function addRsKeywords(text) {
  text.split(/[\n,]+/).map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean).forEach(k => {
    if (rs.keywords.length < 15 && !rs.keywords.some(x => x.toLowerCase() === k.toLowerCase())) rs.keywords.push(k.slice(0, 100));
  });
  renderRsChips(); saveRs();
}

async function suggestFor(store, term, country) {
  if (!playAvailable()) throw new Error('Needs the proxy (see Options on the Rank check page)');
  const r = await throttled('suggest', () => api(`${playBase()}/api/suggest?store=${store}&country=${country}&q=${encodeURIComponent(term)}`));
  return (r.items || []).map(x => String(x).toLowerCase());
}

// Looks for the keyword in the store's autocomplete after typing 3, 5, 8, ... characters. The fewer characters
// it needs, and the higher it sits, the stronger the signal.
async function probeAutocomplete(store, kw, country) {
  const k = kw.toLowerCase(), len = k.length;
  const lens = [...new Set([3, 5, 8, len].map(n => Math.min(n, len)))].sort((a, b) => a - b);
  for (const p of lens) {
    if (rs.stop) return null;
    const sug = await suggestFor(store, k.slice(0, p), country);
    const idx = sug.findIndex(x => x.startsWith(k));
    if (idx >= 0) return { found: true, prefix: p, pos: idx + 1, strength: Math.max(5, Math.min(100, Math.round(100 * (1 - 0.65 * (p / len))) - 2 * idx)) };
  }
  return { found: false, strength: 0 };
}

function marketMetrics(store, kw, items) {
  const top = items.slice(0, 10);
  const sizes = items.slice(0, 5).map(it => (store === 'ios' ? (it.ratings || 0) : parseInstalls(it.installs)));
  const avgLog = sizes.length ? sizes.reduce((a, n) => a + Math.log10(n + 1), 0) / sizes.length : 0;
  const sizeScore = Math.min(100, avgLog / (store === 'ios' ? 6 : 8) * 100);
  const words = kw.toLowerCase().split(/\s+/).filter(Boolean);
  const titleMatches = top.filter(it => words.every(w => (it.name || '').toLowerCase().includes(w))).length;
  const difficulty = Math.round(0.65 * sizeScore + 0.35 * (titleMatches / Math.max(top.length, 1)) * 100);
  return { difficulty, titleMatches, topCount: top.length, medianSize: median(sizes) };
}

function popCell(res) {
  if (!res) return '<td class="n">…</td>';
  if (res.pop == null) return `<td title="${esc(res.acError || 'No autocomplete data')}"><span class="pill r-none">n/a</span></td>`;
  const tip = res.popSource === 'Apple Ads' ? 'Imported Apple popularity score'
    : res.ac && res.ac.found ? `Autocomplete: shows up after ${res.ac.prefix} typed characters, position ${res.ac.pos}` : 'Never showed up in autocomplete';
  return `<td><span class="pill ${popClass(res.pop)}" title="${esc(tip)}">${res.pop}</span><small class="tier">${tierOf(res.pop)}${res.popSource === 'Apple Ads' ? ' (Apple)' : ''}</small></td>`;
}
function diffCell(store, res) {
  if (!res) return '<td>…</td>';
  if (res.error) return `<td title="${esc(res.error)}"><span class="pill r-err">!</span></td>`;
  const tip = `${res.titleMatches} of the top ${res.topCount} titles contain the keyword · top 5 typical size ${fmtNum(res.medianSize)} ${store === 'ios' ? 'ratings' : 'installs'}`;
  return `<td><span class="pill ${diffClass(res.difficulty)}" title="${esc(tip)}">${res.difficulty}</span></td>`;
}

function renderRsTable() {
  const stores = rs.stores;
  const oppOf = r => { const v = stores.map(s => r[s] && r[s].opp).filter(v => v != null); return v.length ? Math.max(...v) : null; };
  const val = (r, key) => {
    if (key === 'kw') return r.kw.toLowerCase();
    if (key === 'opp') { const o = oppOf(r); return o == null ? -1 : o; }
    const [s, f] = key.split('_'); const x = r[s] && r[s][f]; return x == null ? -1 : x;
  };
  const rows = [...rs.rows.values()].sort((a, b) => { const A = val(a, rs.sort.key), B = val(b, rs.sort.key); return (A < B ? -1 : A > B ? 1 : 0) * rs.sort.dir; });
  const arrow = key => (rs.sort.key === key ? (rs.sort.dir > 0 ? ' ▲' : ' ▼') : '');
  $('#rs-table thead').innerHTML = '<tr>' +
    `<th data-sort="kw" scope="col">Keyword${arrow('kw')}</th><th scope="col">Source</th>` +
    stores.map(s => `<th data-sort="${s}_pop" scope="col">${s === 'ios' ? 'App Store' : 'Play'} popularity${arrow(s + '_pop')}</th><th data-sort="${s}_difficulty" scope="col">${s === 'ios' ? 'App Store' : 'Play'} difficulty${arrow(s + '_difficulty')}</th>`).join('') +
    `<th data-sort="opp" scope="col">Opportunity${arrow('opp')}</th><th scope="col"></th></tr>`;
  $('#rs-table tbody').innerHTML = rows.map(r => {
    const o = oppOf(r);
    return `<tr><td title="${esc(r.kw)}">${esc(r.kw)}</td><td class="src">${r.source}</td>` +
      stores.map(s => popCell(r[s]) + diffCell(s, r[s])).join('') +
      `<td>${o == null ? '<span class="pill r-none">n/a</span>' : `<span class="pill ${popClass(o)}">${o}</span>`}</td>` +
      `<td><button type="button" class="link addkw" data-kw="${esc(r.kw)}">+ track</button></td></tr>`;
  }).join('');
  $('#rs-results').hidden = false;
}

function progressRs() {
  $('#rs-bar').value = rs.total ? Math.round(rs.done / rs.total * 100) : 0;
  setRsStatus(`Researching… ${rs.done} of ${rs.total}`);
}

async function researchStore(store, list, country, apple) {
  for (const x of list) {
    if (rs.stop) return;
    const key = x.kw.toLowerCase(), row = rs.rows.get(key), res = {};
    try {
      Object.assign(res, marketMetrics(store, x.kw, await searchStore(store, x.kw, country, 25)));
    } catch (e) {
      res.error = e.message;
      if (e.auth) rs.stop = true; else if (/rate limit/i.test(e.message)) await sleep(BACKOFF);
    }
    if (!playAvailable()) res.acError = 'Needs the proxy (see Options on the Rank check page)';
    else if (!rs.stop) {
      try { res.ac = await probeAutocomplete(store, x.kw, country); } catch (e) { res.acError = e.message; if (e.auth) rs.stop = true; }
    }
    const a = store === 'ios' ? apple[key] : undefined;
    res.pop = a !== undefined ? a : (res.ac ? res.ac.strength : null);
    res.popSource = a !== undefined ? 'Apple Ads' : (res.ac ? 'Autocomplete' : null);
    res.opp = res.pop != null && res.difficulty !== undefined ? Math.round(res.pop * (100 - res.difficulty) / 100) : null;
    row[store] = res;
    rs.done++; progressRs(); renderRsTable();
  }
}

async function runResearch() {
  const stores = ['ios', 'android'].filter(s => $('#rs-' + s).checked);
  if (!stores.length) { setRsStatus('Pick at least one store.', true); return; }
  if (!rs.keywords.length) { setRsStatus('Add at least one seed keyword.', true); return; }
  const country = $('#rs-country').value;
  Object.assign(rs, { stores, country, running: true, stop: false, rows: new Map(), done: 0, total: 0 });
  const apple = loadApplePop()[country] || {};
  $('#rs-run').disabled = true; $('#rs-stop').hidden = false; $('#rs-export').hidden = true; $('#rs-bar').hidden = false;

  const list = rs.keywords.map(kw => ({ kw, source: 'seed' }));
  const seen = new Set(list.map(x => x.kw.toLowerCase()));
  if ($('#rs-expand').checked && playAvailable()) {
    setRsStatus('Finding suggested keywords…');
    outer: for (const seed of rs.keywords) for (const store of stores) {
      if (rs.stop) break outer;
      try {
        for (const sg of (await suggestFor(store, seed, country)).slice(0, 8)) {
          if (list.length < 30 && !seen.has(sg)) { seen.add(sg); list.push({ kw: sg, source: 'suggested' }); }
        }
      } catch (e) { if (e.auth) rs.stop = true; }
    }
  }
  list.forEach(x => rs.rows.set(x.kw.toLowerCase(), { kw: x.kw, source: x.source }));
  rs.total = list.length * stores.length;
  renderRsTable(); progressRs();

  await Promise.all(stores.map(s => researchStore(s, list, country, apple)));

  const stopped = rs.stop;
  rs.running = false; rs.stop = false;
  saveResearchResults();
  $('#rs-run').disabled = false; $('#rs-stop').hidden = true; $('#rs-bar').hidden = true; $('#rs-export').hidden = false;
  const cells = [...rs.rows.values()].flatMap(r => stores.map(s => r[s]).filter(Boolean));
  const failed = cells.filter(c => c.error).length;
  const noPop = cells.filter(c => c.pop == null).length;
  setRsStatus(`${stopped ? 'Stopped' : 'Done'}: ${rs.rows.size} keywords${failed ? `, ${failed} lookups failed (hover a “!”)` : ''}${noPop ? `, popularity unavailable for ${noPop}` : ''}`, !!failed);
}

function exportResearchCsv() {
  const rows = [['keyword', 'source', 'country', 'store', 'popularity', 'popularity_source', 'tier', 'difficulty', 'title_matches_top10', 'opportunity']];
  for (const r of rs.rows.values()) for (const s of rs.stores) {
    const x = r[s]; if (!x || x.error) continue;
    rows.push([r.kw, r.source, rs.country, s, x.pop ?? '', x.popSource ?? '', x.pop != null ? tierOf(x.pop) : '', x.difficulty, x.titleMatches, x.opp ?? '']);
  }
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `keyword-research-${rs.country}-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function initResearch() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('rc_research') || '{}') || {}; } catch (e) { /* ignore */ }
  if (Array.isArray(saved.keywords)) rs.keywords = saved.keywords.slice(0, 15);
  $('#rs-country').innerHTML = COUNTRIES.map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join('');
  $('#rs-country').value = saved.country || firstCountry();
  if (saved.stores) { $('#rs-ios').checked = saved.stores.ios !== false; $('#rs-android').checked = saved.stores.android !== false; }
  if (saved.expand === false) $('#rs-expand').checked = false;
  renderRsChips(); showApplePop(); rsNote();

  const inp = $('#rs-input');
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addRsKeywords(inp.value); inp.value = ''; } });
  inp.addEventListener('blur', () => { if (inp.value.trim()) { addRsKeywords(inp.value); inp.value = ''; } });
  inp.addEventListener('paste', e => { const t = (e.clipboardData || window.clipboardData).getData('text'); if (/[\n,]/.test(t)) { e.preventDefault(); addRsKeywords(t); } });
  $('#rs-chips').addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (!b) return; rs.keywords.splice(Number(b.dataset.i), 1); renderRsChips(); saveRs(); });
  $('#rs-copy').addEventListener('click', () => addRsKeywords(state.keywords.join(',')));
  ['#rs-ios', '#rs-android', '#rs-expand'].forEach(id => $(id).addEventListener('change', saveRs));
  $('#rs-country').addEventListener('change', () => { saveRs(); showApplePop(); });
  $('#rs-apple-save').addEventListener('click', () => {
    const all = loadApplePop(), c = $('#rs-country').value, m = parseApplePop($('#rs-apple').value);
    all[c] = m;
    try { localStorage.setItem('rc_apple_pop', JSON.stringify(all)); } catch (e) { /* ignore */ }
    $('#rs-apple-msg').textContent = `${Object.keys(m).length} scores saved for ${CNAME[c]}`;
  });
  $('#rs-run').addEventListener('click', runResearch);
  $('#rs-stop').addEventListener('click', () => { rs.stop = true; setRsStatus('Stopping after the current lookup…'); });
  $('#rs-export').addEventListener('click', exportResearchCsv);
  $('#rs-table').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (th) { const k = th.dataset.sort; rs.sort = { key: k, dir: rs.sort.key === k ? -rs.sort.dir : (k === 'kw' ? 1 : -1) }; renderRsTable(); return; }
    const b = e.target.closest('button.addkw');
    if (b) { addKeywords(b.dataset.kw); b.textContent = '✓ tracked'; b.disabled = true; }
  });
}

/* ---------- ASO listing analyzer ---------- */
// Everything below is deterministic JavaScript: no AI calls, no external libraries.
const AN_KEY = 'rc_analyzer';
const AN_LIMITS = { android: { title: 30, short: 80, long: 4000 }, ios: { title: 30, subtitle: 30, keywords: 100, long: 4000 } };
const AN_STOP = new Set('a an and are as at be been by for from has have in into is it its of on or our so that the their this to up us we with you your'.split(' '));
const AN_SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);
// A short, built-in list of well-known trademarks to keep out of generated copy. Add your own under "Terms to avoid".
const AN_TM = ['candy crush', 'zynga', 'pokerstars', 'uno', 'ludo king', 'teen patti gold', 'dream11', 'whatsapp', 'facebook', 'instagram', 'tiktok', 'youtube', 'pubg', 'free fire', 'minecraft', 'roblox', 'fortnite'];
const AN_PROMO = /\b(best|#\s?1|no\.?\s?1|number one|top|free|new|sale|discount|download now|install now|official)\b/i;
const AN_RISKY = /\b(best|#\s?1|no\.?\s?1|number one|ultimate|most addictive|guaranteed|world'?s (?:best|largest|first)|top[- ]rated|award[- ]winning|real money|cash prizes?|high[- ]stakes|gambl\w*|betting)\b/i;
const AN_PLATFORM = /\b(android|google play|play store|playstore|samsung|huawei|amazon appstore)\b/i;

const an = {
  store: 'android', country: 'us',
  src: { android: '', ios: '' },
  app: { android: null, ios: null },
  fields: { android: { title: '', short: '', long: '' }, ios: { title: '', subtitle: '', keywords: '', long: '' } },
  keywords: [], brand: '', avoid: '',
  sel: { title: 0, mid: 0 },
  last: null
};

/* ----- text helpers ----- */
const anNorm = s => String(s ?? '').normalize('NFKC').replace(/[’‘]/g, "'").toLowerCase();
const anTok = s => anNorm(s).match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) || [];
const anStem = w => {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith("'s")) return w.slice(0, -1);
  return w;
};
const anStemTok = s => anTok(s).map(anStem);
const anLen = s => [...String(s ?? '')].length;
const anBytes = s => new TextEncoder().encode(String(s ?? '')).length;
const anCap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const anTitleCase = s => String(s).split(/\s+/).filter(Boolean).map((w, i) => (i > 0 && AN_SMALL.has(w.toLowerCase()) ? w.toLowerCase() : anCap(w))).join(' ');
const anList = a => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
const anEscRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const anContent = stems => { const c = stems.filter(w => !AN_STOP.has(w)); return c.length ? c : stems; };
const anAvoidList = () => [...AN_TM, ...an.avoid.split(/[,\n]+/).map(x => anNorm(x).trim()).filter(Boolean)];
const anHasAvoid = text => { const t = ' ' + anTok(text).join(' ') + ' '; return anAvoidList().some(a => a && t.includes(' ' + anTok(a).join(' ') + ' ')); };

function anMatch(text, kw) {
  const t = anStemTok(text), p = anStemTok(kw);
  if (!p.length) return { type: 'none', count: 0, first: -1, total: t.length };
  let count = 0, first = -1;
  for (let i = 0; i + p.length <= t.length; i++) {
    let ok = true;
    for (let j = 0; j < p.length; j++) if (t[i + j] !== p[j]) { ok = false; break; }
    if (ok) { count++; if (first < 0) first = i; }
  }
  const set = new Set(t), need = anContent(p), present = need.filter(w => set.has(w)).length;
  const type = count ? 'exact' : (present === need.length && need.length > 1) ? 'words' : present ? 'partial' : 'none';
  return { type, count, first, total: t.length, present, need: need.length };
}

function anRelevance(kw, allText) {
  const t = new Set(anStemTok(allText)), need = anContent(anStemTok(kw));
  const ratio = need.length ? need.filter(w => t.has(w)).length / need.length : 0;
  return { ratio, level: ratio === 1 ? 'High' : ratio >= 0.5 ? 'Medium' : 'Low' };
}

function anSyllables(w) {
  w = w.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const m = w.match(/[aeiouy]{1,2}/g);
  return m ? m.length : 1;
}

function anReadability(text) {
  const raw = String(text || '').trim();
  if (!raw) return { empty: true };
  const words = anTok(raw), n = words.length;
  const sentences = raw.split(/[.!?]+(?:\s|$)|\n+/).map(s => s.trim()).filter(s => anTok(s).length > 0);
  const sCount = Math.max(sentences.length, 1);
  const letters = (raw.match(/\p{L}/gu) || []).length, latin = (raw.match(/[A-Za-z]/g) || []).length;
  const isLatin = letters > 0 && latin / letters >= 0.7;
  const syl = isLatin ? words.reduce((a, w) => a + anSyllables(w), 0) : 0;
  const avgSentence = n / sCount;
  const flesch = isLatin && n >= 30 ? Math.round(206.835 - 1.015 * avgSentence - 84.6 * (syl / n)) : null;
  const lines = raw.split(/\r?\n/);
  const bullets = lines.filter(l => /^\s*([-–—•*·▪►✔✓✅➤➔●◆]|\p{Extended_Pictographic})/u.test(l)).length;
  const paragraphs = raw.split(/\n\s*\n/).filter(p => p.trim()).length;
  const band = flesch == null ? null : flesch >= 70 ? 'Easy' : flesch >= 50 ? 'Fairly easy' : flesch >= 30 ? 'Hard' : 'Very hard';
  return { empty: false, words: n, sentences: sCount, avgSentence, flesch, band, bullets, paragraphs, isLatin };
}

/* ----- metrics reused from the other tabs (no extra API calls) ----- */
function researchSnapshot() {
  const rows = {};
  for (const [k, r] of rs.rows) {
    rows[k] = { kw: r.kw, source: r.source };
    for (const s of ['ios', 'android']) if (r[s]) rows[k][s] = { pop: r[s].pop ?? null, difficulty: r[s].difficulty ?? null, opp: r[s].opp ?? null, popSource: r[s].popSource ?? null, error: r[s].error ? true : undefined };
  }
  return { country: rs.country, stores: rs.stores, rows };
}
function saveResearchResults() {
  try { localStorage.setItem('rc_research_results', JSON.stringify(researchSnapshot())); } catch (e) { /* ignore */ }
}
function anResearch() {
  if (rs.rows.size) return researchSnapshot();
  try { const s = JSON.parse(localStorage.getItem('rc_research_results') || 'null'); return s && s.rows ? s : null; } catch (e) { return null; }
}
function anMetrics(store, country, kw) {
  const snap = anResearch();
  if (!snap || snap.country !== country) return null;
  const x = (snap.rows[kw.toLowerCase()] || {})[store];
  if (!x || x.error) return null;
  return { pop: x.pop ?? null, difficulty: x.difficulty ?? null, opp: x.opp ?? null, popSource: x.popSource || null };
}
function anRank(store, country, kw, appId) {
  const low = kw.toLowerCase();
  for (const [k, d] of Object.entries(state.data[store] || {})) {
    const i = k.indexOf('|');
    if (k.slice(0, i) === country && k.slice(i + 1).toLowerCase() === low && d && !d.error) return { rank: d.rank, scanned: d.scanned, from: 'this session' };
  }
  if (appId) {
    const p = loadLast()[`${store}|${appId}|${country}|${low}`];
    if (p) return { rank: p.rank, scanned: null, from: 'last check ' + (p.date || '') };
  }
  return null;
}
function anKeywordRows(store, country) {
  const id = (an.app[store] && an.app[store].id) || (state.app[store] && state.app[store].id) || null;
  return an.keywords.map((kw, i) => ({ kw, i, metrics: anMetrics(store, country, kw), rank: anRank(store, country, kw, id) }));
}

/* ----- analysis ----- */
const AN_CREDIT = {
  android: { title: { exact: 1, words: 0.6, partial: 0.3 }, mid: { exact: 0.8, words: 0.5, partial: 0.25 }, long: { exact: 0.5, words: 0.3, partial: 0.15 } },
  ios: { title: { exact: 1, words: 0.7, partial: 0.35 }, mid: { exact: 0.9, words: 0.6, partial: 0.3 }, kwf: { exact: 0.8, words: 0.75, partial: 0.3 } }
};
const anMid = (store, f) => (store === 'ios' ? f.subtitle : f.short);

function anAnalyze(store, f, kwRows) {
  const L = AN_LIMITS[store], credit = AN_CREDIT[store];
  const mid = anMid(store, f), kwf = store === 'ios' ? String(f.keywords || '').replace(/,/g, ' ') : '';
  const all = [f.title, mid, f.long, kwf].join('\n');
  const indexedStems = new Set(anStemTok([f.title, mid, kwf].join(' ')));
  const longStats = anReadability(f.long);

  const rows = kwRows.map(k => {
    const m = { title: anMatch(f.title, k.kw), mid: anMatch(mid, k.kw), long: anMatch(f.long, k.kw) };
    if (store === 'ios') m.kwf = anMatch(kwf, k.kw);
    const rel = anRelevance(k.kw, all);
    let cr = 0;
    for (const field of Object.keys(credit)) cr = Math.max(cr, credit[field][m[field].type] || 0);
    if (store === 'ios' && anContent(anStemTok(k.kw)).every(w => indexedStems.has(w))) cr = Math.max(cr, 0.85); // Apple combines words across fields
    const density = store === 'android' && m.long.total ? (m.long.count * anStemTok(k.kw).length / m.long.total) * 100 : null;
    return { ...k, m, rel, credit: cr, covered: cr >= 0.5, density, avoided: anHasAvoid(k.kw) };
  });

  const opps = rows.map(r => r.metrics && r.metrics.opp).filter(v => v != null);
  const HI = 25;
  const hiSet = new Set(opps.some(v => v >= HI) ? rows.filter(r => r.metrics && r.metrics.opp >= HI).map(r => r.i)
    : rows.filter(r => r.metrics && r.metrics.opp != null).sort((a, b) => b.metrics.opp - a.metrics.opp).slice(0, 3).map(r => r.i));
  rows.forEach(r => { r.highOpp = hiSet.has(r.i); r.rec = anRecommend(store, r); });

  const considered = rows.filter(r => r.rel.level !== 'Low');
  const w = r => 1 + (r.metrics && r.metrics.opp != null ? r.metrics.opp / 25 : 0);
  const wSum = considered.reduce((a, r) => a + w(r), 0);
  const coverage = wSum ? considered.reduce((a, r) => a + w(r) * r.credit, 0) / wSum : null;
  const coveredCount = considered.filter(r => r.covered).length;

  const A = { store, f, rows, considered, coverage, coveredCount, hiSet, longStats };
  A.flags = anFlags(store, f, rows);
  A.rep = anRepetition(store, f, rows);
  A.parts = anScoreParts(store, A);
  const avail = A.parts.filter(p => p.pts != null), max = avail.reduce((a, p) => a + p.max, 0);
  A.total = max ? Math.round(avail.reduce((a, p) => a + p.pts, 0) / max * 100) : null;
  A.band = A.total == null ? 'N/A' : A.total >= 85 ? 'Strong' : A.total >= 70 ? 'Good' : A.total >= 50 ? 'Needs work' : 'Weak';
  return A;
}

function anRecommend(store, r) {
  const { title, mid, long } = r.m, kwf = r.m.kwf;
  if (r.avoided) return 'Avoid: contains a trademark or a term you excluded';
  if (r.rel.level === 'Low') return 'Skip: your listing does not support this keyword';
  if (store === 'android') {
    const inT = title.type === 'exact', inM = mid.type === 'exact', inL = long.count > 0;
    if (long.count > 5) return `Used ${long.count} times in the description: reduce repetition`;
    if (r.highOpp && !inT && !inM) return 'High opportunity: work it into the title or short description';
    if (r.highOpp && !inT) return 'High opportunity: consider the exact phrase in the title';
    if (inT && inM && inL) return 'Well covered';
    if (inT && !inL) return 'In the title: also mention it naturally in the description';
    if (inM && !inL) return 'Mention it naturally in the long description';
    if (!inT && !inM && !inL) return 'Mention it naturally in the long description';
    return 'Covered';
  }
  const inT = title.type === 'exact', inM = mid.type === 'exact', inK = kwf && (kwf.type === 'exact' || kwf.type === 'words');
  if (r.highOpp && !r.covered) return 'High opportunity: add to the subtitle or keyword field';
  if (inT || inM) return inK ? 'Also in the keyword field: remove those words to free bytes' : 'Well covered';
  if (r.covered) return 'Covered by combining title, subtitle and keyword field';
  if (long.type !== 'none') return 'Only in the description: Apple does not use it for search';
  return 'Add to the keyword field if space allows';
}

function anFlags(store, f, rows) {
  const flags = [], L = AN_LIMITS[store];
  const add = (level, text) => flags.push({ level, text });
  const check = (label, v, lim, bytes) => {
    const n = bytes ? anBytes(v) : anLen(v);
    if (!String(v || '').trim()) add('warn', `${label} is empty`);
    else if (n > lim) add('error', `${label} is over the limit by ${n - lim}${bytes ? ' bytes' : ' characters'}`);
  };
  check('Title', f.title, L.title);
  if (store === 'android') { check('Short description', f.short, L.short); } else { check('Subtitle', f.subtitle, L.subtitle); check('Keyword field', f.keywords, L.keywords, true); }
  check('Description', f.long, L.long);
  const short = anMid(store, f);
  if (AN_PROMO.test(f.title) || AN_PROMO.test(short)) add('warn', `Promotional or price wording in the title or ${store === 'ios' ? 'subtitle' : 'short description'} can be rejected by ${store === 'ios' ? 'Apple' : 'Google Play'}`);
  if (/\p{Extended_Pictographic}/u.test(f.title)) add('warn', 'Emoji in the title: both stores discourage this');
  if ((f.title.match(/\b[A-Z]{6,}\b/g) || []).length) add('info', 'All-caps words in the title can be flagged');
  const text = [f.title, short, f.long, f.keywords].join('\n');
  if (store === 'ios' && AN_PLATFORM.test(text)) add('error', 'Mentions another mobile platform (for example Android). Apple rejects this in metadata');
  const risky = String(f.long || '').split(/(?<=[.!?])\s+|\n+/).filter(s => AN_RISKY.test(s)).slice(0, 3);
  if (risky.length || AN_RISKY.test(f.title + ' ' + short)) add('warn', 'Claims to review (superlatives or gambling-style wording): ' + (risky.map(s => '“' + s.slice(0, 70) + (s.length > 70 ? '…' : '') + '”').join(', ') || 'in the title or short text'));
  if (anHasAvoid(text)) add('warn', 'The text contains a trademark or a term you asked to avoid');
  const bad = rows.filter(r => r.avoided).map(r => r.kw);
  if (bad.length) add('warn', 'Keywords to drop: ' + bad.join(', '));
  if (store === 'ios' && /,\s/.test(f.keywords || '')) add('info', 'The keyword field has spaces after commas, which waste bytes');
  return flags;
}

function anRepetition(store, f, rows) {
  const out = { penalties: [], items: [] };
  const long = f.long || '', toks = anStemTok(long).filter(w => !AN_STOP.has(w));
  const counts = new Map(); toks.forEach(w => counts.set(w, (counts.get(w) || 0) + 1));
  const total = Math.max(anTok(long).length, 1);
  const top = [...counts.entries()].filter(([, c]) => c >= 6).map(([w, c]) => ({ w, c, d: c / total * 100 })).sort((a, b) => b.c - a.c).slice(0, 5);
  out.top = top;
  if (store === 'android') {
    const heavy = rows.filter(r => r.m.long.count > 5);
    if (heavy.length) out.penalties.push({ pts: Math.min(9, 3 * heavy.length), why: `keyword phrase used more than 5 times in the description: ${heavy.map(r => r.kw).join(', ')}` });
    const dense = top.filter(x => x.d >= 3.5 && x.c >= 8);
    if (dense.length) out.penalties.push({ pts: Math.min(6, 2 * dense.length), why: `single words that dominate the text: ${dense.map(x => x.w).join(', ')}` });
    const tw = anContent(anStemTok(f.title)), sw = new Set(anStemTok(f.short));
    if (tw.length && tw.filter(w => sw.has(w)).length / tw.length >= 0.75) out.penalties.push({ pts: 2, why: 'the short description repeats most of the title words' });
  } else {
    const places = { title: new Set(anContent(anStemTok(f.title))), subtitle: new Set(anContent(anStemTok(f.subtitle))), keywords: new Set(anStemTok(String(f.keywords || '').replace(/,/g, ' '))) };
    const seen = new Map();
    for (const [name, set] of Object.entries(places)) for (const w of set) seen.set(w, [...(seen.get(w) || []), name]);
    const dup = [...seen.entries()].filter(([, v]) => v.length > 1);
    out.dups = dup.map(([w, v]) => ({ w, in: v }));
    if (dup.length) out.penalties.push({ pts: Math.min(9, 1.5 * dup.length), why: `words repeated across title, subtitle and keyword field (wasted space): ${dup.map(([w]) => w).join(', ')}` });
    const dense = top.filter(x => x.d >= 4 && x.c >= 8);
    if (dense.length) out.penalties.push({ pts: Math.min(3, dense.length), why: `padding in the description (readability, not a ranking factor): ${dense.map(x => x.w).join(', ')}` });
  }
  return out;
}

function anScoreParts(store, A) {
  const f = A.f, L = AN_LIMITS[store], rows = A.rows, parts = [];
  // 1. keyword coverage (30)
  parts.push(A.coverage == null
    ? { key: 'coverage', label: 'Keyword coverage', pts: null, max: 30, why: 'N/A: add keywords (and relevant ones) to measure it' }
    : { key: 'coverage', label: 'Keyword coverage', pts: +(A.coverage * 30).toFixed(1), max: 30, why: `${Math.round(A.coverage * 100)}% weighted coverage; ${A.coveredCount} of ${A.considered.length} relevant keywords sit in ${store === 'ios' ? 'title, subtitle or keyword field' : 'title, short or long description'}` });
  // 2. relevance (20)
  if (!rows.length) parts.push({ key: 'relevance', label: 'Relevance', pts: null, max: 20, why: 'N/A: add keywords to measure it' });
  else {
    const sc = rows.reduce((a, r) => a + (r.rel.level === 'High' ? 1 : r.rel.level === 'Medium' ? 0.5 : 0), 0) / rows.length;
    const low = rows.filter(r => r.rel.level === 'Low').length;
    parts.push({ key: 'relevance', label: 'Relevance', pts: +(sc * 20).toFixed(1), max: 20, why: `${rows.length - low} of ${rows.length} keywords are supported by words already in your listing` });
  }
  // 3. metadata limits (15)
  const spec = store === 'android'
    ? [['Title', f.title, L.title, 5, 20, false], ['Short description', f.short, L.short, 5, 60, false], ['Description', f.long, L.long, 5, 1500, false]]
    : [['Title', f.title, L.title, 4, 20, false], ['Subtitle', f.subtitle, L.subtitle, 4, 20, false], ['Keyword field', f.keywords, L.keywords, 4, 90, true], ['Description', f.long, L.long, 3, 1000, false]];
  let pts = 0, max = 0; const notes = [];
  for (const [label, v, lim, wt, target, bytes] of spec) {
    const n = bytes ? anBytes(v) : anLen(v); max += wt;
    if (!String(v || '').trim()) notes.push(`${label} empty`);
    else if (n > lim) notes.push(`${label} over by ${n - lim}`);
    else { pts += wt * (0.5 + 0.5 * Math.min(1, n / target)); }
  }
  parts.push({ key: 'limits', label: 'Metadata limits', pts: +pts.toFixed(1), max, why: notes.length ? notes.join('; ') : 'every field is filled and within its limit' });
  // 4. readability (15)
  const rd = A.longStats;
  if (rd.empty) parts.push({ key: 'readability', label: 'Readability', pts: 0, max: 15, why: 'no description to read' });
  else {
    const sent = rd.avgSentence <= 18 ? 3 : rd.avgSentence <= 25 ? 2 : 0.5;
    const struct = (rd.paragraphs >= 3 || rd.bullets >= 3) ? 4 : rd.paragraphs >= 2 ? 2 : 0;
    let p, why;
    if (rd.flesch != null) { p = Math.max(0, Math.min(1, (rd.flesch - 20) / 40)) * 8 + sent + struct; why = `Flesch ${rd.flesch} (${rd.band}), ${rd.avgSentence.toFixed(1)} words per sentence, ${rd.paragraphs} paragraphs, ${rd.bullets} bullet lines`; }
    else { p = (sent + struct) * 15 / 7; why = `${rd.isLatin ? 'text too short for Flesch' : 'Flesch is English-only'}; ${rd.avgSentence.toFixed(1)} words per sentence, ${rd.paragraphs} paragraphs, ${rd.bullets} bullet lines`; }
    parts.push({ key: 'readability', label: 'Readability', pts: +Math.min(15, p).toFixed(1), max: 15, why });
  }
  // 5. repetition (20)
  const pen = A.rep.penalties.reduce((a, p) => a + p.pts, 0);
  parts.push({ key: 'repetition', label: 'Repetition', pts: +Math.max(0, 20 - pen).toFixed(1), max: 20, why: A.rep.penalties.length ? A.rep.penalties.map(p => `-${p.pts}: ${p.why}`).join('; ') : 'no stuffing or wasted repeats found' });
  return parts;
}

/* ----- generation (only reuses your own wording and your chosen keywords) ----- */
function anBrandOf(store, f) {
  if (an.brand.trim()) return an.brand.trim();
  const seg = String(f.title || '').trim().split(/\s+[-–—|]\s+|\s*:\s*/)[0].trim();
  return seg || (an.app[store] && an.app[store].name) || '';
}

function anPriority(rows) {
  const num = (r, k, d) => (r.metrics && r.metrics[k] != null ? r.metrics[k] : d);
  return rows.filter(r => r.rel.level !== 'Low' && !r.avoided)
    .sort((a, b) => (num(b, 'opp', -1) - num(a, 'opp', -1)) || (num(b, 'pop', -1) - num(a, 'pop', -1)) || (num(a, 'difficulty', 101) - num(b, 'difficulty', 101)) || (a.i - b.i));
}

// Splits the existing description into features (bullets, headings, "Label: detail" lines), rules and paragraphs.
function anParse(text, brand) {
  const feats = [], paras = [], rules = []; let sawFirst = false;
  const GENERIC = /^(key features|features|download|join|about|how to play|classic .* gameplay)\b/i;
  const RULE = /^the (goal|twist|title|challenge|rules?)\b/i;
  for (let line of String(text || '').replace(/\r/g, '').split('\n')) {
    line = line.trim(); if (!line) continue;
    const bulleted = /^([-–—•*·▪►✔✓✅➤➔●◆]|\p{Extended_Pictographic})/u.test(line);
    let clean = line;
    for (let i = 0; i < 3; i++) clean = clean.replace(/^[\s\-–—•*·▪►✔✓✅➤➔●◆\uFE0F]+/u, '').replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '');
    clean = clean.trim(); if (!clean) continue;
    if (!sawFirst) { sawFirst = true; if (!bulleted && (clean.includes(':') || (clean.length <= 90 && !/[.]$/.test(clean)))) continue; } // headline, not a feature
    const ld = clean.match(/^([^:.!?]{2,45}):\s*(.+)$/);
    if (ld) { (RULE.test(ld[1]) ? rules : feats).push(RULE.test(ld[1]) ? clean : { label: ld[1].trim(), detail: ld[2].trim() }); continue; }
    const head = clean.replace(/[!:.]+$/, '').trim();
    if (clean.endsWith(':') || GENERIC.test(head)) continue;
    if ((bulleted || (clean.length <= 60 && !/[.]$/.test(clean))) && head.length <= 60) { feats.push({ label: head, detail: '' }); continue; }
    paras.push(clean);
  }
  const seen = new Set();
  const uniq = feats.filter(x => { const k = anStemTok(x.label).join(' '); if (seen.has(k)) return false; seen.add(k); return true; });
  return { feats: uniq, paras, rules };
}

function anFeaturePhrases(parsed, prior, brand) {
  const bs = new Set(anStemTok(brand)), want = new Map();
  prior.forEach((r, i) => anContent(anStemTok(r.kw)).forEach(w => { if (!want.has(w)) want.set(w, prior.length - i); }));
  const out = [], seen = new Set();
  for (const f of parsed.feats) {
    for (const part of f.label.split(/\s+(?:&|and)\s+/i)) {
      const toks = part.trim().split(/\s+/).filter(Boolean);
      if (!toks.length || toks.length > 5 || AN_RISKY.test(part) || anHasAvoid(part) || AN_PLATFORM.test(part)) continue;
      const phrase = toks.map(w => (/^[A-Z0-9]{2,}$/.test(w) || bs.has(anStem(w.toLowerCase())) ? w : w.toLowerCase())).join(' ');
      const key = anStemTok(phrase).join(' ');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const score = anStemTok(phrase).reduce((a, w) => a + (want.get(w) || 0), 0);
      out.push({ phrase, score, len: phrase.length });
    }
  }
  return out.sort((a, b) => (b.score - a.score) || (a.len - b.len)).map(x => x.phrase);
}

function anTitleOptions(store, brand, prior) {
  const limit = AN_LIMITS[store].title, bs = new Set(anStemTok(brand));
  if (!brand) return [];
  const descs = [], seen = new Set();
  for (const r of prior) {
    const words = r.kw.trim().split(/\s+/).filter(w => !bs.has(anStem(anNorm(w))));
    const all = r.kw.trim().split(/\s+/).length;
    if (!words.length || (words.length < all && words.length < 2)) continue; // the brand already covers it
    const text = anTitleCase(words.join(' '));
    if (!seen.has(text.toLowerCase())) { seen.add(text.toLowerCase()); descs.push(text); }
  }
  const fits = d => d && anLen(brand) + 2 + anLen(d) <= limit;
  const usable = descs.filter(fits);
  const pool = [];
  if (usable[0]) pool.push(`${brand}: ${usable[0]}`);
  if (usable[1]) pool.push(`${brand} - ${usable[1]}`);
  const short = descs.filter(d => anLen(d) <= 12).slice(0, 4);
  for (let i = 0; i < short.length; i++) for (let j = i + 1; j < short.length; j++) { const c = `${short[i]} & ${short[j]}`; if (fits(c)) pool.push(`${brand}: ${c}`); }
  if (usable[2]) pool.push(`${brand}: ${usable[2]}`);
  if (usable[0]) pool.push(`${brand} ${usable[0]}`);
  const out = [];
  for (const t of pool) if (anLen(t) <= limit && !out.some(o => o.toLowerCase() === t.toLowerCase())) out.push(t);
  return out.slice(0, 3);
}

function anDistinct(feats, used) {
  const stems = p => new Set(anContent(anStemTok(p))), out = [];
  for (const f of feats) {
    const sf = stems(f); if (!sf.size) continue;
    const inside = (a, b) => [...a].every(w => b.has(w));
    if (used.some(u => [...sf].some(w => stems(u).has(w)))) continue;          // a keyword in the sentence already uses these words
    if (out.some(o => inside(sf, stems(o)) || inside(stems(o), sf))) continue; // near-duplicate of a feature already kept
    out.push(f);
  }
  return out;
}

function anMidOptions(store, prior, feats, titleText, brand) {
  const limit = store === 'ios' ? AN_LIMITS.ios.subtitle : AN_LIMITS.android.short;
  const titleStems = new Set(anStemTok(titleText));
  const fresh = prior.filter(r => !anContent(anStemTok(r.kw)).every(w => titleStems.has(w)));
  const ordered = [...fresh, ...prior.filter(r => !fresh.includes(r))];
  const opts = [];
  const push = t => { t = t.replace(/\s+/g, ' ').trim(); if (t && anLen(t) <= limit && !opts.some(o => o.toLowerCase() === t.toLowerCase())) opts.push(t); };
  if (store === 'ios') {
    const phr = ordered.map(r => anTitleCase(r.kw.trim().split(/\s+/).filter(w => !titleStems.has(anStem(anNorm(w)))).join(' '))).filter(Boolean);
    const frag = k => { const n = k.trim().split(/\s+/).length; return anTitleCase(k.trim().split(/\s+/).filter(w => !titleStems.has(anStem(anNorm(w)))).join(' ')).split(' ').length < Math.min(n, 2) ? 1 : 0; };
    const u = [...new Set(phr)].map((t, i) => ({ t, f: frag(ordered[i].kw) })).sort((a, b) => a.f - b.f).map(x => x.t);
    const featT = feats.slice(0, 2).map(anTitleCase);
    const disjoint = (a, b) => { const sa = new Set(anContent(anStemTok(a))); return anContent(anStemTok(b)).every(w => !sa.has(w)); };
    const pair = (a, b) => (a && b && disjoint(a, b) ? `${a} & ${b}` : false);
    const seq = [u[0], pair(u[0], u[1]), u[1], featT.length === 2 && pair(featT[0], featT[1]), u[2], pair(u[0], u[2]), featT[0]];
    seq.forEach(t => t && push(t));
    return opts.slice(0, 3);
  }
  const K = ordered.map(r => r.kw.trim());
  const fitList = (build, list) => { for (let n = list.length; n >= 1; n--) { const t = build(list.slice(0, n)); if (anLen(t) <= limit) return t; } return ''; };
  if (!K.length) return [];
  if (feats.length) {
    const fA = anDistinct(feats, [K[0]]), fB = anDistinct(feats, [K[1] || K[0]]), fC = anDistinct(feats, K.slice(0, 2));
    if (fA.length) push(fitList(F => `${anCap(K[0])} with ${anList(F)}.`, fA.slice(0, 3)));
    if (fB.length) push(fitList(F => `${anCap(K[1] || K[0])}: ${anList(F)}.`, fB.length > 2 ? fB.slice(1, 4) : fB.slice(0, 2)));
    if (K[1] && fC.length) push(fitList(F => `${anCap(K[0])} and ${K[1]}, with ${anList(F)}.`, fC.slice(0, 2)));
    if (fA.length) push(fitList(F => `${anCap(K[0])}: ${anList(F)}.`, fA.slice(0, 3)));
  }
  if (opts.length < 3) push(`${anCap(anList(K.slice(0, 3)))}.`);
  if (opts.length < 3 && K[1]) push(`${anCap(K[0])} and ${K[1]}.`);
  return opts.slice(0, 3);
}

function anKeywordField(prior, usedStems) {
  const used = new Set(usedStems), out = []; let bytes = 0;
  for (const r of prior) for (const w of anTok(r.kw)) {
    const st = anStem(w);
    if (used.has(st) || AN_STOP.has(w) || w.length < 2 || /^\d+$/.test(w)) continue;
    const add = (out.length ? 1 : 0) + anBytes(w);
    if (bytes + add > AN_LIMITS.ios.keywords) continue;
    out.push(w); used.add(st); bytes += add;
  }
  return out.join(',');
}

function anLongDesc(store, f, parsed, prior, brand, midText) {
  const sentences = p => p.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const ok = s => !AN_RISKY.test(s) && !anHasAvoid(s) && !(store === 'ios' && AN_PLATFORM.test(s));
  const intro = [];
  for (const p of parsed.paras) { for (const s of sentences(p)) if (ok(s) && intro.length < 3) intro.push(s); if (intro.length >= 3) break; }
  if (!intro.length && midText) intro.push(/[.!?]$/.test(midText) ? midText : midText + '.');
  const out = [];
  if (intro.length) out.push(intro.join(' '));
  if (store === 'android') {
    const introStems = anStemTok(intro.join(' ')).join(' ');
    const add = prior.filter(r => r.rel.level === 'High' && !introStems.includes(anStemTok(r.kw).join(' '))).slice(0, 3).map(r => r.kw.trim());
    if (add.length >= 2) out.push(`${brand || 'This app'} brings together ${anList(add)}.`);
  }
  const bullets = parsed.feats.filter(x => ok(x.label) && ok(x.detail || '') && !AN_PLATFORM.test(x.label)).map(x => `• ${x.label}${x.detail ? ': ' + x.detail : ''}`);
  const rules = parsed.rules.filter(ok);
  const rest = parsed.paras.filter(p => !intro.some(s => p.includes(s))).map(p => sentences(p).filter(ok).join(' ')).filter(Boolean);
  const cta = rest.length && /^(download|join|play|install|start)\b/i.test(rest[rest.length - 1]) ? rest.pop() : '';
  const build = n => {
    const parts = [...out];
    if (bullets.length) parts.push('Features\n' + bullets.slice(0, n).join('\n'));
    if (rules.length) parts.push('How to play\n' + rules.join('\n'));
    if (rest.length) parts.push(rest.join('\n\n'));
    if (cta) parts.push(cta);
    return parts.join('\n\n');
  };
  let n = bullets.length, text = build(n);
  while (anLen(text) > AN_LIMITS[store].long && n > 0) { n--; text = build(n); }
  if (anLen(text) > AN_LIMITS[store].long) text = [...text].slice(0, AN_LIMITS[store].long).join('');
  return { text, notes: [] };
}

function anGenerate(store, A) {
  const f = A.f, brand = anBrandOf(store, f), prior = anPriority(A.rows);
  const parsed = anParse(f.long, brand);
  const feats = anFeaturePhrases(parsed, prior, brand);
  const titles = anTitleOptions(store, brand, prior);
  const ti = Math.min(an.sel.title, Math.max(titles.length - 1, 0));
  const titleText = titles.length ? titles[ti] : f.title;
  const mids = anMidOptions(store, prior, feats, titleText, brand);
  const mi = Math.min(an.sel.mid, Math.max(mids.length - 1, 0));
  const midText = mids.length ? mids[mi] : anMid(store, f);
  const G = { brand, titles, mids, ti, mi, feats, prior };
  if (store === 'ios') {
    const used = [...anStemTok(titleText), ...anStemTok(midText)];
    G.kwfield = anKeywordField(prior, used);
  }
  G.long = anLongDesc(store, f, parsed, prior, brand, midText);
  G.after = store === 'ios'
    ? { title: titleText, subtitle: midText, keywords: G.kwfield, long: G.long.text }
    : { title: titleText, short: midText, long: G.long.text };
  return G;
}

/* ----- storage ----- */
function anSnapshot(L) {
  return {
    store: L.store, country: L.country, at: L.at,
    score: { before: L.A.total, after: L.A2.total }, parts: L.A.parts,
    coverage: { before: L.A.coverage, after: L.A2.coverage },
    options: { titles: L.G.titles, mids: L.G.mids, keywords: L.G.kwfield ?? null, long: L.G.long.text },
    table: L.A.rows.map(r => ({ keyword: r.kw, popularity: r.metrics ? r.metrics.pop : null, difficulty: r.metrics ? r.metrics.difficulty : null, opportunity: r.metrics ? r.metrics.opp : null, relevance: r.rel.level, recommendation: r.rec }))
  };
}
function anSave() {
  try {
    localStorage.setItem(AN_KEY, JSON.stringify({ store: an.store, country: an.country, src: an.src, app: an.app, fields: an.fields, keywords: an.keywords, brand: an.brand, avoid: an.avoid, sel: an.sel, result: an.last ? anSnapshot(an.last) : null }));
  } catch (e) { /* storage may be unavailable */ }
}
function anLoad() {
  try {
    const s = JSON.parse(localStorage.getItem(AN_KEY) || 'null');
    if (!s) return false;
    if (s.store === 'ios' || s.store === 'android') an.store = s.store;
    if (typeof s.country === 'string' && CNAME[s.country]) an.country = s.country;
    for (const k of ['android', 'ios']) {
      if (s.src && typeof s.src[k] === 'string') an.src[k] = s.src[k];
      if (s.app && s.app[k] && typeof s.app[k].id === 'string') an.app[k] = s.app[k];
      for (const key of Object.keys(an.fields[k])) if (s.fields && s.fields[k] && typeof s.fields[k][key] === 'string') an.fields[k][key] = s.fields[k][key];
    }
    if (Array.isArray(s.keywords)) an.keywords = s.keywords.filter(x => typeof x === 'string').slice(0, 50);
    if (typeof s.brand === 'string') an.brand = s.brand;
    if (typeof s.avoid === 'string') an.avoid = s.avoid;
    if (s.sel) an.sel = { title: Math.max(0, +s.sel.title || 0), mid: Math.max(0, +s.sel.mid || 0) };
    return !!s.result;
  } catch (e) { return false; }
}

/* ----- fields, counters, keywords ----- */
const anFieldKey = id => (id === 'mid' ? (an.store === 'ios' ? 'subtitle' : 'short') : id === 'kwf' ? 'keywords' : id);
const anFieldId = key => (key === 'subtitle' || key === 'short' ? 'mid' : key === 'keywords' ? 'kwf' : key);
const anLimitOf = (store, key) => AN_LIMITS[store][key];

function anCounterText(store, key, value) {
  const bytes = key === 'keywords', n = bytes ? anBytes(value) : anLen(value), lim = anLimitOf(store, key);
  return { n, lim, over: n > lim, text: `${n} / ${lim}${bytes ? ' bytes' : ''}${n > lim ? `, over by ${n - lim}` : ''}` };
}
function anUpdateCounters() {
  const store = an.store, f = an.fields[store];
  for (const key of Object.keys(f)) {
    const id = anFieldId(key), c = anCounterText(store, key, f[key]), el = $('#an-' + id + '-count');
    el.textContent = c.text; el.classList.toggle('over', c.over);
    $('#an-' + id + '-trim').hidden = !c.over;
  }
}
function anTrim(id) {
  const key = anFieldKey(id), f = an.fields[an.store], lim = anLimitOf(an.store, key);
  if (key === 'keywords') { const p = f.keywords.split(','); while (p.length && anBytes(p.join(',')) > lim) p.pop(); f.keywords = p.join(','); }
  else f[key] = [...f[key]].slice(0, lim).join('').trimEnd();
  anSyncFields(); anSave();
}
function anSyncFields() {
  const store = an.store, f = an.fields[store], ios = store === 'ios';
  $('#an-store-android').checked = !ios; $('#an-store-ios').checked = ios;
  $('#an-title').value = f.title; $('#an-mid').value = ios ? f.subtitle : f.short; $('#an-long').value = f.long;
  $('#an-kwf').value = ios ? f.keywords : '';
  $('#an-mid-label').textContent = ios ? 'Subtitle' : 'Short description';
  $('#an-kwf-wrap').hidden = !ios;
  $('#an-src').value = an.src[store];
  $('#an-src').placeholder = ios ? 'https://apps.apple.com/us/app/…/id123456789, or just the ID' : 'https://play.google.com/store/apps/details?id=…, or the package name';
  $('#an-country').value = an.country; $('#an-brand').value = an.brand; $('#an-avoid').value = an.avoid;
  const sel = state.app[store];
  $('#an-use-app').hidden = !sel; if (sel) $('#an-use-app').textContent = `Use ${sel.name && sel.name !== sel.id ? sel.name : 'selected app'}`;
  anUpdateCounters(); anRenderChips(); anMetricsNote();
  $('#an-results').hidden = !(an.last && an.last.store === store);
  $('#an-export-csv').hidden = $('#an-export-txt').hidden = $('#an-results').hidden;
}
function anRenderChips() {
  $('#an-chips').innerHTML = an.keywords.map((k, i) => `<span class="chip">${esc(k)} <button type="button" class="link x" data-i="${i}" aria-label="Remove ${esc(k)}">×</button></span>`).join('');
}
function anAddKeywords(text) {
  text.split(/[\n,]+/).map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean).forEach(k => {
    if (an.keywords.length < 50 && !an.keywords.some(x => x.toLowerCase() === k.toLowerCase())) an.keywords.push(k.slice(0, 100));
  });
  anRenderChips(); anMetricsNote(); anSave();
}
function anResearchKeywords() {
  const snap = anResearch(), out = [];
  if (snap) Object.values(snap.rows).sort((a, b) => {
    const o = r => Math.max(-1, ...['ios', 'android'].map(s => (r[s] && r[s].opp != null ? r[s].opp : -1)));
    return o(b) - o(a);
  }).forEach(r => out.push(r.kw));
  return out;
}
function anImportResearch() { anAddKeywords(anResearchKeywords().slice(0, 30).join(',')); }
function anImportRank() { anAddKeywords(state.keywords.join(',')); }
function anMetricsNote() {
  const snap = anResearch(), store = an.store, el = $('#an-metrics-note');
  let msg;
  if (!snap) msg = 'No Keyword research results yet. Popularity, difficulty and opportunity will show N/A until you run it.';
  else if (snap.country !== an.country) msg = `Your Keyword research ran for ${CNAME[snap.country] || snap.country}. Choose that country to use its metrics, or the columns show N/A.`;
  else if (!(snap.stores || []).includes(store)) msg = `Your Keyword research did not include the ${STORE_LABEL[store]}. Metrics show N/A.`;
  else { const n = an.keywords.filter(k => anMetrics(store, an.country, k)).length; msg = `Using Keyword research for ${STORE_LABEL[store]} in ${CNAME[an.country]}: metrics found for ${n} of ${an.keywords.length} keywords. Others show N/A.`; }
  el.textContent = msg;
}

/* ----- fetch a public listing ----- */
function anParseSource(text, dflt) {
  const t = String(text || '').trim();
  let store = null, id = '', country = null, m;
  if (/apps\.apple\.com|itunes\.apple\.com/i.test(t)) store = 'ios'; else if (/play\.google\.com|^market:\/\//i.test(t)) store = 'android';
  if ((store || dflt || an.store) === 'ios') { m = t.match(/\bid(\d{4,15})\b/) || t.match(/^(\d{4,15})$/); id = m ? m[1] : ''; const c = t.match(/apple\.com\/([a-z]{2})\//i); if (c && CNAME[c[1].toLowerCase()]) country = c[1].toLowerCase(); }
  else { m = t.match(/[?&]id=([A-Za-z]\w*(?:\.[A-Za-z_]\w*)+)/) || t.match(/^([A-Za-z]\w*(?:\.[A-Za-z_]\w*)+)$/); id = m ? m[1] : ''; const c = t.match(/[?&]gl=([a-z]{2})/i); if (c && CNAME[c[1].toLowerCase()]) country = c[1].toLowerCase(); }
  return { store, id, country };
}
const anListingBase = () => state.proxy.trim().replace(/\/+$/, '');
async function anLookupIos(id, country) {
  const data = await throttled('ios', () => jsonp(`https://itunes.apple.com/lookup?id=${id}&country=${country}`));
  const r = (data.results || [])[0];
  if (!r) throw new Error("App not found in that country's App Store");
  return { title: r.trackName || '', subtitle: null, description: r.description || '', developer: r.sellerName || '', icon: r.artworkUrl100 || '' };
}
function anHandleLink() {
  const raw = $('#an-src').value, st = $('#an-fetch-status'), p = anParseSource(raw);
  if (!p.id) { st.classList.add('err'); st.textContent = 'Could not find an app ID in that link.'; return; }
  if (p.store) an.store = p.store;
  if (p.country) an.country = p.country;
  an.src[an.store] = p.id; // trim the link down to the app ID or package name
  anSyncFields();
  anFetch();
}
async function anFetch() {
  const st = $('#an-fetch-status'), parsed = anParseSource($('#an-src').value);
  if (parsed.store && parsed.store !== an.store) { an.store = parsed.store; }
  if (parsed.country) an.country = parsed.country;
  const store = an.store; an.src[store] = $('#an-src').value.trim();
  if (!parsed.id) { anSyncFields(); st.textContent = `Paste a ${STORE_LABEL[store]} URL or ${store === 'ios' ? 'numeric app ID' : 'package name'}.`; st.classList.add('err'); return; }
  anSyncFields(); st.classList.remove('err'); st.innerHTML = '<span class="spinner" aria-hidden="true"></span> Fetching the public listing…';
  let L = null, err = null;
  if (anListingBase()) { try { L = (await api(`${anListingBase()}/api/listing?store=${store}&id=${encodeURIComponent(parsed.id)}&country=${an.country}`)).listing; } catch (e) { err = e; if (e.auth) { st.textContent = 'Access key required.'; return; } } }
  if (!L && store === 'ios') { try { L = await anLookupIos(parsed.id, an.country); err = null; } catch (e) { err = err || e; } }
  if (!L) { st.classList.add('err'); st.textContent = `Could not fetch the listing (${err ? err.message : 'no proxy set'}). Type or paste the text below instead.`; return; }
  const f = an.fields[store];
  f.title = L.title || f.title;
  if (store === 'ios') { if (L.subtitle) f.subtitle = L.subtitle; f.long = L.description || f.long; }
  else { f.short = L.short || f.short; f.long = L.description || f.long; }
  an.app[store] = { id: parsed.id, name: L.title || parsed.id, developer: L.developer || '' };
  const missing = store === 'ios' ? [!L.subtitle && 'the subtitle', 'the keyword field'].filter(Boolean) : [!L.short && 'the short description'].filter(Boolean);
  st.textContent = `Loaded “${L.title}”.` + (missing.length ? ` Not available publicly: ${missing.join(' and ')}. Type ${missing.length > 1 ? 'them' : 'it'} in below.` : '');
  anSyncFields(); anSave();
}

/* ----- rendering ----- */
const anMatchPill = (m, muted) => {
  const label = { exact: 'Exact', words: 'Words', partial: 'Partial', none: '—' }[m.type];
  const cls = muted ? (m.type === 'none' ? 'r-none' : 'r-low') : { exact: 'r-top', words: 'r-good', partial: 'r-mid', none: 'r-none' }[m.type];
  return `<span class="pill ${cls}"${m.type === 'partial' ? ` title="${m.present} of ${m.need} words"` : ''}>${label}</span>`;
};
const anNA = '<span class="pill r-none">N/A</span>';
const anPill = (v, cls) => (v == null ? anNA : `<span class="pill ${cls(v)}">${v}</span>`);

function anHighlight(text, rows, field) {
  const src = String(text || '');
  if (!src) return '<span class="hint">(empty)</span>';
  const strong = [], soft = [];
  const phrases = rows.filter(r => !r.avoided).map(r => ({ toks: anTok(r.kw), r })).filter(x => x.toks.length).sort((a, b) => b.toks.join(' ').length - a.toks.join(' ').length);
  const wre = w => anEscRe(w) + '(?:s|es)?';
  for (const { toks, r } of phrases) {
    const re = new RegExp('(?<![\\p{L}\\p{N}])' + toks.map(wre).join('[^\\p{L}\\p{N}]+') + '(?![\\p{L}\\p{N}])', 'giu');
    for (const m of src.matchAll(re)) strong.push([m.index, m.index + m[0].length]);
    const t = r.m[field] && r.m[field].type;
    if (t === 'words' || t === 'partial') for (const w of anContent(toks)) {
      if (w.length < 3) continue;
      const wr = new RegExp('(?<![\\p{L}\\p{N}])' + wre(w) + '(?![\\p{L}\\p{N}])', 'giu');
      for (const m of src.matchAll(wr)) soft.push([m.index, m.index + m[0].length]);
    }
  }
  const taken = [];
  const free = (a, b) => !taken.some(([x, y]) => a < y && b > x);
  const marks = [];
  for (const [a, b] of strong.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]))) if (free(a, b)) { taken.push([a, b]); marks.push([a, b, 'k']); }
  for (const [a, b] of soft) if (free(a, b)) { taken.push([a, b]); marks.push([a, b, 'soft']); }
  marks.sort((p, q) => p[0] - q[0]);
  let out = '', pos = 0;
  for (const [a, b, c] of marks) { out += esc(src.slice(pos, a)) + `<mark class="${c}">${esc(src.slice(a, b))}</mark>`; pos = b; }
  return out + esc(src.slice(pos));
}

function anScoreCard(A, A2) {
  const parts = A.parts.map(p => `<tr><td>${esc(p.label)}</td><td class="n">${p.pts == null ? 'N/A' : p.pts}</td><td class="n">${p.max}</td><td class="why">${esc(p.why)}</td></tr>`).join('');
  return `<section class="card"><div class="res-head"><h2>ASO optimization score</h2><span class="sum">Heuristic, not an official store score</span></div>
    <div class="score-row"><div class="score-num">${A.total ?? 'N/A'}${A.total == null ? '' : '<small> / 100</small>'}</div>
    <div class="score-meta"><div class="meter" role="img" aria-label="Score ${A.total ?? 'not available'} out of 100"><span style="width:${A.total || 0}%"></span></div>
    <p>${esc(A.band)}${A2.total != null ? `. The suggested copy below scores ${A2.total}.` : ''}</p></div></div>
    <div class="scroll"><table class="parts"><thead><tr><th scope="col">Component</th><th scope="col">Points</th><th scope="col">Max</th><th scope="col">Why</th></tr></thead><tbody>${parts}</tbody></table></div>
    <p class="hint">Rules are fixed and computed in your browser: keyword coverage 30, relevance 20, metadata limits 15, readability 15, repetition 20. Components without data show N/A and are left out of the total. Apple descriptions count toward readability only; keyword density in an Apple description is not treated as a search-ranking factor.</p></section>`;
}
function anFlagsCard(A) {
  if (!A.flags.length) return '<section class="card"><div class="res-head"><h2>Checks</h2></div><p class="hint" style="margin:0">No limit, wording or policy problems found.</p></section>';
  const icon = { error: 'Fix', warn: 'Check', info: 'Note' };
  return `<section class="card"><div class="res-head"><h2>Checks</h2></div><ul class="flags">${A.flags.map(f => `<li><span class="pill ${f.level === 'error' ? 'r-err-bg' : f.level === 'warn' ? 'r-mid' : 'r-low'}">${icon[f.level]}</span> ${esc(f.text)}</li>`).join('')}</ul></section>`;
}
function anTableCard(A) {
  const ios = A.store === 'ios';
  const head = ['Keyword', 'Popularity', 'Difficulty', 'Opportunity', 'Current rank', 'Title', ios ? 'Subtitle' : 'Short description', ...(ios ? ['Keyword field'] : []), ios ? 'Description (not indexed)' : 'Long description', 'Relevance', 'Recommendation'];
  const rows = [...A.rows].sort((a, b) => ((b.metrics && b.metrics.opp != null ? b.metrics.opp : -1) - (a.metrics && a.metrics.opp != null ? a.metrics.opp : -1)) || a.i - b.i).map(r => {
    const mt = r.metrics || {};
    const rank = !r.rank ? anNA : r.rank.rank == null ? `<span class="pill r-none" title="Not found in the results checked (${esc(r.rank.from)})">—</span>` : `<span class="pill ${r.rank.rank <= 3 ? 'r-top' : r.rank.rank <= 10 ? 'r-good' : r.rank.rank <= 50 ? 'r-mid' : 'r-low'}" title="${esc(r.rank.from)}">${r.rank.rank}</span>`;
    const longSub = r.m.long.count ? `<small class="tier">${r.m.long.count}×${r.density != null ? ' · ' + r.density.toFixed(1) + '%' : ''}</small>` : '';
    return `<tr><td title="${esc(r.kw)}">${esc(r.kw)}${r.highOpp ? ' <small class="tier">high opportunity</small>' : ''}</td>` +
      `<td>${anPill(mt.pop, popClass)}</td><td>${anPill(mt.difficulty, diffClass)}</td><td>${anPill(mt.opp, popClass)}</td><td>${rank}</td>` +
      `<td>${anMatchPill(r.m.title)}</td><td>${anMatchPill(r.m.mid)}</td>${ios ? `<td>${anMatchPill(r.m.kwf)}</td>` : ''}` +
      `<td>${anMatchPill(r.m.long, ios)}${longSub}</td><td><span class="rel rel-${r.rel.level}">${r.rel.level}</span></td><td class="rec">${esc(r.rec)}</td></tr>`;
  }).join('');
  const body = A.rows.length ? `<div class="scroll"><table class="kwt"><thead><tr>${head.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="hint" style="margin:0">Add keywords above to compare them with your listing.</p>';
  const hiNote = A.hiSet.size ? 'High opportunity means opportunity of 25 or more, or the top 3 if none reach 25.' : 'Run Keyword research for this store and country to find high-opportunity keywords.';
  return `<section class="card"><div class="res-head"><h2>Keyword comparison</h2><span class="sum">Exact = the phrase appears, Words = all words appear, Partial = some words</span></div>${body}<p class="hint">${hiNote} N/A means the value was not available, not zero. Current rank comes from your Rank check for the app selected there.${ios ? ' Apple does not use the description for search, so that column is shown for context only.' : ''}</p></section>`;
}
function anHighlightCard(A) {
  const ios = A.store === 'ios', f = A.f;
  const blocks = [['Title', f.title, 'title', 'title'], [ios ? 'Subtitle' : 'Short description', anMid(A.store, f), 'mid', ios ? 'subtitle' : 'short']];
  if (ios) blocks.push(['Keyword field', f.keywords, 'kwf', 'keywords']);
  blocks.push([ios ? 'Description' : 'Long description', f.long, 'long', 'long']);
  return `<section class="card"><div class="res-head"><h2>Keywords in your text</h2><span class="sum"><mark class="k">exact phrase</mark> <mark class="soft">some of the words</mark></span></div>` +
    blocks.map(([label, text, field, key]) => `<h3 class="hl-h">${label} <span class="counter${anCounterText(A.store, key, text).over ? ' over' : ''}">${anCounterText(A.store, key, text).text}</span></h3><div class="hl">${anHighlight(text, A.rows, field)}</div>`).join('') + '</section>';
}
function anStatsCard(A) {
  const rd = A.longStats, ios = A.store === 'ios';
  const read = rd.empty ? '<li>No description to analyze.</li>' : `<li>${rd.words} words, ${rd.sentences} sentences, ${rd.avgSentence.toFixed(1)} words per sentence</li><li>Flesch reading ease: ${rd.flesch == null ? 'N/A (English text of 30+ words needed)' : `${rd.flesch} (${rd.band})`}</li><li>${rd.paragraphs} paragraphs, ${rd.bullets} bullet lines</li>`;
  const rep = A.rep, top = (rep.top || []).map(x => `${esc(x.w)} ×${x.c} (${x.d.toFixed(1)}%)`).join(', ');
  const repLines = [top ? `<li>Most repeated words: ${top}</li>` : '<li>No word is repeated 6 or more times.</li>'];
  if (ios) repLines.push(rep.dups && rep.dups.length ? `<li>Repeated across title, subtitle and keyword field: ${rep.dups.map(d => `${esc(d.w)} (${d.in.join(', ')})`).join('; ')}</li>` : '<li>No words are repeated across title, subtitle and keyword field.</li>');
  return `<section class="card"><div class="res-head"><h2>Readability and repetition</h2>${ios ? '<span class="sum">Apple description: conversion copy, not a ranking factor</span>' : ''}</div><ul class="stats">${read}${repLines.join('')}</ul></section>`;
}
function anOptRows(name, items, sel, store, key) {
  if (!items.length) return '<p class="hint" style="margin:0">Add relevant keywords (and a brand name) to generate options.</p>';
  return items.map((t, i) => { const c = anCounterText(store, key, t); return `<div class="opt-row"><label class="opt-pick"><input type="radio" name="${name}" value="${i}"${i === sel ? ' checked' : ''}><span class="opt-text">${esc(t)}</span></label><span class="counter${c.over ? ' over' : ''}">${c.text}</span><button type="button" class="link copy" data-copy="${esc(t)}">Copy</button></div>`; }).join('');
}
function anOptionsCard(A, G) {
  const ios = A.store === 'ios', midKey = ios ? 'subtitle' : 'short';
  let html = `<section class="card"><div class="res-head"><h2>Suggested copy</h2><span class="sum">Built only from your own wording and keywords. Review before using.</span></div>`;
  html += `<h3 class="hl-h">Title options <span class="sum">brand kept: ${esc(G.brand || 'N/A')}</span></h3>${anOptRows('an-sel-title', G.titles, G.ti, A.store, 'title')}`;
  html += `<h3 class="hl-h">${ios ? 'Subtitle' : 'Short description'} options</h3>${anOptRows('an-sel-mid', G.mids, G.mi, A.store, midKey)}`;
  if (ios) { const c = anCounterText('ios', 'keywords', G.kwfield || ''); html += `<h3 class="hl-h">Keyword field <span class="sum">no spaces, words already in the title and subtitle left out</span></h3>` + (G.kwfield ? `<div class="opt-row"><span class="opt-text mono">${esc(G.kwfield)}</span><span class="counter${c.over ? ' over' : ''}">${c.text}</span><button type="button" class="link copy" data-copy="${esc(G.kwfield)}">Copy</button></div>` : '<p class="hint" style="margin:0">No relevant keywords to add.</p>'); }
  const lc = anCounterText(A.store, 'long', G.long.text);
  html += `<h3 class="hl-h">Improved ${ios ? 'description' : 'long description'} <span class="counter${lc.over ? ' over' : ''}">${lc.text}</span> <button type="button" class="link copy" data-copy-from="#an-long-out">Copy</button></h3>` +
    (G.long.text ? `<textarea id="an-long-out" rows="12" readonly aria-label="Improved description">${esc(G.long.text)}</textarea>` : '<p class="hint" style="margin:0">Add a description so it can be restructured.</p>');
  return html + '</section>';
}
function anBaCard(A, G, A2) {
  const ios = A.store === 'ios', f = A.f, g = G.after;
  const fields = [['Title', 'title', f.title, g.title]];
  fields.push([ios ? 'Subtitle' : 'Short description', ios ? 'subtitle' : 'short', anMid(A.store, f), anMid(A.store, g)]);
  if (ios) fields.push(['Keyword field', 'keywords', f.keywords, g.keywords]);
  const col = (label, store, key, text, cls) => { const c = anCounterText(store, key, text); return `<div class="ba-col ${cls}"><h4>${label}</h4><p class="ba-text">${text ? esc(text) : '<span class="hint">(empty)</span>'}</p><span class="counter${c.over ? ' over' : ''}">${c.text}</span></div>`; };
  const pairs = fields.map(([label, key, b, a]) => `<h3 class="hl-h">${label}</h3><div class="ba">${col('Before', A.store, key, b, 'before')}${col('After', A.store, key, a, 'after')}</div>`).join('');
  const newly = A2.rows.filter((r, i) => r.covered && !A.rows[i].covered && r.rel.level !== 'Low').map(r => r.kw);
  const pct = v => (v == null ? 'N/A' : Math.round(v * 100) + '%');
  const sum = `<ul class="stats"><li>Score: <strong>${A.total ?? 'N/A'}</strong> → <strong>${A2.total ?? 'N/A'}</strong> (heuristic)</li><li>Weighted keyword coverage: <strong>${pct(A.coverage)}</strong> → <strong>${pct(A2.coverage)}</strong></li><li>Relevant keywords covered: <strong>${A.coveredCount}</strong> → <strong>${A2.coveredCount}</strong> of ${A.considered.length}</li>${newly.length ? `<li>Newly covered: ${newly.map(esc).join(', ')}</li>` : ''}</ul>`;
  const longBa = `<details class="adv"><summary>${ios ? 'Description' : 'Long description'}: before and after</summary><div class="inner"><div class="ba">${col('Before', A.store, 'long', f.long, 'before').replace('ba-text"', 'ba-text long"')}${col('After', A.store, 'long', g.long, 'after').replace('ba-text"', 'ba-text long"')}</div></div></details>`;
  return `<section class="card"><div class="res-head"><h2>Before and after</h2><span class="sum">After uses the options selected above</span></div>${sum}${pairs}${longBa}</section>`;
}
function anRender() {
  const L = an.last, box = $('#an-results');
  if (!L) { box.innerHTML = ''; return; }
  box.innerHTML = [anScoreCard(L.A, L.A2), anFlagsCard(L.A), anTableCard(L.A), anHighlightCard(L.A), anStatsCard(L.A), anOptionsCard(L.A, L.G), anBaCard(L.A, L.G, L.A2)].join('');
  box.hidden = L.store !== an.store;
  $('#an-export-csv').hidden = $('#an-export-txt').hidden = box.hidden;
}

/* ----- run ----- */
function anRun(quiet) {
  const store = an.store, f = an.fields[store], st = $('#an-status');
  if (![f.title, anMid(store, f), f.long].some(v => String(v || '').trim())) { st.textContent = 'Add some listing text first (fetch a listing or type it in).'; st.classList.add('err'); return; }
  st.classList.remove('err');
  const kwRows = anKeywordRows(store, an.country);
  const A = anAnalyze(store, f, kwRows), G = anGenerate(store, A), A2 = anAnalyze(store, G.after, kwRows);
  an.last = { store, country: an.country, at: new Date().toISOString(), A, G, A2 };
  anRender(); anSave();
  if (!quiet) st.textContent = `Analyzed ${kwRows.length} keywords. Heuristic score ${A.total ?? 'N/A'}${A2.total != null ? `, ${A2.total} with the suggested copy` : ''}.`;
}

/* ----- copy and export ----- */
async function anCopy(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e2) { /* ignore */ } ta.remove(); }
  const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = old; }, 1500);
}
function anDownload(name, mime, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const anCsv = rows => rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
function anExportCsv() {
  const L = an.last; if (!L) return;
  const { A, G, A2 } = L, ios = A.store === 'ios', n = v => (v == null ? 'N/A' : v);
  const head = ['store', 'country', 'keyword', 'popularity', 'difficulty', 'opportunity', 'current_rank', 'title_match', ios ? 'subtitle_match' : 'short_description_match', ...(ios ? ['keyword_field_match'] : []), 'description_match', 'description_frequency', 'relevance', 'recommendation'];
  const rows = [head, ...A.rows.map(r => [STORE_LABEL[A.store], L.country.toUpperCase(), r.kw, n(r.metrics && r.metrics.pop), n(r.metrics && r.metrics.difficulty), n(r.metrics && r.metrics.opp), r.rank ? (r.rank.rank == null ? 'not found' : r.rank.rank) : 'N/A', r.m.title.type, r.m.mid.type, ...(ios ? [r.m.kwf.type] : []), r.m.long.type, r.m.long.count, r.rel.level, r.rec])];
  const f = A.f, g = G.after, lim = AN_LIMITS[A.store];
  const fl = [['field', 'before', 'after', 'before_count', 'after_count', 'limit'], ['title', f.title, g.title, anLen(f.title), anLen(g.title), lim.title], [ios ? 'subtitle' : 'short_description', anMid(A.store, f), anMid(A.store, g), anLen(anMid(A.store, f)), anLen(anMid(A.store, g)), ios ? lim.subtitle : lim.short]];
  if (ios) fl.push(['keyword_field_bytes', f.keywords, g.keywords, anBytes(f.keywords), anBytes(g.keywords), lim.keywords]);
  fl.push(['description', f.long, g.long, anLen(f.long), anLen(g.long), lim.long]);
  const sc = [['component', 'points', 'max', 'why'], ...A.parts.map(p => [p.label, n(p.pts), p.max, p.why]), ['TOTAL (heuristic, not an official store score)', n(A.total), 100, 'after suggested copy: ' + n(A2.total)]];
  anDownload(`aso-analysis-${A.store}-${L.country}.csv`, 'text/csv', [anCsv(rows), anCsv(fl), anCsv(sc)].join('\n\n'));
}
function anExportTxt() {
  const L = an.last; if (!L) return;
  const { A, G, A2 } = L, ios = A.store === 'ios', f = A.f, g = G.after, n = v => (v == null ? 'N/A' : v);
  const out = [`ASO LISTING ANALYSIS`, `${STORE_LABEL[A.store]}, ${CNAME[L.country]}, ${L.at.slice(0, 10)}`, '',
    `Heuristic score (not an official store score): ${n(A.total)} / 100 (${A.band}). With suggested copy: ${n(A2.total)}`, ...A.parts.map(p => `  - ${p.label}: ${n(p.pts)} / ${p.max}. ${p.why}`), '', 'CHECKS', ...(A.flags.length ? A.flags.map(x => `  - [${x.level}] ${x.text}`) : ['  - none']), '',
    'KEYWORDS (popularity / difficulty / opportunity / rank / title / ' + (ios ? 'subtitle / keyword field' : 'short') + ' / description / relevance)',
    ...A.rows.map(r => `  - ${r.kw}: ${n(r.metrics && r.metrics.pop)} / ${n(r.metrics && r.metrics.difficulty)} / ${n(r.metrics && r.metrics.opp)} / ${r.rank ? (r.rank.rank == null ? 'not found' : r.rank.rank) : 'N/A'} / ${r.m.title.type} / ${r.m.mid.type}${ios ? ' / ' + r.m.kwf.type : ''} / ${r.m.long.type} / ${r.rel.level}. ${r.rec}`), '',
    'BEFORE', `Title (${anLen(f.title)}/${AN_LIMITS[A.store].title}): ${f.title}`, `${ios ? 'Subtitle' : 'Short description'} (${anLen(anMid(A.store, f))}/${ios ? AN_LIMITS.ios.subtitle : AN_LIMITS.android.short}): ${anMid(A.store, f)}`,
    ...(ios ? [`Keyword field (${anBytes(f.keywords)}/100 bytes): ${f.keywords}`] : []), `Description (${anLen(f.long)}/4000):`, f.long, '',
    'AFTER (selected options)', `Title (${anLen(g.title)}/30): ${g.title}`, `${ios ? 'Subtitle' : 'Short description'} (${anLen(anMid(A.store, g))}/${ios ? 30 : 80}): ${anMid(A.store, g)}`,
    ...(ios ? [`Keyword field (${anBytes(g.keywords)}/100 bytes): ${g.keywords}`] : []), `Description (${anLen(g.long)}/4000):`, g.long, '',
    'ALL TITLE OPTIONS', ...G.titles.map((t, i) => `  ${i + 1}. ${t} (${anLen(t)}/30)`), `ALL ${ios ? 'SUBTITLE' : 'SHORT DESCRIPTION'} OPTIONS`, ...G.mids.map((t, i) => `  ${i + 1}. ${t} (${anLen(t)})`)];
  anDownload(`aso-analysis-${A.store}-${L.country}.txt`, 'text/plain', out.join('\n'));
}

/* ----- wiring ----- */
function anOnShow() {
  if (!an.keywords.length) { const k = [...anResearchKeywords(), ...state.keywords]; if (k.length) anAddKeywords(k.slice(0, 30).join(',')); }
  if (!an.app[an.store] && state.app[an.store]) { /* the quick button is enough; nothing is changed silently */ }
  anMetricsNote();
}
function initAnalyzer() {
  const restored = anLoad();
  $('#an-country').innerHTML = COUNTRIES.map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join('');
  if (!localStorage.getItem(AN_KEY)) { const snap = anResearch(); an.country = snap && snap.country ? snap.country : firstCountry(); }
  anSyncFields();
  document.querySelectorAll('input[name="an-store"]').forEach(r => r.addEventListener('change', e => { an.store = e.target.value; anSyncFields(); anSave(); }));
  $('#an-country').addEventListener('change', e => { an.country = e.target.value; anMetricsNote(); anSave(); if (an.last) anRun(true); });
  for (const id of ['title', 'mid', 'kwf', 'long']) $('#an-' + id).addEventListener('input', e => { an.fields[an.store][anFieldKey(id)] = e.target.value; anUpdateCounters(); anSave(); });
  document.querySelectorAll('[data-trim]').forEach(b => b.addEventListener('click', () => anTrim(b.dataset.trim)));
  $('#an-src').addEventListener('input', e => {
    const typed = /^(insertText|delete)/.test(e.inputType || '');
    if (isStoreLink(e.target.value) && !typed) { anHandleLink(); return; } // typed links are handled on "change"
    an.src[an.store] = e.target.value; anSave();
  });
  $('#an-src').addEventListener('change', () => { if (isStoreLink($('#an-src').value)) anHandleLink(); });
  $('#an-src').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); anFetch(); } });
  $('#an-fetch').addEventListener('click', anFetch);
  $('#an-use-app').addEventListener('click', () => { const a = state.app[an.store]; if (a) { $('#an-src').value = a.id; an.src[an.store] = a.id; anFetch(); } });
  const kw = $('#an-kw-input');
  kw.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); anAddKeywords(kw.value); kw.value = ''; } });
  kw.addEventListener('blur', () => { if (kw.value.trim()) { anAddKeywords(kw.value); kw.value = ''; } });
  kw.addEventListener('paste', e => { const t = (e.clipboardData || window.clipboardData).getData('text'); if (/[\n,]/.test(t)) { e.preventDefault(); anAddKeywords(t); } });
  $('#an-chips').addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (!b) return; an.keywords.splice(Number(b.dataset.i), 1); anRenderChips(); anMetricsNote(); anSave(); });
  $('#an-import-research').addEventListener('click', anImportResearch);
  $('#an-import-rank').addEventListener('click', anImportRank);
  $('#an-brand').addEventListener('input', e => { an.brand = e.target.value; anSave(); });
  $('#an-avoid').addEventListener('input', e => { an.avoid = e.target.value; anSave(); });
  $('#an-run').addEventListener('click', () => anRun(false));
  $('#an-export-csv').addEventListener('click', anExportCsv);
  $('#an-export-txt').addEventListener('click', anExportTxt);
  $('#an-results').addEventListener('click', e => { const b = e.target.closest('button.copy'); if (!b) return; const src = b.dataset.copyFrom ? $(b.dataset.copyFrom) : null; anCopy(src ? src.value : b.dataset.copy, b); });
  $('#an-results').addEventListener('change', e => {
    const r = e.target.closest('input[type=radio]'); if (!r) return;
    if (r.name === 'an-sel-title') { an.sel.title = Number(r.value); an.sel.mid = 0; } else if (r.name === 'an-sel-mid') an.sel.mid = Number(r.value);
    anRun(true);
  });
  if (restored && an.fields[an.store] && (an.fields[an.store].title || an.fields[an.store].long)) anRun(true);
}
if (window.RC_TEST) window.__aso = { an, anAnalyze, anGenerate, anParse, anMatch, anKeywordRows, anTitleOptions, anMidOptions, anKeywordField, anReadability, anBytes, anLen, anRun, anHighlight, AN_LIMITS, anExportCsv, anExportTxt, anSave, anLoad, anCounterText };

/* ---------- theme ---------- */
function initTheme() {
  const root = document.documentElement, btn = $('#theme'), modes = ['auto', 'light', 'dark'];
  const names = { auto: 'automatic', light: 'light', dark: 'dark' };
  let mode = 'auto';
  try { const t = localStorage.getItem('rc_theme'); if (modes.includes(t)) mode = t; } catch (e) { /* ignore */ }
  const apply = () => {
    if (mode === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode);
    btn.dataset.mode = mode;
    btn.setAttribute('aria-label', `Theme: ${names[mode]}. Click to change.`);
    btn.title = `Theme: ${names[mode]}`;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--surface').trim() || '#ffffff');
  };
  btn.addEventListener('click', () => {
    mode = modes[(modes.indexOf(mode) + 1) % modes.length];
    try { localStorage.setItem('rc_theme', mode); } catch (e) { /* ignore */ }
    apply();
  });
  if (window.matchMedia) { const mq = window.matchMedia('(prefers-color-scheme: dark)'); (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(apply); }
  apply();
}

/* ---------- wiring ---------- */
function initRank() {
  setupPicker('ios'); setupPicker('android');
  for (const s of ['ios', 'android']) { pickers[s].render(); $('#st-' + s).addEventListener('change', e => { state.stores[s] = e.target.checked; applyStores(); saveSettings(); }); }
  $('#proxy').value = state.proxy;
  $('#proxy').addEventListener('change', e => { state.proxy = e.target.value.trim(); saveSettings(); updatePlayHint(); });
  applyStores(); renderKeywords(); renderCountries();

  const kw = $('#kw-input');
  kw.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addKeywords(kw.value); kw.value = ''; } });
  kw.addEventListener('blur', () => { if (kw.value.trim()) { addKeywords(kw.value); kw.value = ''; } });
  kw.addEventListener('paste', e => { const t = (e.clipboardData || window.clipboardData).getData('text'); if (/[\n,]/.test(t)) { e.preventDefault(); addKeywords(t); } });
  $('#kw-chips').addEventListener('click', e => {
    const b = e.target.closest('button[data-i]'); if (!b) return;
    state.keywords.splice(Number(b.dataset.i), 1); renderKeywords(); saveSettings();
  });

  $('#c-filter').addEventListener('input', renderCountries);
  $('#c-grid').addEventListener('click', e => {
    const b = e.target.closest('button[data-c]'); if (!b) return;
    const c = b.dataset.c; state.countries.has(c) ? state.countries.delete(c) : state.countries.add(c);
    renderCountries(); saveSettings();
  });
  document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
    state.countries = new Set(b.dataset.preset === 'clear' ? [] : PRESETS[b.dataset.preset]);
    renderCountries(); saveSettings();
  }));
  ['ios', 'android'].forEach(s => $('#depth-' + s).addEventListener('change', saveSettings));

  $('#run').addEventListener('click', run);
  $('#stop').addEventListener('click', () => { state.stop = true; setStatus('Stopping after the current check…'); });
  $('#export').addEventListener('click', exportCsv);
  $('#results').addEventListener('click', e => {
    const b = e.target.closest('button.cell'); if (!b) return;
    showDetail(b.closest('section').dataset.store, b.dataset.k);
  });
}

function init() {
  initTheme();
  loadSettings();
  if (PAGE === 'rank') initRank();
  if (PAGE === 'research') initResearch();
  if (PAGE === 'analyzer') { initAnalyzer(); anOnShow(); }
  updatePlayHint();
  $('#key-save').addEventListener('click', () => {
    try { localStorage.setItem('rc_key', $('#key').value); } catch (e) { /* ignore */ }
    $('#auth').hidden = true; setStatus('Access key saved. Try again.');
  });

  // Served by server.py? Then it doubles as the Google Play proxy. On GitHub Pages this request 404s.
  fetch('/api/config').then(r => { if (!r.ok) throw new Error('no server'); return r.json(); })
    .then(c => { if (typeof c.auth_required !== 'boolean') throw new Error('not ours'); state.sameOrigin = true; if (c.auth_required && !localStorage.getItem('rc_key')) $('#auth').hidden = false; updatePlayHint(); })
    .catch(() => {});
}
init();
})();
