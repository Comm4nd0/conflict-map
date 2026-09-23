# Conflict Map

A fully local, news-driven world map of current armed conflicts: who is fighting,
who is backing whom, and what the consequences are.

## How it works

1. **GDELT** – every 15 minutes GDELT publishes a global event file. We keep the
   "material conflict" events (CAMEO quad class 4) for the last 48 h and use them as
   a background heat layer (per-country fill + heatmap) and for actor-pair links.
2. **RSS feeds** – ~50 feeds (see `app/config.py`): BBC/Guardian/France 24 regional
   desks, NYT, WaPo, CNN, NPR, CBC, Sky, DW, Euronews, Politico EU, VOA, UN News,
   ReliefWeb, Google News keyword feeds (which surface Reuters and AP), regional
   outlets (Kyiv Independent, Ukrainska Pravda, TASS, Times of Israel, JPost, Haaretz,
   Middle East Eye, Al-Monitor, Anadolu, Africanews, AllAfrica, Dawn, The Hindu, SCMP,
   Japan Times, Yonhap, The Diplomat) and defence/analysis sites (Defense One,
   Breaking Defense, The War Zone, War on the Rocks, Long War Journal, Crisis Group,
   Bellingcat). Feeds are fetched in parallel. Articles whose title and summary
   contain none of the `RELEVANCE_TERMS` are stored but never sent to the model.
3. **Local LLM extraction** – unprocessed articles go to `gpt-oss-120b` on llama-swap
   (`http://127.0.0.1:8080/v1`) in batches of 40, together with the existing conflict
   records. The model returns updated/new conflict records: parties (side + role),
   consequences by category, latest developments with source citations, an epicenter.
4. **Map** – MapLibre GL 5 (vendored) in globe projection with atmosphere, or flat
   Mercator via the Globe toggle; idle globe slowly spins. Basemap is fully local:
   dark-tinted shaded relief with seabed, built from Natural Earth GRAY_50M_SR_OB by
   `scripts/build_tiles.py` into `static/tiles/` (512px tiles, z0-4, ~4 MB), plus 50m
   country polygons, lakes, rivers and admin-1 lines, and Open Sans glyphs in
   `static/fonts/` for country/capital/city labels. Conflict markers sized by severity
   and coloured by status; dashed arcs from supporters/mediators to the epicenter;
   click a conflict (or a country) to focus: parties keep their side colour, everything
   else darkens.

5. **Attacks** – the model also lists every located attack reported in each batch
   (weapon incl. shelling/ground/bombing, attacker, optional origin, target,
   launched/intercepted counts, outcome, source), for internal conflicts as well as
   cross-border ones. Attacks without a usable origin pulse at the target instead of
   drawing a trajectory.
6. **Incidents** – GDELT fight / mass-violence events with coordinates, aggregated per
   place over the window, drawn as dots from zoom 3 with the most-mentioned source
   article on hover/click. In focus mode only incidents inside the selected conflict's
   countries are shown. This is press attention, not a verified incident log. Place names are resolved
   through a local gazetteer (`static/data/places.geojson`, Natural Earth 10m
   populated places, ~7,300 cities); the model's own coordinates are only accepted
   when they fall inside the named country, otherwise the strike snaps to the country
   centroid with precision `country`. Precision is `city`, `approx` or `country` and is
   shown in the UI. On the map each strike replays as an animated projectile along a
   bent trajectory with an impact flash; a day slider filters to one day.
7. **Military aircraft** – the server polls the public ADS-B aggregator
   airplanes.live (`/v2/mil`, falling back to adsb.fi) once a minute and keeps the
   history in memory. `/api/aircraft` only ever serves a snapshot at least
   `AIRCRAFT_DELAY_MIN` (20) minutes old, with the last `AIRCRAFT_TRAIL_MIN` (30)
   minutes as a trail, so the map never shows live positions near fighting. Aircraft
   are coloured by role from their ICAO type code (tanker, surveillance, transport,
   combat, helicopter). Only aircraft that broadcast ADS-B appear, which in practice
   means support and surveillance flights, not combat missions. This runs on the
   public viewer too (it does not go through the database); after a restart the layer
   stays empty until the first delayed snapshot is available.

