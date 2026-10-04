import { useMemo, useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { GoldSection } from "./GoldSection";
import { BacktestPanel } from "./BacktestPanel";
import { ResponsiveContainer, ComposedChart, BarChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, AreaChart, Area } from "recharts";

// ---------- indicators ----------
function ema(values: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1); const out: (number | null)[] = [];
  let prev: number | null = null;
  values.forEach((v, i) => { if (i < period - 1) { out.push(null); return; } if (prev === null) { prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period; out.push(prev); } else { prev = v * k + prev * (1 - k); out.push(prev); } });
  return out;
}
function sma(values: number[], period: number): (number | null)[] { return values.map((_, i) => i < period - 1 ? null : values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period); }
function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  if (values.length <= period) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = values[i]! - values[i - 1]!; if (d >= 0) gains += d; else losses -= d; }
  let avgG = gains / period, avgL = losses / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < values.length; i++) { const d = values[i]! - values[i - 1]!; avgG = (avgG * (period - 1) + Math.max(d, 0)) / period; avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period; out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL); }
  return out;
}
function bollinger(values: number[], period = 20, mult = 2) {
  const mid = sma(values, period); const upper: (number | null)[] = [], lower: (number | null)[] = [];
  values.forEach((_, i) => { if (mid[i] == null) { upper.push(null); lower.push(null); return; } const slice = values.slice(i - period + 1, i + 1); const mean = mid[i]!; const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period); upper.push(mean + mult * sd); lower.push(mean - mult * sd); });
  return { mid, upper, lower };
}
function macd(values: number[]) {
  const e12 = ema(values, 12), e26 = ema(values, 26);
  const line = values.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i]! - e26[i]! : null);
  const valid = line.map(v => v ?? 0); const sigE = ema(valid, 9);
  const signal = line.map((v, i) => v == null ? null : sigE[i]); const hist = line.map((v, i) => (v != null && signal[i] != null) ? v - signal[i]! : null);
  return { line, signal, hist };
}
function fmt(n: number | null | undefined, dec = 2) { if (n == null || !isFinite(n)) return "—"; if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: dec }); if (n >= 1) return n.toFixed(dec); if (n >= 0.01) return n.toFixed(4); return n.toFixed(6); }
function fmtBig(n: number | null | undefined) { if (n == null) return "—"; if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`; if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`; return `$${fmt(n)}`; }

const COINS = [
  { id: "bitcoin", symbol: "BTC", name: "Bitcoin" }, { id: "ethereum", symbol: "ETH", name: "Ethereum" },
  { id: "solana", symbol: "SOL", name: "Solana" }, { id: "ripple", symbol: "XRP", name: "XRP" },
  { id: "binancecoin", symbol: "BNB", name: "BNB" }, { id: "dogecoin", symbol: "DOGE", name: "Dogecoin" },
  { id: "cardano", symbol: "ADA", name: "Cardano" }, { id: "avalanche-2", symbol: "AVAX", name: "Avalanche" },
  { id: "chainlink", symbol: "LINK", name: "Chainlink" }, { id: "polkadot", symbol: "DOT", name: "Polkadot" },
];
const TFS = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const;

function CandleShape(props: any) {
  const { x, y, width, height, payload } = props; if (!payload) return null;
  const { o, h, l, c, yHigh, yLow } = payload; // we use custom via payload scale passed through? Instead compute from chart scale not available; fallback: use y/height for body from Bar [l,h]
  // Bar gives y at high, height to low. Body proportion:
  const range = h - l || 1; const top = y + ((h - Math.max(o, c)) / range) * height; const bottom = y + ((h - Math.min(o, c)) / range) * height;
  const color = c >= o ? "#00e676" : "#ff5252"; const cx = x + width / 2;
  return <g><line x1={cx} x2={cx} y1={y} y2={y + height} stroke={color} strokeWidth={1} /><rect x={x + 1} y={top} width={Math.max(width - 2, 2)} height={Math.max(bottom - top, 1)} fill={color} /></g>;
}

