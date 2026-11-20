// Deterministic risk and exit engine.
//
// The trading agent decides WHAT to trade; this module decides HOW MUCH and
// WHEN TO GET OUT. Every function here is pure — no network, no clock, no
// randomness — so the same inputs always produce the same decision, and the
// rules cannot be argued away by a language model having an off session.
//
// The agent proposes, this layer disposes.
//
// PORTABILITY CONTRACT: this file has ZERO imports and never touches
// `process`, the filesystem or the network. That is deliberate and load
// bearing — the same module runs inside the Node agent on GitHub Actions AND
// inside the Cloudflare Worker that sweeps exits every two minutes. Adding an
// import here breaks the Worker build. Config arrives as an injected object,
// never read from the ambient environment.

/** Alpaca rejects notional orders below $1. */
export const MIN_NOTIONAL = 1;

export interface RiskConfig {
  /**
   * Floor for the hard stop, used when no volatility estimate is available.
   * With bar data the stop is scaled to the instrument (see `stopDistancePct`).
   */
  stopLossPct: number;
  /**
   * Hard take-profit, retained only as a BACKSTOP for when bar data is
   * unavailable and the trailing stop therefore cannot run. Deliberately set
   * far out: the measured average win was +5.66% against a +25% ceiling, so
   * this threshold was never what closed a winner — the trailing stop is.
   */
  takeProfitPct: number;
  /** No single position may exceed this percent of total equity. */
  maxPositionPct: number;
  /** Keep at least this percent of equity in cash, undeployed. */
  cashReservePct: number;
  /** Halve position sizing once equity falls this far below its peak. */
  maxDrawdownPct: number;
  /** Cap buy orders per session to limit spread-cost churn. */
  maxBuysPerSession: number;
  /**
   * Refuse to re-buy a ticker sold within this many hours. Kills the
   * sell-then-buy-back-higher round trip, which pays the spread twice for no
   * change in exposure.
   */
  minRebuyHours: number;
  /**
   * Refuse buys below this share price. Sub-$10 names carry percentage spreads
   * one to two orders of magnitude wider than large caps; on an account this
   * size the spread, not the thesis, decides the outcome.
   */
  minSharePrice: number;
  /**
   * Minimum dollar value of a sell. Blocks the "trim $2 off a $20 position"
   * order, which pays a full spread to change nothing.
   */
  minSellNotional: number;
  /**
   * How far back the equity high-water mark is measured. A peak must eventually
   * expire: an unbounded lookback means one good week in August can suppress
   * position sizing until November, long after it stopped being informative.
   */
  peakLookbackDays: number;

  // --- volatility-targeted sizing ------------------------------------------
  /**
   * Percent of equity risked on a single trade, assuming the stop fills at its
   * trigger. This, not a fixed position percentage, is what sizing solves for:
   * notional = equity * riskPerTradePct / stopPct. A name that needs a wide
   * stop therefore gets a SMALL position, and every position carries the same
   * dollar risk regardless of how volatile the instrument is.
   *
   * The failure this exists to prevent: a 40%-of-equity position in a name
   * volatile enough to travel 35% against the book. Under this rule that same
   * name is sized so the planned loss is ~2.5% of equity.
   */
  riskPerTradePct: number;
  /** Hard stop placed this many ATRs below entry. */
  atrStopMultiple: number;
  /** Stop distance is clamped into this band whatever the ATR says. */
  minStopPct: number;
  maxStopPct: number;

  // --- trailing stop --------------------------------------------------------
  /**
   * Trailing only begins once the position's high-water mark is this far above
   * entry. Before that the hard stop is the only protection — a trail that
   * activates immediately is just a tighter stop, and gets hit by noise.
   */
  trailActivatePct: number;
  /** Trail this many ATRs below the high-water mark. */
  trailAtrMultiple: number;
  /** Trail distance is clamped into this band whatever the ATR says. */
  minTrailPct: number;
  maxTrailPct: number;

  // --- book shape -----------------------------------------------------------
  /**
   * Maximum simultaneous open positions. On a ~$100 account each extra name
   * adds a full spread on entry and exit plus its own regulatory fee events,
   * which carry a $0.01 floor and are therefore charged per TRADE rather than
   * per dollar. Measured fees came to 13.5% of gross realised profit.
   */
  maxPositions: number;
  /**
   * Minimum size for OPENING a new position. A $3 position cannot pay for its
   * own round trip once the fee floor and spread are counted; it is a rounding
   * error with a transaction cost attached. Adding to an existing position is
   * exempt.
   */
  minPositionNotional: number;
  /**
   * Minimum holding period before a DISCRETIONARY sell is allowed. Risk-engine
   * exits (stop, trail, take-profit) always bypass this — the rule targets the
   * model reversing its own decision, not genuine risk control.
   *
   * Measured: 14 round trips closed inside two hours, 12 of them losers,
   * netting -$1.19. That is the whole rule's justification.
   */
  minHoldHours: number;
  /**
   * Refuse to BUY when the quoted bid/ask spread is wider than this percent of
   * the mid price.
   *
   * The agent has always fetched both sides of the quote to compute a mid and
   * then thrown the width away — so the one directly observable measure of
   * what a round trip will cost was being discarded at the moment of deciding
   * to pay it. On a liquid large cap this is 0.01-0.05%; anything near a
   * percent means the position needs to move that far before breaking even.
   */
  maxSpreadPct: number;

  // --- market regime --------------------------------------------------------
  /** Fast moving average, in trading days, for the benchmark trend filter. */
  regimeFastDays: number;
  /** Slow moving average, in trading days, for the benchmark trend filter. */
  regimeSlowDays: number;
}

