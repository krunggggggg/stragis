import { defineAction, z, type ActionsModule } from "./sdk-shim";
import { desc, eq } from "drizzle-orm";
import * as schema from "./schema";

const CG = "https://api.coingecko.com/api/v3";
const BIN = "https://data-api.binance.vision";
const KRK = "https://api.kraken.com/0/public";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// fetch with retry + exponential backoff (honours Retry-After, capped) so a
// transient 429/5xx no longer surfaces as OFFLINE on the first attempt.
async function fetchJson(url: string): Promise<any> {
  let lastErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "Stragis/1.1" }, signal: AbortSignal.timeout(12000) });
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after") || 0) * 1000;
        lastErr = new Error(`${url.split("?")[0]} -> ${res.status}`);
        await sleep(Math.min(Math.max(ra, 500 * Math.pow(2, attempt)), 3000));
        continue;
      }
      if (!res.ok) throw new Error(`${url.split("?")[0]} -> ${res.status}`);
      return await res.json();
    } catch (e: any) { lastErr = e; if (attempt < 2) await sleep(400 * Math.pow(2, attempt)); }
  }
  throw lastErr;
}

// Tiny TTL cache with in-flight coalescing and stale-on-error fallback.
// This is what keeps the app far under provider rate limits: the 30s UI
// refresh cycles share one upstream fetch per key.
const cacheStore = new Map<string, { at: number; ttl: number; val: any }>();
const inflight = new Map<string, Promise<any>>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cacheStore.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.val as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = (async () => {
    try { const val = await fn(); cacheStore.set(key, { at: Date.now(), ttl: ttlMs, val }); return val; }
    catch (e) { const stale = cacheStore.get(key); if (stale) return stale.val; throw e; }
    finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p as Promise<T>;
}

async function cg(path: string) { return fetchJson(`${CG}${path}`); }

// ---- Symbol mapping: CoinGecko id -> exchange base symbol ----
const KNOWN_BASE: Record<string, string> = {
  bitcoin: "BTC", ethereum: "ETH", solana: "SOL", ripple: "XRP", binancecoin: "BNB",
  dogecoin: "DOGE", cardano: "ADA", "avalanche-2": "AVAX", chainlink: "LINK", polkadot: "DOT",
  "the-open-network": "TON", tron: "TRX", "shiba-inu": "SHIB", "bitcoin-cash": "BCH", litecoin: "LTC",
  near: "NEAR", uniswap: "UNI", "ethereum-classic": "ETC", stellar: "XLM", cosmos: "ATOM",
};
const KRAKEN_PAIR: Record<string, string> = { BTC: "XBTUSD", DOGE: "XDGUSD" };
let binancePairs: Set<string> | null = null;
async function binanceUsdtPairs(): Promise<Set<string>> {
  if (binancePairs) return binancePairs;
  const info: any = await cached("binance:exchangeInfo", 24 * 3600_000, () => fetchJson(`${BIN}/api/v3/exchangeInfo`));
  binancePairs = new Set((info.symbols || []).filter((s: any) => s.status === "TRADING" && s.quoteAsset === "USDT").map((s: any) => s.symbol));
  return binancePairs;
}
const TF_LIMIT: Record<string, number> = { "1m": 180, "5m": 180, "15m": 192, "1h": 168, "4h": 180, "1d": 180, "1w": 120 };
const KRK_INTERVAL: Record<string, number> = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080 };

