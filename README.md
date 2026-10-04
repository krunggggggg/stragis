# Stragis

**Stragis — Understand the Trend. Trade With a Plan.**

Live AI-powered crypto trading analysis web app, plus a separate **GOLD ONLY — XAU/USD** section.

## What it does

- **Crypto dashboard** — live CoinGecko prices (auto-refresh, LIVE badge + last-updated time), candlestick charts with EMA/Bollinger overlays, RSI and MACD panels, support/resistance, multi-factor BUY / SELL / WAIT signals with UPTREND / DOWNTREND / SIDEWAYS detection, entry zone, stop-loss, take-profits, risk/reward, trend strength and confidence. Market overview, persistent watchlist, live-evaluated alerts, and a risk calculator. If the live feed is unavailable it shows **LIVE DATA UNAVAILABLE** instead of fake prices.
- **GOLD ONLY — XAU/USD** — a separate section applying an intraday framework: H4/H1 structure, M15 setup, M5 confirmation, liquidity sweep -> market structure shift -> pullback -> confirmation, PDH/PDL and session levels, VWAP context, a live USD news/macro filter, setup score /100, and BUY / SELL / WAIT / NO TRADE decisions. Gold uses **pure spot XAU/USD** (Swissquote spot feed; spot history is recorded by the app itself, and timeframes without enough spot bars show LIVE DATA UNAVAILABLE and force NO TRADE).

## Tech

React + TypeScript client (`client/`), server actions (`server/src/actions.ts`), Drizzle schema/migrations (`drizzle/`, `server/src/schema.ts`).

## Important notes

- This source was exported from the Muse (Hatch) web-artifact runtime. `package.json` references `@hatch/space-sdk` from a local runtime path — to run it outside that runtime, that SDK dependency needs to be replaced with your own hosting/data layer.
- Runtime data (`app.db`), `node_modules`, build output, and audit files are intentionally not included (see `.gitignore`).

## Disclaimer

Stragis provides market analysis and educational information based on available market data. Trading cryptocurrency and gold involves substantial risk, and past performance does not guarantee future results. Signals are not guaranteed predictions or financial advice. Always conduct your own research and consider your risk tolerance.