// Tuned for a ~$100 account holding two or three names for days to weeks.
//
// The binding constraint at this size is transaction cost, not catastrophic
// loss, which is why the book is kept deliberately narrow. Sizing is risk
// based rather than a flat percentage: with riskPerTradePct 2.5 and a stop
// between 5% and 12%, a position lands between 21% and 30% of equity (the
// 30% cap binds for calm names, the ATR scaling binds for volatile ones).
// Three such positions put ~80-90% of the account to work, which is the
// exposure needed to compete with holding SPY outright.
export const DEFAULT_RISK_CONFIG: RiskConfig = {
  stopLossPct: 8,
  takeProfitPct: 30,
  maxPositionPct: 30,
  cashReservePct: 5,
  maxDrawdownPct: 20,
  maxBuysPerSession: 2,
  minRebuyHours: 24,
  minSharePrice: 10,
  minSellNotional: 5,
  peakLookbackDays: 30,

  riskPerTradePct: 2.5,
  atrStopMultiple: 2.5,
  minStopPct: 5,
  maxStopPct: 12,

  trailActivatePct: 6,
  trailAtrMultiple: 1.5,
  minTrailPct: 3,
  maxTrailPct: 10,

  maxPositions: 3,
  minPositionNotional: 15,
  minHoldHours: 24,
  maxSpreadPct: 0.5,

  regimeFastDays: 20,
  regimeSlowDays: 100,
};

/**
 * Read overrides from the environment, falling back to the defaults for any
 * value that is missing, unparseable, or non-positive. A typo in a workflow
 * secret should degrade to the safe default, never to an unlimited setting.
 *
 * Takes an injected record rather than reading `process.env`, so the same call
 * works in the Worker (where `process` does not exist).
 */
export const loadRiskConfig = (
  env: Record<string, string | undefined> = {}
): RiskConfig => {
  const read = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  return {
    stopLossPct: read("RISK_STOP_LOSS_PCT", DEFAULT_RISK_CONFIG.stopLossPct),
    takeProfitPct: read("RISK_TAKE_PROFIT_PCT", DEFAULT_RISK_CONFIG.takeProfitPct),
    maxPositionPct: read("RISK_MAX_POSITION_PCT", DEFAULT_RISK_CONFIG.maxPositionPct),
    cashReservePct: read("RISK_CASH_RESERVE_PCT", DEFAULT_RISK_CONFIG.cashReservePct),
    maxDrawdownPct: read("RISK_MAX_DRAWDOWN_PCT", DEFAULT_RISK_CONFIG.maxDrawdownPct),
    maxBuysPerSession: read(
      "RISK_MAX_BUYS_PER_SESSION",
      DEFAULT_RISK_CONFIG.maxBuysPerSession
    ),
    minRebuyHours: read("RISK_MIN_REBUY_HOURS", DEFAULT_RISK_CONFIG.minRebuyHours),
    minSharePrice: read("RISK_MIN_SHARE_PRICE", DEFAULT_RISK_CONFIG.minSharePrice),
    minSellNotional: read(
      "RISK_MIN_SELL_NOTIONAL",
      DEFAULT_RISK_CONFIG.minSellNotional
    ),
    peakLookbackDays: read(
      "RISK_PEAK_LOOKBACK_DAYS",
      DEFAULT_RISK_CONFIG.peakLookbackDays
    ),

    riskPerTradePct: read(
      "RISK_PER_TRADE_PCT",
      DEFAULT_RISK_CONFIG.riskPerTradePct
    ),
    atrStopMultiple: read(
      "RISK_ATR_STOP_MULTIPLE",
      DEFAULT_RISK_CONFIG.atrStopMultiple
    ),
    minStopPct: read("RISK_MIN_STOP_PCT", DEFAULT_RISK_CONFIG.minStopPct),
    maxStopPct: read("RISK_MAX_STOP_PCT", DEFAULT_RISK_CONFIG.maxStopPct),

    trailActivatePct: read(
      "RISK_TRAIL_ACTIVATE_PCT",
      DEFAULT_RISK_CONFIG.trailActivatePct
    ),
    trailAtrMultiple: read(
      "RISK_TRAIL_ATR_MULTIPLE",
      DEFAULT_RISK_CONFIG.trailAtrMultiple
    ),
    minTrailPct: read("RISK_MIN_TRAIL_PCT", DEFAULT_RISK_CONFIG.minTrailPct),
    maxTrailPct: read("RISK_MAX_TRAIL_PCT", DEFAULT_RISK_CONFIG.maxTrailPct),

    maxPositions: read("RISK_MAX_POSITIONS", DEFAULT_RISK_CONFIG.maxPositions),
    minPositionNotional: read(
      "RISK_MIN_POSITION_NOTIONAL",
      DEFAULT_RISK_CONFIG.minPositionNotional
    ),
    minHoldHours: read("RISK_MIN_HOLD_HOURS", DEFAULT_RISK_CONFIG.minHoldHours),
    maxSpreadPct: read("RISK_MAX_SPREAD_PCT", DEFAULT_RISK_CONFIG.maxSpreadPct),

    regimeFastDays: read(
      "RISK_REGIME_FAST_DAYS",
      DEFAULT_RISK_CONFIG.regimeFastDays
    ),
    regimeSlowDays: read(
      "RISK_REGIME_SLOW_DAYS",
      DEFAULT_RISK_CONFIG.regimeSlowDays
    ),
  };
};

// ---------------------------------------------------------------------------
// Volatility measurement
// ---------------------------------------------------------------------------