type CandleV = { t: number; o: number; h: number; l: number; c: number; v: number };
async function binanceCandles(pair: string, tf: string): Promise<CandleV[]> {
  const interval = TF_LIMIT[tf] ? tf : "1h";
  const rows: any[] = await fetchJson(`${BIN}/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${TF_LIMIT[tf] ?? 168}`);
  return rows.map(r => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[7]) }));
}
async function krakenCandles(base: string, tf: string, sinceSec?: number): Promise<CandleV[]> {
  const pair = KRAKEN_PAIR[base] || `${base}USD`;
  const since = sinceSec ? `&since=${sinceSec}` : "";
  const d: any = await fetchJson(`${KRK}/OHLC?pair=${pair}&interval=${KRK_INTERVAL[tf] ?? 60}${since}`);
  if (d.error?.length) throw new Error(`Kraken ${d.error[0]}`);
  const key = Object.keys(d.result || {}).find(k => k !== "last");
  if (!key) throw new Error("Kraken OHLC empty");
  return (d.result[key] as any[]).map(r => ({ t: Number(r[0]) * 1000, o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[6]) * Number(r[4]) }));
}
const TF_MS: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000 };
async function binanceCandlesRange(pair: string, tf: string, startTime: number, endTime: number): Promise<CandleV[]> {
  const intervalMs = TF_MS[tf] ?? TF_MS["1h"]!;
  const out: CandleV[] = [];
  let cursor = startTime;
  while (cursor <= endTime && out.length < 12_000) {
    const rows: any[] = await fetchJson(`${BIN}/api/v3/klines?symbol=${pair}&interval=${tf}&startTime=${cursor}&endTime=${endTime}&limit=1000`);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) {
      // Exclude the still-forming candle so a backtest only uses completed bars.
      if (Number(r[6]) < endTime) out.push({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[7]) });
    }
    const lastOpen = Number(rows[rows.length - 1][0]);
    if (!Number.isFinite(lastOpen)) break;
    cursor = lastOpen + intervalMs;
    if (rows.length < 1000) break;
  }
  return out;
}

const marketSchema = z.object({
  id: z.string(), symbol: z.string(), name: z.string(), image: z.string().nullable().optional(),
  current_price: z.number(), market_cap: z.number().nullable(), total_volume: z.number().nullable(),
  high_24h: z.number().nullable(), low_24h: z.number().nullable(),
  price_change_24h: z.number().nullable(), price_change_percentage_24h: z.number().nullable(),
  last_updated: z.string().nullable(),
});
type Market = z.infer<typeof marketSchema>;
function norm(m: any): Market {
  return { id: m.id, symbol: m.symbol, name: m.name, image: m.image ?? null, current_price: m.current_price ?? 0, market_cap: m.market_cap ?? null, total_volume: m.total_volume ?? null, high_24h: m.high_24h ?? null, low_24h: m.low_24h ?? null, price_change_24h: m.price_change_24h ?? null, price_change_percentage_24h: m.price_change_percentage_24h ?? null, last_updated: m.last_updated ?? null };
}

