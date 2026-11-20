import { describe, it, expect } from "@jest/globals";
import {
  DEFAULT_RISK_CONFIG,
  atrPercent,
  decideExits,
  describeExit,
  detectRegime,
  highWaterSince,
  hoursSinceEntry,
  sizePosition,
  stopDistancePct,
  trailDistancePct,
  vetBuy,
  vetSell,
  vetSpread,
  type Bar,
  type BuyRequest,
  type FillRecord,
  type RiskConfig,
} from "../src/risk.js";

/**
 * Tests for the volatility, trailing-stop, sizing, regime and execution-cost
 * additions.
 *
 * Kept separate from risk.test.ts so the original proofs stay readable and are
 * not quietly restated in terms of the new rules. Behaviour is asserted against
 * an explicit config, as in that file: retuning a shipped default is a trading
 * decision and must not silently rewrite what the engine is proven to do.
 */
const config: RiskConfig = {
  ...DEFAULT_RISK_CONFIG,
  stopLossPct: 8,
  takeProfitPct: 30,
  maxPositionPct: 30,
  cashReservePct: 5,
  maxDrawdownPct: 20,
  maxBuysPerSession: 2,
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
};

/** Bars with a constant daily range, so the expected ATR is exact. */
const flatRangeBars = (count: number, close: number, rangePct: number): Bar[] => {
  const half = (close * rangePct) / 200;
  return Array.from({ length: count }, (_, i) => ({
    t: new Date(Date.UTC(2025, 0, i + 1)).toISOString(),
    o: close,
    h: close + half,
    l: close - half,
    c: close,
  }));
};

describe("atrPercent", () => {
  it("measures a constant daily range as that percentage", () => {
    // Range is a flat 4% of price every day and the close never moves, so true
    // range equals high-low and ATR% is exactly 4.
    const atr = atrPercent(flatRangeBars(20, 100, 4));
    expect(atr).toBeCloseTo(4, 5);
  });

  it("counts an overnight gap, not just the intraday range", () => {
    // Two bars with tiny intraday ranges but a large gap between them. A naive
    // high-minus-low would report ~1%; true range must see the 10% gap, because
    // a gap is exactly how a stop gets skipped.
    const bars: Bar[] = [
      { t: "2025-01-01T00:00:00Z", o: 100, h: 100.5, l: 99.5, c: 100 },
      { t: "2025-01-02T00:00:00Z", o: 110, h: 110.5, l: 109.5, c: 110 },
      { t: "2025-01-03T00:00:00Z", o: 110, h: 110.5, l: 109.5, c: 110 },
      { t: "2025-01-04T00:00:00Z", o: 110, h: 110.5, l: 109.5, c: 110 },
      { t: "2025-01-05T00:00:00Z", o: 110, h: 110.5, l: 109.5, c: 110 },
      { t: "2025-01-06T00:00:00Z", o: 110, h: 110.5, l: 109.5, c: 110 },
    ];
    const atr = atrPercent(bars);
    expect(atr).toBeDefined();
    // The gap bar contributes ~10.5 of true range, lifting the average well
    // above the ~0.9% the intraday ranges alone would give.
    expect(atr as number).toBeGreaterThan(2);
  });

  it("returns undefined rather than zero when there is too little data", () => {
    // The distinction matters: undefined means "no estimate" and falls back to
    // the flat stop; zero would mean "no volatility" and justify a huge
    // position.
    expect(atrPercent([])).toBeUndefined();
    expect(atrPercent(flatRangeBars(2, 100, 4))).toBeUndefined();
  });

  it("ignores unusable bars", () => {
    const bars = flatRangeBars(20, 100, 4);
    bars[5] = { ...bars[5], h: NaN };
    expect(atrPercent(bars)).toBeCloseTo(4, 1);
  });
});

