# Data Plan

## Context provenance
- Verbatim request: live AI crypto analysis for BTC, ETH, SOL, XRP, BNB, DOGE, ADA, AVAX, LINK + search, live price/24h/high/low/volume, candlestick chart with 1m/5m/15m/1h/4h/1d/1w, EMA/SMA/RSI/MACD/Bollinger/support/resistance, BUY/SELL/WAIT signals with reasons, uptrend/downtrend/sideways strategies, risk calculator, watchlist, alerts, dark premium design, LIVE indicator + timestamp, disclaimer verbatim, LIVE DATA UNAVAILABLE fallback.
- No other external context applied.

## Tested sources
### CoinGecko Public API (primary)
**Used by**: getMarkets, getCoinChart, searchCoins actions (server-side fetch)
**Test command**: `curl -s "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&price_change_percentage=24h"` and `curl -s "https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=1"` and `curl -s "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1"` and `curl -s "https://api.coingecko.com/api/v3/search?query=pepe"`
**Sample output**: markets returns [{id:bitcoin,symbol:btc,current_price:84737,high_24h:85014,low_24h:84518,price_change_percentage_24h:0.07,total_volume:14715626597,market_cap,last_updated}]; OHLC returns [[ts,open,high,low,close],...] 30-min candles for days=1, 4h for days=7; market_chart returns prices/volumes arrays; search returns coins with id/symbol/name/rank.
**Processing**: Server action fetches CoinGecko, normalizes to typed rows. Timeframe mapping: 1m/5m/15m approximated from market_chart minute data + OHLC days=1 sliced; 1h uses OHLC days=1; 4h uses days=7; 1d uses days=30; 1w uses days=90. Client computes EMA20/50/200, SMA, RSI14, MACD(12,26,9), Bollinger(20,2), support/resistance from swing highs/lows, trend & signal scoring. Poll every 30s via react-query. On fetch failure return {ok:false} and UI shows LIVE DATA UNAVAILABLE, never fake prices.

### Binance / Bybit (rejected)
**Test command**: `curl -s https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT` and Bybit tickers
**Sample output**: Binance: {code:0,msg:Service unavailable from a restricted location}; Bybit: CloudFront block.
**Processing**: Not used; CoinGecko is the replaceable provider behind a single server module so it can be swapped.

## Gold section (PURE SPOT since 2026-10-04 edit — separate GOLD ONLY / XAU/USD tab)
**Change**: Removed the COMEX GC=F futures candles and the spot–futures offset adjustment entirely. No futures data is fetched or presented anywhere in the Gold section. COMEX cross-check was also dropped (cleaner than labelling risk).

### Swissquote Bank public-quotes — XAU/USD spot BBO (primary spot + tick source)
**Used by**: getGoldData action — live spot quote; every poll also records the tick into the `gold_ticks` DB table (deduped on source timestamp)
**Test command**: `curl -s "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD"`
**Sample output**: [{"topo":{...},"spreadProfilePrices":[{"spreadProfile":"standard","bid":4138.890,"ask":4139.580,...}, premium, prime...],"ts":1790974800089}, ...] — genuine spot XAU/USD bid/ask from a Swiss bank/broker feed, no API key.
**Processing**: Mid = (bid+ask)/2 of the standard profile (fallback: first profile). Headline spot price, bid/ask and quote age are shown. Market-closed detection uses the spot timestamp age + ET weekend window (Fri 17:00–Sun 18:00 ET).

### Spot candles — Stragis tick recorder (ONLY candle source)
**Used by**: getGoldData action — aggregates recorded `gold_ticks` into M5/M15/H1/H4 (epoch buckets) and daily (America/New_York date buckets) OHLC; candle "v" is a tick count, never shown as traded volume.
**Processing**: Client gates the framework on recorded-bar counts (M5≥40, M15≥40, H1≥60, H4≥60). Any timeframe below threshold shows "LIVE DATA UNAVAILABLE — building" and the decision is forced to NO TRADE. PDH/PDL come only from recorded spot daily bars (need a full previous recorded day). No backfill is invented and no other candle source is substituted.
**Limitation (shown in UI)**: History only exists from when recording started and only accumulates while the feed is polled — early on, most timeframes are UNAVAILABLE and the section sits at NO TRADE. That is the honest cost of pure spot with the keyless sources reachable from this egress (see Rejected).

