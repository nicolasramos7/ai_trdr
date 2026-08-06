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
  /** Block new buys once equity falls this far below its peak. */
  maxDrawdownPct: number;
  /** Cap buy orders per session to limit spread-cost churn. */
  maxBuysPerSession: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  stopLossPct: 7,
  takeProfitPct: 15,
  maxPositionPct: 25,
  cashReservePct: 10,
  maxDrawdownPct: 15,
  maxBuysPerSession: 4,
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
 * Sells are deliberately never vetted. Blocking an exit could trap the agent
 * in a losing position, which is far more dangerous than any oversized buy.
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

  // 1. Circuit breaker — the account is in trouble; stop adding risk.
  if (request.currentDrawdownPct >= config.maxDrawdownPct) {
    return deny(
      `RISK HALT: equity is ${request.currentDrawdownPct.toFixed(
        1
      )}% below its peak, at or beyond the ${config.maxDrawdownPct}% max-drawdown limit. ` +
        `New buys are blocked for this session. You may still sell or close positions.`
    );
  }

  // 2. Turnover cap — every round trip pays the spread.
  if (request.buysThisSession >= config.maxBuysPerSession) {
    return deny(
      `RISK LIMIT: ${request.buysThisSession} buy order(s) already placed this session ` +
        `(max ${config.maxBuysPerSession}). Further buys are blocked; excessive turnover ` +
        `loses more to spread than it gains.`
    );
  }

  // 3. Cash reserve — never deploy the last dollar.
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

  // 4. Concentration cap — no single name may dominate the book.
  const positionCap = request.equity * (config.maxPositionPct / 100);
  const headroom = positionCap - request.existingPositionValue;
  if (headroom < MIN_NOTIONAL) {
    return deny(
      `RISK LIMIT: ${request.ticker} already holds $${request.existingPositionValue.toFixed(
        2
      )}, at or above the ${config.maxPositionPct}% per-position cap ` +
        `($${positionCap.toFixed(2)}). Buy something else or trim this position first.`
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
      : `the ${config.maxPositionPct}% per-position cap`;

  return {
    allowed: true,
    approvedNotional,
    clamped: true,
    reason:
      `RISK ADJUSTED: reduced from $${request.requestedNotional.toFixed(2)} to ` +
      `$${approvedNotional.toFixed(2)} for ${request.ticker}, limited by ${binding}.`,
  };
};
