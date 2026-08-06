import { describe, it, expect } from "@jest/globals";
import {
  DEFAULT_RISK_CONFIG,
  MIN_NOTIONAL,
  decideExits,
  describeExit,
  drawdownPct,
  loadRiskConfig,
  peakEquity,
  vetBuy,
  type BuyRequest,
  type RiskConfig,
} from "../src/risk.js";

const config: RiskConfig = DEFAULT_RISK_CONFIG;

/** A buy request that passes every rule, so each test varies one thing. */
const baseRequest = (overrides: Partial<BuyRequest> = {}): BuyRequest => ({
  ticker: "NVDA",
  requestedNotional: 20,
  equity: 100,
  cash: 100,
  existingPositionValue: 0,
  buysThisSession: 0,
  currentDrawdownPct: 0,
  config,
  ...overrides,
});

describe("loadRiskConfig", () => {
  it("falls back to defaults when the environment is empty", () => {
    expect(loadRiskConfig({})).toEqual(DEFAULT_RISK_CONFIG);
  });

  it("falls back to defaults when called with no argument at all", () => {
    expect(loadRiskConfig()).toEqual(DEFAULT_RISK_CONFIG);
  });

  it("applies valid overrides", () => {
    const loaded = loadRiskConfig({
      RISK_STOP_LOSS_PCT: "5",
      RISK_MAX_POSITION_PCT: "40",
    });
    expect(loaded.stopLossPct).toBe(5);
    expect(loaded.maxPositionPct).toBe(40);
    // Untouched keys keep their defaults.
    expect(loaded.takeProfitPct).toBe(DEFAULT_RISK_CONFIG.takeProfitPct);
  });

  it("ignores unparseable, zero, and negative values rather than disabling a limit", () => {
    const loaded = loadRiskConfig({
      RISK_STOP_LOSS_PCT: "not-a-number",
      RISK_MAX_POSITION_PCT: "0",
      RISK_CASH_RESERVE_PCT: "-10",
      RISK_MAX_DRAWDOWN_PCT: "",
    });
    expect(loaded.stopLossPct).toBe(DEFAULT_RISK_CONFIG.stopLossPct);
    expect(loaded.maxPositionPct).toBe(DEFAULT_RISK_CONFIG.maxPositionPct);
    expect(loaded.cashReservePct).toBe(DEFAULT_RISK_CONFIG.cashReservePct);
    expect(loaded.maxDrawdownPct).toBe(DEFAULT_RISK_CONFIG.maxDrawdownPct);
  });
});

describe("decideExits", () => {
  it("leaves positions inside the band alone", () => {
    const exits = decideExits(
      [
        { ticker: "AAPL", unrealizedPlPct: 3 },
        { ticker: "MSFT", unrealizedPlPct: -4 },
      ],
      config
    );
    expect(exits).toEqual([]);
  });

  it("closes a position past the stop-loss", () => {
    const exits = decideExits([{ ticker: "AMC", unrealizedPlPct: -9.2 }], config);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ ticker: "AMC", reason: "stop_loss" });
  });

  it("closes a position past the take-profit", () => {
    const exits = decideExits([{ ticker: "NVDA", unrealizedPlPct: 18 }], config);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ ticker: "NVDA", reason: "take_profit" });
  });

  it("treats the thresholds as inclusive", () => {
    expect(decideExits([{ ticker: "A", unrealizedPlPct: -7 }], config)[0].reason).toBe(
      "stop_loss"
    );
    expect(decideExits([{ ticker: "B", unrealizedPlPct: 15 }], config)[0].reason).toBe(
      "take_profit"
    );
  });

  it("does not fire one tick inside either threshold", () => {
    expect(decideExits([{ ticker: "A", unrealizedPlPct: -6.99 }], config)).toEqual([]);
    expect(decideExits([{ ticker: "B", unrealizedPlPct: 14.99 }], config)).toEqual([]);
  });

  it("handles a mixed book, exiting only the breaches", () => {
    const exits = decideExits(
      [
        { ticker: "WIN", unrealizedPlPct: 22 },
        { ticker: "HOLD", unrealizedPlPct: 1 },
        { ticker: "LOSE", unrealizedPlPct: -12 },
      ],
      config
    );
    expect(exits.map((e) => e.ticker)).toEqual(["WIN", "LOSE"]);
  });

  it("skips positions with a non-finite P&L instead of closing them", () => {
    expect(decideExits([{ ticker: "BAD", unrealizedPlPct: NaN }], config)).toEqual([]);
  });

  it("respects a custom configuration", () => {
    const tight: RiskConfig = { ...config, stopLossPct: 2, takeProfitPct: 5 };
    const exits = decideExits([{ ticker: "X", unrealizedPlPct: -3 }], tight);
    expect(exits[0].reason).toBe("stop_loss");
  });

  it("describes exits readably", () => {
    expect(describeExit({ ticker: "NVDA", reason: "take_profit", unrealizedPlPct: 18.4 }))
      .toBe("TAKE-PROFIT NVDA at +18.40%");
    expect(describeExit({ ticker: "AMC", reason: "stop_loss", unrealizedPlPct: -9.2 }))
      .toBe("STOP-LOSS AMC at -9.20%");
  });
});

