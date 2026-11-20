/**
 * Backtest the deterministic risk layer.
 *
 * WHAT THIS TESTS, AND WHAT IT CANNOT
 *
 * It tests the risk engine: stop placement, trailing stops, volatility-based
 * position sizing, the benchmark regime filter, and how often exits are
 * evaluated. Both engines are given the SAME entry signal, so every difference
 * in the results comes from the risk layer and nothing else.
 *
 * It does NOT test Gemini's stock picking. There is no way to replay what a
 * language model would have chosen on a Tuesday in 2024, so the entry signal
 * here is a deliberately mediocre 20-day momentum rank standing in for it. Read
 * the numbers as "the risk layer, holding selection constant" — which is the
 * part that produced the -16.3% drawdown, so it is the part worth measuring.
 *
 * MONITORING FREQUENCY, MODELLED HONESTLY
 *
 * The central change is that exits are now evaluated every two minutes by a
 * Cloudflare Worker instead of a few times a day by a cron-scheduled job that
 * was frequently hours late. Daily bars cannot represent two-minute polling
 * directly, so it is approximated:
 *
 *   exitMonitoring "close"    — a stop can only be seen at the daily CLOSE, and
 *                               fills there. Models the old setup, where a
 *                               breach between sessions was discovered late and
 *                               sold at whatever the price had become.
 *   exitMonitoring "intraday" — a stop is seen when the bar's LOW breaches it
 *                               and fills at the stop price, or at the OPEN if
 *                               the bar gapped straight through it. Models
 *                               continuous polling, including the fact that a
 *                               gap cannot be caught by any polling frequency.
 *
 * This is an approximation in the new engine's favour on the fill price and
 * against it on gaps. It is stated plainly rather than buried, and the
 * attribution run below separates how much of the result comes from monitoring
 * frequency versus the sizing and exit rules.
 *
 * Usage:
 *   npx tsx scripts/backtest.ts              # headline before/after
 *   npx tsx scripts/backtest.ts --sweep      # parameter sweep on the tuning window
 */

import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_RISK_CONFIG,
  atrPercent,
  decideExits,
  detectRegime,
  drawdownPct,
  sizePosition,
  stopDistancePct,
  vetBuy,
  type Bar,
  type RiskConfig,
  type RiskPosition,
} from "../src/risk.js";

const BARS_DIR = path.resolve(process.env.BARS_DIR ?? "backtest-data");

// --- cost model, calibrated against this account's measured costs -----------
//
// Measured: 73 regulatory fee events totalling $0.74 across 92 filled orders,
// i.e. ~$0.01 per fill, with a $0.01 per-event FLOOR — so the cost is charged
// per trade, not per dollar, which is what makes small positions expensive.
// Spread is modelled at 3bp per fill, the low end for the liquid large caps in
// this universe; a market order crosses it in full.
const FEE_PER_FILL = 0.01;
const SPREAD_BPS_PER_FILL = 3;

const UNIVERSE = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "AMD", "AVGO",
  "JPM", "V", "UNH", "JNJ", "WMT", "PG", "HD", "COST", "LLY",
  "XOM", "TSLA", "NFLX",
];
const BENCHMARK = "SPY";
const STARTING_EQUITY = 100;
const MOMENTUM_LOOKBACK = 20;

interface Engine {
  name: string;
  config: RiskConfig;
  useRegime: boolean;
  useVolSizing: boolean;
  useTrailing: boolean;
  exitMonitoring: "close" | "intraday";
}

interface Trade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  notional: number;
  pnl: number;
  pnlPct: number;
  reason: string;
  heldDays: number;
}

interface Holding {
  ticker: string;
  shares: number;
  entryPrice: number;
  entryDate: string;
  entryIndex: number;
  highWater: number;
}

