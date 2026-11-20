// Exit sweep — Cloudflare Worker, cron-triggered every two minutes.
//
// WHY THIS EXISTS, in one paragraph:
//
// Stop-losses used to live only inside the trading agent's own process, which
// ran four times a day on GitHub Actions. Measured over 192 scheduled runs on
// this repository, 40% of those runs started AFTER the 16:00 ET close (worst
// observed delay 7h25m), so in practice a position was checked against its
// stop once or twice a day at unpredictable times. One position drifted to -35%
// against an -8% stop and cost 10.3% of the account — the entire gap to the
// benchmark, from a stop that existed in code and never got the chance to run.
//
// Cron DELAY, not cron drop, was the problem: delivery was ~98% reliable but
// arbitrarily late. The fix is to stop depending on a scheduler for timing.
// This Worker is purpose-built for punctual small jobs: the exit sweep is three
// HTTP calls and some float comparisons, so Cloudflare's 10ms free-tier CPU
// budget is ample (time spent awaiting fetch does not count toward it).
//
// It shares `decideExits` VERBATIM with the Node agent — same module, same
// thresholds, same 50+ unit tests. There is no second implementation to drift.
//
// This Worker only ever SELLS. It cannot open a position, so the worst case
// from a bug here is being flat, never being unexpectedly long.

import {
  atrPercent,
  decideExits,
  describeExit,
  highWaterSince,
  hoursSinceEntry,
  loadRiskConfig,
  type Bar,
  type FillRecord,
  type RiskPosition,
} from "../../src/risk.js";

export interface Env {
  ALPACA_API_KEY: string;
  ALPACA_SECRET_KEY: string;
  /** Paper endpoint. Defaults to the paper host and is refused if it is not. */
  ALPACA_BASE_URL?: string;
  /** Market-data feed. `iex` is free on paper accounts; `sip` needs a subscription. */
  ALPACA_DATA_FEED?: string;
  /**
   * When set, GET / returns a DRY-RUN report for whoever presents this token.
   * Unset (the default) makes the HTTP endpoint a flat 404. The sweep itself
   * runs on the cron trigger and never needs an inbound request.
   */
  SWEEP_TOKEN?: string;
  // Risk overrides — identical names to the Node agent, so one set of values
  // configures both halves of the system.
  [key: string]: string | undefined;
}

const DATA_BASE = "https://data.alpaca.markets";

/** Minutes of dedup protection against submitting the same exit twice. */
const DEDUP_BUCKET_MINUTES = 10;

interface SweepReport {
  ranAt: string;
  marketOpen: boolean;
  positionsChecked: number;
  exits: string[];
  submitted: string[];
  skipped: string[];
  errors: string[];
}

const alpacaHeaders = (env: Env): Record<string, string> => ({
  "APCA-API-KEY-ID": env.ALPACA_API_KEY,
  "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY,
  accept: "application/json",
});

const tradingBase = (env: Env): string => {
  const raw = env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
  const base = raw.replace(/\/+$/, "").replace(/\/v2$/, "");
  // Same guard rail as the Node agent: never point this at live trading.
  if (!/paper-api\.alpaca\.markets/.test(base)) {
    throw new Error(`Refusing to run: ${base} is not the Alpaca paper endpoint.`);
  }
  return base;
};

const num = (value: unknown, fallback = NaN): number => {
  const parsed = parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
};