export function App() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState(COINS[0]!);
  const [view, setView] = useState<"crypto" | "gold">("crypto");
  const [tf, setTf] = useState<string>("1h");
  const [search, setSearch] = useState("");
  const [showBB, setShowBB] = useState(true); const [showEMA, setShowEMA] = useState(true);
  const [balance, setBalance] = useState("10000"); const [riskPct, setRiskPct] = useState("1"); const [entry, setEntry] = useState(""); const [stop, setStop] = useState("");
  const [alertType, setAlertType] = useState("price_above"); const [alertValue, setAlertValue] = useState("");

  const marketsQ = useQuery({ queryKey: ["markets"], queryFn: () => api.getMarkets({ perPage: 30 }), refetchInterval: 30000 });
  const coinQ = useQuery({ queryKey: ["coin", selected.id, tf], queryFn: () => api.getCoinData({ coinId: selected.id, symbol: selected.symbol, timeframe: tf }), refetchInterval: 30000 });
  const watchQ = useQuery({ queryKey: ["watchlist"], queryFn: () => api.listWatchlist({}) });
  const alertsQ = useQuery({ queryKey: ["alerts"], queryFn: () => api.listAlerts({}) });
  const searchQ = useQuery({ queryKey: ["search", search], queryFn: () => api.searchCoins({ query: search }), enabled: search.length > 1 });

  const watchIds = watchQ.data?.items.map(i => i.coinId) || [];
  const watchMarketsQ = useQuery({ queryKey: ["watchMarkets", watchIds.join(",")], queryFn: () => api.getMarkets({ ids: watchIds, perPage: 20 }), enabled: watchIds.length > 0, refetchInterval: 30000 });

  const addWatch = useMutation({ mutationFn: () => api.addWatchlist({ coinId: selected.id, symbol: selected.symbol, name: selected.name }), onSuccess: () => qc.invalidateQueries({ queryKey: ["watchlist"] }) });
  const removeWatch = useMutation({ mutationFn: (id: number) => api.removeWatchlist({ id }), onSuccess: () => qc.invalidateQueries({ queryKey: ["watchlist"] }) });
  const addAlert = useMutation({ mutationFn: () => api.addAlert({ coinId: selected.id, symbol: selected.symbol, type: alertType, value: alertValue ? parseFloat(alertValue) : null }), onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }) });
  const removeAlert = useMutation({ mutationFn: (id: number) => api.removeAlert({ id }), onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }) });

  const market = coinQ.data?.market;
  const candles = coinQ.data?.candles || [];
  const closes = candles.map(c => c.c);
  const analysis = useMemo(() => {
    if (closes.length < 20) return null;
    const e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = ema(closes, Math.min(200, closes.length - 1));
    const r = rsi(closes); const m = macd(closes); const bb = bollinger(closes);
    const last = closes.length - 1; const price = closes[last]!;
    const curRsi = r[last] ?? 50; const curE20 = e20[last]; const curE50 = e50[last]; const curE200 = e200[last];
    const macdHist = m.hist[last] ?? 0; const macdPrev = m.hist[last - 1] ?? 0;
    // support / resistance from recent swings
    const recent = candles.slice(-60);
    const support = Math.min(...recent.map(c => c.l)); const resistance = Math.max(...recent.map(c => c.h));
    const support2 = Math.min(...candles.slice(-120, -60).map(c => c.l).concat([support]));
    let score = 0; const reasons: string[] = [];
    if (curE50 && price > curE50) { score += 2; reasons.push(`Price $${fmt(price)} is above 50 EMA ($${fmt(curE50)}) — bullish structure`); } else if (curE50) { score -= 2; reasons.push(`Price is below 50 EMA ($${fmt(curE50)}) — bearish structure`); }
    if (curE20 && curE50 && curE20 > curE50) { score += 1; reasons.push("20 EMA above 50 EMA — short-term momentum aligned up"); } else if (curE20 && curE50) { score -= 1; reasons.push("20 EMA below 50 EMA — short-term momentum down"); }
    if (curE200 && price > curE200) { score += 1; reasons.push("Price above 200 EMA — long-term trend filter bullish"); } else if (curE200) { score -= 1; reasons.push("Price below 200 EMA — long-term trend filter bearish"); }
    if (curRsi > 70) { score -= 1; reasons.push(`RSI ${curRsi.toFixed(1)} is overbought — overextended, pullback risk`); } else if (curRsi < 30) { score += 1; reasons.push(`RSI ${curRsi.toFixed(1)} is oversold — potential bounce zone`); } else if (curRsi >= 50) { score += 1; reasons.push(`RSI ${curRsi.toFixed(1)} above 50 — positive momentum`); } else { score -= 1; reasons.push(`RSI ${curRsi.toFixed(1)} below 50 — weak momentum`); }
    if (macdHist > 0 && macdHist > macdPrev) { score += 2; reasons.push("MACD histogram rising and positive — bullish momentum building"); } else if (macdHist < 0) { score -= 2; reasons.push("MACD histogram negative — bearish momentum"); } else { score += 1; reasons.push("MACD histogram positive — momentum favors buyers"); }
    const distRes = resistance ? (resistance - price) / price * 100 : 99; const distSup = support ? (price - support) / price * 100 : 99;
    if (distRes < 1.5) reasons.push(`Price within ${distRes.toFixed(1)}% of resistance $${fmt(resistance)} — don't chase`);
    if (distSup < 1.5) reasons.push(`Price near support $${fmt(support)} — potential buy zone on confirmation`);
    const trend = score >= 3 ? "UPTREND" : score <= -3 ? "DOWNTREND" : "SIDEWAYS";
    const signal = trend === "UPTREND" ? (curRsi > 72 || distRes < 0.8 ? "WAIT" : "BUY") : trend === "DOWNTREND" ? (curRsi < 28 ? "WAIT" : "SELL") : "WAIT";
    const signalLabel = signal === "BUY" ? (distSup < 3 ? "BUY" : "BUY ON PULLBACK") : signal === "SELL" ? "SELL / REDUCE" : "WAIT / HOLD";
    const strength = Math.min(100, Math.abs(score) * 12 + 20);
    const confidence = Math.min(92, 45 + Math.abs(score) * 6);
    const bbUpper = bb.upper[last]; const bbLower = bb.lower[last];
    const volatility = bbUpper && bbLower && price ? ((bbUpper - bbLower) / price * 100) : 0;
    const sentiment = score >= 3 ? "Bullish" : score <= -3 ? "Bearish" : "Neutral";
    const entryZone = trend === "UPTREND" ? `$${fmt(support)} – $${fmt(support * 1.01)}` : trend === "DOWNTREND" ? `Below $${fmt(resistance * 0.99)} on rejection` : `$${fmt(support)} – $${fmt(resistance)} range`;
    const sl = trend === "DOWNTREND" ? resistance * 1.01 : support * 0.99;
    const tp1 = trend === "DOWNTREND" ? support : resistance; const tp2 = trend === "DOWNTREND" ? support * 0.97 : resistance * 1.03;
    const rr = sl && price && tp1 ? Math.abs(tp1 - price) / Math.abs(price - sl) : 0;
    const explanation = trend === "UPTREND"
      ? `${selected.name} is in an uptrend because price is ${curE50 && price > curE50 ? "above" : "near"} the 50 EMA and momentum (RSI ${curRsi.toFixed(0)}, MACD) remains ${macdHist >= 0 ? "positive" : "mixed"}. ${distRes < 1.5 ? "Price is close to resistance, so instead of chasing, consider waiting for a pullback toward support." : "Look for pullbacks toward support as potential buy zones rather than buying after a large move."}`
      : trend === "DOWNTREND" ? `${selected.name} is in a downtrend — price below key EMAs with ${macdHist < 0 ? "negative" : "weakening"} MACD momentum. Avoid catching a falling price; wait for reversal confirmation (RSI recovery, EMA reclaim) or use resistance as an exit/reduce zone.`
      : `${selected.name} is sideways with no strong directional edge. RSI near ${curRsi.toFixed(0)} and EMAs are flat/mixed. The plan is to WAIT for a breakout of the $${fmt(support)}–$${fmt(resistance)} range with volume confirmation.`;
    return { e20, e50, r, m, bb, price, curRsi, support, resistance, score, trend, signal, signalLabel, strength, confidence, sentiment, volatility, reasons, explanation, entryZone, sl, tp1, tp2, rr, macdHist };
  }, [candles, selected]);

  useEffect(() => { if (market && !entry) setEntry(String(market.current_price)); if (market && analysis && !stop) setStop(String(analysis.sl.toFixed(2))); }, [market?.current_price]);

  const chartData = useMemo(() => {
    if (!analysis) return candles.map(c => ({ ...c, time: new Date(c.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), range: [c.l, c.h] }));
    return candles.map((c, i) => ({ ...c, time: new Date(c.t).toLocaleDateString([], { month: "short", day: "numeric" }) + " " + new Date(c.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), range: [c.l, c.h], ema20: analysis.e20[i], ema50: analysis.e50[i], bbU: analysis.bb.upper[i], bbL: analysis.bb.lower[i], rsi: analysis.r[i], macd: analysis.m.line[i], macdSig: analysis.m.signal[i], macdHist: analysis.m.hist[i] }));
  }, [candles, analysis]);

  // risk calc
  const bal = parseFloat(balance) || 0, rp = parseFloat(riskPct) || 0, en = parseFloat(entry) || 0, st = parseFloat(stop) || 0;
  const riskAmt = bal * rp / 100; const perUnit = Math.abs(en - st); const posSize = perUnit > 0 ? riskAmt / perUnit : 0; const posValue = posSize * en;
  const tpLevels = en && perUnit ? [1, 2, 3].map(mult => ({ label: `TP${mult} (${mult}R)`, price: en + (en > st ? perUnit * mult : -perUnit * mult), rr: mult })) : [];

  // alert evaluation
  const triggered = (a: any) => {
    if (!market || a.coinId !== selected.id) return false;
    if (a.type === "price_above" && a.value) return market.current_price >= a.value;
    if (a.type === "price_below" && a.value) return market.current_price <= a.value;
    if (a.type === "rsi_oversold") return (analysis?.curRsi ?? 50) < 30;
    if (a.type === "rsi_overbought") return (analysis?.curRsi ?? 50) > 70;
    if (a.type === "bullish_trend") return analysis?.trend === "UPTREND";
    if (a.type === "bearish_trend") return analysis?.trend === "DOWNTREND";
    if (a.type === "buy_signal") return analysis?.signal === "BUY";
    if (a.type === "sell_signal") return analysis?.signal === "SELL";
    return false;
  };
  const liveOk = coinQ.data?.ok && marketsQ.data?.ok;
  const lastUpdated = coinQ.data?.fetchedAt ? new Date(coinQ.data.fetchedAt).toLocaleTimeString() : "—";

  const trendColor = analysis?.trend === "UPTREND" ? "var(--green)" : analysis?.trend === "DOWNTREND" ? "var(--red)" : "var(--amber)";
  const signalBg = analysis?.signal === "BUY" ? "#052e16" : analysis?.signal === "SELL" ? "#2e0a0a" : "#2a2000";

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <header className="sticky top-0 z-40 pt-safe border-b" style={{ background: "#0d1117ee", borderColor: "var(--border)", backdropFilter: "blur(8px)" }}>
        <div className="max-w-7xl mx-auto px-3 py-3 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2"><div className="w-8 h-8 rounded flex items-center justify-center font-bold text-black" style={{ background: "var(--green)" }}>S</div><div><div className="font-bold tracking-tight leading-none">STRAGIS</div><div className="text-[10px]" style={{ color: "var(--dim)" }}>Understand the Trend. Trade With a Plan.</div></div></div>
          {view === "crypto" ? <><div className="flex-1 min-w-[180px] relative">
            <input aria-label="Search cryptocurrency" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search BTC, Ethereum, PEPE…" className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }} />
            {search.length > 1 && searchQ.data?.results && <div className="absolute top-11 left-0 right-0 rounded-lg overflow-hidden shadow-xl z-50" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>{searchQ.data.results.map(r => <button key={r.id} aria-label={`Select ${r.name}`} onClick={() => { setSelected({ id: r.id, symbol: r.symbol.toUpperCase(), name: r.name }); setSearch(""); }} className="w-full text-left px-3 py-2 hover:bg-white/5 flex justify-between"><span><b>{r.symbol.toUpperCase()}</b> {r.name}</span><span style={{ color: "var(--dim)" }}>#{r.rank ?? "—"}</span></button>)}</div>}
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs font-bold px-2 py-1 rounded-full" style={{ background: liveOk ? "#052e16" : "#2e0a0a", color: liveOk ? "var(--green)" : "var(--red)" }}><span className="w-2 h-2 rounded-full animate-pulse" style={{ background: liveOk ? "var(--green)" : "var(--red)" }} />{liveOk ? "LIVE" : "OFFLINE"}</span>
            <span className="text-xs hidden sm:block" style={{ color: "var(--dim)" }}>CoinGecko • Updated {lastUpdated}</span>
          </div></> : <div className="flex-1 text-sm font-bold" style={{ color: "#d4af37" }}>🥇 GOLD ONLY — XAU/USD <span className="font-normal text-xs" style={{ color: "var(--dim)" }}>Separate gold feed & framework below — not part of the crypto dashboard</span></div>}
        </div>
        <div className="max-w-7xl mx-auto px-3 pb-2 flex gap-2">
          <button aria-label="Open crypto dashboard" onClick={() => setView("crypto")} className="px-4 py-2 rounded-lg text-sm font-black whitespace-nowrap" style={{ background: view === "crypto" ? "var(--green)" : "var(--surface2)", color: view === "crypto" ? "#000" : "var(--text)", border: "1px solid var(--border)" }}>₿ CRYPTO</button>
          <button aria-label="Open Gold Only XAU USD section" onClick={() => setView("gold")} className="px-4 py-2 rounded-lg text-sm font-black whitespace-nowrap" style={{ background: view === "gold" ? "#d4af37" : "var(--surface2)", color: view === "gold" ? "#000" : "#d4af37", border: "1px solid #d4af37" }}>🥇 GOLD ONLY — XAU/USD</button>
        </div>
        {view === "crypto" && <div className="max-w-7xl mx-auto px-3 pb-2 flex gap-1.5 overflow-x-auto">{COINS.map(c => <button key={c.id} aria-label={`Select ${c.name}`} onClick={() => setSelected(c)} className="px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap" style={{ background: selected.id === c.id ? "var(--green)" : "var(--surface2)", color: selected.id === c.id ? "#000" : "var(--text)", border: "1px solid var(--border)" }}>{c.symbol}</button>)}</div>}
      </header>

      <main className="max-w-7xl mx-auto px-3 py-4 space-y-4 pb-10">
        {view === "gold" ? <GoldSection /> : <>
        {!liveOk && coinQ.data && <div className="rounded-xl p-4 text-center font-bold" style={{ background: "#2e0a0a", color: "var(--red)", border: "1px solid var(--red)" }}>🔴 LIVE DATA UNAVAILABLE — the data providers did not return data. No fake prices are shown. Last attempt {lastUpdated}. <button aria-label="Retry live data" onClick={() => { coinQ.refetch(); marketsQ.refetch(); }} className="underline ml-2">Retry</button></div>}

        {/* Hero */}
        <section className="grid lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="flex justify-between flex-wrap gap-3">
              <div><div className="text-sm" style={{ color: "var(--dim)" }}>{selected.name} • {selected.symbol}/USDT</div>
                <div className="mono text-4xl font-bold mt-1">${fmt(market?.current_price)}</div>
                <div className="mono text-sm mt-1" style={{ color: (market?.price_change_percentage_24h ?? 0) >= 0 ? "var(--green)" : "var(--red)" }}>{market ? `${market.price_change_24h && market.price_change_24h >= 0 ? "+" : ""}$${fmt(market.price_change_24h)} (${fmt(market.price_change_percentage_24h)}%) 24h` : "Loading live price…"}</div></div>
              <div className="text-right"><button aria-label="Add to watchlist" onClick={() => addWatch.mutate()} className="px-3 py-1.5 rounded-lg text-xs font-bold" style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}>☆ Watchlist</button>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-3 text-xs mono text-right"><span style={{ color: "var(--dim)" }}>24h High</span><b>${fmt(market?.high_24h)}</b><span style={{ color: "var(--dim)" }}>24h Low</span><b>${fmt(market?.low_24h)}</b><span style={{ color: "var(--dim)" }}>Volume</span><b>{fmtBig(market?.total_volume)}</b><span style={{ color: "var(--dim)" }}>Mkt Cap</span><b>{fmtBig(market?.market_cap)}</b></div></div>
            </div>
            {/* Timeframes + toggles */}
            <div className="flex flex-wrap gap-1.5 mt-4 items-center">{TFS.map(t => <button key={t} aria-label={`Timeframe ${t}`} onClick={() => setTf(t)} className="px-2.5 py-1 rounded text-xs font-bold" style={{ background: tf === t ? "var(--green)" : "var(--surface2)", color: tf === t ? "#000" : "var(--text)" }}>{t}</button>)}
              <label className="text-xs ml-2 flex items-center gap-1"><input type="checkbox" aria-label="Show EMA" checked={showEMA} onChange={e => setShowEMA(e.target.checked)} /> EMA</label>
              <label className="text-xs flex items-center gap-1"><input type="checkbox" aria-label="Show Bollinger Bands" checked={showBB} onChange={e => setShowBB(e.target.checked)} /> Bollinger</label>
              {analysis && <span className="text-xs mono ml-auto" style={{ color: "var(--dim)" }}>RSI {analysis.curRsi.toFixed(1)} • MACD {analysis.macdHist >= 0 ? "+" : ""}{analysis.macdHist.toFixed(4)} • Vol {analysis.volatility.toFixed(1)}%</span>}
            </div>
            <div className="h-[320px] mt-2">
              <ResponsiveContainer width="100%" height="100%"><ComposedChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" /><XAxis dataKey="time" tick={{ fontSize: 9, fill: "#8b9bb4" }} interval="preserveStartEnd" /><YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "#8b9bb4" }} width={62} tickFormatter={(v: number) => `$${fmt(v)}`} /><Tooltip contentStyle={{ background: "#11161f", border: "1px solid #1e293b", fontSize: 12 }} formatter={(v: any, name: string) => name === "range" ? "" : `$${fmt(Number(v))}`} />
                {analysis && <ReferenceLine y={analysis.support} stroke="#00e676" strokeDasharray="4 4" label={{ value: `S $${fmt(analysis.support)}`, fill: "#00e676", fontSize: 10 }} />}
                {analysis && <ReferenceLine y={analysis.resistance} stroke="#ff5252" strokeDasharray="4 4" label={{ value: `R $${fmt(analysis.resistance)}`, fill: "#ff5252", fontSize: 10 }} />}
                <Bar dataKey="range" shape={<CandleShape />} isAnimationActive={false} />
                {showEMA && <Line type="monotone" dataKey="ema20" stroke="#ffb300" dot={false} strokeWidth={1.2} connectNulls />}
                {showEMA && <Line type="monotone" dataKey="ema50" stroke="#38bdf8" dot={false} strokeWidth={1.2} connectNulls />}
                {showBB && <Line type="monotone" dataKey="bbU" stroke="#a78bfa" dot={false} strokeWidth={0.8} strokeDasharray="3 3" connectNulls />}
                {showBB && <Line type="monotone" dataKey="bbL" stroke="#a78bfa" dot={false} strokeWidth={0.8} strokeDasharray="3 3" connectNulls />}
              </ComposedChart></ResponsiveContainer>
            </div>
            <div className="h-[64px] mt-1"><div className="text-[10px] font-bold" style={{ color: "var(--dim)" }}>VOLUME</div><ResponsiveContainer width="100%" height="85%"><BarChart data={chartData}><YAxis hide /><Bar dataKey="v" fill="#38bdf8" fillOpacity={0.55} isAnimationActive={false} /></BarChart></ResponsiveContainer></div>
            <div className="grid md:grid-cols-2 gap-3 mt-2">
              <div className="h-[110px]"><div className="text-[10px] font-bold" style={{ color: "var(--dim)" }}>RSI (14)</div><ResponsiveContainer width="100%" height="90%"><AreaChart data={chartData}><YAxis domain={[0, 100]} hide /><ReferenceLine y={70} stroke="#ff5252" strokeDasharray="3 3" /><ReferenceLine y={30} stroke="#00e676" strokeDasharray="3 3" /><Area dataKey="rsi" stroke="#ffb300" fill="#ffb30033" dot={false} /></AreaChart></ResponsiveContainer></div>
              <div className="h-[110px]"><div className="text-[10px] font-bold" style={{ color: "var(--dim)" }}>MACD</div><ResponsiveContainer width="100%" height="90%"><ComposedChart data={chartData}><YAxis hide /><Bar dataKey="macdHist" fill="#38bdf8" /><Line dataKey="macd" stroke="#00e676" dot={false} strokeWidth={1} /><Line dataKey="macdSig" stroke="#ff5252" dot={false} strokeWidth={1} /></ComposedChart></ResponsiveContainer></div>
            </div>
            <div className="text-[11px] mt-1" style={{ color: "var(--dim)" }}>Candles & volume: {coinQ.data?.source || "exchange feed"} • Support = recent swing low, Resistance = recent swing high • Chart auto-refreshes every 30s</div>
          </div>

          {/* Signal panel */}
          <div className="rounded-xl p-4 space-y-3" style={{ background: "var(--surface)", border: `1px solid ${trendColor}` }}>
            <div className="flex justify-between items-center"><span className="text-xs font-bold tracking-widest" style={{ color: "var(--dim)" }}>AI ANALYSIS • {selected.symbol}/USDT</span><span className="text-xs mono" style={{ color: "var(--dim)" }}>{lastUpdated}</span></div>
            {analysis ? <>
              <div><div className="text-xs" style={{ color: "var(--dim)" }}>TREND</div><div className="text-2xl font-black" style={{ color: trendColor }}>{analysis.trend === "UPTREND" ? "📈 UPTREND" : analysis.trend === "DOWNTREND" ? "📉 DOWNTREND" : "➡️ SIDEWAYS"}</div>
                <div className="h-2 rounded-full mt-2 overflow-hidden" style={{ background: "var(--surface2)" }}><div className="h-full rounded-full" style={{ width: `${analysis.strength}%`, background: trendColor }} /></div><div className="text-xs mt-1" style={{ color: "var(--dim)" }}>Trend strength {analysis.strength.toFixed(0)}% • Sentiment: <b style={{ color: trendColor }}>{analysis.sentiment}</b> • Confidence {analysis.confidence.toFixed(0)}%</div></div>
              <div className="rounded-lg p-3 text-center" style={{ background: signalBg, border: `1px solid ${trendColor}` }}><div className="text-xs" style={{ color: "var(--dim)" }}>SIGNAL</div><div className="text-xl font-black" style={{ color: trendColor }}>{analysis.signal === "BUY" ? "🟢" : analysis.signal === "SELL" ? "🔴" : "🟡"} {analysis.signalLabel}</div></div>
              <p className="text-sm leading-relaxed">{analysis.explanation}</p>
              <div><div className="text-xs font-bold mb-1">Why this signal?</div><ul className="space-y-1">{analysis.reasons.map((r, i) => <li key={i} className="text-xs flex gap-1.5"><span style={{ color: trendColor }}>•</span>{r}</li>)}</ul></div>
              <div className="grid grid-cols-2 gap-2 text-xs mono">
                <div className="rounded-lg p-2" style={{ background: "var(--surface2)" }}><div style={{ color: "var(--dim)" }}>Entry zone</div><b>{analysis.entryZone}</b></div>
                <div className="rounded-lg p-2" style={{ background: "var(--surface2)" }}><div style={{ color: "var(--dim)" }}>Stop-loss</div><b style={{ color: "var(--red)" }}>${fmt(analysis.sl)}</b></div>
                <div className="rounded-lg p-2" style={{ background: "var(--surface2)" }}><div style={{ color: "var(--dim)" }}>Take-profit 1 / 2</div><b style={{ color: "var(--green)" }}>${fmt(analysis.tp1)} / ${fmt(analysis.tp2)}</b></div>
                <div className="rounded-lg p-2" style={{ background: "var(--surface2)" }}><div style={{ color: "var(--dim)" }}>Risk / Reward</div><b>1 : {analysis.rr.toFixed(2)}</b></div>
                <div className="rounded-lg p-2" style={{ background: "var(--surface2)" }}><div style={{ color: "var(--dim)" }}>Support</div><b style={{ color: "var(--green)" }}>${fmt(analysis.support)}</b></div>
                <div className="rounded-lg p-2" style={{ background: "var(--surface2)" }}><div style={{ color: "var(--dim)" }}>Resistance</div><b style={{ color: "var(--red)" }}>${fmt(analysis.resistance)}</b></div>
              </div>
              {analysis.trend === "UPTREND" && <div className="text-xs rounded-lg p-2" style={{ background: "#052e16" }}>Uptrend playbook: buy pullbacks to support, don't chase near resistance, trail stop below support.</div>}
              {analysis.trend === "DOWNTREND" && <div className="text-xs rounded-lg p-2" style={{ background: "#2e0a0a" }}>Downtrend playbook: protect capital, reduce on bounces to resistance, wait for reversal confirmation.</div>}
              {analysis.trend === "SIDEWAYS" && <div className="text-xs rounded-lg p-2" style={{ background: "#2a2000" }}>Sideways playbook: WAIT — range-trade only at extremes or wait for a confirmed breakout.</div>}
            </> : <p className="text-sm" style={{ color: "var(--dim)" }}>{coinQ.isLoading ? "Analyzing live candles…" : "Not enough live candle data to analyze yet."}</p>}
          </div>
        </section>

        {/* Market overview */}
        <section className="rounded-xl overflow-hidden" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className="px-4 py-3 font-bold flex justify-between"><span>Market Overview — Top Coins (Live)</span><span className="text-xs font-normal" style={{ color: "var(--dim)" }}>Source: CoinGecko • {lastUpdated}</span></div>
          <div className="overflow-x-auto"><table className="w-full text-sm min-w-[560px]"><thead><tr className="text-left text-xs" style={{ color: "var(--dim)" }}><th className="px-4 py-2">Asset</th><th className="px-4 py-2">Price</th><th className="px-4 py-2">24h %</th><th className="px-4 py-2">24h High/Low</th><th className="px-4 py-2">Volume</th></tr></thead>
            <tbody>{(marketsQ.data?.markets || []).slice(0, 15).map(m => <tr key={m.id} onClick={() => { const c = COINS.find(x => x.id === m.id); setSelected(c || { id: m.id, symbol: m.symbol.toUpperCase(), name: m.name }); }} className="cursor-pointer hover:bg-white/5 border-t" style={{ borderColor: "var(--border)" }}><td className="px-4 py-2 font-bold">{m.symbol.toUpperCase()} <span className="font-normal" style={{ color: "var(--dim)" }}>{m.name}</span></td><td className="px-4 py-2 mono">${fmt(m.current_price)}</td><td className="px-4 py-2 mono" style={{ color: (m.price_change_percentage_24h ?? 0) >= 0 ? "var(--green)" : "var(--red)" }}>{fmt(m.price_change_percentage_24h)}%</td><td className="px-4 py-2 mono text-xs">${fmt(m.high_24h)} / ${fmt(m.low_24h)}</td><td className="px-4 py-2 mono text-xs">{fmtBig(m.total_volume)}</td></tr>)}</tbody></table></div>
        </section>

        <BacktestPanel selected={selected} balance={bal} riskPct={rp} />

        <div className="grid lg:grid-cols-3 gap-4">
          {/* Watchlist */}
          <section className="rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <h2 className="font-bold mb-3">Watchlist</h2>
            {(watchQ.data?.items || []).length === 0 && <p className="text-sm" style={{ color: "var(--dim)" }}>No coins yet — select a coin and tap ☆ Watchlist. It will update live here.</p>}
            <div className="space-y-2">{(watchQ.data?.items || []).map(w => { const m = watchMarketsQ.data?.markets.find(x => x.id === w.coinId); return <div key={w.id} className="flex items-center justify-between rounded-lg px-3 py-2" style={{ background: "var(--surface2)" }}><button aria-label={`View ${w.name}`} onClick={() => setSelected({ id: w.coinId, symbol: w.symbol, name: w.name })} className="text-left"><b>{w.symbol}</b> <span className="text-xs" style={{ color: "var(--dim)" }}>{w.name}</span><div className="mono text-xs">${fmt(m?.current_price)} <span style={{ color: (m?.price_change_percentage_24h ?? 0) >= 0 ? "var(--green)" : "var(--red)" }}>{fmt(m?.price_change_percentage_24h)}%</span></div></button><button aria-label={`Remove ${w.symbol} from watchlist`} onClick={() => removeWatch.mutate(w.id)} className="text-xs px-2 py-1 rounded" style={{ background: "#2e0a0a", color: "var(--red)" }}>Remove</button></div>; })}</div>
          </section>

          {/* Risk calculator */}
          <section className="rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <h2 className="font-bold mb-3">Risk Management Calculator</h2>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label>Account balance ($)<input aria-label="Account balance" type="number" value={balance} onChange={e => setBalance(e.target.value)} className="w-full mt-1 rounded px-2 py-2 mono" style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }} /></label>
              <label>Risk %<input aria-label="Risk percentage" type="number" value={riskPct} onChange={e => setRiskPct(e.target.value)} className="w-full mt-1 rounded px-2 py-2 mono" style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }} /></label>
              <label>Entry price<input aria-label="Entry price" type="number" value={entry} onChange={e => setEntry(e.target.value)} className="w-full mt-1 rounded px-2 py-2 mono" style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }} /></label>
              <label>Stop-loss price<input aria-label="Stop-loss price" type="number" value={stop} onChange={e => setStop(e.target.value)} className="w-full mt-1 rounded px-2 py-2 mono" style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }} /></label>
            </div>
            <button aria-label="Use live price as entry" onClick={() => market && setEntry(String(market.current_price))} className="mt-2 text-xs underline" style={{ color: "var(--green)" }}>Use live price as entry</button>
            <div className="mt-3 space-y-1.5 text-sm mono">
              <div className="flex justify-between"><span style={{ color: "var(--dim)" }}>Max loss</span><b style={{ color: "var(--red)" }}>${fmt(riskAmt)}</b></div>
              <div className="flex justify-between"><span style={{ color: "var(--dim)" }}>Position size</span><b>{fmt(posSize, 6)} {selected.symbol}</b></div>
              <div className="flex justify-between"><span style={{ color: "var(--dim)" }}>Position value</span><b>${fmt(posValue)}</b></div>
              {tpLevels.map(t => <div key={t.label} className="flex justify-between"><span style={{ color: "var(--dim)" }}>{t.label}</span><b style={{ color: "var(--green)" }}>${fmt(t.price)} (1:{t.rr})</b></div>)}
            </div>
          </section>

          {/* Alerts */}
          <section className="rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <h2 className="font-bold mb-3">Alerts — {selected.symbol}</h2>
            <div className="flex gap-2 flex-wrap">
              <select aria-label="Alert type" value={alertType} onChange={e => setAlertType(e.target.value)} className="rounded px-2 py-2 text-xs flex-1" style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }}>
                <option value="price_above">Price reaches above</option><option value="price_below">Price falls below</option><option value="rsi_oversold">RSI oversold (&lt;30)</option><option value="rsi_overbought">RSI overbought (&gt;70)</option><option value="bullish_trend">Bullish trend detected</option><option value="bearish_trend">Bearish trend detected</option><option value="buy_signal">BUY signal</option><option value="sell_signal">SELL signal</option>
              </select>
              {(alertType === "price_above" || alertType === "price_below") && <input aria-label="Alert price level" type="number" value={alertValue} onChange={e => setAlertValue(e.target.value)} placeholder="Price" className="rounded px-2 py-2 text-xs w-24 mono" style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }} />}
              <button aria-label="Create alert" onClick={() => addAlert.mutate()} className="px-3 py-2 rounded text-xs font-bold text-black" style={{ background: "var(--green)" }}>Add Alert</button>
            </div>
            <div className="space-y-2 mt-3">{(alertsQ.data?.items || []).map(a => <div key={a.id} className="flex justify-between items-center rounded-lg px-3 py-2 text-xs" style={{ background: triggered(a) ? "#052e16" : "var(--surface2)", border: triggered(a) ? "1px solid var(--green)" : "none" }}><span><b>{a.symbol}</b> — {a.type.replaceAll("_", " ")} {a.value ? `$${fmt(a.value)}` : ""} {triggered(a) && <b style={{ color: "var(--green)" }}>• TRIGGERED</b>}</span><button aria-label={`Delete alert for ${a.symbol}`} onClick={() => removeAlert.mutate(a.id)} style={{ color: "var(--red)" }}>Delete</button></div>)}
              {(alertsQ.data?.items || []).length === 0 && <p className="text-xs" style={{ color: "var(--dim)" }}>No alerts yet. Alerts are checked live against the selected coin's price, RSI, trend and signal every refresh.</p>}</div>
          </section>
        </div>

        {/* About / summary */}
        <section className="rounded-xl p-4 text-sm leading-relaxed space-y-2" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <h2 className="font-bold text-base">How Stragis Works</h2>
          <p><b>Live data:</b> Prices, 24h high/low, volume and OHLCV candles come live from Binance (primary) with automatic Kraken fallback, and auto-refresh every 30 seconds (LIVE badge + timestamp above). CoinGecko supplies market-cap rankings and search, cached to respect its free rate limit. If all providers are unavailable, Stragis shows LIVE DATA UNAVAILABLE instead of fake prices. Supported: BTC, ETH, SOL, XRP, BNB, DOGE, ADA, AVAX, LINK, DOT and any coin via search.</p>
          <p><b>Signals:</b> BUY / SELL / WAIT is a multi-factor score — price vs 50/200 EMA, 20/50 EMA alignment, RSI, MACD histogram, distance to support/resistance, momentum and volatility (Bollinger width). Uptrend = score ≥ +3, Downtrend = ≤ −3, otherwise Sideways. Every signal lists its reasons, entry zone, stop-loss, take-profits and risk/reward.</p>
          <p><b>Backtesting:</b> Use the <b>Run Backtest</b> button to test those same rules over the last 3 or 5 days. It uses completed historical candles, a 200-candle warm-up, next-candle-open entries, and SL/TP1 exits. It excludes fees and slippage, so treat it as a rules check — not proof of future profit.</p>
          <p><b>Indicators:</b> EMA 20/50/200, SMA, RSI 14, MACD 12/26/9, Bollinger Bands 20/2, swing support/resistance. <b>Risk:</b> position size = (balance × risk%) ÷ |entry − stop|. <b>Alerts & watchlist</b> persist and are evaluated live.</p>
          <p style={{ color: "var(--dim)" }}>Limitations: Indicators describe the past and present — they cannot predict prices. Exchange feeds reflect that exchange's own trades; prices can differ slightly between exchanges. Always verify on your exchange before trading.</p>
        </section>

        <footer className="rounded-xl p-4 text-xs leading-relaxed" style={{ background: "#1a1200", border: "1px solid var(--amber)", color: "#fde68a" }}>
          ⚠️ Stragis provides market analysis and educational information based on available market data. Trading cryptocurrency involves substantial risk, and past performance does not guarantee future results. Signals are not guaranteed predictions or financial advice. Always conduct your own research and consider your risk tolerance.
          <div className="mt-2" style={{ color: "var(--dim)" }}>Data source: CoinGecko • Stragis — Understand the Trend. Trade With a Plan.</div>
        </footer>
        </>}
      </main>
    </div>
  );
}
