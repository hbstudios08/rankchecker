// Cloudflare Worker: tiny Google Play search proxy for the Rank Checker page.
//
// GitHub Pages can't talk to Google Play from the browser (no CORS, no API), so this Worker
// fetches Play's search page and returns the results as JSON:
//     GET /api/search?q=bhabhi&country=pk&limit=50   ->   { "items": [ {id, name, developer, icon}, ... ] }
//
// It is a port of what the Python `google-play-scraper` package does for `search()`, so it reads
// the first page of results only (usually 20-30 apps) and can break if Google changes its page format.
//
// Keyword research also uses:
//     GET /api/suggest?store=ios|android&q=bha&country=pk   ->   { "items": ["bhabhi card game", ...] }
// which reads Apple's and Google Play's search autocomplete. Both are unofficial endpoints.
//
// Settings (Worker > Settings > Variables):
//   ALLOWED_ORIGIN  your site's origin, e.g. https://thulla.online  (default: * = any site)
//   ACCESS_KEY      optional secret; the page asks for it once and sends it as X-Access-Key

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function at(obj, path) {
  try {
    let v = obj;
    for (const i of path) v = v[i];
    return v ?? null;
  } catch (e) {
    return null;
  }
}

// Returns { ok, items }. ok=false means the page did not contain the expected data block.
function parsePlaySearch(html, limit) {
  const dataset = {};
  for (const block of html.match(/AF_initDataCallback[\s\S]*?<\/script/g) || []) {
    const key = block.match(/(ds:.*?)'/);
    const val = block.match(/data:([\s\S]*?), sideChannel: \{\}\}\);<\//);
    if (key && val) {
      try { dataset[key[1]] = JSON.parse(val[1]); } catch (e) { /* skip unparsable block */ }
    }
  }
  const ds4 = dataset["ds:4"];
  const groups = at(ds4, [0, 1]);
  if (!Array.isArray(groups)) return { ok: false, items: [] };

  const topRaw = at(groups, [0, 23, 16]);
  let rows = null;
  for (let i = 0; i < groups.length; i++) {
    const r = at(groups, [i, 22, 0]);
    if (Array.isArray(r)) { rows = r; break; }
  }
  if (!rows) return { ok: true, items: [] };

  const items = [];
  if (topRaw) {
    items.push({
      id: at(topRaw, [11, 0, 0]), name: at(topRaw, [2, 0, 0]),
      developer: at(topRaw, [2, 68, 0]), icon: at(topRaw, [2, 95, 0, 3, 2]),
      installs: at(topRaw, [2, 13, 0]), score: at(topRaw, [2, 51, 0, 1]),
    });
  }
  const count = Math.min(rows.length, limit) - items.length; // same arithmetic as google-play-scraper
  for (let i = 0; i < count && i < rows.length; i++) {
    const row = rows[i];
    items.push({
      id: at(row, [0, 0, 0]), name: at(row, [0, 3]),
      developer: at(row, [0, 14]), icon: at(row, [0, 1, 3, 2]),
      installs: at(row, [0, 15]), score: at(row, [0, 4, 1]),
    });
  }
  return {
    ok: true,
    items: items.filter(x => x.id).map(x => ({
      id: x.id, name: x.name || "", developer: x.developer || "", icon: x.icon || "",
      installs: x.installs || "", score: x.score || 0,
    })),
  };
}

// Apple storefront IDs, used to ask the App Store's autocomplete for a specific country.
const APPLE_STOREFRONTS = {
  us: 143441, gb: 143444, ca: 143455, au: 143460, nz: 143461, ie: 143449, in: 143467, pk: 143477,
  bd: 143490, lk: 143486, np: 143484, ae: 143481, sa: 143479, qa: 143498, kw: 143493, om: 143514,
  bh: 143559, de: 143443, fr: 143442, it: 143450, es: 143454, nl: 143452, se: 143456, no: 143457,
  dk: 143458, tr: 143480, id: 143476, my: 143473, sg: 143464, ph: 143474, th: 143475, vn: 143471,
  jp: 143462, kr: 143466, za: 143472, ng: 143561, ke: 143529, eg: 143516, br: 143503, mx: 143468, ar: 143505,
};

function xmlUnescape(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&");
}