describe("highWaterSince", () => {
  const bars: Bar[] = [
    { t: "2025-01-01T00:00:00Z", o: 100, h: 105, l: 99, c: 100 },
    { t: "2025-01-02T00:00:00Z", o: 100, h: 120, l: 99, c: 110 },
    { t: "2025-01-03T00:00:00Z", o: 110, h: 115, l: 105, c: 108 },
  ];

  it("takes the highest high at or after entry", () => {
    expect(highWaterSince(bars, "2025-01-02T00:00:00Z")).toBe(120);
  });

  it("includes the entry day, which can set the high", () => {
    // A position opened intraday can peak on its first day; excluding that bar
    // would start the trail below where the position actually traded.
    expect(highWaterSince(bars, "2025-01-01T12:00:00Z")).toBe(120);
  });

  it("excludes highs from before entry", () => {
    expect(highWaterSince(bars, "2025-01-03T00:00:00Z")).toBe(115);
  });

  it("lets the live price exceed every bar", () => {
    expect(highWaterSince(bars, "2025-01-01T00:00:00Z", 130)).toBe(130);
  });

  it("returns undefined with no usable bars", () => {
    expect(highWaterSince([], "2025-01-01T00:00:00Z")).toBeUndefined();
  });
});

describe("stopDistancePct / trailDistancePct", () => {
  it("scales the stop with volatility", () => {
    expect(stopDistancePct(3, config)).toBeCloseTo(7.5, 5);
  });

  it("clamps a quiet instrument up to the floor", () => {
    // 2.5 x 0.5% = 1.25%, which noise would trip immediately.
    expect(stopDistancePct(0.5, config)).toBe(config.minStopPct);
  });

  it("clamps a wild instrument down to the ceiling", () => {
    expect(stopDistancePct(20, config)).toBe(config.maxStopPct);
  });

  it("falls back to the flat stop with no ATR estimate", () => {
    expect(stopDistancePct(undefined, config)).toBe(config.stopLossPct);
    expect(stopDistancePct(NaN, config)).toBe(config.stopLossPct);
    expect(stopDistancePct(0, config)).toBe(config.stopLossPct);
  });

  it("keeps the trail inside its own band", () => {
    expect(trailDistancePct(4, config)).toBeCloseTo(6, 5);
    expect(trailDistancePct(0.1, config)).toBe(config.minTrailPct);
    expect(trailDistancePct(50, config)).toBe(config.maxTrailPct);
  });
});

describe("decideExits — trailing stop", () => {
  it("does not arm before the position has shown a real gain", () => {
    // High-water is only +3%, below the 6% activation, so a pullback here is
    // noise rather than a surrendered gain.
    const decisions = decideExits(
      [
        {
          ticker: "AAPL",
          unrealizedPlPct: 0,
          avgEntryPrice: 100,
          highWaterPrice: 103,
          currentPrice: 100,
          atrPct: 2,
        },
      ],
      config
    );
    expect(decisions).toHaveLength(0);
  });

  it("fires once an armed position gives back the trail distance", () => {
    // High-water +20%, ATR 2% so the trail is 3%: the trigger is 120 * 0.97.
    const decisions = decideExits(
      [
        {
          ticker: "AAPL",
          unrealizedPlPct: 16,
          avgEntryPrice: 100,
          highWaterPrice: 120,
          currentPrice: 116,
          atrPct: 2,
        },
      ],
      config
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0].reason).toBe("trailing_stop");
  });

  it("holds while the position is still near its high", () => {
    const decisions = decideExits(
      [
        {
          ticker: "AAPL",
          unrealizedPlPct: 18,
          avgEntryPrice: 100,
          highWaterPrice: 120,
          currentPrice: 118,
          atrPct: 2,
        },
      ],
      config
    );
    expect(decisions).toHaveLength(0);
  });

  it("gives a volatile name more room before trailing out", () => {
    // ATR 6% -> trail 9%. A 5% pullback from the high exits a calm name but
    // not this one.
    const volatile = {
      ticker: "TSLA",
      unrealizedPlPct: 14,
      avgEntryPrice: 100,
      highWaterPrice: 120,
      currentPrice: 114,
      atrPct: 6,
    };
    expect(decideExits([volatile], config)).toHaveLength(0);
    expect(decideExits([{ ...volatile, atrPct: 1 }], config)).toHaveLength(1);
  });

  it("puts the hard stop ahead of the trailing stop", () => {
    // Both would fire; the hard stop must win so the reported reason reflects
    // the more severe condition.
    const decisions = decideExits(
      [
        {
          ticker: "NVDA",
          unrealizedPlPct: -20,
          avgEntryPrice: 100,
          highWaterPrice: 120,
          currentPrice: 80,
          atrPct: 2,
        },
      ],
      config
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0].reason).toBe("stop_loss");
  });

  it("still honours the flat stop when no bar data is available", () => {
    // This is the degraded path: without bars there is no ATR and no
    // high-water mark, and the engine must not silently stop protecting.
    const decisions = decideExits(
      [{ ticker: "F", unrealizedPlPct: -9 }],
      config
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0].reason).toBe("stop_loss");
    expect(decisions[0].thresholdPct).toBe(config.stopLossPct);
  });

  it("scales the hard stop to the instrument when bars exist", () => {
    // ATR 1% -> stop clamped to the 5% floor, so -6% is a breach even though
    // the flat 8% stop would not have fired yet.
    const decisions = decideExits(
      [{ ticker: "KO", unrealizedPlPct: -6, atrPct: 1 }],
      config
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0].thresholdPct).toBe(5);
  });

  it("describes a trailing exit distinctly", () => {
    expect(
      describeExit({
        ticker: "AAPL",
        reason: "trailing_stop",
        unrealizedPlPct: 12.5,
        thresholdPct: 3,
      })
    ).toContain("TRAILING-STOP");
  });

  it("skips positions with an unusable P&L figure", () => {
    expect(decideExits([{ ticker: "X", unrealizedPlPct: NaN }], config)).toHaveLength(0);
  });
});

