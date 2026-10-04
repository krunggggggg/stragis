import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from "recharts";

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

function ema(values: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1); const out: (number | null)[] = []; let prev: number | null = null;
  values.forEach((v, i) => { if (i < period - 1) { out.push(null); return; } if (prev === null) { prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period; out.push(prev); } else { prev = v * k + prev * (1 - k); out.push(prev); } });
  return out;
}
function atr(candles: Candle[], period = 14): number | null {
  if (candles.length <= period) return null; const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) { const c = candles[i]!, p = candles[i - 1]!; trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c))); }
  const last = trs.slice(-period); return last.reduce((a, b) => a + b, 0) / last.length;
}
function fmt(n: number | null | undefined, dec = 2) { if (n == null || !isFinite(n)) return "—"; return n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec }); }
function etDate(ms: number) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)); }
function swings(candles: Candle[], win = 2) {
  const highs: { idx: number; price: number; t: number }[] = []; const lows: { idx: number; price: number; t: number }[] = [];
  for (let i = win; i < candles.length - win; i++) {
    const c = candles[i]!; let isH = true, isL = true;
    for (let j = 1; j <= win; j++) { if (candles[i - j]!.h >= c.h || candles[i + j]!.h > c.h) isH = false; if (candles[i - j]!.l <= c.l || candles[i + j]!.l < c.l) isL = false; }
    if (isH) highs.push({ idx: i, price: c.h, t: c.t }); if (isL) lows.push({ idx: i, price: c.l, t: c.t });
  }
  return { highs, lows };
}
function structure(candles: Candle[]) {
  if (candles.length < 30) return { label: "Unclear", text: "Not enough candles to establish structure.", e20: null as number | null, e50: null as number | null, e200: null as number | null };
  const closes = candles.map(c => c.c); const last = closes.length - 1; const price = closes[last]!;
  const e20 = ema(closes, 20)[last]; const e50 = ema(closes, 50)[last]; const e200 = ema(closes, Math.min(200, closes.length - 1))[last];
  const sw = swings(candles.slice(-80));
  const hh = sw.highs.slice(-2); const ll = sw.lows.slice(-2);
  const risingHighs = hh.length === 2 && hh[1]!.price > hh[0]!.price; const risingLows = ll.length === 2 && ll[1]!.price > ll[0]!.price;
  const fallingHighs = hh.length === 2 && hh[1]!.price < hh[0]!.price; const fallingLows = ll.length === 2 && ll[1]!.price < ll[0]!.price;
  let label = "Ranging"; let seq = "swing sequence is mixed";
  if (risingHighs && risingLows) { label = "Bullish"; seq = "Higher Highs + Higher Lows"; }
  else if (fallingHighs && fallingLows) { label = "Bearish"; seq = "Lower Highs + Lower Lows"; }
  else if (risingHighs || risingLows) seq = "partially rising swings (mixed HH/HL evidence)";
  else if (fallingHighs || fallingLows) seq = "partially falling swings (mixed LH/LL evidence)";
  const emaNote = `Price ${e50 ? (price > e50 ? "above" : "below") : "vs"} 50 EMA${e50 ? ` ($${fmt(e50)})` : ""}${e200 ? ` and ${price > e200 ? "above" : "below"} 200 EMA ($${fmt(e200)})` : ""}`;
  if (label === "Ranging" && e50 && e20) { if (price > e50 && e20 > e50) label = "Bullish"; else if (price < e50 && e20 < e50) label = "Bearish"; }
  return { label, text: `${seq}. ${emaNote}.`, e20, e50, e200 };
}
function CandleShape(props: any) {
  const { x, y, width, height, payload } = props; if (!payload) return null;
  const { o, h, l, c } = payload; const range = h - l || 1;
  const top = y + ((h - Math.max(o, c)) / range) * height; const bottom = y + ((h - Math.min(o, c)) / range) * height;
  const color = c >= o ? "#d4af37" : "#ff5252"; const cx = x + width / 2;
  return <g><line x1={cx} x2={cx} y1={y} y2={y + height} stroke={color} strokeWidth={1} /><rect x={x + 1} y={top} width={Math.max(width - 2, 2)} height={Math.max(bottom - top, 1)} fill={color} /></g>;
}

const NEWS_KEYWORDS = ["fomc", "federal funds", "cpi", "pce", "non-farm", "nonfarm", "unemployment", "gdp", "powell", "fed chair", "interest rate", "federal reserve"];