interface Result {
  name: string;
  dates: string[];
  equity: number[];
  trades: Trade[];
  feesPaid: number;
  exposureDays: number;
  /** Sum of invested/equity per day, for an average. */
  investedPctSum: number;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export const loadBars = (): Map<string, Bar[]> => {
  const out = new Map<string, Bar[]>();
  for (const symbol of [...UNIVERSE, BENCHMARK]) {
    const file = path.join(BARS_DIR, `${symbol}.json`);
    if (!fs.existsSync(file)) {
      throw new Error(
        `Missing ${file}. Run: npx tsx scripts/fetch-bars.ts`
      );
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Bar[];
    out.set(
      symbol,
      raw.map((bar) => ({
        t: String(bar.t).slice(0, 10),
        o: Number(bar.o),
        h: Number(bar.h),
        l: Number(bar.l),
        c: Number(bar.c),
      }))
    );
  }
  return out;
};

/** Trading calendar, taken from the benchmark's own bars. */
const tradingDates = (bars: Map<string, Bar[]>): string[] =>
  (bars.get(BENCHMARK) ?? []).map((bar) => bar.t);

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export const runBacktest = (
  engine: Engine,
  bars: Map<string, Bar[]>,
  startDate: string,
  endDate: string
): Result => {
  const dates = tradingDates(bars);
  // Index every symbol by date once, so the hot loop is map lookups rather
  // than scans.
  const byDate = new Map<string, Map<string, Bar>>();
  for (const [symbol, series] of bars) {
    for (const bar of series) {
      let day = byDate.get(bar.t);
      if (!day) byDate.set(bar.t, (day = new Map()));
      day.set(symbol, bar);
    }
  }

  const startIdx = dates.findIndex((date) => date >= startDate);
  const endIdx = dates.findLastIndex((date) => date <= endDate);
  if (startIdx < 0 || endIdx <= startIdx) {
    throw new Error(`No tradeable window between ${startDate} and ${endDate}`);
  }

  let cash = STARTING_EQUITY;
  const holdings = new Map<string, Holding>();
  const trades: Trade[] = [];
  const equityCurve: number[] = [];
  const curveDates: string[] = [];
  const lastSellIndex = new Map<string, number>();
  let feesPaid = 0;
  let exposureDays = 0;
  let investedPctSum = 0;
  let peak = STARTING_EQUITY;

  const costOf = (notional: number): number =>
    FEE_PER_FILL + (notional * SPREAD_BPS_PER_FILL) / 10_000;

  const barFor = (symbol: string, date: string): Bar | undefined =>
    byDate.get(date)?.get(symbol);

  /** Bars strictly before `index`, for indicators — never peeks ahead. */
  const historyBefore = (symbol: string, index: number, count: number): Bar[] => {
    const series = bars.get(symbol) ?? [];
    const end = series.findIndex((bar) => bar.t === dates[index]);
    if (end < 0) return [];
    return series.slice(Math.max(0, end - count), end);
  };

  for (let i = startIdx; i <= endIdx; i++) {
    const date = dates[i];

    // ---- 1. Exits, before anything else ---------------------------------
    for (const holding of [...holdings.values()]) {
      const bar = barFor(holding.ticker, date);
      if (!bar) continue;

      const history = historyBefore(holding.ticker, i, 30);
      const atrPct = engine.useVolSizing || engine.useTrailing
        ? atrPercent(history)
        : undefined;
      const stopPct = stopDistancePct(atrPct, engine.config);
      const stopPrice = holding.entryPrice * (1 - stopPct / 100);

      // The high-water mark updates with each bar, exactly as the live engine
      // reconstructs it from bars.
      holding.highWater = Math.max(holding.highWater, bar.h);

      let exitPrice: number | undefined;
      let reason = "";

      if (engine.exitMonitoring === "intraday") {
        // A gap through the stop fills at the open — no polling frequency can
        // beat a gap, and pretending otherwise would flatter this engine.
        if (bar.l <= stopPrice) {
          exitPrice = Math.min(bar.o, stopPrice);
          reason = "stop_loss";
        }
      } else if (bar.c <= stopPrice) {
        // Delayed monitoring: the breach is only noticed at the close, and the
        // sale happens there, however far past the stop that is.
        exitPrice = bar.c;
        reason = "stop_loss";
      }

      if (exitPrice === undefined && engine.useTrailing) {
        const position: RiskPosition = {
          ticker: holding.ticker,
          unrealizedPlPct: (bar.c / holding.entryPrice - 1) * 100,
          currentPrice: bar.c,
          avgEntryPrice: holding.entryPrice,
          highWaterPrice: holding.highWater,
          atrPct,
        };
        const decided = decideExits([position], engine.config);
        const trail = decided.find((d) => d.reason === "trailing_stop");
        if (trail) {
          exitPrice = bar.c;
          reason = "trailing_stop";
        }
      }

      if (exitPrice === undefined) {
        const gainPct = (bar.h / holding.entryPrice - 1) * 100;
        if (gainPct >= engine.config.takeProfitPct) {
          exitPrice =
            engine.exitMonitoring === "intraday"
              ? holding.entryPrice * (1 + engine.config.takeProfitPct / 100)
              : bar.c;
          reason = "take_profit";
        }
      }

      if (exitPrice !== undefined && exitPrice > 0) {
        const proceeds = holding.shares * exitPrice;
        const cost = costOf(proceeds);
        cash += proceeds - cost;
        feesPaid += cost;
        const entryNotional = holding.shares * holding.entryPrice;
        trades.push({
          ticker: holding.ticker,
          entryDate: holding.entryDate,
          exitDate: date,
          entryPrice: holding.entryPrice,
          exitPrice,
          notional: entryNotional,
          pnl: proceeds - entryNotional - cost,
          pnlPct: (exitPrice / holding.entryPrice - 1) * 100,
          reason,
          heldDays: i - holding.entryIndex,
        });
        holdings.delete(holding.ticker);
        lastSellIndex.set(holding.ticker, i);
      }
    }

    // ---- 2. Mark to market ----------------------------------------------
    let positionsValue = 0;
    for (const holding of holdings.values()) {
      const bar = barFor(holding.ticker, date);
      positionsValue += holding.shares * (bar?.c ?? holding.entryPrice);
    }
    const equity = cash + positionsValue;
    peak = Math.max(peak, equity);

    // ---- 3. Regime ------------------------------------------------------
    const benchmarkHistory = historyBefore(
      BENCHMARK,
      i,
      Math.ceil(engine.config.regimeSlowDays * 1.2) + 5
    ).map((bar) => bar.c);
    const regime = engine.useRegime
      ? detectRegime(benchmarkHistory, engine.config)
      : {
          regime: "risk_on" as const,
          riskMultiplier: 1,
          maxPositions: engine.config.maxPositions,
          reason: "regime filter disabled",
        };

    // ---- 4. Entries -----------------------------------------------------
    // One session per day for BOTH engines, so session frequency is held
    // constant and only the risk layer varies.
    const ranked = UNIVERSE.map((symbol) => {
      const history = historyBefore(symbol, i, MOMENTUM_LOOKBACK + 1);
      if (history.length < MOMENTUM_LOOKBACK + 1) return { symbol, score: -Infinity };
      const first = history[0].c;
      const last = history[history.length - 1].c;
      return { symbol, score: first > 0 ? last / first - 1 : -Infinity };
    })
      .filter((entry) => Number.isFinite(entry.score))
      .sort((a, b) => b.score - a.score);

    let buysToday = 0;
    for (const { symbol } of ranked) {
      if (buysToday >= engine.config.maxBuysPerSession) break;
      if (holdings.has(symbol)) continue;
      if (holdings.size >= regime.maxPositions) break;

      const bar = barFor(symbol, date);
      if (!bar || !(bar.c > 0)) continue;

      const hoursSinceSell = lastSellIndex.has(symbol)
        ? (i - (lastSellIndex.get(symbol) as number)) * 24
        : undefined;

      const history = historyBefore(symbol, i, 30);
      const atrPct = engine.useVolSizing ? atrPercent(history) : undefined;
      const stopPct = stopDistancePct(atrPct, engine.config);

      // Legacy sizing is a flat percentage of equity; the new engine solves for
      // equal dollar risk against each name's own stop.
      const requested = engine.useVolSizing
        ? sizePosition({
            equity,
            stopPct,
            riskMultiplier: regime.riskMultiplier,
            config: engine.config,
          }).notional
        : equity * (engine.config.maxPositionPct / 100);

      if (!(requested > 0)) continue;

      const verdict = vetBuy({
        ticker: symbol,
        requestedNotional: requested,
        equity,
        cash,
        existingPositionValue: 0,
        buysThisSession: buysToday,
        currentDrawdownPct: drawdownPct(equity, peak),
        hoursSinceLastSell: hoursSinceSell,
        sharePrice: bar.c,
        openPositionCount: holdings.size,
        maxPositionsOverride: regime.maxPositions,
        config: engine.config,
      });

      if (!verdict.allowed || verdict.approvedNotional <= 0) continue;

      const notional = Math.min(verdict.approvedNotional, cash - costOf(verdict.approvedNotional));
      if (notional < 1) continue;

      const cost = costOf(notional);
      const shares = notional / bar.c;
      cash -= notional + cost;
      feesPaid += cost;
      holdings.set(symbol, {
        ticker: symbol,
        shares,
        entryPrice: bar.c,
        entryDate: date,
        entryIndex: i,
        highWater: bar.c,
      });
      buysToday++;
    }

    if (holdings.size > 0) exposureDays++;
    if (equity > 0) investedPctSum += (positionsValue / equity) * 100;
    curveDates.push(date);
    equityCurve.push(equity);
  }

  return {
    name: engine.name,
    dates: curveDates,
    equity: equityCurve,
    trades,
    feesPaid,
    exposureDays,
    investedPctSum,
  };
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

interface Metrics {
  name: string;
  start: string;
  end: string;
  days: number;
  totalReturnPct: number;
  cagrPct: number;
  volPct: number;
  sharpe: number;
  sharpeRf4: number;
  sortino: number;
  maxDrawdownPct: number;
  calmar: number;
  trades: number;
  winRatePct: number;
  avgWinPct: number;
  avgLossPct: number;
  payoff: number;
  feesPaid: number;
  feesPctOfCapital: number;
  avgInvestedPct: number;
  avgHoldDays: number;
  worstDayPct: number;
}

const dailyReturns = (equity: number[]): number[] => {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    if (equity[i - 1] > 0) out.push(equity[i] / equity[i - 1] - 1);
  }
  return out;
};

const stdev = (values: number[]): number => {
  if (values.length < 2) return 0;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
};

const maxDrawdown = (equity: number[]): number => {
  let peak = -Infinity;
  let worst = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    if (peak > 0) worst = Math.min(worst, value / peak - 1);
  }
  return worst * 100;
};

export const computeMetrics = (result: Result): Metrics => {
  const { equity, dates, trades } = result;
  const returns = dailyReturns(equity);
  const totalReturn = equity.length > 1 ? equity[equity.length - 1] / equity[0] - 1 : 0;
  const years = returns.length / 252;
  const vol = stdev(returns) * Math.sqrt(252);
  const meanAnnual = (returns.reduce((a, b) => a + b, 0) / returns.length) * 252;
  const downside = returns.filter((r) => r < 0);
  const downsideVol = stdev(downside) * Math.sqrt(252);
  const mdd = maxDrawdown(equity);

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const avgWinPct = wins.length ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length
    ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length
    : 0;

  return {
    name: result.name,
    start: dates[0],
    end: dates[dates.length - 1],
    days: returns.length,
    totalReturnPct: totalReturn * 100,
    cagrPct: years > 0 ? ((1 + totalReturn) ** (1 / years) - 1) * 100 : 0,
    volPct: vol * 100,
    sharpe: vol > 0 ? meanAnnual / vol : 0,
    sharpeRf4: vol > 0 ? (meanAnnual - 0.04) / vol : 0,
    sortino: downsideVol > 0 ? meanAnnual / downsideVol : 0,
    maxDrawdownPct: mdd,
    calmar: mdd < 0 ? (totalReturn * 100) / Math.abs(mdd) : 0,
    trades: trades.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    avgWinPct,
    avgLossPct,
    payoff: avgLossPct !== 0 ? Math.abs(avgWinPct / avgLossPct) : 0,
    feesPaid: result.feesPaid,
    feesPctOfCapital: (result.feesPaid / STARTING_EQUITY) * 100,
    avgInvestedPct: dates.length ? result.investedPctSum / dates.length : 0,
    avgHoldDays: trades.length
      ? trades.reduce((sum, t) => sum + t.heldDays, 0) / trades.length
      : 0,
    worstDayPct: returns.length ? Math.min(...returns) * 100 : 0,
  };
};

/** Buy and hold the benchmark over the same window, with one entry cost. */
export const benchmarkResult = (
  bars: Map<string, Bar[]>,
  startDate: string,
  endDate: string
): Result => {
  const series = (bars.get(BENCHMARK) ?? []).filter(
    (bar) => bar.t >= startDate && bar.t <= endDate
  );
  const entryCost = FEE_PER_FILL + (STARTING_EQUITY * SPREAD_BPS_PER_FILL) / 10_000;
  const shares = (STARTING_EQUITY - entryCost) / series[0].c;
  return {
    name: "SPY buy & hold",
    dates: series.map((bar) => bar.t),
    equity: series.map((bar) => shares * bar.c),
    trades: [],
    feesPaid: entryCost,
    exposureDays: series.length,
    investedPctSum: series.length * 100,
  };
};

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

/**
 * The configuration as it was before this change: a flat 8% stop, a +25%
 * take-profit, 40% of equity per position, no volatility scaling, no trailing
 * stop, no regime filter, and exits visible only at the close.
 */
export const legacyEngine = (): Engine => ({
  name: "BEFORE (flat stop, 40% positions, close-only exits)",
  config: {
    ...DEFAULT_RISK_CONFIG,
    stopLossPct: 8,
    takeProfitPct: 25,
    maxPositionPct: 40,
    cashReservePct: 5,
    maxBuysPerSession: 2,
    minRebuyHours: 24,
    // The old engine had no position-count ceiling and no minimum stake.
    maxPositions: 10,
    minPositionNotional: 0,
  },
  useRegime: false,
  useVolSizing: false,
  useTrailing: false,
  exitMonitoring: "close",
});

export const v2Engine = (overrides: Partial<RiskConfig> = {}): Engine => ({
  name: "AFTER (ATR stop, vol sizing, trailing, regime, 2-min exits)",
  config: { ...DEFAULT_RISK_CONFIG, ...overrides },
  useRegime: true,
  useVolSizing: true,
  useTrailing: true,
  exitMonitoring: "intraday",
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const pct = (value: number, digits = 2): string =>
  `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;

const table = (rows: Metrics[]): void => {
  const labels: Array<[string, (m: Metrics) => string]> = [
    ["Total return", (m) => pct(m.totalReturnPct)],
    ["CAGR", (m) => pct(m.cagrPct)],
    ["Volatility (ann.)", (m) => `${m.volPct.toFixed(2)}%`],
    ["Sharpe (rf=0)", (m) => m.sharpe.toFixed(2)],
    ["Sharpe (rf=4%)", (m) => m.sharpeRf4.toFixed(2)],
    ["Sortino", (m) => m.sortino.toFixed(2)],
    ["Max drawdown", (m) => pct(m.maxDrawdownPct)],
    ["Return / MaxDD", (m) => m.calmar.toFixed(2)],
    ["Worst day", (m) => pct(m.worstDayPct)],
    ["Round trips", (m) => String(m.trades)],
    ["Win rate", (m) => (m.trades ? `${m.winRatePct.toFixed(1)}%` : "n/a")],
    ["Avg win", (m) => (m.trades ? pct(m.avgWinPct) : "n/a")],
    ["Avg loss", (m) => (m.trades ? pct(m.avgLossPct) : "n/a")],
    ["Payoff ratio", (m) => (m.trades ? m.payoff.toFixed(2) : "n/a")],
    ["Costs paid", (m) => `$${m.feesPaid.toFixed(2)} (${m.feesPctOfCapital.toFixed(2)}% of capital)`],
    ["Avg invested", (m) => `${m.avgInvestedPct.toFixed(0)}% of equity`],
    ["Avg holding period", (m) => (m.trades ? `${m.avgHoldDays.toFixed(1)} days` : "whole window")],
  ];

  const width = 22;
  const colWidth = 34;
  console.log(
    "".padEnd(width) + rows.map((r) => r.name.slice(0, colWidth - 2).padEnd(colWidth)).join("")
  );
  console.log("-".repeat(width + colWidth * rows.length));
  for (const [label, render] of labels) {
    console.log(
      label.padEnd(width) + rows.map((r) => render(r).padEnd(colWidth)).join("")
    );
  }
};

export const WINDOWS: Array<{ label: string; start: string; end: string }> = [
  { label: "TUNING WINDOW (parameters chosen here)", start: "2023-01-03", end: "2025-06-30" },
  { label: "OUT-OF-SAMPLE (never used for tuning)", start: "2025-07-01", end: "2026-11-19" },
  { label: "FULL PERIOD", start: "2023-01-03", end: "2026-11-19" },
];

const sweep = (bars: Map<string, Bar[]>): void => {
  const window = WINDOWS[0];
  console.log(`\n=== PARAMETER SWEEP — ${window.label} ===`);
  console.log(`${window.start} → ${window.end}\n`);
  console.log(
    "risk%  atrMult  trail  return    maxDD     Sharpe  Sortino  ret/DD  trades"
  );
  console.log("-".repeat(70));

  const results: Array<{ risk: number; mult: number; trail: number; m: Metrics }> = [];
  for (const risk of [1.5, 2.0, 2.5, 3.0, 3.5]) {
    for (const mult of [2.0, 2.5, 3.0]) {
      for (const trail of [1.5, 2.5, 3.5, 5.0]) {
        const result = runBacktest(
          v2Engine({
            riskPerTradePct: risk,
            atrStopMultiple: mult,
            trailAtrMultiple: trail,
          }),
          bars,
          window.start,
          window.end
        );
        const m = computeMetrics(result);
        results.push({ risk, mult, trail, m });
        console.log(
          `${risk.toFixed(1).padStart(4)}  ${mult.toFixed(1).padStart(6)}  ` +
            `${trail.toFixed(1).padStart(5)}  ` +
            `${pct(m.totalReturnPct).padStart(8)}  ${pct(m.maxDrawdownPct).padStart(8)}  ` +
            `${m.sharpe.toFixed(2).padStart(6)}  ${m.sortino.toFixed(2).padStart(7)}  ` +
            `${m.calmar.toFixed(2).padStart(6)}  ${String(m.trades).padStart(6)}`
        );
      }
    }
  }

  const best = [...results].sort((a, b) => b.m.sortino - a.m.sortino)[0];
  console.log(
    `\nBest Sortino: risk ${best.risk}% / ATR x${best.mult} / trail x${best.trail} ` +
      `(return ${pct(best.m.totalReturnPct)}, maxDD ${pct(best.m.maxDrawdownPct)}, ` +
      `Sortino ${best.m.sortino.toFixed(2)})`
  );

  // Stability matters more than the maximum. A setting whose neighbours are all
  // good is a setting that survives contact with a different market; a lone
  // spike is noise that happens to look like skill.
  const bySortino = [...results].sort((a, b) => b.m.sortino - a.m.sortino);
  console.log("\nTop 8 by Sortino:");
  for (const entry of bySortino.slice(0, 8)) {
    console.log(
      `  risk ${entry.risk.toFixed(1)}% / ATR x${entry.mult.toFixed(1)} / trail x${entry.trail.toFixed(
        1
      )}  →  Sortino ${entry.m.sortino.toFixed(2)}, return ${pct(
        entry.m.totalReturnPct
      )}, maxDD ${pct(entry.m.maxDrawdownPct)}, ${entry.m.trades} trades`
    );
  }
  console.log(
    "NOTE: the shipped defaults are NOT simply this maximum. A sweep maximum on a\n" +
      "2.5-year window is the most overfit point available; the defaults sit in the\n" +
      "middle of the stable region instead. See the PR description."
  );
};

const main = (): void => {
  const bars = loadBars();

  if (process.argv.includes("--sweep")) {
    sweep(bars);
    return;
  }

  for (const window of WINDOWS) {
    console.log(`\n\n=== ${window.label} ===`);
    console.log(`${window.start} → ${window.end}`);
    console.log();

    const before = computeMetrics(runBacktest(legacyEngine(), bars, window.start, window.end));
    const after = computeMetrics(runBacktest(v2Engine(), bars, window.start, window.end));
    // Attribution: the new rules WITHOUT continuous monitoring, so the effect
    // of the Worker can be separated from the effect of the risk rules.
    const rulesOnly = computeMetrics(
      runBacktest(
        { ...v2Engine(), name: "AFTER, rules only (close-only exits)", exitMonitoring: "close" },
        bars,
        window.start,
        window.end
      )
    );
    const spy = computeMetrics(benchmarkResult(bars, window.start, window.end));

    table([before, rulesOnly, after, spy]);
  }

  console.log(
    "\n\nColumn 2 isolates the risk RULES (new stops, sizing, regime) while still\n" +
      "only seeing prices at the close. Column 3 adds continuous exit monitoring,\n" +
      "which is what the Cloudflare Worker provides. The gap between them is the\n" +
      "part of the improvement that comes from scheduling rather than strategy.\n"
  );
};

if (process.argv[1]?.endsWith("backtest.ts")) main();