describe("sizePosition", () => {
  it("solves for a fixed dollar risk against the stop", () => {
    // 2.5% of $1000 = $25 of risk; a 10% stop means a $250 position.
    const verdict = sizePosition({ equity: 1000, stopPct: 10, config });
    expect(verdict.notional).toBeCloseTo(250, 2);
    expect(verdict.binding).toBe("risk_budget");
  });

  it("gives a volatile name a smaller position than a calm one", () => {
    // This is the whole point of the rule, and the specific failure it
    // prevents: a 35% adverse move in a 38%-of-equity position.
    //
    // Both stops here are wide enough that the RISK budget binds rather than
    // the concentration cap — the equal-dollar-risk property only holds in that
    // regime, since the cap deliberately overrides it for very tight stops.
    const calm = sizePosition({ equity: 1000, stopPct: 10, config });
    const wild = sizePosition({ equity: 1000, stopPct: 12, config });
    expect(calm.binding).toBe("risk_budget");
    expect(wild.binding).toBe("risk_budget");
    expect(wild.notional).toBeLessThan(calm.notional);
    // Equal dollar risk either way: 2.5% of $1000 = $25 in both cases.
    expect((wild.notional * 12) / 100).toBeCloseTo(25, 1);
    expect((calm.notional * 10) / 100).toBeCloseTo(25, 1);
  });

  it("lets the cap override equal-risk sizing for a very tight stop", () => {
    // A 2% stop would justify $1,250 on a $1,000 account. The cap must win,
    // which necessarily means this position carries LESS than the full risk
    // budget — that asymmetry is intended.
    const verdict = sizePosition({ equity: 1000, stopPct: 2, config });
    expect(verdict.binding).toBe("position_cap");
    expect((verdict.notional * 2) / 100).toBeLessThan(25);
  });

  it("never exceeds the concentration cap", () => {
    // A 1% stop would justify 250% of equity; the cap must bind.
    const verdict = sizePosition({ equity: 1000, stopPct: 1, config });
    expect(verdict.notional).toBeCloseTo(300, 2);
    expect(verdict.binding).toBe("position_cap");
  });

  it("scales down with the regime multiplier", () => {
    const full = sizePosition({ equity: 1000, stopPct: 10, config });
    const half = sizePosition({
      equity: 1000,
      stopPct: 10,
      riskMultiplier: 0.5,
      config,
    });
    expect(half.notional).toBeCloseTo(full.notional / 2, 2);
  });

  it("clamps a nonsensical multiplier instead of trusting it", () => {
    const over = sizePosition({ equity: 1000, stopPct: 10, riskMultiplier: 9, config });
    const normal = sizePosition({ equity: 1000, stopPct: 10, config });
    expect(over.notional).toBe(normal.notional);
    const under = sizePosition({ equity: 1000, stopPct: 10, riskMultiplier: -1, config });
    expect(under.notional).toBe(0);
  });

  it("returns nothing to deploy on a dead account", () => {
    expect(sizePosition({ equity: 0, stopPct: 8, config }).notional).toBe(0);
    expect(sizePosition({ equity: -50, stopPct: 8, config }).notional).toBe(0);
  });

  it("never rounds up past a limit", () => {
    const verdict = sizePosition({ equity: 93.54, stopPct: 7, config });
    expect(verdict.notional).toBeLessThanOrEqual((93.54 * 2.5) / 7);
  });
});