export function GoldSection() {
  const goldQ = useQuery({ queryKey: ["gold"], queryFn: () => api.getGoldData({}), refetchInterval: 30000 });
  const d = goldQ.data;
  const [balance, setBalance] = useState("10000"); const [riskPct, setRiskPct] = useState("0.5");
  const [gEntry, setGEntry] = useState(""); const [gStop, setGStop] = useState(""); const [vpp, setVpp] = useState("1");

  const A = useMemo(() => {
    if (!d || !d.spot) return null;
    // PURE SPOT ONLY: candles come from the server's spot tick recorder
    // (Swissquote XAU/USD spot ticks). No futures data, no offset adjustment.
    const m5 = d.m5, m15 = d.m15, h1 = d.h1, h4 = d.h4, daily = d.daily;
    const price = d.spot.price;
    const now = Date.now();
    const spotTs = d.spotTs ?? (d.spot.updatedAt ? new Date(d.spot.updatedAt).getTime() : 0);
    const ageH = spotTs ? (now - spotTs) / 3600_000 : 999;
    const etNow = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false }).format(new Date(now));
    const isWeekendClosed = etNow.startsWith("Sat") || (etNow.startsWith("Fri") && parseInt(etNow.replace(/\D/g, "") || "0") >= 17) || (etNow.startsWith("Sun") && parseInt(etNow.replace(/\D/g, "") || "0") < 18);
    const closed = isWeekendClosed || ageH > 3;
    // ---- Spot-history availability (recorded spot ticks only) ----
    const NEED = { m5: 40, m15: 40, h1: 60, h4: 60 } as const;
    const ready = { m5: m5.length >= NEED.m5, m15: m15.length >= NEED.m15, h1: h1.length >= NEED.h1, h4: h4.length >= NEED.h4 };
    const historyReady = ready.m5 && ready.m15 && ready.h1 && ready.h4;
    const h4s = ready.h4 ? structure(h4) : { label: "Unclear", text: `LIVE DATA UNAVAILABLE — only ${h4.length} recorded spot H4 bars so far (need ${NEED.h4}). H4 structure unlocks as genuine spot ticks accumulate.`, e20: null, e50: null, e200: null };
    const h1s = ready.h1 ? structure(h1) : { label: "Unclear", text: `LIVE DATA UNAVAILABLE — only ${h1.length} recorded spot H1 bars so far (need ${NEED.h1}). H1 structure unlocks as genuine spot ticks accumulate.`, e20: null, e50: null, e200: null };
    const bias = h4s.label === "Bullish" && h1s.label !== "Bearish" ? "Bullish" : h4s.label === "Bearish" && h1s.label !== "Bullish" ? "Bearish" : (h4s.label === "Ranging" || h1s.label === "Ranging") ? "Range" : h4s.label === "Unclear" && h1s.label === "Unclear" ? "Neutral" : h1s.label;
    // PDH / PDL from daily bars
    const todayET = etDate(now);
    const lastDaily = daily[daily.length - 1];
    const prevDaily = lastDaily && etDate(lastDaily.t) === todayET ? daily[daily.length - 2] : lastDaily;
    const pdh = prevDaily?.h ?? null; const pdl = prevDaily?.l ?? null;
    // Session H/L from latest trading date in M5
    const lastM5 = m5[m5.length - 1];
    const sessDate = lastM5 ? etDate(lastM5.t) : null;
    const sessCandles = sessDate ? m5.filter(c => etDate(c.t) === sessDate) : [];
    const sessHigh = sessCandles.length ? Math.max(...sessCandles.map(c => c.h)) : null;
    const sessLow = sessCandles.length ? Math.min(...sessCandles.map(c => c.l)) : null;
    // VWAP: spot XAU/USD is OTC — there is no centralised traded volume, and the
    // spot tick feed carries no volume (candle "v" here is a tick count, not volume).
    // VWAP is therefore UNAVAILABLE on the pure-spot feed. It is never borrowed
    // from futures volume. The VWAP/EMA score component uses EMA confluence only.
    const vwap: number | null = null; const vwapSeries: (number | null)[] = m15.map(() => null);
    // Support / resistance from H1 swings
    const swH1 = swings(h1.slice(-120));
    const resAbove = swH1.highs.filter(s => s.price > price).sort((a, b) => a.price - b.price)[0]?.price ?? null;
    const supBelow = swH1.lows.filter(s => s.price < price).sort((a, b) => b.price - a.price)[0]?.price ?? null;
    const resistance: number | null = resAbove ?? (pdh && pdh > price ? pdh : null) ?? (h1.length ? Math.max(...h1.slice(-40).map(c => c.h)) : null);
    const support: number | null = supBelow ?? (pdl && pdl < price ? pdl : null) ?? (h1.length ? Math.min(...h1.slice(-40).map(c => c.l)) : null);
    // Equal highs / lows (liquidity pools)
    const eqHighs: number[] = []; const eqLows: number[] = [];
    const allH = swH1.highs, allL = swH1.lows;
    for (let i = 0; i < allH.length; i++) for (let j = i + 1; j < allH.length; j++) { if (Math.abs(allH[i]!.price - allH[j]!.price) / allH[i]!.price < 0.0015) eqHighs.push((allH[i]!.price + allH[j]!.price) / 2); }
    for (let i = 0; i < allL.length; i++) for (let j = i + 1; j < allL.length; j++) { if (Math.abs(allL[i]!.price - allL[j]!.price) / allL[i]!.price < 0.0015) eqLows.push((allL[i]!.price + allL[j]!.price) / 2); }
    // Liquidity sweep on recent M15 candles
    let sweep: "bullish" | "bearish" | null = null; let sweepText = "No confirmed liquidity sweep on the latest M15 candles — price has not swept PDH/PDL or a major swing and closed back inside.";
    for (const c of m15.slice(-4)) {
      if (pdl && c.l < pdl && c.c > pdl) { sweep = "bullish"; sweepText = `Bullish sweep: M15 wicked below PDL ($${fmt(pdl)}) and closed back above it — stops below PDL were taken.`; }
      if (support && c.l < support && c.c > support && !sweep) { sweep = "bullish"; sweepText = `Bullish sweep: M15 wicked below support ($${fmt(support)}) and closed back above.`; }
      if (pdh && c.h > pdh && c.c < pdh) { sweep = "bearish"; sweepText = `Bearish sweep: M15 wicked above PDH ($${fmt(pdh)}) and closed back below it — stops above PDH were taken.`; }
      if (resistance && c.h > resistance && c.c < resistance && sweep !== "bearish") { /* resistance sweep check */ if (c.h > resistance && c.c < resistance) { sweep = "bearish"; sweepText = `Bearish sweep: M15 wicked above resistance ($${fmt(resistance)}) and closed back below.`; } }
    }
    // M5 MSS: break of recent M5 swing
    const swM5 = swings(m5.slice(-40));
    const lastM5Close = m5[m5.length - 1]?.c ?? price;
    const recentSwingHigh = swM5.highs[swM5.highs.length - 1]?.price ?? null;
    const recentSwingLow = swM5.lows[swM5.lows.length - 1]?.price ?? null;
    let mss: "bullish" | "bearish" | null = null;
    if (recentSwingHigh && lastM5Close > recentSwingHigh) mss = "bullish";
    if (recentSwingLow && lastM5Close < recentSwingLow) mss = "bearish";
    const atrM15 = atr(m15); const atrH1 = atr(h1);
    // News: upcoming USD events, imminent high-impact check
    const events = (d.news || []).map(e => ({ ...e, ts: new Date(e.date).getTime() })).filter(e => !isNaN(e.ts)).sort((a, b) => a.ts - b.ts);
    const upcoming = events.filter(e => e.ts > now - 30 * 60_000).slice(0, 6);
    const imminent = upcoming.find(e => e.impact === "High" && e.ts - now < 2 * 3600_000 && e.ts > now - 30 * 60_000 && NEWS_KEYWORDS.some(k => e.title.toLowerCase().includes(k)));
    const highSoon = upcoming.find(e => e.impact === "High" && e.ts - now < 24 * 3600_000);
    // Direction & trade plan
    const direction: "long" | "short" | null = resistance == null || support == null ? null : bias === "Bullish" && (sweep === "bullish" || mss === "bullish") ? "long" : bias === "Bearish" && (sweep === "bearish" || mss === "bearish") ? "short" : bias === "Bullish" && mss === "bullish" ? "long" : bias === "Bearish" && mss === "bearish" ? "short" : null;
    const buf = (atrM15 ?? 5) * 0.15;
    let entry: number | null = null, sl: number | null = null, tp1: number | null = null, tp2: number | null = null, rr: number | null = null;
    if (direction === "long" && resistance != null && support != null) { entry = price; sl = (recentSwingLow ?? support) - buf; tp1 = resistance; tp2 = eqHighs.find(x => x > resistance) ?? resistance + (resistance - support); }
    if (direction === "short" && resistance != null && support != null) { entry = price; sl = (recentSwingHigh ?? resistance) + buf; tp1 = support; tp2 = eqLows.find(x => x < support) ?? support - (resistance - support); }
    if (entry != null && sl != null && tp1 != null && Math.abs(entry - sl) > 0) rr = Math.abs(tp1 - entry) / Math.abs(entry - sl);
    // ---- Scoring /100 ----
    let sHTF = 0; if (h4s.label === h1s.label && (h4s.label === "Bullish" || h4s.label === "Bearish")) sHTF = 20; else if (h4s.label !== "Unclear" && h1s.label !== "Unclear" && bias !== "Range") sHTF = 12; else if (bias === "Range") sHTF = 8; else sHTF = 4;
    const distToLevel = Math.min(...[pdh, pdl, sessHigh, sessLow, resistance, support].filter((x): x is number => x != null).map(x => Math.abs(price - x) / price * 100), 999);
    let sLiq = sweep ? 20 : distToLevel < 0.3 ? 12 : distToLevel < 1 ? 7 : 3;
    let sM15 = 0; if (!closed) { sM15 = sweep ? 15 : (mss ? 9 : distToLevel < 0.5 ? 6 : 2); }
    let sM5 = 0; if (!closed) { sM5 = mss && sweep && mss === sweep ? 15 : mss ? 9 : 0; }
    const closesM15 = m15.map(c => c.c); const e20 = ema(closesM15, 20)[closesM15.length - 1]; const e50 = ema(closesM15, 50)[closesM15.length - 1]; const e200 = ema(closesM15, Math.min(200, closesM15.length - 1))[closesM15.length - 1];
    // VWAP unavailable on spot (no volume) — this component scores EMA confluence
    // only and is capped at 6/10; the 4 VWAP points are never awarded from a proxy.
    let sVW = 0; if (!closed && historyReady) { const emaAlign = e20 != null && e50 != null && ((bias === "Bullish" && e20 > e50) || (bias === "Bearish" && e20 < e50)); const priceAlign = e50 != null && ((bias === "Bullish" && price > e50) || (bias === "Bearish" && price < e50)); sVW = emaAlign && priceAlign ? 6 : emaAlign || priceAlign ? 3 : 0; }
    let sRR = 0; if (rr != null) sRR = rr >= 2.5 ? 10 : rr >= 2 ? 8 : rr >= 1.5 ? 5 : rr >= 1 ? 3 : 0;
    let sNews = imminent ? 0 : highSoon ? 6 : upcoming.length ? 8 : 5;
    if (closed || !historyReady) { sM15 = 0; sM5 = 0; sVW = 0; sRR = 0; }
    const score = sHTF + sLiq + sM15 + sM5 + sVW + sRR + sNews;
    const grade = score >= 90 ? "A+" : score >= 80 ? "A" : score >= 70 ? "B" : score >= 60 ? "Weak" : "NO TRADE";
    // ---- Decision ----
    let decision = "NO TRADE"; let decisionNote = "NO TRADE — WAIT FOR BETTER CONDITIONS.";
    if (!d.ok) { decision = "NO TRADE"; decisionNote = "LIVE DATA UNAVAILABLE — no decision can be made without confirmed data."; }
    else if (imminent) { decision = "NO TRADE"; decisionNote = `NO TRADE — HIGH-IMPACT NEWS RISK. ${imminent.title} at ${new Date(imminent.ts).toLocaleString()}.`; }
    else if (closed) { decision = "NO TRADE"; decisionNote = "NO TRADE — MARKET CLOSED. Gold trades Sun 18:00 – Fri 17:00 ET. No M15 setup or M5 confirmation can form on a closed market; levels below are from the last completed session."; }
    else if (!historyReady) { decision = "NO TRADE"; decisionNote = `NO TRADE — SPOT CANDLE HISTORY STILL BUILDING. Recorded spot bars: M5 ${m5.length}/${NEED.m5} • M15 ${m15.length}/${NEED.m15} • H1 ${h1.length}/${NEED.h1} • H4 ${h4.length}/${NEED.h4}. This section is pure spot XAU/USD — no futures fallback is used, so no trade analysis is offered until enough genuine spot candles have been recorded.`; }
    else if (score < 60) { decision = "NO TRADE"; decisionNote = `Setup score ${score}/100 is below the 60 minimum — NO TRADE.`; }
    else if (score < 70) { decision = "WAIT"; decisionNote = `Weak setup (${score}/100, 60–69). WAIT for stronger confirmation.`; }
    else if (!direction) { decision = "WAIT"; decisionNote = "No directional confirmation (no sweep + MSS aligned with HTF bias). WAIT."; }
    else if (rr != null && rr < 2) { decision = "WAIT"; decisionNote = `R:R to TP1 is 1:${rr.toFixed(2)}, below the preferred minimum 1:2. WAIT for a better entry (pullback).`; }
    else { decision = direction === "long" ? "BUY" : "SELL"; decisionNote = `${decision} setup qualifies: score ${score}/100 (${grade}), R:R 1:${rr?.toFixed(2)}. Entry only on M5 confirmation at the level — do not chase.`; }
    const confidence = closed || !d.ok || !historyReady ? "High (in the NO TRADE decision)" : score >= 80 ? "High" : score >= 65 ? "Medium" : "Low";
    const m15SetupText = !ready.m15 ? `LIVE DATA UNAVAILABLE — M15 spot candle history is still building (${m15.length}/${NEED.m15} bars recorded from Swissquote spot ticks). No M15 setup can be assessed until enough genuine spot candles exist — no futures substitute is used.`
      : closed ? "None — market closed. On the next session, require: liquidity sweep of PDH/PDL or a major swing, OR breakout + retest, OR rejection at VWAP/EMA confluence in the direction of the H1/H4 bias. Price mid-range is no-man's-land."
      : sweep ? `${sweepText} Next: wait for the pullback to the swept level / VWAP and M5 confirmation — do not enter on the sweep alone.`
      : `No completed M15 setup. Price is ${distToLevel.toFixed(2)}% from the nearest key level. Watch PDH ($${fmt(pdh)}), PDL ($${fmt(pdl)}), session extremes and VWAP for a sweep, breakout/retest, or rejection aligned with the ${bias} bias.`;
    const m5Text = !ready.m5 ? `LIVE DATA UNAVAILABLE — M5 spot candle history is still building (${m5.length}/${NEED.m5} bars recorded from spot ticks). No M5 confirmation can exist yet.`
      : closed ? "None available — market closed. Required before any entry: sweep first, then an M5 market structure shift in the trade direction, then a pullback that holds, with the stop beyond structural invalidation and R:R ≥ 1:2."
      : mss ? `M5 shows a ${mss} market structure shift (last M5 close ${mss === "bullish" ? "above" : "below"} the recent M5 swing ${mss === "bullish" ? `$${fmt(recentSwingHigh)}` : `$${fmt(recentSwingLow)}`}). Confirmation still requires a pullback that holds — a single M5 break is not an entry by itself.`
      : `No M5 market structure shift yet. Required: ${bias === "Bullish" ? "break and hold above the recent M5 swing high" : bias === "Bearish" ? "break and hold below the recent M5 swing low" : "a clear M5 shift in either direction after a sweep"} before any entry.`;
    const invalidation = direction === "long" ? `Long idea is invalidated by an M15 close below ${sl ? `$${fmt(sl)}` : "the swept low / support"} — the sweep low and support structure would be lost. Also invalid if price reclaims nothing and H1 closes back below the 50 EMA.`
      : direction === "short" ? `Short idea is invalidated by an M15 close above ${sl ? `$${fmt(sl)}` : "the swept high / resistance"} — the sweep high and resistance structure would be reclaimed.`
      : `The current ${bias} lean is invalidated by an H1 close ${bias === "Bearish" ? `above resistance ($${fmt(resistance)}) that holds on a retest` : `through the opposite side of the range (support $${fmt(support)} / resistance $${fmt(resistance)}) with a confirmed M5 shift`}. The NO TRADE stance is only lifted by sweep → MSS → pullback → M5 confirmation with R:R ≥ 1:2.`;
    const why = decision === "BUY" || decision === "SELL" ? `HTF bias (${bias}), liquidity event, and M5 confirmation align, VWAP/EMA confluence supports the direction, and the plan offers at least 1:2 to TP1. Risk stays at 0.25%–0.5% of equity — the setup can still fail; the stop defines the trade.`
      : closed ? "The market is closed, so no live M15 setup, M5 confirmation, or session VWAP exists. Trading a plan built on stale prices violates the framework — capital preservation comes before frequency."
      : !historyReady ? "The framework requires H4/H1 structure, an M15 setup and M5 confirmation — all from genuine spot candles. Those candles are still being recorded from the live Swissquote spot tick feed, and this section uses no futures substitute, so there is nothing honest to analyse yet."
      : imminent ? "A high-impact USD event is imminent. Even a valid technical setup is vulnerable to a volatility spike that can jump stops — the framework's news filter overrides the technicals."
      : `Score ${score}/100 (${grade}). Missing or weak elements are listed in the score breakdown — the framework requires sweep → MSS → pullback → confirmation, aligned with H4/H1 structure, at ≥1:2 R:R. Until those align, the correct decision is to wait.`;
    const liquidityText = [
      pdh ? `PDH $${fmt(pdh)}${price < (pdh ?? 0) ? " — liquidity resting above" : " — already taken / price above"}` : null,
      pdl ? `PDL $${fmt(pdl)}${price > (pdl ?? 0) ? " — liquidity resting below" : " — already taken / price below"}` : null,
      eqHighs.length ? `Equal highs near $${fmt(eqHighs[eqHighs.length - 1])} — stop pool above` : null,
      eqLows.length ? `Equal lows near $${fmt(eqLows[eqLows.length - 1])} — stop pool below` : null,
      `Nearest swing liquidity: above $${fmt(resistance)}, below $${fmt(support)}`,
      sessHigh ? `Session high $${fmt(sessHigh)} / session low $${fmt(sessLow)}` : null,
    ].filter(Boolean).join(" • ");
    const chartData = m15.slice(-96).map((c, i, arr) => ({ ...c, range: [c.l, c.h], time: new Date(c.t).toLocaleDateString([], { month: "short", day: "numeric" }) + " " + new Date(c.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), ema20: ema(m15.map(x => x.c), 20)[m15.length - arr.length + i], ema50: ema(m15.map(x => x.c), 50)[m15.length - arr.length + i], vwap: vwapSeries[m15.length - arr.length + i] }));
    return { ready, historyReady, NEED, spotBid: d.spot.bid, spotAsk: d.spot.ask, crossCheck: d.crossCheck, tickStats: d.tickStats, m5, m15, h1, h4, daily, price, closed, ageH, h4s, h1s, bias, pdh, pdl, sessHigh, sessLow, sessDate, vwap, resistance, support, eqHighs, eqLows, sweep, sweepText, mss, recentSwingHigh, recentSwingLow, atrM15, atrH1, upcoming, imminent, direction, entry, sl, tp1, tp2, rr, sHTF, sLiq, sM15, sM5, sVW, sRR, sNews, score, grade, decision, decisionNote, confidence, m15SetupText, m5Text, invalidation, why, liquidityText, e20, e50, e200, chartData };
  }, [d]);

  const liveOk = !!d?.ok && !!A && !A.closed;
  const bal = parseFloat(balance) || 0, rp = parseFloat(riskPct) || 0;
  const en = parseFloat(gEntry) || A?.entry || 0, st = parseFloat(gStop) || A?.sl || 0, vppN = parseFloat(vpp) || 0;
  const riskAmt = bal * rp / 100; const slDist = Math.abs(en - st);
  const posOz = slDist > 0 && vppN > 0 ? riskAmt / (slDist * vppN) : 0;
  const decColor = A?.decision === "BUY" ? "var(--green)" : A?.decision === "SELL" ? "var(--red)" : "var(--amber)";
  const scoreRows = A ? [["Higher-timeframe structure", A.sHTF, 20], ["Liquidity setup", A.sLiq, 20], ["M15 confirmation", A.sM15, 15], ["M5 confirmation", A.sM5, 15], ["VWAP / EMA confluence (EMA only — spot has no volume, cap 6)", A.sVW, 10], ["Risk / Reward", A.sRR, 10], ["News / Macro environment", A.sNews, 10]] as const : [];

  return (
    <div className="space-y-4">
      {/* Gold header */}
      <section className="rounded-xl p-4" style={{ background: "linear-gradient(135deg,#1a1503,#11161f)", border: "1px solid #d4af37" }}>
        <div className="flex justify-between flex-wrap gap-3">
          <div>
            <div className="text-xs font-black tracking-widest" style={{ color: "#d4af37" }}>🥇 GOLD ONLY — SEPARATE FROM CRYPTO</div>
            <div className="text-2xl font-black mt-1">XAU/USD Intraday Analysis</div>
            <div className="text-xs mt-1" style={{ color: "var(--dim)" }}>H4/H1 bias → M15 setup → M5 confirmation • Liquidity sweep → MSS → Pullback → Confirmation → Entry</div>
          </div>
          <div className="text-right">
            <span className="flex items-center gap-1.5 text-xs font-bold px-2 py-1 rounded-full justify-center" style={{ background: liveOk ? "#052e16" : "#2a2000", color: liveOk ? "var(--green)" : "var(--amber)" }}><span className="w-2 h-2 rounded-full animate-pulse" style={{ background: liveOk ? "var(--green)" : "var(--amber)" }} />{!d?.ok ? "DATA UNAVAILABLE" : A?.closed ? "MARKET CLOSED" : "LIVE"}</span>
            <div className="mono text-3xl font-bold mt-2" style={{ color: "#d4af37" }}>${fmt(A?.price)}</div>
            <div className="text-[11px]" style={{ color: "var(--dim)" }}>Spot XAU/USD {A?.spotBid != null ? `• Bid $${fmt(A.spotBid)} / Ask $${fmt(A.spotAsk)}` : ""} • Updated {d?.fetchedAt ? new Date(d.fetchedAt).toLocaleTimeString() : "—"}{A ? ` • Spot quote ${A.ageH >= 999 ? "—" : A.ageH < 1 ? `${Math.round(A.ageH * 60)}m old` : `${A.ageH.toFixed(1)}h old`}` : ""}</div>
            {A?.crossCheck && <div className="text-[11px]" style={{ color: "var(--dim)" }}>Cross-check only: {A.crossCheck.source} ${fmt(A.crossCheck.price)} (Δ ${fmt(Math.abs(A.crossCheck.price - A.price))} vs Swissquote mid) — never used for levels or signals.</div>}
          </div>
        </div>
        <div className="text-[11px] mt-2" style={{ color: "var(--dim)" }}>Sources: Spot — {d?.spotSource}. Candles — {d?.candleSource}. News — {d?.newsSource}.</div>
      </section>

      {/* Pure-spot coverage / transparency */}
      {d?.ok && A && <section className="rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div className="flex justify-between flex-wrap gap-2 items-center"><b className="text-sm">Pure Spot Coverage — no futures data in this section</b><span className="text-[11px] mono" style={{ color: "var(--dim)" }}>{A.tickStats.count.toLocaleString()} spot ticks recorded{A.tickStats.firstTs ? ` since ${new Date(A.tickStats.firstTs).toLocaleString()}` : ""}</span></div>
        <div className="flex flex-wrap gap-2 mt-2">{([["M5", A.m5.length, A.NEED.m5, A.ready.m5], ["M15", A.m15.length, A.NEED.m15, A.ready.m15], ["H1", A.h1.length, A.NEED.h1, A.ready.h1], ["H4", A.h4.length, A.NEED.h4, A.ready.h4], ["Daily", A.daily.length, 2, A.daily.length >= 2]] as const).map(([tf, n, need, okReady]) => <span key={tf} className="text-[11px] font-bold px-2 py-1 rounded-full" style={{ background: okReady ? "#052e16" : "#2a2000", color: okReady ? "var(--green)" : "var(--amber)" }}>{tf}: {n}/{need} bars {okReady ? "READY" : "UNAVAILABLE — building"}</span>)}</div>
        <p className="text-[11px] mt-2 leading-relaxed" style={{ color: "var(--dim)" }}>Candles are aggregated only from Swissquote XAU/USD spot ticks this app records while the feed is polled. A timeframe without enough recorded spot bars shows LIVE DATA UNAVAILABLE and forces NO TRADE — there is no futures fallback and no backfill is invented. PDH/PDL need one full previous recorded spot day. Spot gold is OTC: there is no centralised traded volume, so session VWAP cannot be computed from a spot tick feed and is marked unavailable rather than borrowed from COMEX futures volume; the VWAP/EMA score uses EMA confluence only (capped at 6/10).</p>
      </section>}

      {!goldQ.isLoading && !d?.ok && <div className="rounded-xl p-4 text-center font-bold" style={{ background: "#2e0a0a", color: "var(--red)", border: "1px solid var(--red)" }}>🔴 LIVE DATA UNAVAILABLE — gold sources did not return data. No fake prices are shown. <button aria-label="Retry gold data" onClick={() => goldQ.refetch()} className="underline ml-2">Retry</button></div>}
      {d?.ok && A?.closed && <div className="rounded-xl p-4 text-center font-bold" style={{ background: "#2a2000", color: "var(--amber)", border: "1px solid var(--amber)" }}>🟡 MARKET CLOSED — Gold trades Sunday 18:00 to Friday 17:00 ET (with a daily 17:00–18:00 ET break). The analysis below uses the last completed session and the decision is NO TRADE until the market reopens and a live setup forms.</div>}
      {A?.imminent && <div className="rounded-xl p-4 text-center font-black" style={{ background: "#2e0a0a", color: "var(--red)", border: "1px solid var(--red)" }}>⛔ NO TRADE — HIGH-IMPACT NEWS RISK: {A.imminent.title} at {new Date(A.imminent.ts).toLocaleString()}</div>}

      {goldQ.isLoading && <p className="text-sm" style={{ color: "var(--dim)" }}>Loading live gold data…</p>}

      {A && <>
        {/* Decision banner */}
        <section className="rounded-xl p-4 text-center" style={{ background: "var(--surface)", border: `2px solid ${decColor}` }}>
          <div className="grid sm:grid-cols-3 gap-3 items-center">
            <div><div className="text-[10px] tracking-widest" style={{ color: "var(--dim)" }}>CURRENT BIAS</div><div className="text-xl font-black">{A.bias.toUpperCase()}</div></div>
            <div><div className="text-[10px] tracking-widest" style={{ color: "var(--dim)" }}>TRADE DECISION</div><div className="text-3xl font-black" style={{ color: decColor }}>{A.decision === "BUY" ? "🟢 BUY" : A.decision === "SELL" ? "🔴 SELL" : A.decision === "WAIT" ? "🟡 WAIT" : "⛔ NO TRADE"}</div><div className="text-xs mt-1">{A.decisionNote}</div></div>
            <div><div className="text-[10px] tracking-widest" style={{ color: "var(--dim)" }}>SETUP SCORE</div><div className="text-xl font-black">{A.score}/100 <span className="text-sm" style={{ color: decColor }}>({A.grade})</span></div><div className="text-xs" style={{ color: "var(--dim)" }}>Confidence: {A.confidence}</div></div>
          </div>
        </section>

        {/* Chart */}
        <section className="rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className="flex justify-between flex-wrap gap-2"><b>M15 Chart — XAU/USD (pure spot, recorded spot ticks)</b><span className="text-xs mono" style={{ color: "var(--dim)" }}>ATR(14) M15 ${fmt(A.atrM15)} • H1 ${fmt(A.atrH1)} • EMA20 ${fmt(A.e20)} • EMA50 ${fmt(A.e50)} • EMA200 ${fmt(A.e200)}</span></div>
          {A.m15.length === 0 ? <div className="rounded-lg p-6 mt-2 text-center font-bold" style={{ background: "#2e0a0a", color: "var(--red)", border: "1px solid var(--red)" }}>🔴 LIVE DATA UNAVAILABLE — no spot M15 candles recorded yet. Candles build from live Swissquote spot ticks while this section is open; nothing is substituted from futures.</div> : <><div className="h-[300px] mt-2"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={A.chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" /><XAxis dataKey="time" tick={{ fontSize: 9, fill: "#8b9bb4" }} interval="preserveStartEnd" /><YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "#8b9bb4" }} width={62} tickFormatter={(v: number) => `$${fmt(v, 0)}`} /><Tooltip contentStyle={{ background: "#11161f", border: "1px solid #1e293b", fontSize: 12 }} formatter={(v: any, name: string) => name === "range" ? "" : `$${fmt(Number(v))}`} />
            {A.pdh && <ReferenceLine y={A.pdh} stroke="#ff5252" strokeDasharray="4 4" label={{ value: `PDH $${fmt(A.pdh)}`, fill: "#ff5252", fontSize: 10 }} />}
            {A.pdl && <ReferenceLine y={A.pdl} stroke="#00e676" strokeDasharray="4 4" label={{ value: `PDL $${fmt(A.pdl)}`, fill: "#00e676", fontSize: 10 }} />}
            <Bar dataKey="range" shape={<CandleShape />} isAnimationActive={false} />
            <Line type="monotone" dataKey="ema20" stroke="#ffb300" dot={false} strokeWidth={1.2} connectNulls />
            <Line type="monotone" dataKey="ema50" stroke="#38bdf8" dot={false} strokeWidth={1.2} connectNulls />
          </ComposedChart></ResponsiveContainer></div>
          <div className="text-[11px]" style={{ color: "var(--dim)" }}>Gold = spot candles (recorded Swissquote spot ticks) • Amber = EMA20 • Blue = EMA50 • Red dashed = PDH • Green dashed = PDL • No VWAP line — spot OTC has no centralised volume</div></>}
        </section>

        <div className="grid lg:grid-cols-2 gap-4">
          {/* Required framework report */}
          <section className="rounded-xl p-4 space-y-3 text-sm leading-relaxed" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <h2 className="font-black text-base">Framework Report — XAU/USD</h2>
            <div><b style={{ color: "#d4af37" }}>MARKET:</b> XAU/USD</div>
            <div><b style={{ color: "#d4af37" }}>CURRENT BIAS:</b> {A.bias}</div>
            <div><b style={{ color: "#d4af37" }}>H4 STRUCTURE:</b> {A.h4s.label} — {A.h4s.text} Do not trade against H4 structure without a confirmed reversal.</div>
            <div><b style={{ color: "#d4af37" }}>H1 STRUCTURE:</b> {A.h1s.label} — {A.h1s.text}</div>
            <div><b style={{ color: "#d4af37" }}>M15 SETUP:</b> {A.m15SetupText}</div>
            <div><b style={{ color: "#d4af37" }}>M5 CONFIRMATION:</b> {A.m5Text}</div>
            <div><b style={{ color: "#d4af37" }}>LIQUIDITY:</b> {A.liquidityText}. {A.sweepText}</div>
            <div><b style={{ color: "#d4af37" }}>VWAP:</b> UNAVAILABLE on the pure-spot feed — spot XAU/USD is OTC and has no centralised traded volume, and the Swissquote spot tick feed carries no volume, so an honest session VWAP cannot be computed. It is not borrowed from COMEX futures volume and no tick-count proxy is presented as VWAP. The VWAP/EMA score component therefore uses EMA confluence only (EMA20 ${fmt(A.e20)} / EMA50 ${fmt(A.e50)} / EMA200 ${fmt(A.e200)} on M15) and is capped at 6/10.</div>
            <div><b style={{ color: "#d4af37" }}>NEWS / MACRO:</b> {A.imminent ? `⛔ HIGH-IMPACT IMMINENT: ${A.imminent.title} at ${new Date(A.imminent.ts).toLocaleString()} — news filter overrides technicals.` : A.upcoming.length ? "Upcoming USD events from the live calendar are listed in the News Filter panel. High-impact events (FOMC, CPI, PCE, NFP, unemployment, GDP, Fed speeches) can spike gold, USD and yields — no entries into them." : "No upcoming USD events remain in this week's calendar feed (coverage is weekly) — verify the calendar before the next session before treating the news score as clear."}</div>
            <div><b style={{ color: "#d4af37" }}>INVALIDATION:</b> {A.invalidation}</div>
            <div><b style={{ color: "#d4af37" }}>WHY:</b> {A.why}</div>
            {(A.decision === "NO TRADE") && <div className="font-black text-center rounded-lg p-2" style={{ background: "#2a2000", color: "var(--amber)" }}>NO TRADE — WAIT FOR BETTER CONDITIONS.</div>}
          </section>

          <div className="space-y-4">
            {/* Key levels */}
            <section className="rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              <h2 className="font-bold mb-3">Key Levels</h2>
              <div className="grid grid-cols-2 gap-2 text-sm mono">
                <div className="rounded-lg p-2" style={{ background: "var(--surface2)" }}><div className="text-xs" style={{ color: "var(--dim)" }}>Resistance</div><b style={{ color: "var(--red)" }}>${fmt(A.resistance)}</b></div>
                <div className="rounded-lg p-2" style={{ background: "var(--surface2)" }}><div className="text-xs" style={{ color: "var(--dim)" }}>Support</div><b style={{ color: "var(--green)" }}>${fmt(A.support)}</b></div>
                <div className="rounded-lg p-2" style={{ background: "var(--surface2)" }}><div className="text-xs" style={{ color: "var(--dim)" }}>PDH</div><b>${fmt(A.pdh)}</b></div>
                <div className="rounded-lg p-2" style={{ background: "var(--surface2)" }}><div className="text-xs" style={{ color: "var(--dim)" }}>PDL</div><b>${fmt(A.pdl)}</b></div>
                <div className="rounded-lg p-2" style={{ background: "var(--surface2)" }}><div className="text-xs" style={{ color: "var(--dim)" }}>Session High {A.closed ? "(last session)" : ""}</div><b>${fmt(A.sessHigh)}</b></div>
                <div className="rounded-lg p-2" style={{ background: "var(--surface2)" }}><div className="text-xs" style={{ color: "var(--dim)" }}>Session Low {A.closed ? "(last session)" : ""}</div><b>${fmt(A.sessLow)}</b></div>
              </div>
              {/* Trade plan */}
              <h3 className="font-bold mt-4 mb-2">{A.direction === "short" ? "IF SELL" : "IF BUY"} — Trade Plan {A.decision !== "BUY" && A.decision !== "SELL" ? "(reference only — not a valid trade while decision is " + A.decision + ")" : ""}</h3>
              {A.entry ? <div className="grid grid-cols-2 gap-2 text-sm mono">
                <div className="rounded-lg p-2" style={{ background: "var(--surface2)" }}><div className="text-xs" style={{ color: "var(--dim)" }}>Entry (reference)</div><b>${fmt(A.entry)}</b></div>
                <div className="rounded-lg p-2" style={{ background: "var(--surface2)" }}><div className="text-xs" style={{ color: "var(--dim)" }}>Stop Loss</div><b style={{ color: "var(--red)" }}>${fmt(A.sl)}</b></div>
                <div className="rounded-lg p-2" style={{ background: "var(--surface2)" }}><div className="text-xs" style={{ color: "var(--dim)" }}>TP1</div><b style={{ color: "var(--green)" }}>${fmt(A.tp1)}</b></div>
                <div className="rounded-lg p-2" style={{ background: "var(--surface2)" }}><div className="text-xs" style={{ color: "var(--dim)" }}>TP2</div><b style={{ color: "var(--green)" }}>${fmt(A.tp2)}</b></div>
                <div className="rounded-lg p-2 col-span-2" style={{ background: "var(--surface2)" }}><div className="text-xs" style={{ color: "var(--dim)" }}>Risk / Reward (to TP1)</div><b>1 : {A.rr ? A.rr.toFixed(2) : "—"}</b> <span className="text-xs" style={{ color: "var(--dim)" }}>• Minimum preferred 1:2</span></div>
              </div> : <p className="text-sm" style={{ color: "var(--dim)" }}>No directional plan — no sweep + MSS aligned with the H4/H1 bias. Entry, stop and targets are only calculated when a direction qualifies; they are never forced.</p>}
            </section>

            {/* Score breakdown */}
            <section className="rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              <h2 className="font-bold mb-3">Setup Score — {A.score}/100 ({A.grade})</h2>
              <div className="space-y-2">{scoreRows.map(([label, pts, max]) => <div key={label}><div className="flex justify-between text-xs"><span>{label}</span><b className="mono">{pts}/{max}</b></div><div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--surface2)" }}><div className="h-full" style={{ width: `${(pts / max) * 100}%`, background: "#d4af37" }} /></div></div>)}</div>
              <p className="text-xs mt-3" style={{ color: "var(--dim)" }}>90–100 A+ • 80–89 A • 70–79 B • 60–69 Weak • Below 60 = NO TRADE. Only setups ≥70 with R:R ≥ 1:2 can become BUY/SELL here.</p>
            </section>

            {/* News */}
            <section className="rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              <h2 className="font-bold mb-3">News Filter — USD / Fed / Gold Catalysts</h2>
              {A.upcoming.length === 0 && <p className="text-sm" style={{ color: "var(--dim)" }}>No upcoming USD events remain in this week's live calendar feed. The feed is weekly — re-check before the next session; an empty list here is not proof of a clear calendar.</p>}
              <div className="space-y-2">{A.upcoming.map((e, i) => <div key={i} className="flex justify-between gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: e.impact === "High" ? "#2e0a0a" : "var(--surface2)", border: e.impact === "High" ? "1px solid var(--red)" : "none" }}><span><b>{e.title}</b><div style={{ color: "var(--dim)" }}>{new Date(e.ts).toLocaleString()} {e.forecast ? `• Forecast ${e.forecast}` : ""} {e.previous ? `• Previous ${e.previous}` : ""}</div></span><b style={{ color: e.impact === "High" ? "var(--red)" : e.impact === "Medium" ? "var(--amber)" : "var(--dim)" }}>{e.impact.toUpperCase()}</b></div>)}</div>
              <p className="text-[11px] mt-2" style={{ color: "var(--dim)" }}>Filter watches: FOMC & Fed decisions/speeches, CPI, PCE, NFP, unemployment, GDP, and USD/yield shocks. High-impact within 2 hours = NO TRADE — HIGH-IMPACT NEWS RISK.</p>
            </section>
          </div>
        </div>

        {/* Risk rules + position size */}
        <section className="rounded-xl p-4 grid lg:grid-cols-2 gap-4" style={{ background: "var(--surface)", border: "1px solid #d4af37" }}>
          <div>
            <h2 className="font-bold mb-2">Gold Risk Rules</h2>
            <ul className="text-sm space-y-1.5 leading-relaxed">
              <li>• Risk <b>0.25%–0.5%</b> of account equity per trade — never more.</li>
              <li>• Maximum daily loss <b>1%</b> of equity. Hit it → <b>STOP TRADING</b> for the day.</li>
              <li>• Never increase size to recover losses. <b>No martingale.</b></li>
              <li>• Never average into a losing position just because price moved against you.</li>
              <li>• Do not chase price after a large impulsive move. Do not enter on one indicator alone.</li>
              <li>• Minimum preferred R:R <b>1:2</b>. Below 60/100 score = NO TRADE.</li>
            </ul>
          </div>
          <div>
            <h2 className="font-bold mb-2">Position Size — XAU/USD</h2>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label>Account balance ($)<input aria-label="Gold account balance" type="number" value={balance} onChange={e => setBalance(e.target.value)} className="w-full mt-1 rounded px-2 py-2 mono" style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }} /></label>
              <label>Risk % (0.25–0.5)<input aria-label="Gold risk percentage" type="number" step="0.25" value={riskPct} onChange={e => setRiskPct(e.target.value)} className="w-full mt-1 rounded px-2 py-2 mono" style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }} /></label>
              <label>Entry price<input aria-label="Gold entry price" type="number" placeholder={A.entry ? String(A.entry.toFixed(2)) : ""} value={gEntry} onChange={e => setGEntry(e.target.value)} className="w-full mt-1 rounded px-2 py-2 mono" style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }} /></label>
              <label>Stop-loss price<input aria-label="Gold stop-loss price" type="number" placeholder={A.sl ? String(A.sl.toFixed(2)) : ""} value={gStop} onChange={e => setGStop(e.target.value)} className="w-full mt-1 rounded px-2 py-2 mono" style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }} /></label>
              <label className="col-span-2">Value per point — $ your broker pays per $1 move, per 1 oz (verify your broker's contract spec)<input aria-label="Gold value per point" type="number" step="0.1" value={vpp} onChange={e => setVpp(e.target.value)} className="w-full mt-1 rounded px-2 py-2 mono" style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)" }} /></label>
            </div>
            {rp > 0.5 && <p className="text-xs mt-2 font-bold" style={{ color: "var(--red)" }}>⚠️ Risk {rp}% exceeds the framework maximum of 0.5% per trade.</p>}
            <div className="mt-3 space-y-1.5 text-sm mono">
              <div className="flex justify-between"><span style={{ color: "var(--dim)" }}>Risk Amount = Balance × Risk%</span><b style={{ color: "var(--red)" }}>${fmt(riskAmt)}</b></div>
              <div className="flex justify-between"><span style={{ color: "var(--dim)" }}>Stop distance</span><b>${fmt(slDist)}</b></div>
              <div className="flex justify-between"><span style={{ color: "var(--dim)" }}>Position Size = Risk ÷ (SL distance × Value/point)</span><b style={{ color: "#d4af37" }}>{posOz ? `${fmt(posOz, 3)} oz` : "—"}</b></div>
              <div className="flex justify-between"><span style={{ color: "var(--dim)" }}>Max daily loss (1%) — then STOP</span><b>${fmt(bal * 0.01)}</b></div>
            </div>
            <p className="text-[11px] mt-2" style={{ color: "var(--dim)" }}>Broker contract specs are NOT assumed: lot size, contract size (oz per lot) and value per point differ by broker. Enter your broker's actual value per point above — if you don't know it, do not trade until you've confirmed it in your broker's contract specifications.</p>
          </div>
        </section>

        <footer className="rounded-xl p-4 text-xs leading-relaxed" style={{ background: "#1a1200", border: "1px solid var(--amber)", color: "#fde68a" }}>
          ⚠️ Stragis provides market analysis and educational information based on available market data. Trading involves substantial risk, and past performance does not guarantee future results. Signals are not guaranteed predictions or financial advice. No setup here guarantees profit — when the setup is unclear, the correct answer is NO TRADE — WAIT FOR BETTER CONDITIONS. Gold data in this section is pure spot XAU/USD only (Swissquote spot feed; candles built from spot ticks recorded by Stragis — no COMEX futures data is used). Confirm all levels on your own broker's XAU/USD feed before trading — spot quotes differ slightly between brokers.
        </footer>
      </>}
    </div>
  );
}
