# Stragis — Standalone + Desktop (.exe)

**Stragis — Understand the Trend. Trade With a Plan.**

This is the standalone version of Stragis, converted from the Muse
web artifact so it runs on a normal PC with only standard open-source
dependencies — no `@hatch/space-sdk` anywhere. The original web version is
untouched; the conversion lives entirely in this folder.

It contains:

- **Strategy Backtest** — a **Run Backtest** button tests the same fixed
  crypto signal rules over the last 3 or 5 days at 1m/5m/15m/1h/4h, with a
  200-candle warm-up, next-candle-open entries, SL/TP1 exits, win rate,
  net P&L, total R, profit factor, max drawdown, an equity curve, and a
  trade log. Fees and slippage are not modeled.
- **Crypto dashboard** — live prices and true per-interval OHLCV candles from
  Binance (primary) with automatic Kraken fallback; CoinGecko supplies
  market-cap rankings/search behind a server cache (60s markets, 5min
  metadata) with retry/backoff. Candlestick charts with
  EMA/Bollinger, RSI and MACD, multi-factor BUY / SELL / WAIT signals,
  watchlist, alerts, and a risk calculator. Shows **LIVE DATA UNAVAILABLE**
  instead of fake prices when a feed fails.
- **GOLD ONLY — XAU/USD** — separate section: H4/H1 structure, M15 setup,
  M5 confirmation, liquidity / PDH / PDL, news filter, setup score /100.
  Pure spot XAU/USD only (Swissquote spot feed). Spot candles are
  aggregated from spot ticks this app records itself, so history builds
  up as it runs; timeframes without enough recorded bars show
  LIVE DATA UNAVAILABLE and force NO TRADE. No futures data is used.

## Using the .exe — quick guide

### Get the latest Stragis.exe

1. Open the repo on GitHub → **Actions** tab → **Build Windows EXE**
   (left sidebar) → click the **newest run at the top** (check its
   commit message matches the latest change).
2. Scroll to **Artifacts** at the bottom of the run page and download
   **Stragis-exe** (a zip).
3. Unzip it, **delete any older `Stragis.exe` first**, then put the new
   `Stragis.exe` wherever you keep it (Desktop is fine) and double-click.
4. First launch only: Windows SmartScreen may say “Windows protected
   your PC” → **More info → Run anyway**. The app is not code-signed;
   this prompt is expected for a self-built app.

There is nothing to install and no commands to run — the portable .exe
contains the whole app (UI + local server + database engine).

### Updating to a new version is safe

Replacing `Stragis.exe` with a newer one **does not erase your data**.
Your watchlist, alerts, settings and the gold spot ticks the app has
recorded live in a separate file:

```text
%APPDATA%\Stragis\stragis.db
```

To back up your data, copy that one file somewhere safe. To reset the
app completely, close Stragis and delete that file (it is recreated
empty on next launch).

### What you should see

- **Crypto dashboard** shows a green **LIVE** badge and updates every
  ~30 seconds. Under the chart, the source line tells you which feed is
  serving you: **Binance (primary)** normally, **Kraken (fallback)** if
  Binance is unreachable on your network — both are working states.
  The chart has true per-timeframe candles (1m–1w) and a volume
  histogram underneath it.
- **Strategy Backtest**: choose 3 or 5 days and a timeframe, then click
  **Run Backtest**. It only runs when you click — it does not run
  automatically on every refresh.
- **GOLD ONLY tab**: leave the app open on this tab while the gold
  market is open (from Monday). The spot history/candles are built from
  ticks the app records itself, so structure and setups become
  available as bars accumulate. On weekends it honestly shows the last
  spot quote / no-trade state rather than inventing data.

### Troubleshooting

- **Red OFFLINE / “LIVE DATA UNAVAILABLE” banner** — the app could not
  reach any data provider. Check your internet connection, then click
  **Retry** in the banner. If it persists, allow `Stragis.exe` in
  *Windows Security → Firewall & network protection → Allow an app
  through firewall* (Private). The app never shows invented prices —
  the banner means “no live data”, not a crash.
- **Data “sometimes stops” and comes back** — that was the old
  CoinGecko-only build hitting the free rate limit (~10 calls/min).
  The current build fetches prices/candles from Binance/Kraken and
  caches CoinGecko metadata, with automatic retries, so refresh stalls
  should no longer happen.
- **App window does not open / instant error dialog** — make sure you
  are running the newest .exe (delete older copies so you don't launch
  one by accident). The original broken build (pre-fix) showed a
  `spawn ... ENOENT` JavaScript error; that was fixed — if you ever see
  it, you are running an old file.