describe("detectRegime", () => {
  /** A series rising by `step` each day, then optionally falling. */
  const series = (count: number, start: number, step: number): number[] =>
    Array.from({ length: count }, (_, i) => start + i * step);

  it("reports risk-on in a steady uptrend", () => {
    const verdict = detectRegime(series(150, 100, 1), config);
    expect(verdict.regime).toBe("risk_on");
    expect(verdict.riskMultiplier).toBe(1);
    expect(verdict.maxPositions).toBe(config.maxPositions);
  });

  it("reports risk-off below the long trend, and cuts exposure", () => {
    const verdict = detectRegime([...series(150, 100, 1), ...series(40, 240, -4)], config);
    expect(verdict.regime).toBe("risk_off");
    expect(verdict.riskMultiplier).toBeLessThan(1);
    expect(verdict.maxPositions).toBe(1);
  });

  it("fails to NEUTRAL, not risk-off, when there is too little history", () => {
    // Defaulting to risk_off on a data outage would silently halt the strategy;
    // defaulting to risk_on would silently max it out. Neutral is the only
    // honest answer to "I don't know".
    const verdict = detectRegime(series(10, 100, 1), config);
    expect(verdict.regime).toBe("neutral");
    expect(verdict.riskMultiplier).toBe(1);
    expect(verdict.reason).toMatch(/neutral/i);
  });

  it("does not de-risk on ordinary noise inside an uptrend", () => {
    // Above the slow MA but with the fast MA rolled over is a normal pullback,
    // not a regime change.
    const verdict = detectRegime([...series(150, 100, 2), ...series(15, 400, -3)], config);
    expect(verdict.regime).not.toBe("risk_off");
  });

  it("ignores unusable prices", () => {
    const withJunk = [...series(150, 100, 1)];
    const verdict = detectRegime([...withJunk, NaN, 0, -5] as number[], config);
    expect(verdict.regime).toBe("risk_on");
  });
});

describe("vetSpread", () => {
  it("accepts a tight institutional spread", () => {
    const verdict = vetSpread(100.0, 100.02, config);
    expect(verdict.acceptable).toBe(true);
    expect(verdict.spreadPct).toBeCloseTo(0.02, 2);
  });

  it("refuses a spread that would need a 2% move to break even", () => {
    const verdict = vetSpread(100, 101, config);
    expect(verdict.acceptable).toBe(false);
    expect(verdict.reason).toMatch(/spread/i);
  });

  it("fails OPEN on a missing or crossed quote", () => {
    // A data gap must not block a legitimate trade; the penny-stock filter
    // already covers the names whose spreads are reliably bad.
    expect(vetSpread(undefined, undefined, config).acceptable).toBe(true);
    expect(vetSpread(0, 100, config).acceptable).toBe(true);
    expect(vetSpread(101, 100, config).acceptable).toBe(true);
    expect(vetSpread(NaN, 100, config).acceptable).toBe(true);
  });
});