export const Actions = {
  getMarkets: defineAction({
    request: z.object({ ids: z.array(z.string()).optional(), perPage: z.number().int().min(1).max(50).default(20) }),
    response: z.object({ ok: z.boolean(), source: z.string(), fetchedAt: z.string(), markets: z.array(marketSchema), error: z.string().nullable() }),
    async handler(_ctx, args) {
      const fetchedAt = new Date().toISOString();
      try {
        if (args.ids && args.ids.length) {
          const byId: Record<string, any> = {};
          const meta = await cached(`cg:markets:ids:${args.ids.join(",")}`, 60_000, () => cg(`/coins/markets?vs_currency=usd&ids=${args.ids!.join(",")}&price_change_percentage=24h`)).catch(() => []);
          for (const m of (meta as any[])) byId[m.id] = norm(m);
          // Overlay live Binance prices where a pair exists (fresher, unthrottled)
          await Promise.all(args.ids.map(async id => {
            const base = KNOWN_BASE[id] || byId[id]?.symbol?.toUpperCase();
            if (!base) return;
            try {
              const t: any = await cached(`binance:24hr:${base}USDT`, 20_000, () => fetchJson(`${BIN}/api/v3/ticker/24hr?symbol=${base}USDT`));
              const live = { current_price: Number(t.lastPrice), high_24h: Number(t.highPrice), low_24h: Number(t.lowPrice), total_volume: Number(t.quoteVolume), price_change_24h: Number(t.priceChange), price_change_percentage_24h: Number(t.priceChangePercent), last_updated: fetchedAt };
              byId[id] = byId[id] ? { ...byId[id], ...live } : { id, symbol: base.toLowerCase(), name: base, image: null, market_cap: null, ...live };
            } catch { /* keep CoinGecko values */ }
          }));
          const markets = args.ids.map(id => byId[id]).filter(Boolean);
          if (!markets.length) throw new Error("No provider returned watchlist data");
          return { ok: true, source: "Binance + CoinGecko (metadata)", fetchedAt, markets, error: null };
        }
        const data: any = await cached(`cg:markets:top:${args.perPage}`, 60_000, () => cg(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${args.perPage}&page=1&price_change_percentage=24h`));
        return { ok: true, source: "CoinGecko (cached 60s)", fetchedAt, markets: (data as any[]).map(norm), error: null };
      } catch (e: any) {
        // CoinGecko down/rate-limited: build the table from Binance 24hr tickers
        try {
          const all: any[] = await cached("binance:24hr:all", 30_000, () => fetchJson(`${BIN}/api/v3/ticker/24hr`));
          const byBase = new Map<string, any>();
          for (const t of all) if (t.symbol?.endsWith("USDT")) byBase.set(t.symbol.slice(0, -4), t);
          const known = Object.entries(KNOWN_BASE).map(([id, base]) => ({ id, base })).filter(x => byBase.has(x.base));
          const picked = (known.length >= 10 ? known : Object.entries(byBase).slice(0, 50).map(([base]) => ({ id: base.toLowerCase(), base })))
            .map(x => { const t = byBase.get(x.base); return { id: x.id, symbol: x.base.toLowerCase(), name: x.base, image: null, current_price: Number(t.lastPrice), market_cap: null, total_volume: Number(t.quoteVolume), high_24h: Number(t.highPrice), low_24h: Number(t.lowPrice), price_change_24h: Number(t.priceChange), price_change_percentage_24h: Number(t.priceChangePercent), last_updated: fetchedAt, _qv: Number(t.quoteVolume) }; })
            .sort((a, b) => b._qv - a._qv).slice(0, args.perPage).map(({ _qv, ...m }) => m);
          return { ok: true, source: "Binance (CoinGecko fallback)", fetchedAt, markets: picked, error: null };
        } catch (e2: any) { return { ok: false, source: "CoinGecko/Binance", fetchedAt, markets: [], error: String(e2?.message || e2) }; }
      }
    },
  }),
  getCoinData: defineAction({
    request: z.object({ coinId: z.string(), symbol: z.string().optional(), timeframe: z.string().default("1h") }),
    response: z.object({
      ok: z.boolean(), source: z.string(), fetchedAt: z.string(), error: z.string().nullable(),
      market: marketSchema.nullable(),
      candles: z.array(z.object({ t: z.number(), o: z.number(), h: z.number(), l: z.number(), c: z.number(), v: z.number() })),
      prices: z.array(z.object({ t: z.number(), p: z.number(), v: z.number() })),
    }),
    async handler(_ctx, args) {
      const fetchedAt = new Date().toISOString();
      const tf = TF_LIMIT[args.timeframe] ? args.timeframe : "1h";
      const base = (args.symbol || KNOWN_BASE[args.coinId] || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      // CoinGecko metadata (market cap, image, name) — cached 5 min, never blocks the live path
      const cgMetaP = cached(`cg:meta:${args.coinId}`, 300_000, () => cg(`/coins/markets?vs_currency=usd&ids=${args.coinId}&price_change_percentage=24h`))
        .then((d: any) => (Array.isArray(d) && d[0] ? norm(d[0]) : null)).catch(() => null);
      const withMeta = async (m: Market | null, candles: CandleV[], source: string) => {
        const meta = await cgMetaP;
        const market = m ? { ...m, market_cap: m.market_cap ?? meta?.market_cap ?? null, image: m.image ?? meta?.image ?? null, name: meta?.name || m.name } : meta;
        return { ok: true, source, fetchedAt, error: null, market, candles, prices: candles.map(cd => ({ t: cd.t, p: cd.c, v: cd.v })) };
      };
      const pair = base ? `${base}USDT` : "";
      // ---- Primary: Binance ----
      if (pair) {
        try {
          const pairs = await binanceUsdtPairs().catch(() => null);
          if (!pairs || pairs.has(pair)) {
            const [t, candles]: any[] = await Promise.all([
              cached(`binance:24hr:${pair}`, 20_000, () => fetchJson(`${BIN}/api/v3/ticker/24hr?symbol=${pair}`)),
              cached(`binance:klines:${pair}:${tf}`, 20_000, () => binanceCandles(pair, tf)),
            ]);
            const market: Market = { id: args.coinId, symbol: base.toLowerCase(), name: base, image: null, current_price: Number(t.lastPrice), market_cap: null, total_volume: Number(t.quoteVolume), high_24h: Number(t.highPrice), low_24h: Number(t.lowPrice), price_change_24h: Number(t.priceChange), price_change_percentage_24h: Number(t.priceChangePercent), last_updated: fetchedAt };
            return await withMeta(market, candles as CandleV[], "Binance (primary)");
          }
        } catch { /* fall through to Kraken */ }
      }
      // ---- Fallback 1: Kraken ----
      if (base) {
        try {
          const pairK = KRAKEN_PAIR[base] || `${base}USD`;
          const [tk, candles]: any[] = await Promise.all([
            fetchJson(`${KRK}/Ticker?pair=${pairK}`),
            cached(`kraken:ohlc:${base}:${tf}`, 20_000, () => krakenCandles(base, tf)),
          ]);
          if (tk.error?.length) throw new Error(`Kraken ${tk.error[0]}`);
          const key = Object.keys(tk.result || {})[0]; const row = key ? tk.result[key] : null;
          if (!row) throw new Error("Kraken ticker empty");
          const last = Number(row.c[0]);
          const market: Market = { id: args.coinId, symbol: base.toLowerCase(), name: base, image: null, current_price: last, market_cap: null, total_volume: Number(row.v[1]) * last, high_24h: Number(row.h[1]), low_24h: Number(row.l[1]), price_change_24h: null, price_change_percentage_24h: Number(row.o) ? ((last - Number(row.o)) / Number(row.o)) * 100 : null, last_updated: fetchedAt };
          return await withMeta(market, candles as CandleV[], "Kraken (fallback)");
        } catch { /* fall through to CoinGecko */ }
      }
      // ---- Fallback 2: CoinGecko (original path, cached) ----
      try {
        const daysMap: Record<string, number> = { "1m": 1, "5m": 1, "15m": 1, "1h": 1, "4h": 7, "1d": 30, "1w": 90 };
        const days = daysMap[tf] ?? 1;
        const [markets, ohlc, chart]: any[] = await Promise.all([
          cgMetaP,
          cached(`cg:ohlc:${args.coinId}:${days}`, 60_000, () => cg(`/coins/${args.coinId}/ohlc?vs_currency=usd&days=${days}`)),
          cached(`cg:chart:${args.coinId}:${days}`, 60_000, () => cg(`/coins/${args.coinId}/market_chart?vs_currency=usd&days=${days}`)),
        ]);
        const market = markets ?? null;
        let candles: CandleV[] = (ohlc as any[]).map((r: any) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: 0 }));
        const volArr = chart?.total_volumes || [];
        const prices = (chart?.prices || []).map((r: any, i: number) => ({ t: r[0], p: r[1], v: volArr[i]?.[1] ?? 0 }));
        if (tf === "1m") candles = candles.slice(-60);
        if (tf === "5m") candles = candles.slice(-80);
        if (tf === "15m") candles = candles.slice(-96);
        if (tf === "4h") candles = candles.slice(-120);
        if (!market && !candles.length) throw new Error("CoinGecko returned no data");
        return { ok: true, source: "CoinGecko (fallback)", fetchedAt, error: null, market, candles, prices: prices.length ? prices : candles.map(cd => ({ t: cd.t, p: cd.c, v: cd.v })) };
      } catch (e: any) { return { ok: false, source: "Binance/Kraken/CoinGecko", fetchedAt, error: String(e?.message || e), market: null, candles: [], prices: [] }; }
    },
  }),
  getBacktestData: defineAction({
    request: z.object({ coinId: z.string(), symbol: z.string().optional(), timeframe: z.string().default("15m"), days: z.number().int().refine(v => v === 3 || v === 5) }),
    response: z.object({
      ok: z.boolean(), source: z.string(), fetchedAt: z.string(), error: z.string().nullable(), testStart: z.number().nullable(),
      candles: z.array(z.object({ t: z.number(), o: z.number(), h: z.number(), l: z.number(), c: z.number(), v: z.number() })),
    }),
    async handler(_ctx, args) {
      const fetchedAt = new Date().toISOString();
      const tf = TF_MS[args.timeframe] ? args.timeframe : "15m";
      const intervalMs = TF_MS[tf]!;
      const base = (args.symbol || KNOWN_BASE[args.coinId] || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!base) return { ok: false, source: "Binance/Kraken", fetchedAt, error: "Unknown coin symbol for backtesting", testStart: null, candles: [] };
      const pair = `${base}USDT`;
      const cacheKey = `backtest:${pair}:${tf}:${args.days}`;
      try {
        return await cached(cacheKey, 60_000, async () => {
          const now = Date.now();
          const testStart = now - args.days * 86_400_000;
          const warmupBars = 280;
          const startTime = testStart - warmupBars * intervalMs;
          // ---- Primary: Binance historical klines (paginated, completed candles only) ----
          try {
            const pairs = await binanceUsdtPairs().catch(() => null);
            if (pairs && !pairs.has(pair)) throw new Error(`${pair} is not listed on Binance spot`);
            const candles = await binanceCandlesRange(pair, tf, startTime, now);
            const warmup = candles.filter(c => c.t < testStart).length;
            const tested = candles.filter(c => c.t >= testStart).length;
            if (warmup < 200 || tested < 10) throw new Error(`Insufficient Binance history (warmup ${warmup}, test bars ${tested})`);
            return { ok: true, source: "Binance (backtest history)", fetchedAt: new Date().toISOString(), error: null, testStart, candles };
          } catch (binanceErr) {
            // ---- Fallback: Kraken OHLC (max ~720 candles from 'since') ----
            const candles = (await krakenCandles(base, tf, Math.floor(startTime / 1000))).filter(c => c.t >= Math.floor(startTime / intervalMs) * intervalMs);
            const warmup = candles.filter(c => c.t < testStart).length;
            const tested = candles.filter(c => c.t >= testStart).length;
            if (warmup < 200 || tested < 10) throw new Error(`Insufficient Kraken history (warmup ${warmup}, test bars ${tested}); Binance error: ${String((binanceErr as any)?.message || binanceErr)}`);
            return { ok: true, source: "Kraken (backtest fallback)", fetchedAt: new Date().toISOString(), error: null, testStart, candles };
          }
        });
      } catch (e: any) { return { ok: false, source: "Binance/Kraken", fetchedAt, error: String(e?.message || e), testStart: null, candles: [] }; }
    },
  }),
  getGoldData: defineAction({
    request: z.object({}),
    response: z.object({
      ok: z.boolean(), fetchedAt: z.string(), error: z.string().nullable(),
      spotSource: z.string(), candleSource: z.string(), newsSource: z.string(),
      spot: z.object({ price: z.number(), bid: z.number().nullable(), ask: z.number().nullable(), updatedAt: z.string().nullable() }).nullable(),
      crossCheck: z.object({ price: z.number(), updatedAt: z.string().nullable(), source: z.string() }).nullable(),
      spotTs: z.number().nullable(),
      tickStats: z.object({ count: z.number(), firstTs: z.number().nullable(), lastTs: z.number().nullable() }),
      bars: z.object({ m5: z.number(), m15: z.number(), h1: z.number(), h4: z.number(), daily: z.number() }),
      m5: z.array(z.object({ t: z.number(), o: z.number(), h: z.number(), l: z.number(), c: z.number(), v: z.number() })),
      m15: z.array(z.object({ t: z.number(), o: z.number(), h: z.number(), l: z.number(), c: z.number(), v: z.number() })),
      h1: z.array(z.object({ t: z.number(), o: z.number(), h: z.number(), l: z.number(), c: z.number(), v: z.number() })),
      h4: z.array(z.object({ t: z.number(), o: z.number(), h: z.number(), l: z.number(), c: z.number(), v: z.number() })),
      daily: z.array(z.object({ t: z.number(), o: z.number(), h: z.number(), l: z.number(), c: z.number(), v: z.number() })),
      news: z.array(z.object({ title: z.string(), country: z.string(), date: z.string(), impact: z.string(), forecast: z.string(), previous: z.string() })),
    }),
    async handler(ctx) {
      const SPOT_SOURCE = "Swissquote Bank — XAU/USD spot feed (public-quotes BBO: bid/ask, mid price used)";
      const CANDLE_SOURCE = "Stragis spot tick recorder — M5/M15/H1/H4/daily candles are aggregated ONLY from Swissquote XAU/USD spot ticks recorded by this app. No futures (COMEX GC=F) data is used anywhere in this section.";
      const NEWS_SOURCE = "ForexFactory calendar via FairEconomy (USD events)";
      try {
        const [sqRes, gaRes, newsRes] = await Promise.allSettled([
          fetch("https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD", { headers: { "user-agent": "Mozilla/5.0", accept: "application/json" } }).then(async r => { if (!r.ok) throw new Error(`Swissquote ${r.status}`); return r.json(); }),
          fetch("https://api.gold-api.com/price/XAU", { headers: { accept: "application/json" } }).then(async r => { if (!r.ok) throw new Error(`Gold-API ${r.status}`); return r.json(); }),
          fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { headers: { accept: "application/json" } }).then(async r => { if (!r.ok) throw new Error(`Calendar ${r.status}`); return r.json(); }),
        ]);
        // ---- Genuine spot quote: Swissquote BBO (primary) ----
        let spot: { price: number; bid: number | null; ask: number | null; updatedAt: string | null } | null = null;
        let spotTs: number | null = null;
        if (sqRes.status === "fulfilled") {
          const arr: any[] = Array.isArray(sqRes.value) ? sqRes.value : [];
          const first = arr[0];
          const profiles: any[] = first?.spreadProfilePrices || [];
          const prof = profiles.find((p: any) => p.spreadProfile === "standard") || profiles[0];
          if (prof && typeof prof.bid === "number" && typeof prof.ask === "number") {
            const mid = (prof.bid + prof.ask) / 2;
            const tsNum: number = typeof first.ts === "number" ? first.ts : Date.now();
            spotTs = tsNum;
            spot = { price: mid, bid: prof.bid, ask: prof.ask, updatedAt: new Date(tsNum).toISOString() };
          }
        }
        // ---- Cross-check quote: Gold-API spot (display only, never used for levels) ----
        let crossCheck: { price: number; updatedAt: string | null; source: string } | null = null;
        if (gaRes.status === "fulfilled" && (gaRes.value as any)?.price) {
          crossCheck = { price: Number((gaRes.value as any).price), updatedAt: (gaRes.value as any).updatedAt ?? null, source: "Gold-API (XAU spot)" };
        }
        if (!spot && crossCheck) {
          spot = { price: crossCheck.price, bid: null, ask: null, updatedAt: crossCheck.updatedAt };
          spotTs = crossCheck.updatedAt ? new Date(crossCheck.updatedAt).getTime() : Date.now();
        }
        // ---- Record the spot tick (dedupe on source timestamp) ----
        const db = ctx.db<typeof schema>();
        if (spot && spotTs && spot.bid != null && spot.ask != null) {
          try {
            const existing = await db.select().from(schema.goldTicks).where(eq(schema.goldTicks.ts, spotTs));
            if (!existing[0]) await db.insert(schema.goldTicks).values({ ts: spotTs, bid: spot.bid, ask: spot.ask, mid: spot.price });
          } catch { /* recording is best-effort; never block the quote */ }
        }
        // ---- Load recorded spot ticks (last 40 days) and aggregate into candles ----
        const cutoff = Date.now() - 40 * 24 * 3600_000;
        let tickRows: { ts: number; mid: number }[] = [];
        try {
          const rows = await db.select().from(schema.goldTicks).orderBy(schema.goldTicks.ts);
          tickRows = rows.filter(r => r.ts >= cutoff).map(r => ({ ts: r.ts, mid: r.mid }));
        } catch { tickRows = []; }
        type C = { t: number; o: number; h: number; l: number; c: number; v: number };
        const agg = (bucketMs: number): C[] => {
          const map = new Map<number, C>();
          for (const tk of tickRows) {
            const key = Math.floor(tk.ts / bucketMs) * bucketMs;
            const b = map.get(key);
            if (!b) map.set(key, { t: key, o: tk.mid, h: tk.mid, l: tk.mid, c: tk.mid, v: 1 });
            else { b.h = Math.max(b.h, tk.mid); b.l = Math.min(b.l, tk.mid); b.c = tk.mid; b.v += 1; }
          }
          return [...map.values()].sort((a, b) => a.t - b.t);
        };
        const etDay = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
        const aggDaily = (): C[] => {
          const map = new Map<string, C>();
          for (const tk of tickRows) {
            const key = etDay(tk.ts);
            const b = map.get(key);
            if (!b) map.set(key, { t: tk.ts, o: tk.mid, h: tk.mid, l: tk.mid, c: tk.mid, v: 1 });
            else { b.h = Math.max(b.h, tk.mid); b.l = Math.min(b.l, tk.mid); b.c = tk.mid; b.v += 1; }
          }
          return [...map.values()].sort((a, b) => a.t - b.t);
        };
        const m5 = agg(5 * 60_000); const m15 = agg(15 * 60_000); const h1 = agg(3600_000); const h4 = agg(4 * 3600_000); const daily = aggDaily();
        const newsRaw: any[] = newsRes.status === "fulfilled" ? (newsRes.value as any[]) : [];
        const news = newsRaw.filter((e: any) => e.country === "USD").map((e: any) => ({ title: String(e.title || ""), country: String(e.country || ""), date: String(e.date || ""), impact: String(e.impact || ""), forecast: String(e.forecast ?? ""), previous: String(e.previous ?? "") }));
        const ok = !!spot;
        return {
          ok, fetchedAt: new Date().toISOString(), error: ok ? null : "Spot XAU/USD quote sources returned no data",
          spotSource: SPOT_SOURCE, candleSource: CANDLE_SOURCE, newsSource: NEWS_SOURCE,
          spot, crossCheck, spotTs,
          tickStats: { count: tickRows.length, firstTs: tickRows[0]?.ts ?? null, lastTs: tickRows[tickRows.length - 1]?.ts ?? null },
          bars: { m5: m5.length, m15: m15.length, h1: h1.length, h4: h4.length, daily: daily.length },
          m5, m15, h1, h4, daily, news,
        };
      } catch (e: any) {
        return { ok: false, fetchedAt: new Date().toISOString(), error: String(e?.message || e), spotSource: SPOT_SOURCE, candleSource: CANDLE_SOURCE, newsSource: NEWS_SOURCE, spot: null, crossCheck: null, spotTs: null, tickStats: { count: 0, firstTs: null, lastTs: null }, bars: { m5: 0, m15: 0, h1: 0, h4: 0, daily: 0 }, m5: [], m15: [], h1: [], h4: [], daily: [], news: [] };
      }
    },
  }),
  searchCoins: defineAction({
    request: z.object({ query: z.string().min(1) }),
    response: z.object({ ok: z.boolean(), results: z.array(z.object({ id: z.string(), symbol: z.string(), name: z.string(), rank: z.number().nullable() })) }),
    async handler(_ctx, args) {
      try { const d: any = await cg(`/search?query=${encodeURIComponent(args.query)}`); return { ok: true, results: (d.coins || []).slice(0, 12).map((c: any) => ({ id: c.id, symbol: c.symbol, name: c.name, rank: c.market_cap_rank ?? null })) }; }
      catch { return { ok: false, results: [] }; }
    },
  }),
  listWatchlist: defineAction({
    request: z.object({}),
    response: z.object({ items: z.array(z.object({ id: z.number(), coinId: z.string(), symbol: z.string(), name: z.string() })) }),
    async handler(ctx) { const db = ctx.db<typeof schema>(); const rows = await db.select().from(schema.watchlist).orderBy(desc(schema.watchlist.id)); return { items: rows.map(r => ({ id: r.id, coinId: r.coinId, symbol: r.symbol, name: r.name })) }; },
  }),
  addWatchlist: defineAction({
    request: z.object({ coinId: z.string(), symbol: z.string(), name: z.string() }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) { const db = ctx.db<typeof schema>(); const existing = await db.select().from(schema.watchlist).where(eq(schema.watchlist.coinId, args.coinId)); if (existing[0]) return { id: existing[0].id }; const r = await db.insert(schema.watchlist).values({ coinId: args.coinId, symbol: args.symbol, name: args.name }).returning({ id: schema.watchlist.id }); ctx.invalidateQueries(); return { id: r[0]!.id }; },
  }),
  removeWatchlist: defineAction({
    request: z.object({ id: z.number() }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => { const db = ctx.db<typeof schema>(); await db.delete(schema.watchlist).where(eq(schema.watchlist.id, args.id)); ctx.invalidateQueries(); return { ok: true }; },
  }),
  listAlerts: defineAction({
    request: z.object({}),
    response: z.object({ items: z.array(z.object({ id: z.number(), coinId: z.string(), symbol: z.string(), type: z.string(), value: z.number().nullable(), enabled: z.number() })) }),
    async handler(ctx) { const db = ctx.db<typeof schema>(); const rows = await db.select().from(schema.alerts).orderBy(desc(schema.alerts.id)); return { items: rows.map(r => ({ id: r.id, coinId: r.coinId, symbol: r.symbol, type: r.type, value: r.value, enabled: r.enabled })) }; },
  }),
  addAlert: defineAction({
    request: z.object({ coinId: z.string(), symbol: z.string(), type: z.string(), value: z.number().nullable() }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) { const db = ctx.db<typeof schema>(); const r = await db.insert(schema.alerts).values({ coinId: args.coinId, symbol: args.symbol, type: args.type, value: args.value, enabled: 1 }).returning({ id: schema.alerts.id }); ctx.invalidateQueries(); return { id: r[0]!.id }; },
  }),
  removeAlert: defineAction({
    request: z.object({ id: z.number() }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => { const db = ctx.db<typeof schema>(); await db.delete(schema.alerts).where(eq(schema.alerts.id, args.id)); ctx.invalidateQueries(); return { ok: true }; },
  }),
} satisfies ActionsModule;
