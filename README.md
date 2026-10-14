# Rank Checker

Two ways to use the same idea:

1. **Web UI** (`server.py` + `static/index.html`): pick the store(s), find your app by name, add keywords, choose countries, and click Check ranks.
2. **Scheduled tracker** (`rank_tracker.py`): headless daily run that stores history in CSV and builds `report.html`.

## Web UI

```
pip install -r requirements.txt
python server.py
```
Open http://127.0.0.1:5000

- **Stores:** App Store, Google Play, or both. Each shows its own app picker.
- **App:** search by name and click the result, or paste the numeric Apple ID / Play package name.
- **Keywords:** type and press Enter, or paste a comma-separated list.
- **Countries:** 41 storefronts, with presets and a filter box.
- **Results:** a keyword x country grid per store. Green is top 10, amber is top 50. Click any cell to see the top 5 apps for that keyword (your competitors), with your app highlighted.
- **Changes since last check:** shown as ▲/▼/new/lost in each cell. Saved in your browser.
- **Export CSV** after a run. Your selections are remembered between visits.

### Deploying it (optional)
Run behind gunicorn (`gunicorn -w 1 --threads 8 server:app`) on any small host. Before exposing it publicly, set `ACCESS_KEY=yourpassword`, otherwise anyone can use your server as a scraping proxy. The UI will ask for the key once.

Env vars: `HOST`, `PORT`, `ACCESS_KEY`, `IOS_DELAY` (default 3.2s between Apple calls), `PLAY_DELAY` (default 1s).

## Scheduled tracker
Edit `config.json` (Apple ID, package name, keywords, countries), then `python rank_tracker.py`.
`.github/workflows/rank-tracker.yml` runs it daily; use a **private** repo.

## Notes
- iOS ranks use Apple's official iTunes Search API. They closely match real App Store results but ignore ads and personalization, so treat them as a trend.
- Android ranks use the unofficial `google-play-scraper`; it can break or get rate-limited, especially from cloud IPs.
- Apple allows roughly 20 searches a minute, so large checks are throttled (about 3 seconds per iOS check).