describe("drawdown", () => {
  it("is zero at a new high", () => {
    expect(drawdownPct(120, 120)).toBe(0);
    expect(drawdownPct(130, 120)).toBe(0);
  });

  it("measures the fall from peak", () => {
    expect(drawdownPct(90, 100)).toBeCloseTo(10, 6);
    // The reported scenario: peaked at 111.54, now 102.89.
    expect(drawdownPct(102.89, 111.54)).toBeCloseTo(7.755, 2);
  });

  it("degrades safely on nonsense input", () => {
    expect(drawdownPct(100, 0)).toBe(0);
    expect(drawdownPct(NaN, 100)).toBe(0);
  });

  it("takes the highest sample as the peak", () => {
    expect(peakEquity([100, 111.54, 105], 102.89)).toBe(111.54);
  });

  it("ignores null and NaN samples in the series", () => {
    expect(peakEquity([100, null, undefined, NaN, 108], 102)).toBe(108);
  });

  it("uses current equity when it exceeds every sample", () => {
    expect(peakEquity([100, 105], 130)).toBe(130);
  });

  it("survives an empty series", () => {
    expect(peakEquity([], 100)).toBe(100);
  });

  it("does not let a non-finite current equity poison the peak", () => {
    expect(peakEquity([100, 120], NaN)).toBe(120);
    expect(peakEquity([], NaN)).toBe(0);
  });
});

describe("vetBuy", () => {
  it("approves a request inside every limit", () => {
    const verdict = vetBuy(baseRequest());
    expect(verdict).toMatchObject({ allowed: true, approvedNotional: 20, clamped: false });
  });

  it("rejects a non-positive amount", () => {
    expect(vetBuy(baseRequest({ requestedNotional: 0 })).allowed).toBe(false);
    expect(vetBuy(baseRequest({ requestedNotional: -5 })).allowed).toBe(false);
  });

  describe("drawdown circuit breaker", () => {
    it("blocks buys at or beyond the limit", () => {
      const verdict = vetBuy(baseRequest({ currentDrawdownPct: 15 }));
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain("RISK HALT");
    });

    it("still allows buys just inside the limit", () => {
      expect(vetBuy(baseRequest({ currentDrawdownPct: 14.9 })).allowed).toBe(true);
    });

    it("tells the agent it may still sell", () => {
      expect(vetBuy(baseRequest({ currentDrawdownPct: 20 })).reason).toMatch(/still sell/i);
    });
  });

  describe("turnover cap", () => {
    it("blocks once the session buy limit is reached", () => {
      const verdict = vetBuy(baseRequest({ buysThisSession: 4 }));
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain("RISK LIMIT");
    });

    it("permits the final allowed buy", () => {
      expect(vetBuy(baseRequest({ buysThisSession: 3 })).allowed).toBe(true);
    });
  });

  describe("cash reserve", () => {
    it("clamps a request that would eat into the reserve", () => {
      // Equity 100 -> reserve 10. Cash 30 -> only 20 deployable.
      const verdict = vetBuy(baseRequest({ cash: 30, requestedNotional: 25 }));
      expect(verdict.allowed).toBe(true);
      expect(verdict.approvedNotional).toBe(20);
      expect(verdict.clamped).toBe(true);
      expect(verdict.reason).toContain("cash reserve");
    });

    it("denies when nothing is deployable", () => {
      const verdict = vetBuy(baseRequest({ cash: 10 }));
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain("cash reserve");
    });
  });

  describe("concentration cap", () => {
    it("clamps to the remaining headroom in a held name", () => {
      // Equity 100 -> cap 25. Already holds 15 -> 10 of headroom.
      const verdict = vetBuy(
        baseRequest({ existingPositionValue: 15, requestedNotional: 40 })
      );
      expect(verdict.approvedNotional).toBe(10);
      expect(verdict.clamped).toBe(true);
      expect(verdict.reason).toContain("per-position cap");
    });

    it("denies a name already at the cap", () => {
      const verdict = vetBuy(baseRequest({ existingPositionValue: 25 }));
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain("per-position cap");
    });

    it("prevents the all-in trade seen in the logs", () => {
      // The agent previously put its entire balance into one ticker.
      const verdict = vetBuy(baseRequest({ requestedNotional: 100 }));
      expect(verdict.approvedNotional).toBe(25);
      expect(verdict.clamped).toBe(true);
    });
  });

  it("applies the tightest binding constraint", () => {
    // Reserve allows 20; position headroom allows 5. Expect 5.
    const verdict = vetBuy(
      baseRequest({ cash: 30, existingPositionValue: 20, requestedNotional: 50 })
    );
    expect(verdict.approvedNotional).toBe(5);
    expect(verdict.reason).toContain("per-position cap");
  });

  it("never approves more than requested", () => {
    const verdict = vetBuy(baseRequest({ requestedNotional: 5, cash: 1000, equity: 1000 }));
    expect(verdict.approvedNotional).toBe(5);
    expect(verdict.clamped).toBe(false);
  });

  it("denies a request below Alpaca's order minimum", () => {
    const verdict = vetBuy(baseRequest({ requestedNotional: 0.5 }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("minimum order size");
  });

  it("denies when headroom is too thin to place any order", () => {
    // $24.50 held against a $25 cap leaves $0.50 — under Alpaca's $1 floor.
    const verdict = vetBuy(baseRequest({ existingPositionValue: 24.5 }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.approvedNotional).toBe(0);
  });

  it("rounds the approved amount down, never up, to stay inside limits", () => {
    // Headroom works out to 13.333...; must not round to 13.34.
    const verdict = vetBuy(
      baseRequest({ equity: 100, cash: 100, existingPositionValue: 11.6667, requestedNotional: 50 })
    );
    expect(verdict.approvedNotional).toBeLessThanOrEqual(25 - 11.6667);
    expect(verdict.approvedNotional).toBe(13.33);
  });

  it("keeps approvals at or above the Alpaca minimum whenever allowed", () => {
    const verdict = vetBuy(baseRequest({ requestedNotional: 1 }));
    expect(verdict.allowed).toBe(true);
    expect(verdict.approvedNotional).toBeGreaterThanOrEqual(MIN_NOTIONAL);
  });
});