/** One OHLC bar. Shape matches Alpaca's bar payload after renaming. */
export interface Bar {
  /** ISO timestamp. */
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/**
 * Average True Range as a percent of the latest close.
 *
 * True Range accounts for overnight gaps, which a simple high-minus-low does
 * not — and an overnight gap is precisely how a stop gets skipped on an
 * account that cannot place resting orders. Returns undefined when there are
 * too few bars to measure, which callers must treat as "no estimate" rather
 * than "zero volatility".
 */
export const atrPercent = (bars: Bar[], period = 14): number | undefined => {
  const usable = bars.filter(
    (bar) =>
      Number.isFinite(bar.h) && Number.isFinite(bar.l) && Number.isFinite(bar.c)
  );
  if (usable.length < Math.min(5, period) + 1) return undefined;

  const trueRanges: number[] = [];
  for (let i = 1; i < usable.length; i++) {
    const bar = usable[i];
    const prevClose = usable[i - 1].c;
    trueRanges.push(
      Math.max(
        bar.h - bar.l,
        Math.abs(bar.h - prevClose),
        Math.abs(bar.l - prevClose)
      )
    );
  }

  const window = trueRanges.slice(-period);
  if (window.length === 0) return undefined;

  const atr = window.reduce((sum, tr) => sum + tr, 0) / window.length;
  const lastClose = usable[usable.length - 1].c;
  if (!(lastClose > 0) || !Number.isFinite(atr)) return undefined;
  return (atr / lastClose) * 100;
};

/**
 * Highest high at or after `entryTime`, which is the trailing stop's
 * high-water mark.
 *
 * This is why a trailing stop is possible at all without local state: the
 * mark is RECONSTRUCTED from market data every time it is needed, so nothing
 * has to survive between runs, and a missed run cannot lose the mark. The
 * entry bar is included, since a position opened intraday can set its high on
 * its first day.
 */
export const highWaterSince = (
  bars: Bar[],
  entryTime: string,
  currentPrice?: number
): number | undefined => {
  const entryMs = new Date(entryTime).getTime();
  let high = Number.isFinite(currentPrice as number)
    ? (currentPrice as number)
    : -Infinity;

  for (const bar of bars) {
    const barMs = new Date(bar.t).getTime();
    if (!Number.isFinite(barMs) || !Number.isFinite(bar.h)) continue;
    // Compare on the calendar day: a daily bar is stamped at midnight, so a
    // strict timestamp comparison would discard the entry day itself.
    if (barMs + 86_400_000 <= entryMs) continue;
    if (bar.h > high) high = bar.h;
  }

  return Number.isFinite(high) && high > 0 ? high : undefined;
};

/**
 * Stop distance in percent for an instrument, from its ATR.
 *
 * Clamped at both ends: the floor stops a quiet week producing a 1% stop that
 * noise trips immediately, and the ceiling stops a genuinely wild name being
 * given so much room that the position it justifies is pointlessly tiny.
 * Falls back to the flat `stopLossPct` when no ATR estimate exists.
 */
export const stopDistancePct = (
  atrPct: number | undefined,
  config: RiskConfig
): number => {
  if (atrPct === undefined || !Number.isFinite(atrPct) || atrPct <= 0) {
    return config.stopLossPct;
  }
  return clamp(
    config.atrStopMultiple * atrPct,
    config.minStopPct,
    config.maxStopPct
  );
};

/** Trail distance in percent, same clamping logic as the hard stop. */
export const trailDistancePct = (
  atrPct: number | undefined,
  config: RiskConfig
): number => {
  if (atrPct === undefined || !Number.isFinite(atrPct) || atrPct <= 0) {
    return clamp(config.stopLossPct, config.minTrailPct, config.maxTrailPct);
  }
  return clamp(
    config.trailAtrMultiple * atrPct,
    config.minTrailPct,
    config.maxTrailPct
  );
};

// ---------------------------------------------------------------------------
// Position sizing
// ---------------------------------------------------------------------------

export interface SizeRequest {
  /** Total account value. */
  equity: number;
  /** Stop distance in percent for this instrument (see `stopDistancePct`). */
  stopPct: number;
  /** Risk budget multiplier from the regime filter, 0-1. */
  riskMultiplier?: number;
  config: RiskConfig;
}

export interface SizeVerdict {
  notional: number;
  /** Percent of equity this notional represents. */
  pctOfEquity: number;
  /** Which rule determined the figure, for logs and for the model's context. */
  binding: "risk_budget" | "position_cap";
  reason: string;
}

/**
 * Volatility-targeted position size.
 *
 * Solves `notional * stopPct = equity * riskPerTradePct` — i.e. every position
 * is sized so that being stopped out costs the same fixed fraction of the
 * account, whatever the instrument's volatility. The concentration cap then
 * applies on top, because a very tight stop would otherwise justify a position
 * larger than the whole book.
 */
export const sizePosition = (request: SizeRequest): SizeVerdict => {
  const { config, equity } = request;
  const multiplier = Number.isFinite(request.riskMultiplier as number)
    ? clamp(request.riskMultiplier as number, 0, 1)
    : 1;

  if (!(equity > 0)) {
    return {
      notional: 0,
      pctOfEquity: 0,
      binding: "risk_budget",
      reason: "No equity to deploy.",
    };
  }

  const stopPct = Math.max(0.1, request.stopPct);
  const riskPct = config.riskPerTradePct * multiplier;
  const fromRisk = (equity * riskPct) / stopPct;
  const cap = equity * (config.maxPositionPct / 100);

  const notional = Math.floor(Math.min(fromRisk, cap) * 100) / 100;
  const binding = fromRisk <= cap ? "risk_budget" : "position_cap";

  return {
    notional,
    pctOfEquity: (notional / equity) * 100,
    binding,
    reason:
      binding === "risk_budget"
        ? `Sized to risk ${riskPct.toFixed(2)}% of equity against a ${stopPct.toFixed(
            1
          )}% stop: $${notional.toFixed(2)} (${((notional / equity) * 100).toFixed(
            1
          )}% of equity).`
        : `Sized at the ${config.maxPositionPct}% concentration cap: $${notional.toFixed(
            2
          )}. The ${stopPct.toFixed(1)}% stop would have justified $${fromRisk.toFixed(
            2
          )}.`,
  };
};

// ---------------------------------------------------------------------------
// Execution cost
// ---------------------------------------------------------------------------

export interface SpreadVerdict {
  /** Spread as a percent of the mid price, or undefined when unquotable. */
  spreadPct?: number;
  acceptable: boolean;
  reason: string;
}

/**
 * Judge the quoted bid/ask spread before paying it.
 *
 * Fees and spread together came to 13.5% of gross realised profit on this
 * account, and the spread half of that is the half nobody was measuring. A
 * round trip pays this twice, so a 1% spread means the thesis has to be worth
 * more than 2% before the trade breaks even.
 *
 * Fails OPEN on a missing or nonsensical quote: a data gap must not block a
 * legitimate trade, and the penny-stock filter already covers the names where
 * spreads are reliably awful.
 */
export const vetSpread = (
  bid: number | undefined,
  ask: number | undefined,
  config: RiskConfig
): SpreadVerdict => {
  if (
    bid === undefined ||
    ask === undefined ||
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    bid <= 0 ||
    ask <= 0 ||
    ask < bid
  ) {
    return {
      acceptable: true,
      reason: "No usable two-sided quote — spread check skipped.",
    };
  }

  const mid = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / mid) * 100;

