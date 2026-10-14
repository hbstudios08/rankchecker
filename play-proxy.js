// Cloudflare Worker: tiny Google Play search proxy for the Rank Checker page.
//
// GitHub Pages can't talk to Google Play from the browser (no CORS, no API), so this Worker
// fetches Play's search page and returns the results as JSON:
//     GET /api/search?q=bhabhi&country=pk&limit=50   ->   { "items": [ {id, name, developer, icon}, ... ] }
//
// It is a port of what the Python `google-play-scraper` package does for `search()`, so it reads
// the first page of results only (usually 20-30 apps) and can break if Google changes its page format.
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
    });
  }
  const count = Math.min(rows.length, limit) - items.length; // same arithmetic as google-play-scraper
  for (let i = 0; i < count && i < rows.length; i++) {
    const row = rows[i];
    items.push({
      id: at(row, [0, 0, 0]), name: at(row, [0, 3]),
      developer: at(row, [0, 14]), icon: at(row, [0, 1, 3, 2]),
    });
  }
  return {
    ok: true,
    items: items.filter(x => x.id).map(x => ({ id: x.id, name: x.name || "", developer: x.developer || "", icon: x.icon || "" })),
  };
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