### Gold-API spot XAU (cross-check quote only)
**Used by**: getGoldData action — displayed as a labelled cross-check next to the Swissquote mid (with Δ); never used for candles, levels, or signals. Also the fallback spot quote if Swissquote fails.
**Test command**: `curl -s "https://api.gold-api.com/price/XAU"`
**Sample output**: {"currency":"USD","name":"Gold","price":4141.799805,"symbol":"XAU","updatedAt":"2026-10-04T02:19:03Z"}

### VWAP on pure spot
Spot XAU/USD is OTC — no centralised traded volume exists and the spot tick feed carries none, so session VWAP is shown as UNAVAILABLE (previously it silently used COMEX futures volume). The VWAP/EMA score component (10 pts) scores EMA confluence only and is capped at 6/10, labelled in the UI.

### FairEconomy — ForexFactory weekly calendar JSON (news filter)
**Used by**: getGoldData action — USD events
**Test command**: `curl -s "https://nfs.faireconomy.media/ff_calendar_thisweek.json"`
**Sample output**: [{title:"Core PCE Price Index m/m",country:"USD",date:"2026-09-30T08:30:00-04:00",impact:"High",forecast,previous}, {title:"Non-Farm Employment Change",date:"2026-10-02T08:30:00-04:00",impact:"High"}, FOMC member speeches, ...]
**Processing**: Server filters country=USD; client lists upcoming events, flags High-impact keyword events (FOMC/Fed/CPI/PCE/NFP/unemployment/GDP) within 2h as NO TRADE — HIGH-IMPACT NEWS RISK. Calendar is weekly coverage — UI states this limitation when no upcoming events remain in the feed.

### Rejected spot-OHLC candidates (tested 2026-10-04)
- Yahoo Finance XAUUSD=X: delisted ("No data found, symbol may be delisted"); XAU-USD is a zero-price CCC crypto listing; GC=F is COMEX futures (excluded by the pure-spot requirement).
- Swissquote candles route (/public-quotes/candles/...): 404 NOT_FOUND for every period/instrument variant tried — only the BBO quote endpoint is public.
- Dukascopy datafeed (datafeed.dukascopy.com XAUUSD .bi5): HTTP 429 Too Many Requests from this egress — hard stop, not retried.
- Stooq XAUUSD CSV: connection times out (http 000) from this egress; earlier attempts hung behind a bot wall.
- TradingView websocket (wss://data.tradingview.com, OANDA:XAUUSD): connected but delivered no messages within 25s from this egress; its scanner endpoint does return genuine OANDA spot day OHLC but no candle history, so it was not used (single-source consistency: levels and candles both come from the recorded Swissquote spot ticks).
- Gold-API history endpoint: requires a paid x-api-key. TwelveData demo key: 401 (demo no longer covers XAU/USD). FXCM candledata.fxcorporate.com: 404 for all instruments/periods (service retired). goldprice.org: 403 Forbidden. metals.live: dead.
- Tokenised gold (PAXG / XAUT on crypto exchanges): not spot XAU/USD — rejected on instrument identity, not just data quality.

## Long-term data behavior
- **Refresh policy**: Fetch-on-open + 30s client polling; server passes through CoinGecko (free tier rate limits handled with graceful error state). No cron.
- **Growth**: Watchlist and alerts tables grow only by user adds; bounded by UI.
- **Ordering**: Markets by market_cap desc; candles chronological.
- **Time semantics**: All timestamps from CoinGecko last_updated / candle ts (UTC ms), rendered viewer-local with explicit Updated label.

## Rejected approaches
- **Tried**: Binance, Bybit public APIs
  **Why rejected**: Geo-blocked from build egress; CoinGecko works without API key.
- **Imagery**: No photos needed — data-viz terminal; coin icons are text/symbol badges, no external images.
