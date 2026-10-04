import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from "recharts";
import { api } from "./api";
import { runBacktest } from "./backtest";

type Coin = { id: string; symbol: string; name: string };
type RunRequest = { coinId: string; symbol: string; name: string; days: 3 | 5; timeframe: string; nonce: number };

function fmt(n: number | null | undefined, dec = 2) {
  if (n == null || !isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: dec });
  if (Math.abs(n) >= 1) return n.toFixed(dec);
  if (Math.abs(n) >= 0.01) return n.toFixed(4);
  return n.toFixed(6);
}
function fmtMoney(n: number) { return `${n < 0 ? "-" : ""}$${fmt(Math.abs(n))}`; }
function fmtDateTime(t: number) { return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }

const BT_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h"] as const;

export function BacktestPanel({ selected, balance, riskPct }: { selected: Coin; balance: number; riskPct: number }) {
  const [days, setDays] = useState<3 | 5>(5);
  const [timeframe, setTimeframe] = useState<string>("15m");
  const [run, setRun] = useState<RunRequest | null>(null);

  const q = useQuery({
    queryKey: ["backtest", run?.coinId, run?.symbol, run?.timeframe, run?.days, run?.nonce],
    queryFn: () => api.getBacktestData({ coinId: run!.coinId, symbol: run!.symbol, timeframe: run!.timeframe, days: run!.days }),
    enabled: !!run,
  });

  const accountBalance = balance > 0 ? balance : 10000;
  const accountRisk = riskPct > 0 ? riskPct : 1;
  const result = useMemo(() => {
    if (!run || !q.data?.ok || q.data.testStart == null) return null;
    return runBacktest(q.data.candles, q.data.testStart, accountBalance, accountRisk);
  }, [run, q.data, accountBalance, accountRisk]);

  const equityData = useMemo(() => (result?.equity || []).map(p => ({ time: fmtDateTime(p.t), balance: Number(p.balance.toFixed(2)) })), [result]);
  const stale = !!run && (run.coinId !== selected.id || run.days !== days || run.timeframe !== timeframe);
  const metric = "rounded-lg p-3";
  const metricLabel = "text-[10px] font-bold tracking-wider";
  const metricValue = "mono text-lg font-black mt-1";

  return (
    <section className="rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-base">Strategy Backtest — {selected.symbol}/USDT</h2>
          <p className="text-xs mt-1 max-w-3xl" style={{ color: "var(--dim)" }}>
            Tests the same fixed Stragis score rules on completed historical candles. Signals are checked after a candle closes and entered at the next candle's open.
          </p>
        </div>
        <button
          aria-label="Run backtest"
          onClick={() => setRun({ coinId: selected.id, symbol: selected.symbol, name: selected.name, days, timeframe, nonce: Date.now() })}
          disabled={q.isFetching}
          className="px-5 py-2.5 rounded-lg text-sm font-black text-black disabled:opacity-50"
          style={{ background: "var(--green)" }}
        >
          {q.isFetching ? "Running…" : `▶ Run Backtest — ${days} Days · ${timeframe}`}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-4 mt-4">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-bold" style={{ color: "var(--dim)" }}>Period</span>
          {([3, 5] as const).map(d => (
            <button key={d} aria-label={`Backtest period ${d} days`} onClick={() => setDays(d)} className="px-3 py-1.5 rounded text-xs font-bold" style={{ background: days === d ? "var(--green)" : "var(--surface2)", color: days === d ? "#000" : "var(--text)" }}>{d} Days</button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-bold" style={{ color: "var(--dim)" }}>Timeframe</span>
          {BT_TIMEFRAMES.map(t => (
            <button key={t} aria-label={`Backtest timeframe ${t}`} onClick={() => setTimeframe(t)} className="px-2.5 py-1.5 rounded text-xs font-bold" style={{ background: timeframe === t ? "var(--green)" : "var(--surface2)", color: timeframe === t ? "#000" : "var(--text)" }}>{t}</button>
          ))}
        </div>
        <span className="text-xs" style={{ color: "var(--dim)" }}>Risk model: {fmtMoney(accountBalance)} account · {fmt(accountRisk)}% risk per trade (from the Risk Calculator)</span>
      </div>

      {!run && <p className="text-sm mt-4 rounded-lg p-3" style={{ background: "var(--surface2)", color: "var(--dim)" }}>Choose 3 or 5 days, choose a timeframe, then click <b style={{ color: "var(--text)" }}>Run Backtest</b>. Nothing runs automatically.</p>}
      {q.isFetching && <p className="text-sm mt-4" style={{ color: "var(--dim)" }}>Loading completed historical candles and running the simulation…</p>}
      {run && q.data && !q.data.ok && <div className="rounded-lg p-3 mt-4 text-sm font-bold" style={{ background: "#2e0a0a", color: "var(--red)", border: "1px solid var(--red)" }}>Backtest data unavailable: {q.data.error || "the providers returned no usable history"}. No results were invented.</div>}
      {q.isError && <div className="rounded-lg p-3 mt-4 text-sm font-bold" style={{ background: "#2e0a0a", color: "var(--red)", border: "1px solid var(--red)" }}>Backtest request failed. Please try again.</div>}
      {stale && run && <div className="rounded-lg p-3 mt-4 text-sm font-bold" style={{ background: "#2a2000", color: "var(--amber)", border: "1px solid var(--amber)" }}>⚠ Settings changed — the results below are still the previous run ({run.symbol} · {run.days} days · {run.timeframe}). Click <b>Run Backtest</b> to update them for {selected.symbol} · {days} days · {timeframe}.</div>}

      {result && q.data?.ok && (
        <div className="mt-4 space-y-4">
          <div className="text-xs flex flex-wrap gap-x-4 gap-y-1" style={{ color: "var(--dim)" }}>
            <span><b style={{ color: "var(--text)" }}>{run?.name}</b> · {run?.days} days · {run?.timeframe}</span>
            <span>Source: {q.data.source}</span>
            <span>{result.testCandles} test candles after a 200-candle warm-up</span>
            {result.firstTestTime && result.lastTestTime && <span>{fmtDateTime(result.firstTestTime)} → {fmtDateTime(result.lastTestTime)}</span>}
            <span>{result.signals} trade setups taken or attempted</span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
            <div className={metric} style={{ background: "var(--surface2)" }}><div className={metricLabel} style={{ color: "var(--dim)" }}>TRADES</div><div className={metricValue}>{result.trades.length}</div><div className="text-[11px]" style={{ color: "var(--dim)" }}>{result.wins} wins · {result.losses} losses</div></div>
            <div className={metric} style={{ background: "var(--surface2)" }}><div className={metricLabel} style={{ color: "var(--dim)" }}>WIN RATE</div><div className={metricValue}>{fmt(result.winRate, 1)}%</div><div className="text-[11px]" style={{ color: "var(--dim)" }}>TP1 exits count as wins</div></div>
            <div className={metric} style={{ background: "var(--surface2)" }}><div className={metricLabel} style={{ color: "var(--dim)" }}>NET RESULT</div><div className={metricValue} style={{ color: result.netPnl >= 0 ? "var(--green)" : "var(--red)" }}>{fmtMoney(result.netPnl)}</div><div className="text-[11px]" style={{ color: result.returnPct >= 0 ? "var(--green)" : "var(--red)" }}>{result.returnPct >= 0 ? "+" : ""}{fmt(result.returnPct)}% account return</div></div>
            <div className={metric} style={{ background: "var(--surface2)" }}><div className={metricLabel} style={{ color: "var(--dim)" }}>TOTAL R</div><div className={metricValue} style={{ color: result.totalR >= 0 ? "var(--green)" : "var(--red)" }}>{result.totalR >= 0 ? "+" : ""}{fmt(result.totalR)}R</div><div className="text-[11px]" style={{ color: "var(--dim)" }}>Average {result.averageR >= 0 ? "+" : ""}{fmt(result.averageR)}R</div></div>
            <div className={metric} style={{ background: "var(--surface2)" }}><div className={metricLabel} style={{ color: "var(--dim)" }}>PROFIT FACTOR</div><div className={metricValue}>{result.profitFactor == null ? (result.trades.length ? "No losses" : "—") : fmt(result.profitFactor)}</div><div className="text-[11px]" style={{ color: "var(--dim)" }}>Gross wins ÷ gross losses</div></div>
            <div className={metric} style={{ background: "var(--surface2)" }}><div className={metricLabel} style={{ color: "var(--dim)" }}>MAX DRAWDOWN</div><div className={metricValue} style={{ color: "var(--red)" }}>{fmt(result.maxDrawdownPct, 1)}%</div><div className="text-[11px]" style={{ color: "var(--dim)" }}>Peak-to-trough equity</div></div>
            <div className={metric} style={{ background: "var(--surface2)" }}><div className={metricLabel} style={{ color: "var(--dim)" }}>BUY & HOLD</div><div className={metricValue} style={{ color: result.buyHoldPct >= 0 ? "var(--green)" : "var(--red)" }}>{result.buyHoldPct >= 0 ? "+" : ""}{fmt(result.buyHoldPct)}%</div><div className="text-[11px]" style={{ color: "var(--dim)" }}>Same test window</div></div>
          </div>

          {result.trades.length > 0 ? (
            <>
              <div className="h-[190px]">
                <div className="text-[10px] font-bold" style={{ color: "var(--dim)" }}>EQUITY CURVE</div>
                <ResponsiveContainer width="100%" height="90%">
                  <AreaChart data={equityData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                    <XAxis dataKey="time" tick={{ fontSize: 9, fill: "#8b9bb4" }} interval="preserveStartEnd" />
                    <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "#8b9bb4" }} width={68} tickFormatter={(v: number) => `$${fmt(v, 0)}`} />
                    <Tooltip contentStyle={{ background: "#11161f", border: "1px solid #1e293b", fontSize: 12 }} formatter={(v: any) => [`$${fmt(Number(v))}`, "Balance"]} />
                    <Area dataKey="balance" stroke="#00e676" fill="#00e67633" dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[820px]">
                  <thead><tr className="text-left" style={{ color: "var(--dim)" }}><th className="px-2 py-2">Direction</th><th className="px-2 py-2">Entry</th><th className="px-2 py-2">Exit</th><th className="px-2 py-2">Entry Price</th><th className="px-2 py-2">SL / TP1</th><th className="px-2 py-2">Exit Price</th><th className="px-2 py-2">Result</th><th className="px-2 py-2">P&amp;L</th></tr></thead>
                  <tbody>{[...result.trades].slice(-12).reverse().map((t, idx) => (
                    <tr key={`${t.entryTime}-${idx}`} className="border-t" style={{ borderColor: "var(--border)" }}>
                      <td className="px-2 py-2 font-black" style={{ color: t.direction === "LONG" ? "var(--green)" : "var(--red)" }}>{t.direction}</td>
                      <td className="px-2 py-2 whitespace-nowrap">{fmtDateTime(t.entryTime)}</td>
                      <td className="px-2 py-2 whitespace-nowrap">{fmtDateTime(t.exitTime)}<div style={{ color: "var(--dim)" }}>{t.exitReason}</div></td>
                      <td className="px-2 py-2 mono">${fmt(t.entry)}</td>
                      <td className="px-2 py-2 mono">${fmt(t.stopLoss)} / ${fmt(t.takeProfit)}</td>
                      <td className="px-2 py-2 mono">${fmt(t.exit)}</td>
                      <td className="px-2 py-2 mono font-bold" style={{ color: t.rMultiple >= 0 ? "var(--green)" : "var(--red)" }}>{t.rMultiple >= 0 ? "+" : ""}{fmt(t.rMultiple)}R</td>
                      <td className="px-2 py-2 mono font-bold" style={{ color: t.pnl >= 0 ? "var(--green)" : "var(--red)" }}>{fmtMoney(t.pnl)}</td>
                    </tr>
                  ))}</tbody>
                </table>
                {result.trades.length > 12 && <p className="text-[11px] mt-1" style={{ color: "var(--dim)" }}>Showing the latest 12 of {result.trades.length} trades.</p>}
              </div>
            </>
          ) : (
            <p className="text-sm rounded-lg p-3" style={{ background: "var(--surface2)", color: "var(--dim)" }}>No valid trades were generated in this period. That is a real result: the rules produced no BUY or SELL setup with a valid stop and TP1, or every setup was blocked by the overbought / near-resistance filters.</p>
          )}

          <p className="text-[11px] leading-relaxed" style={{ color: "var(--dim)" }}>
            Method: one position at a time; entry at the next candle open; exit at SL or TP1; if a candle touches both, the stop is counted first. SELL signals are modeled as short direction so the signal can be measured — on a spot account, SELL normally means exit/reduce rather than opening a short. No exchange fees, slippage, spread, or funding are included. A 3–5 day test is a very small sample and does not prove the rules will work in the future.
          </p>
        </div>
      )}
    </section>
  );
}
