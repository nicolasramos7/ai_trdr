// Deterministic risk and exit engine.
//
// The trading agent decides WHAT to trade; this module decides HOW MUCH and
// WHEN TO GET OUT. Every function here is pure — no network, no clock, no
// randomness — so the same inputs always produce the same decision, and the
// rules cannot be argued away by a language model having an off session.
//
// The agent proposes, this layer disposes.

/** Alpaca rejects notional orders below $1. */
export const MIN_NOTIONAL = 1;

export interface RiskConfig {
  /** Close a position once it is down this many percent (positive number). */
  stopLossPct: number;
  /** Close a position once it is up this many percent. */
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
}

// Tuned for a ~$100 account trading a few times a day. The binding constraint
// at this size is transaction cost, not catastrophic loss: a 25% position cap
// forces at least four names, which on liquid large caps is an index tracker
// paying spread on every rebalance. Fewer, larger, longer-held positions is the
// only shape in which a small account can express an edge at all.
export const DEFAULT_RISK_CONFIG: RiskConfig = {
  stopLossPct: 8,
  takeProfitPct: 25,
  maxPositionPct: 40,
  cashReservePct: 5,
  maxDrawdownPct: 20,
  maxBuysPerSession: 2,
  minRebuyHours: 24,
  minSharePrice: 10,
  minSellNotional: 5,
  peakLookbackDays: 30,
};

/**
 * Read overrides from the environment, falling back to the defaults for any
 * value that is missing, unparseable, or non-positive. A typo in a workflow
 * secret should degrade to the safe default, never to an unlimited setting.
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
  };
};

// ---------------------------------------------------------------------------
// Exit decisions
// ---------------------------------------------------------------------------

/** The subset of a position this module needs in order to judge it. */
export interface RiskPosition {
  ticker: string;
  unrealizedPlPct: number;
}

export type ExitReason = "stop_loss" | "take_profit";

export interface ExitDecision {
  ticker: string;
  reason: ExitReason;
  unrealizedPlPct: number;
}

/**
 * Decide which positions must be closed outright, before the agent gets a say.
 *
 * Note this is a fixed take-profit rather than a trailing stop. A trailing stop
 * would let winners run further, but it needs a per-position high-water mark:
 * the agent holds no state between runs, and Alpaca's native trailing-stop
 * orders are unavailable on fractional positions (fractional supports only
 * market/limit day orders). Revisit if positions move back to whole shares.
 */
export const decideExits = (
  positions: RiskPosition[],
  config: RiskConfig
): ExitDecision[] => {
  const decisions: ExitDecision[] = [];
  for (const position of positions) {
    if (!Number.isFinite(position.unrealizedPlPct)) continue;
    if (position.unrealizedPlPct <= -config.stopLossPct) {
      decisions.push({
        ticker: position.ticker,
        reason: "stop_loss",
        unrealizedPlPct: position.unrealizedPlPct,
      });
    } else if (position.unrealizedPlPct >= config.takeProfitPct) {
      decisions.push({
        ticker: position.ticker,
        reason: "take_profit",
        unrealizedPlPct: position.unrealizedPlPct,
      });
    }
  }
  return decisions;
};

/** Human-readable summary of an exit, for logs and for the agent's context. */
export const describeExit = (decision: ExitDecision): string => {
  const label = decision.reason === "stop_loss" ? "STOP-LOSS" : "TAKE-PROFIT";
  const sign = decision.unrealizedPlPct < 0 ? "-" : "+";
  return `${label} ${decision.ticker} at ${sign}${Math.abs(
    decision.unrealizedPlPct
  ).toFixed(2)}%`;
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
 * Sells are vetted only for triviality (see `vetSell`) — never for direction.
 * Blocking a real exit could trap the agent in a losing position, which is far
 * more dangerous than any oversized buy.
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

  // 4. Cash reserve — never deploy the last dollar.
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

  // 5. Drawdown response — DE-RISK, never halt.
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

  // 6. Concentration cap — no single name may dominate the book.
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
  config: RiskConfig;
}

export interface SellVerdict {
  allowed: boolean;
  reason: string;
}

/**
 * Reject only trivially small sells.
 *
 * A trim worth a couple of dollars pays a full bid/ask spread to change
 * essentially nothing about the book — it is a rounding error with a
 * transaction cost attached. This is the mirror of `MIN_NOTIONAL` on the buy
 * side, which the sell path previously lacked entirely.
 *
 * A full exit is ALWAYS permitted regardless of size: closing a $2 leftover is
 * legitimate housekeeping, and never blocking an exit is the whole point.
 */
export const vetSell = (request: SellRequest): SellVerdict => {
  const { config } = request;

  if (!Number.isFinite(request.notional) || request.notional <= 0) {
    return { allowed: false, reason: "Sell amount must be a positive dollar figure." };
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
// Re-buy cooldown
// ---------------------------------------------------------------------------

/** A filled order, reduced to what the cooldown rule needs. */
export interface FillRecord {
  ticker: string;
  side: "buy" | "sell";
  /** ISO timestamp of the fill. */
  date: string;
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
