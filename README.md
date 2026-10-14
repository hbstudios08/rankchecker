# Rank Checker

- `docs/index.html` is the whole website: one static file, no build step. It can be hosted on GitHub Pages.
- `worker/play-proxy.js` is an optional free Cloudflare Worker that lets the page check **Google Play** and read autocomplete suggestions for keyword research (see below).
- `server.py` runs the same page locally with a built-in Google Play proxy, no Cloudflare needed.
- `rank_tracker.py` is the headless daily tracker (CSV history + `report.html`).

## How it works on GitHub Pages

| Store | How the page gets results | Needs a proxy? |
|---|---|---|
| App Store | Calls Apple's public iTunes Search API straight from the visitor's browser (JSONP). Uses their own connection and rate limit. | No |
| Google Play | Google has no browser-friendly API, so the page asks a small proxy that fetches Play search results. | Yes |

Without a proxy the page still works for the App Store; the Google Play checkbox shows a hint and Play checks are blocked until a proxy URL is set under **Advanced**.

## 1. Publish the page
**Own repo:** push this folder, then Settings > Pages > Deploy from branch > `main` / `/docs`.
**Existing site repo:** copy `docs/index.html` to e.g. `rank/index.html` and it appears at `/rank/`. The page has `noindex`, so search engines will skip it.

## 2. Google Play proxy (optional, free)
1. Cloudflare dashboard > Workers & Pages > Create > Worker. Paste in `worker/play-proxy.js` and deploy. (Or `npx wrangler deploy` from the `worker` folder.)
2. Worker > Settings > Variables: set `ALLOWED_ORIGIN` to your site (e.g. `https://yourname.github.io`) and, optionally, a secret `ACCESS_KEY`.
3. On the page: Advanced > paste the Worker URL (`https://rank-proxy.<you>.workers.dev`). If you set a key, the page asks for it once.

Alternative: run `python server.py` somewhere reachable (it exposes the same `/api/search`) and paste its URL instead.

## Run locally instead
```
pip install -r requirements.txt
python server.py        # http://127.0.0.1:5000  (serves docs/index.html and proxies Google Play itself)
```
Env vars: `HOST`, `PORT`, `ACCESS_KEY`, `ALLOWED_ORIGIN`, `IOS_DELAY`, `PLAY_DELAY`.

## Keyword research tab
Enter seed keywords, pick a country and store(s), and click **Research keywords**. For each keyword you get:

- **Popularity (0 to 100, estimated):** how early the keyword appears in the store's own search suggestions (it is tried after 3, 5, 8, ... typed characters). Earlier and higher in the list means a stronger signal. Tiers: 80+ very high, 60+ high, 40+ medium, 20+ low.
- **Difficulty (0 to 100):** how large the top 5 apps are (ratings on the App Store, installs on Google Play) plus how many of the top 10 titles contain the keyword.
- **Opportunity:** popularity x (100 - difficulty) / 100. Sort by it to find keywords with demand and weak competition.
- **Suggested keywords:** with "Also research suggested keywords" on, the store's autocomplete suggestions for each seed are added and scored too (up to 30 keywords total).
- **+ track** adds a keyword to the Rank check tab, and **Export CSV** saves the table.

**What this is not:** there is no free public source of real search volume. Apple's popularity scores come from Apple Ads, and Google Play has no equivalent. The popularity here is an estimate, not a monthly search count. If you have Apple's real 5 to 100 scores (from Apple Ads or an ASO tool), paste them under *Real Apple popularity scores* and they replace the estimate for App Store keywords. For your own Play listing, the real search-term data is in Play Console under store listing acquisition.

**Needs the proxy:** suggestions and all Google Play data go through the proxy (Worker or `server.py`). Without it you still get App Store difficulty, but popularity shows n/a. The suggestion endpoints are unofficial and unverified against the live stores, so they can break; failures show as n/a or ! with the reason on hover.

## Using the Rank check tab
Pick the store(s), search for your app by name (or paste the Apple ID / package name), add keywords, choose countries, click **Check ranks**. You get a keyword by country grid per store; click a cell to see the top 5 apps for that keyword. Changes since your last check show as ▲/▼/new/lost, and settings and history live in your browser. Export CSV after a run.

## Limits to know about
- App Store results come from Apple's official search API. They closely match real results but ignore ads and personalization, so treat them as a trend.
- Apple allows roughly 20 searches a minute, so each check takes about 3 seconds. The page shows an estimate before you start.
- Google Play returns only the first page of results (about 20 to 30 apps), however deep you ask. A dash means "not on the first page".
- The Play proxy and the suggestion endpoints read unofficial store interfaces and can break if Google changes it, or fail if Google asks the Worker's location for cookie consent. The page shows the error in that cell.
- Rank history lives in each browser. For unattended daily history use `rank_tracker.py` with the included GitHub Actions workflow (private repo).