describe("hoursSinceEntry", () => {
  const now = new Date("2025-03-10T15:00:00Z");

  it("dates a holding from its first buy", () => {
    const fills: FillRecord[] = [
      { ticker: "AAPL", side: "buy", date: "2025-03-09T15:00:00Z" },
      { ticker: "AAPL", side: "buy", date: "2025-03-10T09:00:00Z" },
    ];
    expect(hoursSinceEntry("AAPL", fills, now)).toBeCloseTo(24, 1);
  });

  it("restarts the clock after a full exit", () => {
    const fills: FillRecord[] = [
      { ticker: "AAPL", side: "buy", date: "2025-01-01T15:00:00Z" },
      { ticker: "AAPL", side: "sell", date: "2025-02-01T15:00:00Z" },
      { ticker: "AAPL", side: "buy", date: "2025-03-10T09:00:00Z" },
    ];
    expect(hoursSinceEntry("AAPL", fills, now)).toBeCloseTo(6, 1);
  });

  it("returns undefined when the last event was a sell", () => {
    const fills: FillRecord[] = [
      { ticker: "AAPL", side: "buy", date: "2025-01-01T15:00:00Z" },
      { ticker: "AAPL", side: "sell", date: "2025-02-01T15:00:00Z" },
    ];
    expect(hoursSinceEntry("AAPL", fills, now)).toBeUndefined();
  });

  it("keeps the original entry date through PARTIAL trims", () => {
    // REGRESSION, found by a dry run against the live account. A real AAPL
    // holding bought 2026-08-13 and trimmed twice afterwards reported NO entry
    // date, because any sell was treated as closing the position. That silently
    // disabled the trailing stop — the logs just showed "high-water n/a" — for
    // every position that had ever been trimmed.
    const fills: FillRecord[] = [
      { ticker: "AAPL", side: "buy", date: "2025-03-08T15:00:00Z", qty: 0.0815 },
      { ticker: "AAPL", side: "buy", date: "2025-03-09T15:00:00Z", qty: 0.0353 },
      { ticker: "AAPL", side: "sell", date: "2025-03-09T18:00:00Z", qty: 0.0317 },
      { ticker: "AAPL", side: "sell", date: "2025-03-10T09:00:00Z", qty: 0.03 },
    ];
    // Still holding ~0.055 shares, so the holding dates from the FIRST buy.
    expect(hoursSinceEntry("AAPL", fills, now)).toBeCloseTo(48, 1);
  });

  it("restarts the clock when trims eventually flatten the position", () => {
    const fills: FillRecord[] = [
      { ticker: "AAPL", side: "buy", date: "2025-01-01T15:00:00Z", qty: 1 },
      { ticker: "AAPL", side: "sell", date: "2025-01-02T15:00:00Z", qty: 0.5 },
      { ticker: "AAPL", side: "sell", date: "2025-01-03T15:00:00Z", qty: 0.5 },
      { ticker: "AAPL", side: "buy", date: "2025-03-10T09:00:00Z", qty: 2 },
    ];
    expect(hoursSinceEntry("AAPL", fills, now)).toBeCloseTo(6, 1);
  });

  it("treats a fractional dust remainder as flat", () => {
    // Fractional quantities do not sum exactly; a 1e-12 remainder is closed.
    const fills: FillRecord[] = [
      { ticker: "AAPL", side: "buy", date: "2025-01-01T15:00:00Z", qty: 0.3 },
      { ticker: "AAPL", side: "sell", date: "2025-01-02T15:00:00Z", qty: 0.1 },
      { ticker: "AAPL", side: "sell", date: "2025-01-03T15:00:00Z", qty: 0.2 },
    ];
    expect(hoursSinceEntry("AAPL", fills, now)).toBeUndefined();
  });

  it("degrades conservatively when quantities are missing", () => {
    // Without quantities a trim is indistinguishable from an exit. Reporting
    // "no entry" stands the minimum-hold rule down rather than trapping a
    // position, which is the safe direction to be wrong in.
    const fills: FillRecord[] = [
      { ticker: "AAPL", side: "buy", date: "2025-03-08T15:00:00Z" },
      { ticker: "AAPL", side: "sell", date: "2025-03-09T18:00:00Z" },
    ];
    expect(hoursSinceEntry("AAPL", fills, now)).toBeUndefined();
  });

  it("is unaffected by other tickers and by fill ordering", () => {
    const fills: FillRecord[] = [
      { ticker: "MSFT", side: "buy", date: "2025-03-01T15:00:00Z" },
      { ticker: "aapl", side: "buy", date: "2025-03-10T09:00:00Z" },
      { ticker: "MSFT", side: "sell", date: "2025-03-05T15:00:00Z" },
    ];
    expect(hoursSinceEntry("AAPL", fills, now)).toBeCloseTo(6, 1);
  });

  it("returns undefined for an unknown ticker", () => {
    expect(hoursSinceEntry("ZZZZ", [], now)).toBeUndefined();
  });
});

