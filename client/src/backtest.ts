// Backtesting for the Stragis crypto signal rules.
//
// The score weights and signal thresholds intentionally match the live
// "AI ANALYSIS" panel in App.tsx. The differences are the ones an honest
// backtest requires:
//   * indicators use a full 200-candle warm-up before the test window;
//   * a signal is evaluated only after its candle closes;
//   * entry happens at the NEXT candle's open (no same-candle lookahead);
//   * a position exits at its stop-loss or TP1; if one candle touches
//     both, the stop is assumed to have been hit first (conservative);
//   * no fees, slippage, funding, or partial exits are modeled.

export type BtCandle = { t: number; o: number; h: number; l: number; c: number; v: number };

export type BtTrade = {
  direction: "LONG" | "SHORT";
  signalTime: number;
  entryTime: number;
  exitTime: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exit: number;
  exitReason: "Take profit" | "Stop loss" | "End of test";
  rMultiple: number;
  pnl: number;
};

export type BtResult = {
  trades: BtTrade[];
  signals: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  returnPct: number;
  totalR: number;
  averageR: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  buyHoldPct: number;
  startBalance: number;
  endBalance: number;
  equity: { t: number; balance: number }[];
  testCandles: number;
  firstTestTime: number | null;
  lastTestTime: number | null;
};

function ema(values: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = [];
  let prev: number | null = null;
  values.forEach((v, i) => {
    if (i < period - 1) { out.push(null); return; }
    if (prev === null) {
      prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
      out.push(prev);
    } else {
      prev = v * k + prev * (1 - k);
      out.push(prev);
    }
  });
  return out;
}

function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  if (values.length <= period) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

function macdHist(values: number[]): (number | null)[] {
  const e12 = ema(values, 12), e26 = ema(values, 26);
  const line = values.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i]! - e26[i]! : null);
  const valid = line.map(v => v ?? 0);
  const sigE = ema(valid, 9);
  const signal = line.map((v, i) => v == null ? null : sigE[i]);
  return line.map((v, i) => (v != null && signal[i] != null) ? v - signal[i]! : null);
}

type Evaluation = {
  signal: "BUY" | "SELL";
  support: number;
  resistance: number;
  stopLoss: number;
  takeProfit: number;
};

function evaluateAt(
  candles: BtCandle[],
  i: number,
  e20: (number | null)[],
  e50: (number | null)[],
  e200: (number | null)[],
  r: (number | null)[],
  hist: (number | null)[],
): Evaluation | null {
  const price = candles[i]!.c;
  const curE20 = e20[i], curE50 = e50[i], curE200 = e200[i];
  if (!curE20 || !curE50 || !curE200) return null;
  const curRsi = r[i] ?? 50;
  const macdNow = hist[i] ?? 0;
  const macdPrev = hist[i - 1] ?? 0;

  let score = 0;
  score += price > curE50 ? 2 : -2;
  score += curE20 > curE50 ? 1 : -1;
  score += price > curE200 ? 1 : -1;
  if (curRsi > 70) score -= 1;
  else if (curRsi < 30) score += 1;
  else if (curRsi >= 50) score += 1;
  else score -= 1;
  if (macdNow > 0 && macdNow > macdPrev) score += 2;
  else if (macdNow < 0) score -= 2;
  else score += 1;

  const window = candles.slice(Math.max(0, i - 59), i + 1);
  const support = Math.min(...window.map(c => c.l));
  const resistance = Math.max(...window.map(c => c.h));
  const distRes = resistance ? (resistance - price) / price * 100 : 99;

  const trend = score >= 3 ? "UPTREND" : score <= -3 ? "DOWNTREND" : "SIDEWAYS";
  if (trend === "UPTREND") {
    if (curRsi > 72 || distRes < 0.8) return null;
    return { signal: "BUY", support, resistance, stopLoss: support * 0.99, takeProfit: resistance };
  }
  if (trend === "DOWNTREND") {
    if (curRsi < 28) return null;
    return { signal: "SELL", support, resistance, stopLoss: resistance * 1.01, takeProfit: support };
  }
  return null;
}