Everything lives in `data/conflict.db` (SQLite). Nothing leaves the machine except
the fetches to GDELT, the RSS feeds and the ADS-B aggregator.

Rebuild the relief tiles (only needed if you change the colours in the script):

```bash
curl -LO https://naciscdn.org/naturalearth/50m/raster/GRAY_50M_SR_OB.zip && unzip GRAY_50M_SR_OB.zip -d /tmp/gray
uv run --with pillow --with numpy python scripts/build_tiles.py /tmp/gray/GRAY_50M_SR_OB.tif
```

## Run

```bash
uv sync
uv run uvicorn app.server:app --host 127.0.0.1 --port 8765
# open http://127.0.0.1:8765
```

The server refreshes every 30 min (`REFRESH_MINUTES`). Trigger a refresh manually
with the Refresh button or `curl -X POST localhost:8765/api/refresh`.

Run the pipeline by hand:

```bash
uv run python -m app.pipeline            # GDELT + feeds + LLM extraction
uv run python -m app.pipeline --skip-llm # just fetch data
```

Env vars: `LLM_BASE`, `LLM_MODEL`, `GDELT_BACKFILL_HOURS` (48), `GDELT_WINDOW_HOURS`,
`REFRESH_MINUTES` (30), `ARTICLES_PER_BATCH` (40), `AIRCRAFT_ENABLED` (1),
`AIRCRAFT_DELAY_MIN` (20), `AIRCRAFT_TRAIL_MIN` (30), `AIRCRAFT_POLL_SECONDS` (60).

## Public viewer (Luma001)

The Hetzner box has no GPU, so it only *serves* the map. The home machine runs the
pipeline and pushes a WAL-safe snapshot of `data/conflict.db` after every refresh
(`PUSH_TARGET=luma:/root/conflict-map/data`, set in `run.sh`; the file is swapped in
atomically with `mv`). The container runs with `SERVE_ONLY=1`: read-only database,
no pipeline loop, `/api/refresh` returns 403, the Refresh button is hidden.

```
/root/conflict-map          git clone of this repo (public), docker compose, port 172.17.0.1:8030
/root/caddy/Caddyfile       conflicts.lumatechsolutions.co.uk { reverse_proxy 172.17.0.1:8030 }
```

Deploy an update: `ssh luma 'cd /root/conflict-map && git pull --ff-only && docker compose up -d --build'`.

## Notes / known limits

- GDELT is noisy and English-media-biased (the US always glows). The heat layer
  only uses CAMEO root codes 19/20 (fight, mass violence) and a power curve, but it
  is still a rough "attention" signal, not a casualty count.
- The LLM decides what counts as a conflict; the prompt excludes crime, politics and
  diplomatic disputes but it will occasionally over-reach. Every development cites
  the article it came from so claims can be checked.
- Conflicts are never deleted automatically. `last_seen` is stored; stale ones can be
  filtered in the UI later.

## Military ships layer

Naval vessels from AIS via aisstream.io, limited to watched seas (`SHIPS_BOXES` in
`app/config.py`) and held back 20 minutes like aircraft. It needs a free API key from
https://aisstream.io; without one the layer shows "(off)". On the server put it in
`/root/conflict-map/.env` as `AISSTREAM_API_KEY=...` and run `docker compose up -d`.
Most warships switch AIS off; auxiliaries (USNS, RFA), patrol and coast-guard vessels
are what usually shows up.

## Contributing

Issues and pull requests are welcome: https://github.com/Comm4nd0/conflict-map

The public site is a read-only viewer; the data pipeline (feeds, GDELT, local LLM
extraction) runs on a separate machine. To work on it locally, run `./run.sh` with a
local OpenAI-compatible model endpoint (`LLM_BASE`, `LLM_MODEL`), or run the viewer
alone against any `data/conflict.db` with `SERVE_ONLY=1`.