- **Which version am I running?** The source line under the crypto
  chart (Binance/Kraken/CoinGecko label) only exists in the current
  build — if your chart still says “Candles: CoinGecko OHLC”, you are
  on the old .exe.

## How it works (architecture)

| Piece | Replacement for the Hatch SDK |
|---|---|
| `server/src/sdk-shim.ts` | `defineAction` / `z` / `ActionsModule` — thin wrapper over the real `zod` package; `actions.ts` logic is unchanged apart from its import line |
| `server/src/server.ts` | Plain Node HTTP server: `POST /actions` (`{action, args}`, args validated with each action's zod request schema) + static serving of the built client with SPA fallback |
| `server/src/db.ts` | `ctx.db` — drizzle-orm over **better-sqlite3**; the SQL migrations in `drizzle/` run at startup (tracked in a `_stragis_migrations` table, so restarts are safe) |
| `client/src/api.ts` | Typed `fetch` Proxy client (was `createActionClient`) |
| `client/src/main.tsx` | Plain `new QueryClient()` (was the SDK's shared client) |
| `vite.config.ts` | Vite + `@vitejs/plugin-react` + `@tailwindcss/vite` (Tailwind v4, as in the original) replaces the SDK bundler |

**Server runtime decision:** the production server is bundled by esbuild
into a single ESM file (`server/dist/server.mjs`) and runs under
**plain Node 20+**. better-sqlite3 was chosen over `node:sqlite` because
drizzle-orm has a mature, stable better-sqlite3 driver, and
electron-builder rebuilds the native module for Electron's ABI
automatically (`npmRebuild`). `ctx.invalidateQueries()` is a no-op —
the React client already invalidates its own queries after mutations.

## Run it locally (web version)

Prerequisites: Node.js 20+ (22 recommended) and npm.

```bash
npm install
npm run build     # builds client (Vite) + server (esbuild)
npm start         # serves everything on http://127.0.0.1:4317
```

Then open <http://127.0.0.1:4317>.

Useful variations:

- `PORT=8080 npm start` — change the port.
- `STRAGIS_DB_PATH=/path/to/stragis.db npm start` — change where the
  SQLite database lives (default: `./data/stragis.db`). Your watchlist,
  alerts, and recorded gold ticks live in that file — back it up to keep
  your data.
- `npm run dev` — build once and start (same as above).
- `npm run dev:client` — Vite dev server on :5173 with `/actions`
  proxied to a separately running server on :4317.
- `npm run typecheck` — see the known pre-existing errors below.

No API keys are needed: Binance/Kraken public market data, CoinGecko (free tier), Swissquote spot, Gold-API,
and the ForexFactory calendar feed used by the app are all keyless.

## Build the Windows desktop app (.exe)

### Option A — GitHub Actions (recommended, nothing to install)

This repo has `.github/workflows/build-windows-exe.yml`. Push to the
`feature/desktop-exe` branch (or run the workflow manually from the
Actions tab), then download **Stragis-exe** from the workflow run's
artifacts — it contains a portable `Stragis.exe`. Double-click it: no
installation needed.

### Option B — Build on a Windows PC

```bat
npm install
npm run dist:win
```

The portable `.exe` lands in `dist-exe\`.

### How the desktop app runs

Electron (`electron/main.cjs`) loads the same bundled server
**in-process** (no child process — spawning the portable `.exe` as a
child was the cause of the original `spawn ... ENOENT` startup crash,
fixed in commit `52b45bc`), pointed at a database in your per-user app
data folder (`%APPDATA%\Stragis\stragis.db`), waits for it to answer,
then opens the app window at the local address. Your data persists
between launches and survives app updates. An internet connection is
still required for the live market feeds.

### Windows SmartScreen

The `.exe` is not code-signed, so on first launch Windows may show
**“Windows protected your PC”**. Click **More info → Run anyway**. This
is normal for self-built apps; only a paid code-signing certificate
removes it.

## Known issues

- `npm run typecheck` reports 3 **pre-existing** errors in the original
  app code (`client/src/App.tsx`, unused variables `yHigh`, `yLow`,
  `support2`). They were present before this conversion, don't affect
  the build or runtime, and were deliberately left alone rather than
  rewriting app logic. The server project typechecks cleanly.
- In the Muse Linux sandbox where this was developed, the Electron
  binary download was blocked by a proxy, so the full electron-builder
  packaging could not be completed locally (the better-sqlite3 native
  rebuild for Electron 37 *did* succeed). The Windows `.exe` packaging
  is exercised by the GitHub Actions workflow instead.

## Disclaimer

Stragis provides market analysis and educational information based on
available market data. Trading cryptocurrency and gold involves
substantial risk, and past performance does not guarantee future results.
Signals are not guaranteed predictions or financial advice. Always
conduct your own research and consider your risk tolerance.