export function runBacktest(
  allCandles: BtCandle[],
  testStart: number,
  initialBalance: number,
  riskPct: number,
): BtResult {
  const candles = [...allCandles].sort((a, b) => a.t - b.t);
  const closes = candles.map(c => c.c);
  const e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = ema(closes, 200);
  const r = rsi(closes), hist = macdHist(closes);
  const firstTest = candles.findIndex(c => c.t >= testStart);
  const empty: BtResult = {
    trades: [], signals: 0, wins: 0, losses: 0, winRate: 0, netPnl: 0, returnPct: 0,
    totalR: 0, averageR: 0, profitFactor: null, maxDrawdownPct: 0, buyHoldPct: 0,
    startBalance: initialBalance, endBalance: initialBalance,
    equity: [], testCandles: 0, firstTestTime: null, lastTestTime: null,
  };
  if (firstTest < 0 || initialBalance <= 0 || riskPct <= 0) return empty;

  const riskAmount = initialBalance * riskPct / 100;
  const trades: BtTrade[] = [];
  const equity: { t: number; balance: number }[] = [{ t: candles[firstTest]!.t, balance: initialBalance }];
  let balance = initialBalance;
  let signals = 0;
  let i = Math.max(firstTest, 200); // full EMA200 warm-up before the first signal

  while (i < candles.length - 1) {
    const ev = evaluateAt(candles, i, e20, e50, e200, r, hist);
    if (!ev) { i++; continue; }
    signals++;
    const entryIndex = i + 1;
    const entryCandle = candles[entryIndex]!;
    const entry = entryCandle.o;
    const direction: "LONG" | "SHORT" = ev.signal === "BUY" ? "LONG" : "SHORT";
    const riskDistance = direction === "LONG" ? entry - ev.stopLoss : ev.stopLoss - entry;
    const rewardDistance = direction === "LONG" ? ev.takeProfit - entry : entry - ev.takeProfit;
    if (!(riskDistance > 0) || !(rewardDistance > 0) || entry <= 0) { i++; continue; }

    let exit = candles[candles.length - 1]!.c;
    let exitTime = candles[candles.length - 1]!.t;
    let exitReason: BtTrade["exitReason"] = "End of test";
    let exitIndex = candles.length - 1;

    for (let j = entryIndex; j < candles.length; j++) {
      const c = candles[j]!;
      const stopHit = direction === "LONG" ? c.l <= ev.stopLoss : c.h >= ev.stopLoss;
      const tpHit = direction === "LONG" ? c.h >= ev.takeProfit : c.l <= ev.takeProfit;
      if (stopHit) { // conservative: stop first when a candle touches both
        exit = ev.stopLoss; exitTime = c.t; exitReason = "Stop loss"; exitIndex = j; break;
      }
      if (tpHit) {
        exit = ev.takeProfit; exitTime = c.t; exitReason = "Take profit"; exitIndex = j; break;
      }
      if (j === candles.length - 1) { exit = c.c; exitTime = c.t; exitIndex = j; }
    }

    const directionSign = direction === "LONG" ? 1 : -1;
    const rMultiple = directionSign * (exit - entry) / riskDistance;
    const pnl = riskAmount * rMultiple;
    balance += pnl;
    trades.push({
      direction, signalTime: candles[i]!.t, entryTime: entryCandle.t, exitTime,
      entry, stopLoss: ev.stopLoss, takeProfit: ev.takeProfit, exit, exitReason, rMultiple, pnl,
    });
    equity.push({ t: exitTime, balance });
    i = exitIndex + 1; // one position at a time; next signal after the exit candle
  }

  const wins = trades.filter(t => t.rMultiple > 0).length;
  const losses = trades.filter(t => t.rMultiple < 0).length;
  const grossProfit = trades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
  let peak = initialBalance, maxDd = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.balance);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - p.balance) / peak * 100);
  }
  const firstClose = candles[firstTest]!.c;
  const lastClose = candles[candles.length - 1]!.c;
  const totalR = trades.reduce((a, t) => a + t.rMultiple, 0);

  return {
    trades, signals, wins, losses,
    winRate: trades.length ? wins / trades.length * 100 : 0,
    netPnl: balance - initialBalance,
    returnPct: (balance - initialBalance) / initialBalance * 100,
    totalR, averageR: trades.length ? totalR / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maxDrawdownPct: maxDd,
    buyHoldPct: firstClose > 0 ? (lastClose - firstClose) / firstClose * 100 : 0,
    startBalance: initialBalance, endBalance: balance, equity,
    testCandles: candles.length - firstTest,
    firstTestTime: candles[firstTest]!.t,
    lastTestTime: candles[candles.length - 1]!.t,
  };
}
