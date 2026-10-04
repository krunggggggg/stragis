# Stragis — Standalone + Desktop (.exe)

**Stragis — Understand the Trend. Trade With a Plan.**

This is the standalone version of Stragis, converted from the Muse
web artifact so it runs on a normal PC with only standard open-source
dependencies — no `@hatch/space-sdk` anywhere. The original web version is
untouched; the conversion lives entirely in this folder.

It contains:

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

Electron (`electron/main.cjs`) starts the same bundled server in-process
as a child process (Electron's Node runtime), pointed at a database in
your per-user app data folder (`%APPDATA%\Stragis\stragis.db`), waits for
it to answer, then opens the app window at the local address. Your data
persists between launches and survives app updates. An internet
connection is still required for the live market feeds.

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
