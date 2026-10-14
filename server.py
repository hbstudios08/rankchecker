#!/usr/bin/env python3
"""
Rank Checker web UI backend.

    pip install -r requirements.txt
    python server.py            ->  http://127.0.0.1:5000

Environment variables (all optional):
    HOST        default 127.0.0.1  (use 0.0.0.0 only if you really want to expose it)
    PORT        default 5000
    ALLOWED_ORIGIN  CORS origin allowed to call /api (default *; set to your site if it is hosted elsewhere)
    ACCESS_KEY  if set, every /api call (except /api/config) must send X-Access-Key: <value>.
                Set this if you deploy the site anywhere public, otherwise anyone can use your server
                as a free scraping proxy.
    IOS_DELAY   seconds between iTunes calls   (default 3.2, Apple's soft limit is ~20/min)
    PLAY_DELAY  seconds between Google Play calls (default 1.0)
"""
import hmac
import os
import re
import threading
import time

import requests
from flask import Flask, jsonify, request, send_from_directory

BASE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(BASE, "docs")          # the page lives here (also what GitHub Pages publishes)
app = Flask(__name__, static_folder=None)

ACCESS_KEY = os.environ.get("ACCESS_KEY", "")
IOS_DELAY = float(os.environ.get("IOS_DELAY", "3.2"))
PLAY_DELAY = float(os.environ.get("PLAY_DELAY", "1.0"))
UA = "Mozilla/5.0 (compatible; rank-checker/1.0)"

_locks = {"ios": threading.Lock(), "android": threading.Lock()}
_last_call = {"ios": 0.0, "android": 0.0}


class UpstreamError(Exception):
    pass


def throttle(store):
    """Space out calls per store so we stay under Apple's / Google's soft limits."""
    delay = IOS_DELAY if store == "ios" else PLAY_DELAY
    with _locks[store]:
        wait = _last_call[store] + delay - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_call[store] = time.time()


# --------------------------------------------------------------------------- #
# Store searches (return normalized lists: id, name, developer, icon)
# --------------------------------------------------------------------------- #
def itunes_search(term, country, limit):
    params = {
        "term": term,
        "country": country,
        "media": "software",
        "entity": "software",
        "limit": max(1, min(int(limit), 200)),
    }
    for attempt in range(3):
        throttle("ios")
        try:
            r = requests.get("https://itunes.apple.com/search", params=params,
                             headers={"User-Agent": UA}, timeout=30)
        except requests.RequestException as e:
            raise UpstreamError(f"Could not reach the App Store: {e}")
        if r.status_code in (403, 429, 503):
            time.sleep(8 * (attempt + 1))
            continue
        if not r.ok:
            raise UpstreamError(f"App Store returned HTTP {r.status_code}")
        return [
            {
                "id": str(x.get("trackId")),
                "name": x.get("trackName", ""),
                "developer": x.get("sellerName", ""),
                "icon": x.get("artworkUrl100", ""),
            }
            for x in r.json().get("results", [])
        ]
    raise UpstreamError("Apple is rate limiting requests (rate limit). Wait a minute and try again.")


def play_search(term, country, limit):
    from google_play_scraper import search

    throttle("android")
    try:
        results = search(term, n_hits=max(1, min(int(limit), 100)), lang="en", country=country)
    except Exception as e:  # the scraper raises a variety of exceptions
        raise UpstreamError(f"Google Play search failed: {e}")
    return [
        {
            "id": x.get("appId", ""),
            "name": x.get("title", ""),
            "developer": x.get("developer", ""),
            "icon": x.get("icon", ""),
        }
        for x in results
    ]


def search_store(store, term, country, limit):
    return itunes_search(term, country, limit) if store == "ios" else play_search(term, country, limit)


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
COUNTRY_RE = re.compile(r"^[a-z]{2}$")
IOS_ID_RE = re.compile(r"^\d{4,15}$")
PACKAGE_RE = re.compile(r"^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$")


def bad(msg, code=400):
    return jsonify(error=msg), code


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.before_request
def check_access():
    if request.method == "OPTIONS" or not ACCESS_KEY:
        return None
    if not request.path.startswith("/api/") or request.path == "/api/config":
        return None
    if not hmac.compare_digest(request.headers.get("X-Access-Key", ""), ACCESS_KEY):
        return bad("Access key required", 401)
    return None


