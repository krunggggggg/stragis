import { defineAction, z, type ActionsModule } from "./sdk-shim";
import { desc, eq } from "drizzle-orm";
import * as schema from "./schema";

const CG = "https://api.coingecko.com/api/v3";
async function cg(path: string) {
  const res = await fetch(`${CG}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  return res.json();
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
      try {
        let url = `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${args.perPage}&page=1&price_change_percentage=24h`;
        if (args.ids && args.ids.length) url = `/coins/markets?vs_currency=usd&ids=${args.ids.join(",")}&price_change_percentage=24h`;
        const data: any = await cg(url);
        return { ok: true, source: "CoinGecko", fetchedAt: new Date().toISOString(), markets: (data as any[]).map(norm), error: null };
      } catch (e: any) { return { ok: false, source: "CoinGecko", fetchedAt: new Date().toISOString(), markets: [], error: String(e?.message || e) }; }
    },
  }),
  getCoinData: defineAction({
    request: z.object({ coinId: z.string(), timeframe: z.string().default("1h") }),
    response: z.object({
      ok: z.boolean(), source: z.string(), fetchedAt: z.string(), error: z.string().nullable(),
      market: marketSchema.nullable(),
      candles: z.array(z.object({ t: z.number(), o: z.number(), h: z.number(), l: z.number(), c: z.number() })),
      prices: z.array(z.object({ t: z.number(), p: z.number(), v: z.number() })),
    }),
    async handler(_ctx, args) {
      try {
        const daysMap: Record<string, number> = { "1m": 1, "5m": 1, "15m": 1, "1h": 1, "4h": 7, "1d": 30, "1w": 90 };
        const days = daysMap[args.timeframe] ?? 1;
        const [markets, ohlc, chart]: any[] = await Promise.all([
          cg(`/coins/markets?vs_currency=usd&ids=${args.coinId}&price_change_percentage=24h`),
          cg(`/coins/${args.coinId}/ohlc?vs_currency=usd&days=${days}`),
          cg(`/coins/${args.coinId}/market_chart?vs_currency=usd&days=${days}`),
        ]);
        const market = markets?.[0] ? norm(markets[0]) : null;
        const candles = (ohlc as any[]).map((r: any) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4] }));
        const priceArr = chart?.prices || []; const volArr = chart?.total_volumes || [];
        const prices = priceArr.map((r: any, i: number) => ({ t: r[0], p: r[1], v: volArr[i]?.[1] ?? 0 }));
        // For short timeframes slice to recent portion for readability
        let slicedCandles = candles; let slicedPrices = prices;
        if (args.timeframe === "1m") { slicedCandles = candles.slice(-60); slicedPrices = prices.slice(-120); }
        if (args.timeframe === "5m") { slicedCandles = candles.slice(-80); slicedPrices = prices.slice(-160); }
        if (args.timeframe === "15m") { slicedCandles = candles.slice(-96); }
        if (args.timeframe === "4h") { slicedCandles = candles.slice(-120); }
        return { ok: true, source: "CoinGecko", fetchedAt: new Date().toISOString(), error: null, market, candles: slicedCandles, prices: slicedPrices };
      } catch (e: any) { return { ok: false, source: "CoinGecko", fetchedAt: new Date().toISOString(), error: String(e?.message || e), market: null, candles: [], prices: [] }; }
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