describe("vetBuy — position count and minimum stake", () => {
  const baseRequest = (overrides: Partial<BuyRequest> = {}): BuyRequest => ({
    ticker: "NVDA",
    requestedNotional: 25,
    equity: 100,
    cash: 100,
    existingPositionValue: 0,
    buysThisSession: 0,
    currentDrawdownPct: 0,
    sharePrice: 200,
    config,
    ...overrides,
  });

  it("refuses a new name once the position ceiling is reached", () => {
    const verdict = vetBuy(baseRequest({ openPositionCount: 3 }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/position\(s\) already open/i);
  });

  it("still allows adding to a name already held at the ceiling", () => {
    // The ceiling exists to limit how many spreads and fee events the account
    // pays, and adding to an existing holding does not add a new name.
    const verdict = vetBuy(
      baseRequest({ openPositionCount: 3, existingPositionValue: 10 })
    );
    expect(verdict.allowed).toBe(true);
  });

  it("honours a tighter ceiling from the regime filter", () => {
    const verdict = vetBuy(
      baseRequest({ openPositionCount: 1, maxPositionsOverride: 1 })
    );
    expect(verdict.allowed).toBe(false);
  });

  it("skips the ceiling entirely when the count is unknown", () => {
    expect(vetBuy(baseRequest({ openPositionCount: undefined })).allowed).toBe(true);
  });

  it("refuses to open a position too small to pay for its round trip", () => {
    const verdict = vetBuy(baseRequest({ requestedNotional: 6, cash: 10 }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/minimum for opening a new position/i);
  });

  it("exempts adding to an existing holding from the minimum stake", () => {
    // That spread is already sunk, so a $6 top-up is not the same decision as
    // opening a $6 position.
    const verdict = vetBuy(
      baseRequest({ requestedNotional: 6, cash: 10, existingPositionValue: 20 })
    );
    expect(verdict.allowed).toBe(true);
  });

  it("does not let the minimum stake undo de-risking", () => {
    // REGRESSION: the floor must never exceed what the halved concentration cap
    // structurally allows. On a ~$100 account the halved cap is ~$15, so a
    // fixed $15 floor would deny every new position exactly while the account
    // is in drawdown — recreating the absorbing state that halving exists to
    // prevent.
    const verdict = vetBuy(
      baseRequest({ currentDrawdownPct: 50, requestedNotional: 25 })
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.approvedNotional).toBeGreaterThan(0);
    expect(verdict.approvedNotional).toBeLessThanOrEqual(15);
  });
});

describe("vetSell — minimum holding period", () => {
  const sell = (overrides: Partial<Parameters<typeof vetSell>[0]> = {}) => ({
    ticker: "GOOG",
    notional: 20,
    positionValue: 20,
    config,
    ...overrides,
  });

  it("blocks a discretionary exit inside the holding period", () => {
    const verdict = vetSell(sell({ hoursSinceEntry: 2 }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/cannot be sold discretionarily/i);
  });

  it("allows it once the period has elapsed", () => {
    expect(vetSell(sell({ hoursSinceEntry: 30 })).allowed).toBe(true);
  });

  it("NEVER blocks a risk-engine exit, however fresh the position", () => {
    // The most important assertion in this file. The hold rule targets the
    // model reversing itself; a stop-loss must always get through, or the rule
    // becomes a way to trap a collapsing position.
    const verdict = vetSell(sell({ hoursSinceEntry: 0.1, isRiskExit: true }));
    expect(verdict.allowed).toBe(true);
  });

  it("does not block when the holding age is unknown", () => {
    // Fail open: an unreachable order history must never trap a position.
    expect(vetSell(sell({ hoursSinceEntry: undefined })).allowed).toBe(true);
    expect(vetSell(sell({ hoursSinceEntry: NaN })).allowed).toBe(true);
  });

  it("still rejects a trivial trim after the holding period", () => {
    const verdict = vetSell(
      sell({ notional: 2, positionValue: 40, hoursSinceEntry: 100 })
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/minimum/i);
  });

  it("rejects a nonsensical sell amount before anything else", () => {
    expect(vetSell(sell({ notional: 0 })).allowed).toBe(false);
    expect(vetSell(sell({ notional: NaN })).allowed).toBe(false);
  });
});

describe("fail-safe behaviour", () => {
  /**
   * These assert the property the whole engine exists for: when an input is
   * missing, malformed or hostile, the outcome is a smaller trade or no trade —
   * never a larger one.
   */
  it("never approves a buy on malformed numbers", () => {
    const hostile: Array<Partial<BuyRequest>> = [
      { requestedNotional: NaN },
      { requestedNotional: Infinity },
      { requestedNotional: -100 },
      { requestedNotional: 0 },
    ];
    for (const overrides of hostile) {
      const verdict = vetBuy({
        ticker: "NVDA",
        requestedNotional: 25,
        equity: 100,
        cash: 100,
        existingPositionValue: 0,
        buysThisSession: 0,
        currentDrawdownPct: 0,
        config,
        ...overrides,
      });
      if (verdict.allowed) {
        expect(verdict.approvedNotional).toBeLessThanOrEqual(30);
      } else {
        expect(verdict.approvedNotional).toBe(0);
      }
    }
  });

  it("never sizes a position above the concentration cap, for any stop", () => {
    for (const stopPct of [0.0001, 0.1, 1, 5, 8, 12, 50, 100]) {
      const verdict = sizePosition({ equity: 1000, stopPct, config });
      expect(verdict.notional).toBeLessThanOrEqual(1000 * (config.maxPositionPct / 100));
    }
  });

  it("never lets a zero or negative ATR justify a huge position", () => {
    // A zero-volatility reading would divide into an unbounded size if the
    // floor were not enforced.
    for (const atr of [0, -1, NaN, undefined]) {
      const stopPct = stopDistancePct(atr as number, config);
      expect(stopPct).toBeGreaterThanOrEqual(Math.min(config.minStopPct, config.stopLossPct));
      expect(sizePosition({ equity: 1000, stopPct, config }).notional).toBeLessThanOrEqual(300);
    }
  });

  it("keeps protecting a position when every optional input is missing", () => {
    // The fully degraded case: no bars, no quote, no entry time. The flat stop
    // must still fire.
    const decisions = decideExits([{ ticker: "F", unrealizedPlPct: -12 }], config);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].reason).toBe("stop_loss");
  });

  it("loads a usable config from hostile environment values", () => {
    const { loadRiskConfig } = require("../src/risk.js") as typeof import("../src/risk.js");
    const loaded = loadRiskConfig({
      RISK_PER_TRADE_PCT: "not-a-number",
      RISK_MAX_POSITIONS: "-5",
      RISK_MIN_HOLD_HOURS: "",
      RISK_MAX_SPREAD_PCT: "0",
    });
    expect(loaded.riskPerTradePct).toBe(DEFAULT_RISK_CONFIG.riskPerTradePct);
    expect(loaded.maxPositions).toBe(DEFAULT_RISK_CONFIG.maxPositions);
    expect(loaded.minHoldHours).toBe(DEFAULT_RISK_CONFIG.minHoldHours);
    expect(loaded.maxSpreadPct).toBe(DEFAULT_RISK_CONFIG.maxSpreadPct);
  });
});