@app.after_request
def add_cors(resp):
    """Lets the page (e.g. on GitHub Pages) call this server as its Google Play proxy."""
    if request.path.startswith("/api/"):
        resp.headers["Access-Control-Allow-Origin"] = os.environ.get("ALLOWED_ORIGIN", "*")
        resp.headers["Access-Control-Allow-Headers"] = "X-Access-Key, Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Vary"] = "Origin"
    return resp


@app.errorhandler(UpstreamError)
def upstream_error(e):
    return jsonify(error=str(e)), 502


def find_ui_dir():
    """index.html normally lives in ./docs, but also accept ./static or next to server.py
    (happens when files are downloaded one by one and the folder structure is lost)."""
    for d in (DOCS, os.path.join(BASE, "static"), BASE):
        if os.path.isfile(os.path.join(d, "index.html")):
            return d
    return None


@app.get("/")
def index():
    d = find_ui_dir()
    if not d:
        return (f"index.html not found. Put it in {DOCS} (or next to server.py: {BASE}).", 404,
                {"Content-Type": "text/plain; charset=utf-8"})
    return send_from_directory(d, "index.html")


@app.get("/health")
def health():
    return jsonify(ok=True, ui_found=bool(find_ui_dir()))


@app.get("/api/config")
def api_config():
    return jsonify(auth_required=bool(ACCESS_KEY))


@app.get("/api/apps")
def api_apps():
    """Find an app by name so the UI can pick its ID / package."""
    store = request.args.get("store", "")
    country = request.args.get("country", "us").lower()
    q = request.args.get("q", "").strip()
    if store not in ("ios", "android"):
        return bad("store must be ios or android")
    if not COUNTRY_RE.match(country):
        return bad("invalid country")
    if len(q) < 2 or len(q) > 100:
        return bad("query must be 2-100 characters")
    return jsonify(items=search_store(store, q, country, 8))


@app.get("/api/search")
def api_search():
    """Raw normalized search results. The page calls this for Google Play (same contract as the Worker)."""
    store = request.args.get("store", "android")
    country = request.args.get("country", "us").lower()
    q = request.args.get("q", "").strip()
    try:
        limit = int(request.args.get("limit", "50"))
    except ValueError:
        return bad("limit must be a number")
    if store not in ("ios", "android"):
        return bad("store must be ios or android")
    if not COUNTRY_RE.match(country):
        return bad("invalid country")
    if len(q) < 2 or len(q) > 100:
        return bad("query must be 2-100 characters")
    return jsonify(items=search_store(store, q, country, max(1, min(limit, 200 if store == "ios" else 100))))


@app.post("/api/rank")
def api_rank():
    d = request.get_json(silent=True) or {}
    store = d.get("store")
    country = str(d.get("country", "")).lower()
    keyword = str(d.get("keyword", "")).strip()
    app_id = str(d.get("app_id", "")).strip()
    try:
        depth = int(d.get("depth", 200 if store == "ios" else 50))
    except (TypeError, ValueError):
        return bad("depth must be a number")

    if store not in ("ios", "android"):
        return bad("store must be ios or android")
    if not COUNTRY_RE.match(country):
        return bad("invalid country")
    if not keyword or len(keyword) > 100:
        return bad("keyword must be 1-100 characters")
    if store == "ios" and not IOS_ID_RE.match(app_id):
        return bad("App Store app ID must be numeric")
    if store == "android" and not PACKAGE_RE.match(app_id):
        return bad("invalid Google Play package name")
    depth = max(1, min(depth, 200 if store == "ios" else 100))

    items = search_store(store, keyword, country, depth)
    rank = next((i for i, it in enumerate(items, 1) if it["id"] == app_id), None)
    return jsonify(rank=rank, scanned=len(items), top=items[:5])


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    if not find_ui_dir():
        print(f"WARNING: index.html not found in {DOCS} or {BASE}; the page will return 404.")
    print(f"Rank Checker running on http://{host}:{port}")
    app.run(host=host, port=port, threaded=True)