// App Store hints come back as an Apple plist (XML); every <key>term</key> is one suggestion, best first.
function parseAppleHints(xml) {
  const out = [];
  for (const m of xml.matchAll(/<key>term<\/key>\s*<string>([\s\S]*?)<\/string>/g)) out.push(xmlUnescape(m[1]).trim());
  return [...new Set(out.filter(Boolean))];
}

// Play suggestions come back as a batchexecute response; find the line holding the IJ4APc payload.
function parsePlaySuggest(text) {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("[")) continue;
    let outer;
    try { outer = JSON.parse(t); } catch (e) { continue; }
    const payload = at(outer, [0, 2]);
    if (typeof payload !== "string") continue;
    let data;
    try { data = JSON.parse(payload); } catch (e) { continue; }
    const list = at(data, [0, 0]);
    if (Array.isArray(list)) return list.map(x => (Array.isArray(x) ? x[0] : null)).filter(x => typeof x === "string" && x);
  }
  return [];
}

async function suggest(store, q, country) {
  if (store === "ios") {
    const sf = APPLE_STOREFRONTS[country] || 143441;
    const r = await fetch(
      `https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&term=${encodeURIComponent(q)}`,
      { headers: { "User-Agent": UA, "X-Apple-Store-Front": `${sf}-1,29` } });
    if (!r.ok) throw new Error(`App Store suggestions returned HTTP ${r.status}`);
    return parseAppleHints(await r.text());
  }
  const payload = JSON.stringify([[null, [q], [10], [2], 4]]);
  const body = "f.req=" + encodeURIComponent(JSON.stringify([[["IJ4APc", payload]]]));
  const r = await fetch(
    `https://play.google.com/_/PlayStoreUi/data/batchexecute?rpcids=IJ4APc&f.sid=-697906427155521722&bl=boq_playuiserver_20190903.08_p0&hl=en&gl=${country}&authuser&soc-app=121&soc-platform=1&soc-device=1&_reqid=1065213`,
    { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": UA, "Cookie": "CONSENT=YES+" } });
  if (!r.ok) throw new Error(`Google Play suggestions returned HTTP ${r.status}`);
  return parsePlaySuggest(await r.text());
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "X-Access-Key",
      "Vary": "Origin",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (env.ACCESS_KEY && request.headers.get("X-Access-Key") !== env.ACCESS_KEY) {
      return json({ error: "Access key required" }, 401);
    }

    const url = new URL(request.url);
    if (url.pathname === "/api/suggest") {
      const sq = (url.searchParams.get("q") || "").trim();
      const sc = (url.searchParams.get("country") || "us").toLowerCase();
      const store = url.searchParams.get("store");
      if (store !== "ios" && store !== "android") return json({ error: "store must be ios or android" }, 400);
      if (sq.length < 1 || sq.length > 100) return json({ error: "query must be 1-100 characters" }, 400);
      if (!/^[a-z]{2}$/.test(sc)) return json({ error: "invalid country" }, 400);
      try {
        return json({ items: await suggest(store, sq, sc) });
      } catch (e) {
        return json({ error: e.message || "Suggestions failed" }, 502);
      }
    }
    if (url.pathname !== "/api/search") return json({ error: "Not found" }, 404);

    const q = (url.searchParams.get("q") || "").trim();
    const country = (url.searchParams.get("country") || "us").toLowerCase();
    const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 100));
    if (q.length < 2 || q.length > 100) return json({ error: "query must be 2-100 characters" }, 400);
    if (!/^[a-z]{2}$/.test(country)) return json({ error: "invalid country" }, 400);

    const target = `https://play.google.com/store/search?q=${encodeURIComponent(q)}&c=apps&hl=en&gl=${country}`;
    let res;
    try {
      res = await fetch(target, { headers: { "User-Agent": UA, "Accept-Language": "en", "Cookie": "CONSENT=YES+" } });
    } catch (e) {
      return json({ error: "Could not reach Google Play" }, 502);
    }
    if (res.url.includes("consent.google.")) {
      return json({ error: "Google Play asked for cookie consent from the proxy's location" }, 502);
    }
    if (!res.ok) return json({ error: `Google Play returned HTTP ${res.status}` }, 502);

    const parsed = parsePlaySearch(await res.text(), limit);
    if (!parsed.ok) return json({ error: "Could not read Google Play results (page format may have changed)" }, 502);
    return json({ items: parsed.items });
  },
};