async function alpacaGet<T>(url: string, env: Env): Promise<T> {
  const res = await fetch(url, { headers: alpacaHeaders(env) });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${url}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/**
 * Deterministic order id, bucketed into ten-minute windows.
 *
 * Two safety properties at once. Alpaca rejects a duplicate
 * `client_order_id`, so if this Worker fires again two minutes later while the
 * previous sell is still working, the second submission is refused by the
 * broker rather than doubling the trade. And because the id is derived rather
 * than random, a network timeout that hides a SUCCESSFUL submission cannot
 * turn into a second position-closing order on the next sweep.
 */
const exitOrderId = (symbol: string, reason: string, now: Date): string => {
  const bucket = Math.floor(now.getTime() / (DEDUP_BUCKET_MINUTES * 60_000));
  return `risk-${reason}-${symbol}-${bucket}`.toLowerCase().slice(0, 120);
};

async function runSweep(env: Env, dryRun: boolean): Promise<SweepReport> {
  const now = new Date();
  const report: SweepReport = {
    ranAt: now.toISOString(),
    marketOpen: false,
    positionsChecked: 0,
    exits: [],
    submitted: [],
    skipped: [],
    errors: [],
  };

  const base = tradingBase(env);
  const config = loadRiskConfig(env as Record<string, string | undefined>);

  // 1. Ask the broker whether the market is open. This is the authoritative
  //    answer — it covers federal holidays and half-days, which a hand-rolled
  //    weekday-and-clock check silently gets wrong. Three sessions ran on
  //    Labor Day 2026 under the old check.
  const clock = await alpacaGet<{ is_open: boolean; next_close: string }>(
    `${base}/v2/clock`,
    env
  );
  report.marketOpen = clock.is_open === true;
  if (!report.marketOpen) return report;

  // 2. Current positions.
  const positions = await alpacaGet<Record<string, unknown>[]>(
    `${base}/v2/positions`,
    env
  );
  const open = positions.filter((p) => Math.abs(num(p.qty, 0)) > 0);
  report.positionsChecked = open.length;
  if (open.length === 0) return report;

  const symbols = open.map((p) => String(p.symbol));

  // 3. Entry times, derived from broker fills. The trailing stop needs to know
  //    when each holding started so it can find the high since then; nothing is
  //    stored locally, so this is recomputed every sweep and a missed sweep
  //    cannot lose the high-water mark.
  let fills: FillRecord[] = [];
  try {
    // Filtered to the symbols actually held. This keeps the payload small —
    // which matters against the free plan's 10ms CPU budget for JSON parsing —
    // and guarantees enough history per position to find its opening buy, which
    // an unfiltered `limit=100` would stop doing as the account's order count
    // grows past it.
    const orders = await alpacaGet<Record<string, unknown>[]>(
      `${base}/v2/orders?status=all&limit=500&direction=desc&symbols=${encodeURIComponent(
        symbols.join(",")
      )}`,
      env
    );
    fills = orders
      .filter((o) => o.filled_at)
      .map((o) => ({
        ticker: String(o.symbol),
        side: String(o.side) === "buy" ? ("buy" as const) : ("sell" as const),
        date: String(o.filled_at),
        // Without the quantity a partial trim looks like a full exit, which
        // silently disables the trailing stop on any trimmed position.
        qty: num(o.filled_qty, 0),
      }));
  } catch (error) {
    // Fail degraded, not closed: without entry times the trailing stop is
    // skipped but the hard stop still runs, which is the protection that
    // matters most.
    report.errors.push(`order history unavailable: ${(error as Error).message}`);
  }

  // 4. Daily bars for every held symbol in ONE request, for ATR and the
  //    high-water mark. 45 calendar days comfortably covers ATR(14).
  const start = new Date(now.getTime() - 45 * 86_400_000).toISOString().slice(0, 10);
  const feed = env.ALPACA_DATA_FEED || "iex";
  const barsBySymbol = new Map<string, Bar[]>();
  try {
    const url =
      `${DATA_BASE}/v2/stocks/bars?symbols=${encodeURIComponent(symbols.join(","))}` +
      `&timeframe=1Day&start=${start}&adjustment=all&feed=${feed}&limit=10000`;
    const data = await alpacaGet<{ bars?: Record<string, Record<string, unknown>[]> }>(
      url,
      env
    );
    for (const [symbol, raw] of Object.entries(data.bars ?? {})) {
      barsBySymbol.set(
        symbol,
        raw.map((bar) => ({
          t: String(bar.t),
          o: num(bar.o, 0),
          h: num(bar.h, 0),
          l: num(bar.l, 0),
          c: num(bar.c, 0),
        }))
      );
    }
  } catch (error) {
    report.errors.push(`bars unavailable: ${(error as Error).message}`);
  }

  // 5. Build the view the risk engine judges.
  const riskPositions: RiskPosition[] = open.map((p) => {
    const ticker = String(p.symbol);
    const qty = num(p.qty, 0);
    const marketValue = num(p.market_value, 0);
    const currentPrice =
      num(p.current_price, NaN) ||
      (qty !== 0 ? Math.abs(marketValue / qty) : NaN);
    const avgEntryPrice = num(p.avg_entry_price, NaN);
    const bars = barsBySymbol.get(ticker) ?? [];
    const heldHours = hoursSinceEntry(ticker, fills, now);
    const entryTime =
      heldHours !== undefined
        ? new Date(now.getTime() - heldHours * 3_600_000).toISOString()
        : undefined;

    return {
      ticker,
      unrealizedPlPct: num(p.unrealized_plpc, NaN) * 100,
      currentPrice: Number.isFinite(currentPrice) ? currentPrice : undefined,
      avgEntryPrice: Number.isFinite(avgEntryPrice) ? avgEntryPrice : undefined,
      atrPct: bars.length > 0 ? atrPercent(bars) : undefined,
      highWaterPrice:
        entryTime && bars.length > 0
          ? highWaterSince(bars, entryTime, currentPrice)
          : undefined,
    };
  });

  const decisions = decideExits(riskPositions, config);
  report.exits = decisions.map(describeExit);
  if (decisions.length === 0 || dryRun) return report;

  // 6. Refuse to stack orders. An exit submitted on the previous sweep may
  //    still be working; the deterministic client_order_id below is the second
  //    line of defence, this is the first.
  let openOrderSymbols = new Set<string>();
  try {
    const working = await alpacaGet<Record<string, unknown>[]>(
      `${base}/v2/orders?status=open&limit=100`,
      env
    );
    openOrderSymbols = new Set(working.map((o) => String(o.symbol)));
  } catch (error) {
    // If this cannot be checked, do NOT submit. An unknown order book is
    // exactly the condition under which duplicate sells get created, and a
    // position held two more minutes is a far smaller problem than an
    // unintended short.
    report.errors.push(
      `open-order check failed, skipping all submissions: ${(error as Error).message}`
    );
    return report;
  }

  // 7. Submit.
  for (const decision of decisions) {
    const label = describeExit(decision);
    if (openOrderSymbols.has(decision.ticker)) {
      report.skipped.push(`${label} — an order is already working for this symbol.`);
      continue;
    }

    const position = open.find((p) => String(p.symbol) === decision.ticker);
    const qty = Math.abs(num(position?.qty, 0));
    if (!(qty > 0)) {
      report.skipped.push(`${label} — no resolvable quantity.`);
      continue;
    }
    // A long position is closed by selling; a short by buying. The agent only
    // goes long today, but reading the sign costs nothing and removes the
    // possibility of doubling a short by "closing" it.
    const side = num(position?.qty, 0) < 0 ? "buy" : "sell";

    try {
      const res = await fetch(`${base}/v2/orders`, {
        method: "POST",
        headers: { ...alpacaHeaders(env), "content-type": "application/json" },
        body: JSON.stringify({
          symbol: decision.ticker,
          qty: String(qty),
          side,
          type: "market",
          // Fractional and notional orders are day-only at Alpaca, and `day`
          // is the safer default regardless: a resting GTC market order near
          // the close can fill into the next morning's gap.
          time_in_force: "day",
          client_order_id: exitOrderId(decision.ticker, decision.reason, now),
        }),
      });

      if (res.ok) {
        const order = (await res.json()) as { id?: string; status?: string };
        report.submitted.push(`${label} — order ${order.id} (${order.status}).`);
      } else {
        const body = await res.text();
        // A duplicate client_order_id is the dedup guard working as designed,
        // not a failure.
        if (res.status === 422 && /client_order_id/i.test(body)) {
          report.skipped.push(`${label} — duplicate suppressed by order id.`);
        } else {
          report.errors.push(`${label} — submit failed ${res.status}: ${body}`);
        }
      }
    } catch (error) {
      report.errors.push(`${label} — submit threw: ${(error as Error).message}`);
    }
  }

  return report;
}

const summarise = (report: SweepReport): string => {
  if (!report.marketOpen) return "market closed";
  const parts = [`${report.positionsChecked} position(s)`];
  if (report.exits.length) parts.push(`${report.exits.length} exit(s)`);
  if (report.submitted.length) parts.push(`${report.submitted.length} submitted`);
  if (report.skipped.length) parts.push(`${report.skipped.length} skipped`);
  if (report.errors.length) parts.push(`${report.errors.length} error(s)`);
  return parts.join(", ");
};

export default {
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    try {
      const report = await runSweep(env, false);
      // Worker logs are the operational record here. `wrangler tail` streams
      // them live; the dashboard keeps the 100 most recent cron invocations.
      console.log(`sweep: ${summarise(report)}`);
      for (const line of [...report.submitted, ...report.skipped]) console.log(line);
      for (const line of report.errors) console.error(line);
    } catch (error) {
      console.error(`sweep failed: ${(error as Error).message}`);
      throw error;
    }
  },

  /**
   * Dry-run diagnostic. Reports what the sweep WOULD do and places no orders.
   * Returns 404 unless SWEEP_TOKEN is configured and presented, so a leaked
   * Worker URL discloses nothing about the account.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const expected = env.SWEEP_TOKEN;
    const presented =
      request.headers.get("x-sweep-token") ??
      new URL(request.url).searchParams.get("token");

    if (!expected || presented !== expected) {
      return new Response("Not found", { status: 404 });
    }

    try {
      const report = await runSweep(env, true);
      return Response.json({ dryRun: true, summary: summarise(report), ...report });
    } catch (error) {
      return Response.json(
        { dryRun: true, error: (error as Error).message },
        { status: 500 }
      );
    }
  },
};