  if (spreadPct > config.maxSpreadPct) {
    return {
      spreadPct,
      acceptable: false,
      reason:
        `RISK BLOCK: ${spreadPct.toFixed(2)}% bid/ask spread ($${bid.toFixed(
          2
        )} / $${ask.toFixed(2)}) exceeds the ${config.maxSpreadPct}% limit. ` +
        `A round trip pays this twice, so the position would need to move ` +
        `${(spreadPct * 2).toFixed(2)}% just to break even. Pick a more liquid name, ` +
        `or wait — spreads are widest in the first and last minutes of the session.`,
    };
  }

  return {
    spreadPct,
    acceptable: true,
    reason: `Spread ${spreadPct.toFixed(3)}% is within the ${config.maxSpreadPct}% limit.`,
  };
};

// ---------------------------------------------------------------------------
// Market regime
// ---------------------------------------------------------------------------

export type Regime = "risk_on" | "neutral" | "risk_off";

export interface RegimeVerdict {
  regime: Regime;
  /** Multiplier applied to the per-trade risk budget. */
  riskMultiplier: number;
  /** Position-count ceiling for this regime. */
  maxPositions: number;
  reason: string;
}

const mean = (values: number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Trend state of the benchmark, used to scale gross exposure.
 *
 * The measured problem this addresses: beta +0.57 with annualised alpha
 * -10.83%. The book took most of the market's risk and none of its return,
 * because nothing in the system ever asked whether being long was a good idea
 * at all — only which name to be long. This asks that one question.
 *
 * Deliberately crude. Two moving averages on the benchmark is the most
 * over-studied signal in existence, which makes it a poor source of edge but a
 * reasonable source of exposure control, and it has almost no free parameters
 * to overfit. Unknown data fails SAFE-BUT-INVESTED (neutral), because
 * defaulting to risk_off on a data outage would silently stop the strategy.
 */
export const detectRegime = (
  benchmarkCloses: number[],
  config: RiskConfig
): RegimeVerdict => {
  const closes = benchmarkCloses.filter(
    (close) => Number.isFinite(close) && close > 0
  );
  const fastDays = Math.max(2, Math.round(config.regimeFastDays));
  const slowDays = Math.max(fastDays + 1, Math.round(config.regimeSlowDays));

  if (closes.length < slowDays) {
    return {
      regime: "neutral",
      riskMultiplier: 1,
      maxPositions: config.maxPositions,
      reason: `Only ${closes.length} benchmark closes available, need ${slowDays}. Treating the regime as neutral.`,
    };
  }

  const price = closes[closes.length - 1];
  const fast = mean(closes.slice(-fastDays));
  const slow = mean(closes.slice(-slowDays));

  const describe = (verdict: string) =>
    `${verdict} — benchmark ${price.toFixed(2)}, ${fastDays}d MA ${fast.toFixed(
      2
    )}, ${slowDays}d MA ${slow.toFixed(2)}.`;

  // Below the long trend is the only state that genuinely cuts exposure. Being
  // above the slow MA but below the fast one is ordinary noise inside an
  // uptrend and must not trigger de-risking.
  if (price < slow) {
    return {
      regime: "risk_off",
      riskMultiplier: 0.5,
      maxPositions: 1,
      reason: describe(
        "RISK-OFF: benchmark below its long-term trend. Half risk per trade, one position maximum"
      ),
    };
  }

  if (fast > slow) {
    return {
      regime: "risk_on",
      riskMultiplier: 1,
      maxPositions: config.maxPositions,
      reason: describe("RISK-ON: benchmark above both trends. Full risk budget"),
    };
  }

  return {
    regime: "neutral",
    riskMultiplier: 0.75,
    maxPositions: Math.max(1, config.maxPositions - 1),
    reason: describe(
      "NEUTRAL: benchmark above its long trend but the short trend has rolled over. Three-quarter risk"
    ),
  };
};

// ---------------------------------------------------------------------------
// Exit decisions
// ---------------------------------------------------------------------------

/** The subset of a position this module needs in order to judge it. */
export interface RiskPosition {
  ticker: string;
  unrealizedPlPct: number;
  /** Current mark. Required for the trailing stop. */
  currentPrice?: number;
  /** Average entry price. Required for the trailing stop. */
  avgEntryPrice?: number;
  /**
   * Highest price seen since entry, from `highWaterSince`. Absent means the
   * trailing stop cannot run for this position and only the hard stop applies.
   */
  highWaterPrice?: number;
  /** ATR as a percent of price, from `atrPercent`. */
  atrPct?: number;
}

export type ExitReason = "stop_loss" | "take_profit" | "trailing_stop";

export interface ExitDecision {
  ticker: string;
  reason: ExitReason;
  unrealizedPlPct: number;
  /** The threshold that was breached, in percent, for logging. */
  thresholdPct?: number;
}

/**
 * Decide which positions must be closed outright, before the agent gets a say.
 *
 * Checked in order of severity: the hard stop first, because it is the one that
 * caps catastrophic loss and must never be shadowed by a softer rule; then the
 * trailing stop; then the fixed take-profit, which now exists only as a
 * backstop for positions with no bar data.
 *
 * The trailing stop works WITHOUT any stored state because its high-water mark
 * is reconstructed from bars on every call (see `highWaterSince`). The previous
 * version of this comment said a trailing stop was impossible for that reason;
 * it was wrong — the mark does not need to be remembered, only recomputed.
 * Alpaca's native trailing-stop ORDER type is still unavailable on fractional
 * positions, which is why this is enforced by polling rather than resting at
 * the broker.
 */
export const decideExits = (
  positions: RiskPosition[],
  config: RiskConfig
): ExitDecision[] => {
  const decisions: ExitDecision[] = [];

  for (const position of positions) {
    if (!Number.isFinite(position.unrealizedPlPct)) continue;

    // 1. Hard stop, scaled to the instrument's volatility when known.
    const stopPct = stopDistancePct(position.atrPct, config);
    if (position.unrealizedPlPct <= -stopPct) {
      decisions.push({
        ticker: position.ticker,
        reason: "stop_loss",
        unrealizedPlPct: position.unrealizedPlPct,
        thresholdPct: stopPct,
      });
      continue;
    }

    // 2. Trailing stop, once the position has actually shown a gain.
    const { currentPrice, avgEntryPrice, highWaterPrice } = position;
    if (
      Number.isFinite(currentPrice as number) &&
      Number.isFinite(avgEntryPrice as number) &&
      Number.isFinite(highWaterPrice as number) &&
      (avgEntryPrice as number) > 0 &&
      (highWaterPrice as number) > 0
    ) {
      const highWaterGainPct =
        ((highWaterPrice as number) / (avgEntryPrice as number) - 1) * 100;

      if (highWaterGainPct >= config.trailActivatePct) {
        const trailPct = trailDistancePct(position.atrPct, config);
        const trigger = (highWaterPrice as number) * (1 - trailPct / 100);
        if ((currentPrice as number) <= trigger) {
          decisions.push({
            ticker: position.ticker,
            reason: "trailing_stop",
            unrealizedPlPct: position.unrealizedPlPct,
            thresholdPct: trailPct,
          });
          continue;
        }
      }
    }

    // 3. Fixed take-profit backstop.
    if (position.unrealizedPlPct >= config.takeProfitPct) {
      decisions.push({
        ticker: position.ticker,
        reason: "take_profit",
        unrealizedPlPct: position.unrealizedPlPct,
        thresholdPct: config.takeProfitPct,
      });
    }
  }

  return decisions;
};

/** Human-readable summary of an exit, for logs and for the agent's context. */
export const describeExit = (decision: ExitDecision): string => {
  const label =
    decision.reason === "stop_loss"
      ? "STOP-LOSS"
      : decision.reason === "trailing_stop"
        ? "TRAILING-STOP"
        : "TAKE-PROFIT";
  const sign = decision.unrealizedPlPct < 0 ? "-" : "+";
  const threshold =
    decision.thresholdPct !== undefined
      ? ` (threshold ${decision.thresholdPct.toFixed(1)}%)`
      : "";
  return `${label} ${decision.ticker} at ${sign}${Math.abs(
    decision.unrealizedPlPct
  ).toFixed(2)}%${threshold}`;
};

// ---------------------------------------------------------------------------
// Drawdown
// ---------------------------------------------------------------------------

/**
 * Percent below peak, never negative. A new all-time high is a 0% drawdown,
 * not a negative one.
 */
export const drawdownPct = (currentEquity: number, peakEquity: number): number => {
  if (!Number.isFinite(currentEquity) || !Number.isFinite(peakEquity)) return 0;
  if (peakEquity <= 0) return 0;
  return Math.max(0, ((peakEquity - currentEquity) / peakEquity) * 100);
};

/**
 * Peak equity from an Alpaca portfolio-history series, ignoring null/NaN
 * samples. Current equity is included so a fresh high counts even before it
 * lands in the history series.
 */
export const peakEquity = (
  equitySeries: Array<number | null | undefined>,
  currentEquity: number
): number => {
  let peak = Number.isFinite(currentEquity) ? currentEquity : 0;
  for (const value of equitySeries) {
    if (typeof value === "number" && Number.isFinite(value) && value > peak) {
      peak = value;
    }
  }
  return peak;
};

// ---------------------------------------------------------------------------
// Buy vetting
// ---------------------------------------------------------------------------

export interface BuyRequest {
  ticker: string;
  /** Dollar amount the agent wants to deploy. */
  requestedNotional: number;
  /** Total account value (cash + positions). */
  equity: number;
  /** Cash currently available. */
  cash: number;
  /** Market value already held in this ticker. */
  existingPositionValue: number;
  /** Buy orders already placed this session. */
  buysThisSession: number;
  /** Current drawdown from peak, in percent. */
  currentDrawdownPct: number;
  /**
   * Hours since this ticker was last SOLD, or undefined if it has not been sold
   * recently. Derived from broker fill history, so nothing has to survive
   * locally between runs.
   */
  hoursSinceLastSell?: number;
  /** Current share price, when known. Undefined skips the penny-stock check. */
  sharePrice?: number;
  /**
   * Number of distinct positions currently open. Undefined skips the
   * position-count ceiling.
   */
  openPositionCount?: number;
  /** Position-count ceiling for the current regime; defaults to the config value. */
  maxPositionsOverride?: number;
  config: RiskConfig;
}

export interface BuyVerdict {
  allowed: boolean;
  /** Amount actually permitted; 0 when denied. Never exceeds the request. */
  approvedNotional: number;
  /** True when allowed but reduced below the requested amount. */
  clamped: boolean;
  /** Always populated — fed back to the agent so it can adapt. */
  reason: string;
}

/**
 * Apply every position-sizing rule to a proposed buy.
 *
 * Where possible this CLAMPS rather than denies: returning a smaller permitted
 * amount lets the agent still act, whereas a hard denial burns one of its few
 * turns. Denial is reserved for cases where no trade at all is acceptable.
 *
 * Sells are vetted only for triviality and minimum hold (see `vetSell`) — never
 * for direction. Blocking a real exit could trap the agent in a losing
 * position, which is far more dangerous than any oversized buy.
 */
export const vetBuy = (request: BuyRequest): BuyVerdict => {
  const { config } = request;

  const deny = (reason: string): BuyVerdict => ({
    allowed: false,
    approvedNotional: 0,
    clamped: false,
    reason,
  });

  if (!Number.isFinite(request.requestedNotional) || request.requestedNotional <= 0) {
    return deny("Requested amount must be a positive dollar figure.");
  }

  // 1. Penny-stock filter — below this price the bid/ask spread, not the
  //    thesis, determines the outcome of a round trip.
  if (
    request.sharePrice !== undefined &&
    Number.isFinite(request.sharePrice) &&
    request.sharePrice < config.minSharePrice
  ) {
    return deny(
      `RISK BLOCK: ${request.ticker} trades at $${request.sharePrice.toFixed(
        2
      )}, below the $${config.minSharePrice} minimum share price. Sub-$${
        config.minSharePrice
      } names carry spreads wide enough to consume any edge on an account this ` +
        `size. Pick a liquid large-cap instead — fractional orders make share price irrelevant to affordability.`
    );
  }

  // 2. Re-buy cooldown — selling a name and buying it back the same day pays
  //    the spread twice and leaves exposure unchanged.
  if (
    request.hoursSinceLastSell !== undefined &&
    Number.isFinite(request.hoursSinceLastSell) &&
    request.hoursSinceLastSell < config.minRebuyHours
  ) {
    return deny(
      `RISK BLOCK: you sold ${request.ticker} ${request.hoursSinceLastSell.toFixed(
        1
      )}h ago and cannot re-buy it for another ${(
        config.minRebuyHours - request.hoursSinceLastSell
      ).toFixed(1)}h. Reversing a decision within a day is churn, not a trade — ` +
        `it pays the spread twice for no change in exposure. Deploy into a different name or hold.`
    );
  }

  // 3. Turnover cap — every round trip pays the spread.
  if (request.buysThisSession >= config.maxBuysPerSession) {
    return deny(
      `RISK LIMIT: ${request.buysThisSession} buy order(s) already placed this session ` +
        `(max ${config.maxBuysPerSession}). Further buys are blocked; excessive turnover ` +
        `loses more to spread than it gains.`
    );
  }

  // 4. Position-count ceiling — only for OPENING a new name. Adding to a name
  //    already held changes concentration, not the number of spreads paid, and
  //    is governed by the per-position cap below instead.
  const positionCeiling = Number.isFinite(request.maxPositionsOverride as number)
    ? Math.max(1, Math.round(request.maxPositionsOverride as number))
    : Math.max(1, Math.round(config.maxPositions));

  const openingNewPosition = request.existingPositionValue < MIN_NOTIONAL;
  if (
    openingNewPosition &&
    request.openPositionCount !== undefined &&
    Number.isFinite(request.openPositionCount) &&
    request.openPositionCount >= positionCeiling
  ) {
    return deny(
      `RISK LIMIT: ${request.openPositionCount} position(s) already open (max ${positionCeiling}). ` +
        `Each additional name pays its own spread on entry and exit plus per-trade regulatory fees ` +
        `with a $0.01 floor, which on this account size is charged per trade rather than per dollar. ` +
        `Close something first if you want ${request.ticker} more than what you already hold.`
    );
  }

  // 5. Cash reserve — never deploy the last dollar.
  const reserve = request.equity * (config.cashReservePct / 100);
  const deployableCash = request.cash - reserve;
  if (deployableCash < MIN_NOTIONAL) {
    return deny(
      `RISK LIMIT: only $${Math.max(0, deployableCash).toFixed(
        2
      )} is deployable after holding the ${config.cashReservePct}% cash reserve ` +
        `($${reserve.toFixed(2)} of $${request.equity.toFixed(2)} equity).`
    );
  }

  // 6. Drawdown response — DE-RISK, never halt.
  //
  //    A hard buy-block during drawdown is an absorbing state: recovering
  //    requires being invested, so blocking every buy while stop-losses keep
  //    firing guarantees the account ratchets down and never climbs back to the
  //    peak that triggered the block. Halving position size cuts risk while
  //    leaving a path back up.
  const derisked = request.currentDrawdownPct >= config.maxDrawdownPct;
  const effectiveMaxPositionPct = derisked
    ? config.maxPositionPct / 2
    : config.maxPositionPct;

  // 7. Concentration cap — no single name may dominate the book.
  const positionCap = request.equity * (effectiveMaxPositionPct / 100);
  const headroom = positionCap - request.existingPositionValue;
  if (headroom < MIN_NOTIONAL) {
    return deny(
      `RISK LIMIT: ${request.ticker} already holds $${request.existingPositionValue.toFixed(
        2
      )}, at or above the ${effectiveMaxPositionPct}% per-position cap ` +
        `($${positionCap.toFixed(2)})${
          derisked ? " (halved because the account is in drawdown)" : ""
        }. Buy something else or trim this position first.`
    );
  }

  // Round DOWN to cents so a rounding artifact can never breach a limit.
  const permitted = Math.min(request.requestedNotional, deployableCash, headroom);
  const approvedNotional = Math.floor(permitted * 100) / 100;

  if (approvedNotional < MIN_NOTIONAL) {
    return deny(
      `RISK LIMIT: only $${approvedNotional.toFixed(2)} would be permitted for ` +
        `${request.ticker}, below the $${MIN_NOTIONAL.toFixed(2)} minimum order size.`
    );
  }

  // 8. Minimum size for a NEW position. A position too small to pay for its own
  //    round trip should not be opened at all — but adding to an existing
  //    holding is exempt, since that spread is already sunk.
  //
  //    The floor can never exceed what the concentration cap structurally
  //    allows. Without that clamp this rule would quietly undo the de-risk
  //    design above: on a ~$100 account the halved cap is about $14, so a $15
  //    floor would deny every new position precisely when the account is in
  //    drawdown — recreating the absorbing state that halving exists to avoid.
  const effectiveMinPosition = Math.min(config.minPositionNotional, positionCap);
  if (openingNewPosition && approvedNotional < effectiveMinPosition) {
    return deny(
      `RISK LIMIT: $${approvedNotional.toFixed(2)} is below the $${effectiveMinPosition.toFixed(
        2
      )} minimum for opening a new position. A stake this small cannot cover its own ` +
        `spread and fee floor on a round trip — regulatory fees are charged per trade ` +
        `with a $0.01 floor, so a tiny position pays the same cents as a large one. ` +
        `Either free up cash by closing something, or add to a name you already hold.`
    );
  }

  // Half a cent of slack keeps float noise from reporting a phantom clamp.
  const clamped = approvedNotional < request.requestedNotional - 0.005;
  if (!clamped) {
    return {
      allowed: true,
      approvedNotional,
      clamped: false,
      reason: "Within risk limits.",
    };
  }

  const binding =
    deployableCash <= headroom
      ? `the ${config.cashReservePct}% cash reserve`
      : `the ${effectiveMaxPositionPct}% per-position cap${
          derisked ? " (halved because the account is in drawdown)" : ""
        }`;

  return {
    allowed: true,
    approvedNotional,
    clamped: true,
    reason:
      `RISK ADJUSTED: reduced from $${request.requestedNotional.toFixed(2)} to ` +
      `$${approvedNotional.toFixed(2)} for ${request.ticker}, limited by ${binding}.`,
  };
};

// ---------------------------------------------------------------------------
// Sell vetting
// ---------------------------------------------------------------------------

export interface SellRequest {
  ticker: string;
  /** Dollar value of the proposed sale. */
  notional: number;
  /** Dollar value of the whole position, used to recognise a full exit. */
  positionValue: number;
  /**
   * Hours since the position was opened. Undefined skips the minimum-hold
   * check, so a missing entry time can never trap a position.
   */
  hoursSinceEntry?: number;
  /**
   * Set by the risk engine for its own exits (stop, trail, take-profit). These
   * bypass the minimum hold entirely — the hold rule exists to stop the model
   * reversing itself, not to delay risk control.
   */
  isRiskExit?: boolean;
  config: RiskConfig;
}

export interface SellVerdict {
  allowed: boolean;
  reason: string;
}

/**
 * Reject trivially small sells, and discretionary sells inside the minimum
 * holding period.
 *
 * A trim worth a couple of dollars pays a full bid/ask spread to change
 * essentially nothing about the book — it is a rounding error with a
 * transaction cost attached.
 *
 * A full exit is ALWAYS permitted on size grounds regardless of value: closing
 * a $2 leftover is legitimate housekeeping. It is still subject to the minimum
 * hold unless flagged as a risk exit, because "bought it this morning, changed
 * my mind by lunch" was measurably the most expensive habit in the trade
 * history.
 */
export const vetSell = (request: SellRequest): SellVerdict => {
  const { config } = request;

  if (!Number.isFinite(request.notional) || request.notional <= 0) {
    return { allowed: false, reason: "Sell amount must be a positive dollar figure." };
  }

  // Risk-engine exits are never blocked, for any reason.
  if (request.isRiskExit) {
    return { allowed: true, reason: "Risk-engine exit — always permitted." };
  }

  // Minimum hold applies to the model's own discretionary sells.
  if (
    request.hoursSinceEntry !== undefined &&
    Number.isFinite(request.hoursSinceEntry) &&
    request.hoursSinceEntry < config.minHoldHours
  ) {
    return {
      allowed: false,
      reason:
        `RISK BLOCK: ${request.ticker} was opened ${request.hoursSinceEntry.toFixed(
          1
        )}h ago and cannot be sold discretionarily for another ${(
          config.minHoldHours - request.hoursSinceEntry
        ).toFixed(1)}h. Round trips closed inside a day have been consistently ` +
        `loss-making on this account — 12 of the last 14 lost money. The stop-loss and ` +
        `trailing stop still protect this position and are not subject to this rule, ` +
        `so a genuine breakdown will be exited automatically without you.`,
    };
  }

  // Treat "within a cent of the whole position" as a full exit — fractional
  // share counts do not round-trip cleanly through JSON.
  const isFullExit = request.notional >= request.positionValue - 0.01;
  if (isFullExit) {
    return { allowed: true, reason: "Full exit — always permitted." };
  }

  if (request.notional < config.minSellNotional) {
    return {
      allowed: false,
      reason:
        `RISK BLOCK: a $${request.notional.toFixed(2)} sell of ${request.ticker} is below the ` +
        `$${config.minSellNotional} minimum. A trim this small pays a full bid/ask spread to ` +
        `change nothing — the position is worth $${request.positionValue.toFixed(2)}. ` +
        `Either exit the position properly or leave it alone.`,
    };
  }

  return { allowed: true, reason: "Within risk limits." };
};

// ---------------------------------------------------------------------------
// Fill-derived history helpers
// ---------------------------------------------------------------------------

/** A filled order, reduced to what the cooldown rules need. */
export interface FillRecord {
  ticker: string;
  side: "buy" | "sell";
  /** ISO timestamp of the fill. */
  date: string;
  /**
   * Shares filled. Strongly recommended: without it, `hoursSinceEntry` cannot
   * tell a partial trim from a full exit and must assume the latter.
   */
  qty?: number;
}

/**
 * Hours since `ticker` was last sold, or undefined if it was never sold in the
 * supplied history. Derived from broker fills so the rule survives the agent
 * being stateless between runs.
 */
export const hoursSinceLastSell = (
  ticker: string,
  fills: FillRecord[],
  now: Date = new Date()
): number | undefined => {
  let latest: number | undefined;
  for (const fill of fills) {
    if (fill.side !== "sell") continue;
    if (fill.ticker.toUpperCase() !== ticker.toUpperCase()) continue;
    const at = new Date(fill.date).getTime();
    if (!Number.isFinite(at)) continue;
    if (latest === undefined || at > latest) latest = at;
  }
  if (latest === undefined) return undefined;
  return Math.max(0, (now.getTime() - latest) / 3_600_000);
};

/**
 * Hours since the CURRENT holding in `ticker` was opened.
 *
 * Replays the fills forward, tracking the running share count, and dates the
 * holding from the buy that took the position off zero. A position added to
 * twice still dates from its original entry, which is the honest reading of
 * "how long have I held this".
 *
 * The share count is the whole point. An earlier version treated ANY sell as
 * ending the run of ownership, which silently broke on partially trimmed
 * positions: a live AAPL holding bought on 2026-08-13 and trimmed twice
 * afterwards reported no entry date at all, which disabled its trailing stop
 * without any error — the position simply showed "high-water n/a" in the logs.
 * Any position that had ever been trimmed lost its trailing stop.
 *
 * Without quantities it degrades to the old assumption, which is conservative
 * in the right direction: it under-reports the holding period, so the
 * minimum-hold rule stands down rather than trapping a position.
 */
export const hoursSinceEntry = (
  ticker: string,
  fills: FillRecord[],
  now: Date = new Date()
): number | undefined => {
  const relevant = fills
    .filter((fill) => fill.ticker.toUpperCase() === ticker.toUpperCase())
    .map((fill) => ({ ...fill, at: new Date(fill.date).getTime() }))
    .filter((fill) => Number.isFinite(fill.at))
    .sort((a, b) => a.at - b.at);

  if (relevant.length === 0) return undefined;

  // Fractional share counts do not sum exactly, so "closed" means "within a
  // rounding error of zero" rather than exactly zero.
  const FLAT = 1e-9;
  let held = 0;
  let entryAt: number | undefined;

  for (const fill of relevant) {
    const qty =
      typeof fill.qty === "number" && Number.isFinite(fill.qty)
        ? Math.abs(fill.qty)
        : undefined;

    if (fill.side === "buy") {
      // Only a sell may clear the entry date. Re-dating here whenever the
      // running count looked flat would restart the clock on every top-up in
      // the no-quantity case, where the count never leaves zero.
      if (entryAt === undefined) entryAt = fill.at;
      held += qty ?? 0;
      continue;
    }

    if (qty === undefined) {
      // No quantity to reason with: assume the sell closed the position.
      entryAt = undefined;
      held = 0;
      continue;
    }

    held -= qty;
    if (held <= FLAT) {
      held = 0;
      entryAt = undefined;
    }
  }

  if (entryAt === undefined) return undefined;
  return Math.max(0, (now.getTime() - entryAt) / 3_600_000);
};
