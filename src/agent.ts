// AI trading agent powered by Google Gemini 2.5 Flash.
//
// Uses Gemini's OpenAI-compatible endpoint (so we can reuse the well-tested
// `openai` SDK) with native function/tool calling. Trades are executed on
// Alpaca's PAPER trading API only.
//
// Runs EXACTLY ONE trading session and exits. Scheduling (e.g. every 30 min
// during market hours) is expected to be handled externally by cron.

import { config } from "dotenv";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import OpenAI from "openai";
import invariant from "tiny-invariant";
import Alpaca from "@alpacahq/alpaca-trade-api";
import {
  MIN_NOTIONAL,
  atrPercent,
  decideExits,
  describeExit,
  detectRegime,
  drawdownPct,
  highWaterSince,
  hoursSinceEntry,
  hoursSinceLastSell,
  loadRiskConfig,
  peakEquity,
  sizePosition,
  stopDistancePct,
  vetBuy,
  vetSell,
  vetSpread,
  type Bar,
  type FillRecord,
  type RegimeVerdict,
  type RiskPosition,
} from "./risk.js";

// ---------------------------------------------------------------------------
// Environment / configuration
// ---------------------------------------------------------------------------

// Load .env by default; prefer a profile-specific .env.gemini if present.
config();
if (existsSync(".env.gemini")) {
  config({ path: ".env.gemini", override: true });
}

const MODEL = process.env.MODEL || "gemini-2.5-flash";
const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL ||
  "https://generativelanguage.googleapis.com/v1beta/openai/";
const PROFILE = process.env.PROFILE_NAME || "gemini";

/**
 * Dry run: everything executes except order submission.
 *
 * This is the replacement for the old `TESTING_MODE`, which worked by making
 * `isMarketOpen()` return true unconditionally — i.e. the test flag disabled
 * the production safety gate, and anything that set it could place real
 * (paper) orders at 22:00 on a Sunday. A dry run instead keeps every gate and
 * neuters only the one irreversible step.
 */
const DRY_RUN = process.env.DRY_RUN === "true";
if (DRY_RUN) {
  console.log("🧪 DRY_RUN=true — no orders will be submitted to Alpaca.");
}

// All credentials come from the environment — nothing is hardcoded.
invariant(process.env.GEMINI_API_KEY, "GEMINI_API_KEY is not set");
invariant(process.env.ALPACA_API_KEY, "ALPACA_API_KEY is not set");
invariant(process.env.ALPACA_SECRET_KEY, "ALPACA_SECRET_KEY is not set");

// Alpaca is always kept on the paper endpoint. The Alpaca SDK appends `/v2`
// itself, so strip a trailing `/v2` if the user included it in the base URL.
const rawBaseUrl =
  process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
const ALPACA_BASE_URL = rawBaseUrl.replace(/\/v2\/?$/, "");
if (!/paper-api\.alpaca\.markets/.test(ALPACA_BASE_URL)) {
  // Guard rail: refuse to point at the live trading endpoint.
  throw new Error(
    `Refusing to run: ALPACA_BASE_URL (${ALPACA_BASE_URL}) is not the paper endpoint.`
  );
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const resultsDir = `results/${PROFILE}`;
const log = (message: string): void => {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
    appendFileSync(`${resultsDir}/agent-${PROFILE}.log`, line + "\n");
  } catch (error) {
    console.error(`Failed to write to log file: ${error}`);
  }
};

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

// Gemini via the OpenAI-compatible endpoint.
const gemini = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: GEMINI_BASE_URL,
});

// Alpaca paper trading client.
const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: true,
  baseUrl: ALPACA_BASE_URL,
});

log(`🤖 Model: ${MODEL} (via ${GEMINI_BASE_URL})`);
log(`🔧 Alpaca paper endpoint: ${ALPACA_BASE_URL}`);

// Risk limits are enforced in code, not left to the model's discretion.
const riskConfig = loadRiskConfig(process.env);
log(
  `🛡️ Risk limits: stop-loss -${riskConfig.stopLossPct}%, take-profit +${riskConfig.takeProfitPct}%, ` +
    `max position ${riskConfig.maxPositionPct}% of equity, cash reserve ${riskConfig.cashReservePct}%, ` +
    `max drawdown ${riskConfig.maxDrawdownPct}%, max ${riskConfig.maxBuysPerSession} buys/session`
);

// Session-scoped counters. One process runs exactly one session, so plain
// module state is sufficient — nothing needs to survive the run.
let buysThisSession = 0;
let sessionDrawdownPct = 0;

/**
 * Regime for this session, set once before the model runs.
 *
 * Starts permissive so that a code path which somehow skips regime detection
 * behaves exactly as the engine did before the filter existed, rather than
 * silently refusing to trade.
 */
let sessionRegime: RegimeVerdict = {
  regime: "neutral",
  riskMultiplier: 1,
  maxPositions: riskConfig.maxPositions,
  reason: "Regime not yet evaluated.",
};

/** Symbols bought this session, so one session cannot double into a name. */
const boughtThisSession = new Set<string>();

/**
 * Model-usage accounting.
 *
 * Nothing used to record what a session cost, which made "the agent ran out of
 * Gemini quota by the afternoon" impossible to diagnose: the logs showed the
 * failure but never the consumption that led to it. Every completion now adds
 * to this, and the totals are logged at the end of the session.
 */
const modelUsage = { requests: 0, promptTokens: 0, completionTokens: 0 };

/**
 * Reasoning effort for the tool-calling loop.
 *
 * Gemini 2.5 Flash thinks by default, and thinking tokens are billed as output
 * on every turn — including the turns that do nothing but route a tool call,
 * where the model is choosing between "call get_portfolio" and "call
 * get_stock_price" and needs no deliberation at all. `low` keeps deliberation
 * for the decision turns without paying for it eight times a session; `none`
 * disables it outright.
 */
const REASONING_EFFORT = process.env.GEMINI_REASONING_EFFORT || "low";

/**
 * Hard ceiling on model requests per session, independent of the turn limit.
 *
 * Sized against the Gemini FREE tier, whose limits Google NO LONGER PUBLISHES
 * per model — the former rate-limit table is gone, and the only authoritative
 * figures are the ones in your own AI Studio dashboard
 * (https://aistudio.google.com/rate-limit). Community reports for 2.5 Flash
 * range from 250 requests/day down to 20, a 12x spread, so this is deliberately
 * sized against the PESSIMISTIC end rather than a guess at the real number.
 *
 * At 3 requests and three scheduled slots a day the worst case is 9
 * requests/day, which survives even a 20/day cap with room for retries. Note
 * that retries now count
 * (see `countedCompletion`) — previously they did not, so the real consumption
 * was higher than the budget suggested, which is exactly how a session ran out
 * of quota while believing it had spent 5 of 5.
 *
 * Set MAX_MODEL_REQUESTS from your dashboard's actual figure. Quotas apply per
 * PROJECT, not per key, so other apps on the same Google Cloud project share
 * this budget.
 */
const MAX_MODEL_REQUESTS = Number(process.env.MAX_MODEL_REQUESTS) || 3;

/**
 * Minimum spacing between model requests, to stay under the per-minute limit.
 *
 * The loop used to fire every turn back-to-back — six requests in about twenty
 * seconds against a 5/minute ceiling. The overshoot came back as 429s, which
 * were then RETRIED, and on this tier a retry is charged against the same daily
 * quota it is trying to recover from. Pacing costs a minute of wall clock per
 * session and removes the entire failure mode.
 */
const MIN_REQUEST_INTERVAL_MS =
  Number(process.env.MIN_REQUEST_INTERVAL_MS) || 12_500;

/**
 * Model to fall back to when the primary's daily quota is gone.
 *
 * BEST EFFORT ONLY. The previous comment here asserted that "each model
 * carries its OWN quota pool"; Google's current documentation says rate limits
 * are applied per PROJECT and does not promise per-model pools, so this may
 * simply fail too. It costs one request to find out and a cheaper model still
 * reading the news beats the last session of the day not running at all, so the
 * attempt is kept — but it is not a guarantee, and nothing should be designed
 * on the assumption that it works.
 */
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || "gemini-2.5-flash-lite";

/**
 * Verify the configured model actually exists before trading on it.
 *
 * Google is retiring `gemini-2.5-flash` and `gemini-2.5-flash-lite`: from
 * 2026-12-01 requests to `gemini-2.5-flash` are routed to a different model
 * (`gemini-3.5-flash-lite`) with different behaviour and different quota.
 * Without this check the agent would silently keep trading on a model nobody
 * chose, and the logs would show nothing unusual.
 *
 * Returns the list of available model ids, or undefined if the listing itself
 * is unavailable (in which case we proceed rather than block — an outage on a
 * metadata endpoint is not a reason to skip a trading session).
 */
const verifyModelAvailable = async (): Promise<void> => {
  let available: string[];
  try {
    const listed = await gemini.models.list();
    available = (listed?.data ?? [])
      .map((model: any) => String(model.id).replace(/^models\//, ""))
      .filter(Boolean);
    if (available.length === 0) {
      log("⚠️ Model listing returned no entries — skipping the availability check.");
      return;
    }
  } catch (error) {
    log(`⚠️ Could not list available models (${error}) — skipping the check.`);
    return;
  }

  const has = (model: string): boolean =>
    available.some((id) => id === model || id === `models/${model}`);

  if (!has(MODEL)) {
    throw new Error(
      `Configured MODEL "${MODEL}" is not in the ${available.length} models this API key can reach. ` +
        `Google retires model ids on a schedule and silently reroutes some of them. ` +
        `Pick one of: ${available.slice(0, 12).join(", ")}${
          available.length > 12 ? ", …" : ""
        }. Set MODEL in the workflow environment (or repo variables) to a current id.`
    );
  }
  log(`✅ Model ${MODEL} is available.`);

  if (!has(FALLBACK_MODEL)) {
    log(
      `⚠️ FALLBACK_MODEL "${FALLBACK_MODEL}" is not available — quota fallback is inert this session.`
    );
  }
};

let lastRequestAt = 0;

// ---------------------------------------------------------------------------
// Retry / backoff helper — a transient 429 (or 5xx) should not crash the run.
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Hold the floor between model requests so the per-minute limit is never hit. */
const paceRequest = async (): Promise<void> => {
  const waitMs = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (waitMs > 0) {
    log(`⏳ Pacing ${Math.round(waitMs / 1000)}s to stay under the per-minute limit.`);
    await sleep(waitMs);
  }
  lastRequestAt = Date.now();
};

const getStatusCode = (error: any): number | undefined => {
  if (typeof error?.status === "number") return error.status;
  if (typeof error?.response?.status === "number") return error.response.status;
  const match = String(error?.message || "").match(/\b(\d{3})\b/);
  return match ? parseInt(match[1], 10) : undefined;
};

/**
 * Gemini returns 429 RESOURCE_EXHAUSTED for two completely different
 * conditions, and treating them alike is expensive:
 *
 *   - a PER-MINUTE limit, which clears on its own in seconds; retrying is right.
 *   - a PER-DAY quota, which does not clear until midnight Pacific. Retrying is
 *     not just futile, it BURNS MORE OF THE SAME EXHAUSTED QUOTA — every retry
 *     is another counted request — and sleeps through minutes of the job's
 *     10-minute budget to do it.
 *
 * The daily case is identifiable: the violation names a "PerDay" quota metric.
 */
const isDailyQuotaExhausted = (error: any): boolean =>
  /perday|per day|requests per day|quota_?metric.*day/i.test(
    String(error?.message || "") + JSON.stringify(error?.error ?? {})
  );

/**
 * Seconds Google asks us to wait, when it says so. Honouring the server's own
 * retryDelay beats guessing with exponential backoff: it is usually far shorter
 * than the 2/4/8/16s ladder, which wastes wall-clock inside a capped CI job.
 */
const serverRetryDelayMs = (error: any): number | undefined => {
  const match = String(error?.message || "").match(
    /"?retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i
  );
  return match ? Math.ceil(parseFloat(match[1]) * 1000) : undefined;
};

const withRetry = async <T>(
  fn: () => Promise<T>,
  label: string,
  retries = 5,
  baseDelay = 2000
): Promise<T> => {
  let lastError: any;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const status = getStatusCode(error);

      // A daily quota is not a transient condition. Fail immediately rather
      // than spending four more requests and half a minute confirming it.
      if (status === 429 && isDailyQuotaExhausted(error)) {
        log(
          `🛑 ${label}: DAILY Gemini quota exhausted. Not retrying — retries would consume ` +
            `more of the same quota. This session is over; the next one runs after the quota resets.`
        );
        throw error;
      }

      const isRetryable =
        status === 429 || (status !== undefined && status >= 500 && status < 600);

      if (isRetryable && attempt < retries - 1) {
        const waitMs =
          serverRetryDelayMs(error) ??
          baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
        const reason = status === 429 ? "rate limit (429)" : `server error (${status})`;
        log(
          `⚠️ ${label} hit a ${reason}. Backing off ${Math.round(
            waitMs / 1000
          )}s and retrying (attempt ${attempt + 1}/${retries})...`
        );
        await sleep(waitMs);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
};

// ---------------------------------------------------------------------------
// Market hours (US equities, 9:30 AM – 4:00 PM ET, weekdays)
// ---------------------------------------------------------------------------

/**
 * Is the market open, according to the broker?
 *
 * This used to be computed locally from the ET wall clock and a weekday check,
 * which is wrong in three ways that all showed up in the order history: it
 * knows nothing about federal holidays (three sessions ran on Labor Day 2026),
 * nothing about half-days (1:00pm closes around Thanksgiving and Christmas),
 * and nothing about an unscheduled halt. Alpaca publishes the authoritative
 * answer, so ask it.
 *
 * Fails CLOSED. If the clock cannot be reached we do not know whether the
 * market is open, and the safe reading of "don't know" is "don't trade" — the
 * cost is one skipped session, versus orders fired into a closed or halted
 * market.
 */
const isMarketOpen = async (): Promise<boolean> => {
  // A dry run places no orders at all (see `placeOrder`), so it is safe to let
  // one proceed outside market hours. This replaces the old TESTING_MODE flag,
  // which forced this function to return `true` and thereby disabled the only
  // gate standing between the agent and a closed market — eight orders in the
  // history were submitted outside 09:30-16:00 ET, five of them cancelled.
  if (DRY_RUN) {
    log("🧪 DRY RUN: bypassing the market-hours gate (no orders can be placed).");
    return true;
  }

  try {
    const clock: any = await withRetry(() => alpaca.getClock(), "Alpaca getClock");
    const isOpen = clock?.is_open === true;
    log(
      isOpen
        ? `🕐 Market is OPEN (next close ${clock?.next_close}).`
        : `🕐 Market is CLOSED (next open ${clock?.next_open}).`
    );
    return isOpen;
  } catch (error) {
    log(
      `🛑 Could not reach Alpaca's market clock (${error}). Refusing to trade: ` +
        `an unknown market state is treated as closed.`
    );
    return false;
  }
};

/**
 * Minutes to avoid at each end of the session before OPENING anything.
 *
 * Spreads are at their widest in the first minutes after the open and the
 * closing auction distorts the last ones, and this account pays spread on
 * every market order. Exits are unaffected — they run in the Worker every two
 * minutes regardless of the time of day, which is the point of separating
 * them.
 */
const OPEN_BUFFER_MINUTES = Number(process.env.OPEN_BUFFER_MINUTES) || 10;
const CLOSE_BUFFER_MINUTES = Number(process.env.CLOSE_BUFFER_MINUTES) || 15;

/**
 * Is this a sensible moment to start a model session?
 *
 * GitHub's scheduler delivers reliably but arbitrarily late — measured on this
 * repository, 40% of 192 scheduled runs started after the close and the worst
 * delay was 7h25m. A late run must therefore decide for itself whether its slot
 * is still worth using, instead of trading at whatever time it happens to wake
 * up. The close side uses the broker's own `next_close`, so half-days are
 * handled; the open side uses the ET clock, which is safe because the open is
 * always 09:30 even on a half-day.
 */
const isGoodTimeToTrade = async (): Promise<boolean> => {
  if (DRY_RUN) return true;

  const nowEt = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const minutesSinceOpen =
    nowEt.getHours() * 60 + nowEt.getMinutes() - (9 * 60 + 30);
  if (minutesSinceOpen < OPEN_BUFFER_MINUTES) {
    log(
      `⏭️  Only ${minutesSinceOpen}min since the open; waiting out the first ` +
        `${OPEN_BUFFER_MINUTES}min when spreads are widest. Skipping this session.`
    );
    return false;
  }

  try {
    const clock: any = await withRetry(() => alpaca.getClock(), "Alpaca getClock");
    const msToClose = new Date(clock.next_close).getTime() - Date.now();
    const minutesToClose = Math.floor(msToClose / 60_000);
    if (minutesToClose < CLOSE_BUFFER_MINUTES) {
      log(
        `⏭️  Only ${minutesToClose}min to the close (${clock.next_close}); too late to ` +
          `open a position sensibly. Skipping this session — exits still run in the Worker.`
      );
      return false;
    }
    log(`🕐 ${minutesToClose}min to the close — good to trade.`);
  } catch (error) {
    log(`⚠️ Could not measure time to the close (${error}) — proceeding.`);
  }

  return true;
};

// ---------------------------------------------------------------------------
// Alpaca / market data helpers
// ---------------------------------------------------------------------------

interface Quote {
  price: number;
  /** Undefined when the source gives no two-sided quote (e.g. Yahoo fallback). */
  bid?: number;
  ask?: number;
  spreadPct?: number;
}

/**
 * Latest quote, keeping BOTH sides.
 *
 * The old version computed a mid from the bid and ask and returned only the
 * mid — discarding the spread at precisely the moment it mattered, since the
 * next thing that happens is a market order that pays it. Callers that only
 * want a price still get one; the buy path uses the width.
 */
const getQuote = async (ticker: string): Promise<Quote> => {
  const symbol = ticker.toUpperCase();

  // Primary: Alpaca latest quote.
  try {
    const quote = await withRetry(
      () => alpaca.getLatestQuote(symbol),
      `Alpaca quote ${symbol}`
    );
    if (quote && quote.BidPrice && quote.AskPrice) {
      const bid = quote.BidPrice;
      const ask = quote.AskPrice;
      const mid = (bid + ask) / 2;
      const price = Math.round(mid * 100) / 100;
      const spreadPct = mid > 0 ? ((ask - bid) / mid) * 100 : undefined;
      log(
        `✅ Price for ${symbol}: $${price} (Alpaca, spread ${
          spreadPct !== undefined ? spreadPct.toFixed(3) + "%" : "n/a"
        })`
      );
      return { price, bid, ask, spreadPct };
    }
  } catch (error) {
    log(`⚠️ Alpaca quote failed for ${symbol}: ${error}`);
  }

  // Fallback: Yahoo Finance.
  try {
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`
    );
    if (response.ok) {
      const data: any = await response.json();
      const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (typeof price === "number" && price > 0) {
        const rounded = Math.round(price * 100) / 100;
        log(`✅ Price for ${symbol}: $${rounded} (Yahoo Finance, no spread data)`);
        return { price: rounded };
      }
    }
  } catch (error) {
    log(`⚠️ Yahoo Finance failed for ${symbol}: ${error}`);
  }

  throw new Error(`Could not fetch a price for ${symbol}`);
};

/** Price only, for callers that do not care about execution cost. */
const getStockPrice = async (ticker: string): Promise<number> =>
  (await getQuote(ticker)).price;

/**
 * Daily bars for a set of symbols, in one request.
 *
 * Feeds the ATR-scaled stop and the trailing stop's high-water mark. Paper
 * accounts get the IEX feed for free; `sip` requires a market-data
 * subscription, so IEX is the default and the failure is non-fatal — without
 * bars the engine falls back to the flat stop, which is worse but not unsafe.
 */
const getDailyBars = async (
  symbols: string[],
  lookbackDays = 45
): Promise<Map<string, Bar[]>> => {
  const out = new Map<string, Bar[]>();
  if (symbols.length === 0) return out;

  const start = new Date(Date.now() - lookbackDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const feed = process.env.ALPACA_DATA_FEED || "iex";

  try {
    const url =
      `https://data.alpaca.markets/v2/stocks/bars?symbols=${encodeURIComponent(
        symbols.join(",")
      )}&timeframe=1Day&start=${start}&adjustment=all&feed=${feed}&limit=10000`;
    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": process.env.ALPACA_API_KEY as string,
        "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY as string,
        accept: "application/json",
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data: any = await res.json();
    for (const [symbol, raw] of Object.entries<any[]>(data?.bars ?? {})) {
      out.set(
        symbol,
        raw.map((bar: any) => ({
          t: String(bar.t),
          o: num(bar.o),
          h: num(bar.h),
          l: num(bar.l),
          c: num(bar.c),
        }))
      );
    }
  } catch (error) {
    log(
      `⚠️ Daily bars unavailable (${error}) — volatility sizing and the trailing ` +
        `stop fall back to the flat ${riskConfig.stopLossPct}% stop this session.`
    );
  }

  return out;
};

const getAccount = (): Promise<any> =>
  withRetry<any>(() => alpaca.getAccount(), "Alpaca getAccount");

const getPositions = (): Promise<any[]> =>
  withRetry<any[]>(() => alpaca.getPositions(), "Alpaca getPositions");

/**
 * Order history, paginated.
 *
 * The previous single call asked for `limit: 100` and took whatever came back.
 * The account had 97 orders at the time of writing: at 98 the oldest fills
 * would have started dropping off the end silently, and the two rules derived
 * from this history — the re-buy cooldown and the holding-period check — would
 * have begun failing OPEN on exactly the names held longest. A limit that is
 * about to be reached is a bug with a date on it.
 *
 * Alpaca caps `limit` at 500 per page, so this walks backwards with `until`
 * until a short page arrives. `maxOrders` bounds the work for the common case
 * where only recent history matters.
 */
const getOrderHistory = async (maxOrders = 500): Promise<any[]> => {
  const collected: any[] = [];
  const seen = new Set<string>();
  let until: string | null = null;

  for (let page = 0; page < 20; page++) {
    const pageSize = Math.min(500, Math.max(1, maxOrders - collected.length));
    const batch: any[] = await withRetry<any[]>(
      () =>
        alpaca.getOrders({
          status: "all",
          limit: pageSize,
          nested: true,
          direction: "desc",
          until,
          after: null,
          symbols: null,
        } as any),
      `Alpaca getOrders (page ${page + 1})`
    );

    if (!Array.isArray(batch) || batch.length === 0) break;

    const fresh = batch.filter((order: any) => !seen.has(String(order.id)));
    for (const order of fresh) seen.add(String(order.id));
    collected.push(...fresh);

    // A short page means the end of the history; no fresh ids means `until`
    // stopped advancing and we would otherwise loop on the same page forever.
    if (batch.length < pageSize || fresh.length === 0) break;
    if (collected.length >= maxOrders) break;
    until = String(batch[batch.length - 1].submitted_at);
  }

  return collected;
};

// Alpaca returns every numeric field as a string, and some (e.g. current_price)
// can be missing for stale or illiquid symbols. Parse defensively so a bad
// value can never propagate as NaN into the agent's view of the portfolio.
const num = (value: any, fallback = 0): number => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

interface Position {
  ticker: string;
  shares: number;
  side: "long" | "short";
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
  /** Percent, already scaled from Alpaca's fractional form (0.077 -> 7.7). */
  unrealizedPlPct: number;
}

interface Portfolio {
  cash: number;
  equity: number;
  positions: Position[];
  history: Array<{
    date: string;
    type: "buy" | "sell";
    ticker: string;
    shares: number;
    price: number;
    total: number;
  }>;
}

const getPortfolio = async (): Promise<Portfolio> => {
  const [account, positions, orders] = await Promise.all([
    getAccount(),
    getPositions(),
    getOrderHistory(300),
  ]);

  const openPositions: Position[] = positions
    .map((position: any): Position => {
      const shares = num(position.qty);
      const marketValue = num(position.market_value);
      // Recover the mark from market value when Alpaca omits current_price,
      // so the agent still sees a live price rather than $0.00.
      const currentPrice =
        num(position.current_price) ||
        (shares !== 0 ? Math.abs(marketValue / shares) : 0);

      return {
        ticker: position.symbol,
        shares,
        side: shares < 0 ? "short" : "long",
        avgEntryPrice: num(position.avg_entry_price),
        currentPrice,
        marketValue,
        unrealizedPl: num(position.unrealized_pl),
        // Alpaca reports this as a fraction: 0.0772 means +7.72%.
        unrealizedPlPct: num(position.unrealized_plpc) * 100,
      };
    })
    .filter((position: Position) => position.shares !== 0);

  const history = orders
    .filter((order: any) => order.filled_at)
    .map((order: any) => ({
      date: order.filled_at,
      type: order.side === "buy" ? ("buy" as const) : ("sell" as const),
      ticker: order.symbol,
      shares: parseFloat(order.filled_qty || "0"),
      price: parseFloat(order.filled_avg_price || "0"),
      total:
        parseFloat(order.filled_qty || "0") *
        parseFloat(order.filled_avg_price || "0"),
    }))
    .sort(
      (a: any, b: any) =>
        new Date(a.date).getTime() - new Date(b.date).getTime()
    );

  return {
    cash: num(account.cash),
    equity: num(account.portfolio_value),
    positions: openPositions,
    history,
  };
};

/**
 * Hours since `ticker` was last sold, from the broker's own fill history.
 *
 * The agent is stateless between runs, so the anti-churn cooldown cannot rely
 * on anything the process remembers — but Alpaca already knows what was sold
 * and when, which is a more trustworthy source anyway.
 */
const recentSellAgeHours = async (ticker: string): Promise<number | undefined> => {
  try {
    const orders = await getOrderHistory(100);
    const fills: FillRecord[] = orders
      .filter((order: any) => order.filled_at)
      .map((order: any) => ({
        ticker: order.symbol,
        side: order.side === "buy" ? ("buy" as const) : ("sell" as const),
        date: order.filled_at,
        // Quantity matters: without it a partial trim is indistinguishable
        // from a full exit, which silently disables the trailing stop.
        qty: num(order.filled_qty),
      }));
    return hoursSinceLastSell(ticker, fills);
  } catch (error) {
    // Fail open: an unreachable history must not block a legitimate buy.
    log(`⚠️ Could not check re-buy cooldown for ${ticker}: ${error}`);
    return undefined;
  }
};

/**
 * Hours since the current holding in `ticker` was opened, from broker fills.
 *
 * Fails open (undefined) so an unreachable history can never trap a position:
 * if we cannot prove the holding is young, the minimum-hold rule stands down.
 */
const positionAgeHours = async (ticker: string): Promise<number | undefined> => {
  try {
    const orders = await getOrderHistory(200);
    const fills: FillRecord[] = orders
      .filter((order: any) => order.filled_at)
      .map((order: any) => ({
        ticker: order.symbol,
        side: order.side === "buy" ? ("buy" as const) : ("sell" as const),
        date: order.filled_at,
        // Quantity matters: without it a partial trim is indistinguishable
        // from a full exit, which silently disables the trailing stop.
        qty: num(order.filled_qty),
      }));
    return hoursSinceEntry(ticker, fills);
  } catch (error) {
    log(`⚠️ Could not determine holding age for ${ticker}: ${error}`);
    return undefined;
  }
};

/**
 * Close an entire position regardless of side or fractional quantity.
 *
 * MUST honour DRY_RUN. This function talks to Alpaca directly rather than
 * going through `placeOrder`, because `closePosition` needs no quantity — and
 * that shortcut meant it originally bypassed the dry-run guard entirely. A
 * dry run then queued two real (paper) sell orders: one from the exit sweep and
 * one from the model's `close_all`. Both paths come through here, so this is
 * the one place the guard has to exist.
 */
const closeWholePosition = async (symbol: string): Promise<any> => {
  if (DRY_RUN) {
    log(`🧪 DRY RUN: would close the whole ${symbol} position`);
    return { id: `dry-run-close-${symbol.toLowerCase()}`, status: "dry_run" };
  }
  return withRetry(
    () => alpaca.closePosition(symbol),
    `Alpaca closePosition ${symbol}`
  );
};

/**
 * Peak equity from Alpaca's own equity curve. The agent keeps no state between
 * runs (CI checks out fresh each time), so the high-water mark is derived from
 * the broker rather than stored locally.
 */
const getPeakEquity = async (currentEquity: number): Promise<number> => {
  try {
    const history: any = await withRetry(
      () =>
        alpaca.getPortfolioHistory({
          // A bounded window, not the whole account history. An unbounded peak
          // is permanent: one good week suppresses position sizing for months
          // after it has stopped saying anything about the current market.
          period: `${Math.max(1, Math.round(riskConfig.peakLookbackDays))}D`,
          timeframe: "1D",
          extended_hours: false,
        } as any),
      "Alpaca getPortfolioHistory"
    );
    return peakEquity(history?.equity ?? [], currentEquity);
  } catch (error) {
    // Fail open. A history outage must not manufacture a phantom drawdown and
    // freeze trading; the other position-level limits still apply.
    log(
      `⚠️ Portfolio history unavailable (${error}) — treating current equity as the peak, so the drawdown breaker is inactive this session.`
    );
    return currentEquity;
  }
};

/**
 * Enforce exits BEFORE the model runs, so stop-loss and take-profit do not
 * depend on the model choosing to honour them. Returns a summary that is fed
 * into the model's context — otherwise it would see a position silently
 * disappear and have no idea why.
 */
/**
 * Enrich broker positions with the volatility and high-water data the exit
 * rules need, so the agent and the Worker judge positions identically.
 *
 * Both halves of the system reconstruct the trailing stop's high-water mark
 * from bars rather than remembering it, which is what makes a trailing stop
 * possible at all for a stateless process holding fractional shares.
 */
const enrichPositions = async (
  positions: Position[],
  fills: FillRecord[]
): Promise<RiskPosition[]> => {
  if (positions.length === 0) return [];

  const bars = await getDailyBars(positions.map((position) => position.ticker));
  const now = new Date();

  return positions.map((position): RiskPosition => {
    const symbolBars = bars.get(position.ticker) ?? [];
    const heldHours = hoursSinceEntry(position.ticker, fills, now);
    const entryTime =
      heldHours !== undefined
        ? new Date(now.getTime() - heldHours * 3_600_000).toISOString()
        : undefined;

    return {
      ticker: position.ticker,
      unrealizedPlPct: position.unrealizedPlPct,
      currentPrice: position.currentPrice,
      avgEntryPrice: position.avgEntryPrice,
      atrPct: symbolBars.length > 0 ? atrPercent(symbolBars) : undefined,
      highWaterPrice:
        entryTime && symbolBars.length > 0
          ? highWaterSince(symbolBars, entryTime, position.currentPrice)
          : undefined,
    };
  });
};

/**
 * Current market regime from the benchmark's own trend.
 *
 * Fails to NEUTRAL on any data problem rather than to risk-off: a bars outage
 * must not silently stop the strategy, and must not silently max it out either.
 */
const detectCurrentRegime = async (): Promise<RegimeVerdict> => {
  const benchmark = process.env.REGIME_BENCHMARK || "SPY";
  // Enough calendar days to yield `regimeSlowDays` TRADING days, plus slack.
  const lookback = Math.ceil(riskConfig.regimeSlowDays * 1.6) + 10;
  const bars = await getDailyBars([benchmark], lookback);
  const closes = (bars.get(benchmark) ?? []).map((bar) => bar.c);
  const verdict = detectRegime(closes, riskConfig);
  log(`🌐 Regime: ${verdict.reason}`);
  return verdict;
};

const runExitSweep = async (): Promise<string> => {
  const portfolio = await getPortfolio();
  const peak = await getPeakEquity(portfolio.equity);
  sessionDrawdownPct = drawdownPct(portfolio.equity, peak);

  log(
    `🛡️ Equity $${portfolio.equity.toFixed(2)} | peak $${peak.toFixed(
      2
    )} | drawdown ${sessionDrawdownPct.toFixed(2)}%`
  );

  const fills: FillRecord[] = portfolio.history.map((trade) => ({
    ticker: trade.ticker,
    side: trade.type,
    date: trade.date,
    qty: trade.shares,
  }));

  const enriched = await enrichPositions(portfolio.positions, fills);
  for (const position of enriched) {
    log(
      `   ${position.ticker}: ${position.unrealizedPlPct.toFixed(2)}% | ` +
        `ATR ${position.atrPct !== undefined ? position.atrPct.toFixed(2) + "%" : "n/a"} | ` +
        `stop ${stopDistancePct(position.atrPct, riskConfig).toFixed(1)}% | ` +
        `high-water ${
          position.highWaterPrice !== undefined
            ? "$" + position.highWaterPrice.toFixed(2)
            : "n/a"
        }`
    );
  }

  const exits = decideExits(enriched, riskConfig);
  if (exits.length === 0) {
    log("🛡️ Exit sweep: no positions breached a stop, trailing stop or take-profit.");
    return "No positions breached the stop-loss, trailing-stop or take-profit thresholds.";
  }

  const lines: string[] = [];
  for (const exit of exits) {
    const label = describeExit(exit);
    try {
      await closeWholePosition(exit.ticker);
      log(`🛡️ ${label} — closed automatically.`);
      lines.push(`${label} — position closed automatically by the risk engine.`);
    } catch (error) {
      log(`❌ ${label} — automatic close FAILED: ${error}`);
      lines.push(
        `${label} — AUTOMATIC CLOSE FAILED (${error}). Close this position yourself with the sell tool as your first action.`
      );
    }
  }
  return lines.join("\n");
};

/** Alpaca accepts notional to 2dp and fractional quantities to 9dp. */
const roundTo = (value: number, decimals: number): number => {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
};

/**
 * Size an order either by share count (whole or fractional) or by dollar
 * amount. Notional is preferred for buys: it makes share price irrelevant to
 * affordability and needs no price lookup to size.
 */
type OrderSizing = { qty: number } | { notional: number };

/**
 * Deterministic client order id.
 *
 * Alpaca rejects a duplicate `client_order_id`, which turns the id into an
 * idempotency key. Without one, `withRetry` is dangerous on this path: a 5xx
 * or a socket timeout can hide a submission that actually SUCCEEDED, and the
 * retry then opens a second position (or doubles a sale). The order history
 * contains exactly this — two identical AMC sells four seconds apart, both
 * filled, and five identical MSFT sells inside ten seconds.
 *
 * The id is derived from what the order IS — symbol, side, size, and a
 * coarse time bucket — so a retry of the same intent collides and is refused,
 * while a genuinely new order a few minutes later does not.
 */
const clientOrderId = (
  symbol: string,
  side: "buy" | "sell",
  sizing: OrderSizing
): string => {
  const size =
    "qty" in sizing ? `q${sizing.qty}` : `n${sizing.notional.toFixed(2)}`;
  const bucket = Math.floor(Date.now() / (5 * 60_000));
  return `agent-${side}-${symbol}-${size}-${bucket}`.toLowerCase().slice(0, 120);
};

const placeOrder = async (
  symbol: string,
  sizing: OrderSizing,
  side: "buy" | "sell"
): Promise<any> => {
  const client_order_id = clientOrderId(symbol, side, sizing);

  if (DRY_RUN) {
    log(`🧪 DRY RUN: would submit ${side} ${symbol} ${JSON.stringify(sizing)}`);
    return { id: `dry-run-${client_order_id}`, status: "dry_run" };
  }

  // Refuse to stack a second order on a symbol that already has one working.
  // The idempotency key below catches an exact repeat; this catches the case
  // where the model asks for a slightly different size moments later.
  try {
    const working: any[] = await withRetry(
      () => alpaca.getOrders({ status: "open", limit: 50 } as any),
      "Alpaca getOrders(open)"
    );
    const existing = working.find(
      (order: any) => String(order.symbol).toUpperCase() === symbol.toUpperCase()
    );
    if (existing) {
      throw new Error(
        `An order for ${symbol} is already working (${existing.id}, ${existing.side} ` +
          `${existing.qty ?? existing.notional}, status ${existing.status}). Not stacking another.`
      );
    }
  } catch (error: any) {
    // Only swallow the LOOKUP failing; a genuine "already working" must bubble.
    if (/already working/.test(String(error?.message))) throw error;
    log(`⚠️ Could not check working orders for ${symbol}: ${error}`);
  }

  return withRetry(
    () =>
      alpaca.createOrder({
        symbol,
        side,
        type: "market",
        // Fractional and notional orders are day-only — Alpaca rejects GTC on
        // them. Day is also the safer default for whole shares: a GTC market
        // order placed near the close can rest overnight and fill into a gap.
        time_in_force: "day",
        client_order_id,
        ...sizing,
      } as any),
    `Alpaca ${side} ${symbol}`
  );
};

// Not every asset supports fractional trading. Cache per session — the flag is
// effectively static and a session may size several orders in the same name.
const fractionableCache = new Map<string, boolean>();

const isFractionable = async (symbol: string): Promise<boolean> => {
  const cached = fractionableCache.get(symbol);
  if (cached !== undefined) return cached;
  try {
    const asset: any = await withRetry(
      () => alpaca.getAsset(symbol),
      `Alpaca getAsset ${symbol}`
    );
    const fractionable = asset?.fractionable === true;
    fractionableCache.set(symbol, fractionable);
    return fractionable;
  } catch (error) {
    // Assume whole-share-only on failure: falling back to an integer quantity
    // is always accepted, whereas a rejected fractional order loses the trade.
    log(`⚠️ Could not check fractionability for ${symbol}: ${error}`);
    return false;
  }
};

// ---------------------------------------------------------------------------
// Real-time financial news via Finnhub. No-op if FINNHUB_API_KEY is not set.
// Free tier: 60 calls/min, no credit card — https://finnhub.io
// ---------------------------------------------------------------------------

// Lightweight headline sentiment. Finnhub's native news-sentiment endpoint is a
// premium feature, so we score the headline + summary text against small
// bullish/bearish keyword lists and normalize to a −1 (bearish) … +1 (bullish)
// scale. This lets the agent weigh positive vs. negative coverage without any
// extra dependency or paid endpoint.
const BULLISH_WORDS = [
  "surge", "surges", "soar", "soars", "rally", "rallies", "jump", "jumps",
  "gain", "gains", "beat", "beats", "record", "upgrade", "upgraded", "buy",
  "bullish", "outperform", "growth", "profit", "strong", "rise", "rises",
  "higher", "boost", "boosts", "top", "tops", "win", "wins", "positive",
];
const BEARISH_WORDS = [
  "plunge", "plunges", "slump", "slumps", "fall", "falls", "drop", "drops",
  "miss", "misses", "downgrade", "downgraded", "sell", "bearish",
  "underperform", "loss", "losses", "weak", "decline", "declines", "cut",
  "cuts", "lawsuit", "probe", "warn", "warns", "warning", "lower", "negative",
  "layoff", "layoffs", "recall", "fraud",
];

const scoreSentiment = (text: string): number => {
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  let score = 0;
  for (const word of words) {
    if (BULLISH_WORDS.includes(word)) score += 1;
    if (BEARISH_WORDS.includes(word)) score -= 1;
  }
  const hits = Math.abs(score);
  if (hits === 0) return 0;
  // Squash into [-1, 1] — a couple of strong signals already saturate.
  return Math.max(-1, Math.min(1, score / Math.max(2, hits)));
};

const sentimentLabel = (score: number): string => {
  if (score > 0.15) return "bullish";
  if (score < -0.15) return "bearish";
  return "neutral";
};

const getStockNews = async (symbol: string): Promise<string> => {
  const finnhubApiKey = process.env.FINNHUB_API_KEY;
  if (!finnhubApiKey) {
    return "Financial news unavailable — FINNHUB_API_KEY not configured.";
  }
  const ticker = symbol.toUpperCase();
  // Finnhub company-news is date-ranged; look back one week for fresh coverage.
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(
    ticker
  )}&from=${fmt(from)}&to=${fmt(to)}&token=${finnhubApiKey}`;

  try {
    const response = await fetch(url);
    if (response.status === 429) {
      log(`⚠️ Finnhub rate limit (429) for ${ticker}.`);
      return `News rate-limited for ${ticker} — try again shortly.`;
    }
    if (!response.ok) {
      return `News lookup failed for ${ticker} (HTTP ${response.status}).`;
    }
    const data: any = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
      return `No recent news found for ${ticker} in the last 7 days.`;
    }

    // Score sentiment over the full text of a wider sample, but SEND only the
    // headlines of the top few. The article bodies and URLs were the single
    // largest block of tokens in the session — resent on every subsequent turn —
    // and the model cannot open a URL, so their only effect was cost.
    const scored = data.slice(0, 10).map((a: any) => ({
      headline: String(a.headline || ""),
      source: a.source || "?",
      date: a.datetime
        ? new Date(a.datetime * 1000).toISOString().slice(0, 10)
        : "",
      score: scoreSentiment(`${a.headline || ""} ${(a.summary || "").trim()}`),
    }));

    const aggregate = scored.reduce((sum, a) => sum + a.score, 0);
    const articles = scored.slice(0, 4);
    const lines = articles.map(
      (a) =>
        `• [${sentimentLabel(a.score)} ${a.score.toFixed(2)}] ${a.headline} (${
          a.source
        }, ${a.date})`
    );

    const overall = aggregate / scored.length;
    return `Recent news for ${ticker} (overall sentiment: ${sentimentLabel(
      overall
    )} ${overall.toFixed(2)}, across ${scored.length} article(s); top ${
      articles.length
    } headlines):\n${lines.join("\n")}`;
  } catch (error) {
    log(`⚠️ Finnhub news error for ${ticker}: ${error}`);
    return `News error for ${ticker}.`;
  }
};

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling schema, understood by Gemini's
// OpenAI-compatible endpoint).
// ---------------------------------------------------------------------------

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_portfolio",
      description:
        "Get current cash, total equity, and every open position with its average entry price, current price, market value, and unrealized profit/loss in both dollars and percent — plus recent trade history. Use the per-position unrealized P&L to decide what to take profits on and what to cut.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_net_worth",
      description: "Get total portfolio value (cash + holdings).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_stock_price",
      description:
        "Get current market prices. Pass ALL tickers you are considering in one call.",
      parameters: {
        type: "object",
        properties: {
          tickers: {
            type: "array",
            items: { type: "string" },
            description: "Ticker symbols to price, e.g. [\"NVDA\", \"MSFT\"]",
          },
          ticker: {
            type: "string",
            description: "Single ticker symbol (use `tickers` for more than one)",
          },
        },
      } as any,
    },
  },
  {
    type: "function",
    function: {
      name: "buy",
      description:
        "Buy a stock at market price (Alpaca paper). PREFER `notional` — the dollar amount to invest — which buys fractional shares and works for ANY stock regardless of its share price. A $50 account can buy $25 of a $700 stock. Only use `shares` when you specifically want a whole-share quantity. Share price is irrelevant to what you can afford; judge stocks on quality, not on price per share.",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string", description: "Stock ticker symbol, e.g. AAPL" },
          notional: {
            type: "number",
            description:
              "Dollar amount to invest, e.g. 25.50 (preferred). Minimum $1. Buys fractional shares.",
          },
          shares: {
            type: "number",
            description:
              "Number of shares to buy. May be fractional for fractionable assets. Use only if you are not using notional.",
          },
        },
        required: ["ticker"],
      } as any,
    },
  },
  {
    type: "function",
    function: {
      name: "sell",
      description:
        "Sell a stock you own at market price (Alpaca paper). To EXIT a position completely — the usual case — pass close_all: true and nothing else; do not try to echo back a fractional share count. To trim part of a position, pass `notional` (a DOLLAR AMOUNT, preferred) or `shares`. Minimum $5 per partial sell: smaller trims pay a full spread to change nothing.",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string", description: "Stock ticker symbol, e.g. AAPL" },
          close_all: {
            type: "boolean",
            description:
              "Close the entire position. Preferred way to exit — needs no share count.",
          },
          notional: {
            type: "number",
            description: "Dollar amount to sell for a partial trim, e.g. 12.50.",
          },
          shares: {
            type: "number",
            description: "Share count to sell. Use notional or close_all instead where possible.",
          },
        },
        required: ["ticker"],
      } as any,
    },
  },
  {
    type: "function",
    function: {
      name: "get_stock_news",
      description:
        "Get recent real-time financial news and headline sentiment for a specific ticker (via Finnhub). Call this for any ticker you're considering trading, to factor in recent news sentiment before deciding to buy/hold/sell.",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Stock ticker symbol to fetch news for, e.g. AAPL",
          },
        },
        required: ["symbol"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

// Always render P&L with an explicit +/- so the model can never misread a
// gain as a loss (or vice versa) from formatting alone.
const signedMoney = (value: number): string =>
  `${value < 0 ? "-" : "+"}$${Math.abs(value).toFixed(2)}`;

const signedPct = (value: number): string =>
  `${value < 0 ? "-" : "+"}${Math.abs(value).toFixed(2)}%`;

// Plain amount, no forced sign — but keeps "-$480.00" readable for the
// negative market value a short position carries.
const money = (value: number): string =>
  `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;

const executeTool = async (name: string, args: any): Promise<string> => {
  log(`🛠️  Tool: ${name}(${JSON.stringify(args)})`);
  try {
    switch (name) {
      case "get_portfolio": {
        const p = await getPortfolio();

        const positions =
          p.positions
            .map(
              (pos) =>
                `  - ${pos.ticker}: ${pos.shares} shares (${pos.side})\n` +
                `      avg entry $${pos.avgEntryPrice.toFixed(2)} → now $${pos.currentPrice.toFixed(
                  2
                )} | value ${money(pos.marketValue)} | unrealized ${signedMoney(
                  pos.unrealizedPl
                )} (${signedPct(pos.unrealizedPlPct)})`
            )
            .join("\n") || "  (none)";

        const totalUnrealized = p.positions.reduce(
          (sum, pos) => sum + pos.unrealizedPl,
          0
        );

        const history =
          p.history
            .slice(-15)
            .map(
              (h) =>
                `  - ${h.date} ${h.type} ${h.shares} ${h.ticker} @ $${h.price}`
            )
            .join("\n") || "  (none)";

        return (
          `Cash: $${p.cash.toFixed(2)}\n` +
          `Equity (cash + positions): $${p.equity.toFixed(2)}\n\n` +
          `Open positions (${p.positions.length}):\n${positions}\n\n` +
          `Total unrealized P&L: ${signedMoney(totalUnrealized)}\n\n` +
          `Recent trades:\n${history}`
        );
      }

      case "get_net_worth": {
        const account = await getAccount();
        const netWorth = parseFloat(account.portfolio_value);
        return `Net worth: $${netWorth.toFixed(2)} (cash $${parseFloat(
          account.cash
        ).toFixed(2)}, buying power $${parseFloat(account.buying_power).toFixed(2)}).`;
      }

      case "get_stock_price": {
        // Accept a list or a single ticker. The prompt has always told the model
        // to batch its price lookups; until now the schema made that impossible,
        // so every candidate cost a separate turn.
        const requested: string[] = Array.isArray(args.tickers)
          ? args.tickers
          : args.ticker
            ? [args.ticker]
            : [];
        const tickers = [
          ...new Set(requested.map((t) => String(t).toUpperCase()).filter(Boolean)),
        ];
        if (tickers.length === 0) return "No tickers supplied.";

        const quotes = await Promise.all(
          tickers.map(async (ticker) => {
            try {
              return `${ticker}: $${await getStockPrice(ticker)}`;
            } catch (error) {
              return `${ticker}: price unavailable (${error})`;
            }
          })
        );
        return quotes.join("\n");
      }

      case "buy": {
        const ticker = String(args.ticker).toUpperCase();
        const hasNotional = args.notional !== undefined && args.notional !== null;
        const hasShares = args.shares !== undefined && args.shares !== null;

        if (hasNotional && hasShares) {
          return `Specify either notional or shares for ${ticker}, not both.`;
        }
        if (!hasNotional && !hasShares) {
          return `Specify how much ${ticker} to buy: notional (dollar amount, preferred) or shares.`;
        }

        // One buy per symbol per session. Five identical MSFT sells inside ten
        // seconds appear in the order history; the same failure on the buy
        // side would double a position instead of flattening one.
        if (boughtThisSession.has(ticker)) {
          return `Already bought ${ticker} this session. One order per symbol per session — if the first fill was too small, wait for the next session rather than stacking orders.`;
        }

        const [account, currentPositions] = await Promise.all([
          getAccount(),
          getPositions(),
        ]);
        const buyingPower = num(account.buying_power);
        const held = currentPositions.find((p: any) => p.symbol === ticker);
        const existingPositionValue = held ? Math.abs(num(held.market_value)) : 0;
        const openPositionCount = currentPositions.filter(
          (p: any) => Math.abs(num(p.qty)) > 0
        ).length;

        // Every buy is now priced, whether or not sizing needs it: the
        // penny-stock filter cannot run without a share price, and the sub-$10
        // names are exactly the ones this account must not be trading.
        const quote = await getQuote(ticker);
        const quotedPrice = quote.price;

        // Execution cost, checked before it is paid rather than discarded.
        const spread = vetSpread(quote.bid, quote.ask, riskConfig);
        if (!spread.acceptable) {
          log(`🛡️ Buy blocked for ${ticker}: ${spread.reason}`);
          return spread.reason;
        }

        // Price the request in dollars so one set of risk rules covers both
        // the notional and the share-count paths.
        let requestedNotional: number;
        if (hasNotional) {
          requestedNotional = Number(args.notional);
        } else {
          if (!(Number(args.shares) > 0)) return `Invalid share count for ${ticker}.`;
          requestedNotional = Number(args.shares) * quotedPrice;
        }

        // Volatility-targeted ceiling. The model proposes a dollar amount; this
        // caps it at what the instrument's own volatility justifies, so a name
        // that needs a wide stop cannot be held in size. This is the rule that
        // makes a 35% adverse move in a single name survivable: the position is
        // sized so the stop costs ~riskPerTradePct of equity, not 14% of it.
        const equity = num(account.portfolio_value);
        const bars = await getDailyBars([ticker]);
        const atrPct = atrPercent(bars.get(ticker) ?? []);
        const stopPct = stopDistancePct(atrPct, riskConfig);
        const sized = sizePosition({
          equity,
          stopPct,
          riskMultiplier: sessionRegime.riskMultiplier,
          config: riskConfig,
        });

        // Headroom is measured against the whole position, not this order, so
        // adding to a name already held is capped correctly.
        const volatilityCeiling = Math.max(
          0,
          sized.notional - existingPositionValue
        );
        const volatilityLimited = requestedNotional > volatilityCeiling + 0.005;
        const effectiveRequest = Math.min(requestedNotional, volatilityCeiling);

        if (effectiveRequest < MIN_NOTIONAL) {
          return (
            `RISK LIMIT: volatility sizing permits a total of $${sized.notional.toFixed(
              2
            )} in ${ticker} (ATR ${
              atrPct !== undefined ? atrPct.toFixed(2) + "%" : "unknown"
            }, ${stopPct.toFixed(1)}% stop) and you already hold $${existingPositionValue.toFixed(
              2
            )}. ${sized.reason} No further size is available in this name.`
          );
        }

        const verdict = vetBuy({
          ticker,
          requestedNotional: effectiveRequest,
          equity,
          cash: num(account.cash),
          existingPositionValue,
          buysThisSession,
          currentDrawdownPct: sessionDrawdownPct,
          hoursSinceLastSell: await recentSellAgeHours(ticker),
          sharePrice: quotedPrice,
          openPositionCount,
          maxPositionsOverride: sessionRegime.maxPositions,
          config: riskConfig,
        });

        if (!verdict.allowed) {
          log(`🛡️ Buy blocked for ${ticker}: ${verdict.reason}`);
          return verdict.reason;
        }
        if (verdict.clamped) {
          log(`🛡️ ${verdict.reason}`);
        }

        // Explain the volatility ceiling to the model whenever it bit, so the
        // next proposal is sized correctly instead of being clamped again.
        const volatilityNote = volatilityLimited
          ? `\nVOLATILITY SIZING: ${ticker} has ${
              atrPct !== undefined ? atrPct.toFixed(2) + "% daily ATR" : "no ATR estimate"
            }, giving a ${stopPct.toFixed(1)}% stop. ${sized.reason} Your $${requestedNotional.toFixed(
              2
            )} request was reduced to $${effectiveRequest.toFixed(2)} before the other limits ran.`
          : "";

        // Only worth an asset lookup once the trade is actually going ahead.
        const fractionable = await isFractionable(ticker);

        // --- Dollar-amount sizing (preferred) --------------------------------
        // A volatility clamp also routes here: once the permitted amount is no
        // longer the share count the model asked for, dollars are the only
        // sizing that expresses it correctly.
        if (hasNotional || verdict.clamped || volatilityLimited) {
          const notional = roundTo(
            Math.min(verdict.approvedNotional, buyingPower),
            2
          );
          if (notional < MIN_NOTIONAL) {
            return `Not enough buying power for ${ticker} (have $${buyingPower.toFixed(
              2
            )}).`;
          }

          // Surface any risk reduction to the model so it can re-plan the rest
          // of its session around the smaller fill.
          const note = (verdict.clamped ? `\n${verdict.reason}` : "") + volatilityNote;

          if (fractionable) {
            const order = await placeOrder(ticker, { notional }, "buy");
            buysThisSession++;
            boughtThisSession.add(ticker);
            log(
              `💰 BUY $${notional.toFixed(2)} of ${ticker} — order ${order.id} (${order.status})`
            );
            return `Submitted BUY $${notional.toFixed(
              2
            )} of ${ticker} @ market (fractional). Order ${order.id}, status ${order.status}.${note}`;
          }

          // Whole-share-only asset: convert the dollar budget into shares.
          const price = quotedPrice ?? (await getStockPrice(ticker));
          const wholeShares = Math.floor(notional / price);
          if (wholeShares < 1) {
            return `${ticker} does not support fractional trading and one share costs $${price.toFixed(
              2
            )}, above the $${notional.toFixed(
              2
            )} permitted. Pick another ticker or raise the amount.${note}`;
          }
          const order = await placeOrder(ticker, { qty: wholeShares }, "buy");
          buysThisSession++;
          boughtThisSession.add(ticker);
          log(`💰 BUY ${wholeShares} ${ticker} — order ${order.id} (${order.status})`);
          return `${ticker} is not fractionable, so bought whole shares: submitted BUY ${wholeShares} ${ticker} @ market (~$${(
            wholeShares * price
          ).toFixed(2)}). Order ${order.id}, status ${order.status}.${note}`;
        }

        // --- Share-count sizing (unclamped: honour the exact share count) ----
        let shares = Number(args.shares);
        if (fractionable) {
          shares = roundTo(shares, 9);
        } else if (!Number.isInteger(shares)) {
          shares = Math.floor(shares);
          if (shares < 1) {
            return `${ticker} does not support fractional trading, so it must be bought in whole shares.`;
          }
        }

        const price = quotedPrice ?? (await getStockPrice(ticker));
        const cost = shares * price;
        if (buyingPower < cost) {
          return `Not enough buying power for ${shares} ${ticker} (need ~$${cost.toFixed(
            2
          )}, have $${buyingPower.toFixed(2)}).`;
        }
        const order = await placeOrder(ticker, { qty: shares }, "buy");
        buysThisSession++;
        boughtThisSession.add(ticker);
        log(`💰 BUY ${shares} ${ticker} — order ${order.id} (${order.status})`);
        return `Submitted BUY ${shares} ${ticker} @ market. Order ${order.id}, status ${order.status}, est. cost $${cost.toFixed(
          2
        )}.`;
      }

      case "sell": {
        const ticker = String(args.ticker).toUpperCase();

        const positions = await getPositions();
        const position = positions.find((p: any) => p.symbol === ticker);
        const owned = position ? num(position.qty) : 0;
        if (owned <= 0) return `No long position in ${ticker} to sell.`;
        const positionValue = Math.abs(num(position.market_value));

        // A full exit goes through Alpaca's own closePosition, which needs no
        // share count at all. Making the model echo back a nine-decimal
        // fractional quantity to close a position was an invitation to get the
        // magnitude wrong — and it did, repeatedly.
        if (args.close_all === true) {
          // The minimum-hold rule applies here too. This path used to skip
          // vetting entirely, which mattered because close_all is how the model
          // normally exits — so the one rule aimed at same-day reversals was
          // bypassed by the most common exit route.
          const closeVerdict = vetSell({
            ticker,
            notional: positionValue,
            positionValue,
            hoursSinceEntry: await positionAgeHours(ticker),
            config: riskConfig,
          });
          if (!closeVerdict.allowed) {
            log(`🛡️ Close blocked for ${ticker}: ${closeVerdict.reason}`);
            return closeVerdict.reason;
          }

          const order = await closeWholePosition(ticker);
          log(`💸 CLOSE ${ticker} (${owned} shares) — order ${order?.id ?? "n/a"}`);
          return `Submitted full exit of ${ticker} (${owned} shares, ~$${positionValue.toFixed(
            2
          )}) @ market.`;
        }

        const hasNotional = args.notional !== undefined && args.notional !== null;
        const price = await getStockPrice(ticker);

        let shares = hasNotional ? Number(args.notional) / price : Number(args.shares);
        if (!(shares > 0)) {
          return `Specify how much ${ticker} to sell: close_all, notional (dollars), or shares.`;
        }

        // Snap a near-exact request to the true position size. Fractional
        // quantities don't round-trip cleanly through JSON and display
        // rounding, so an intended full exit can overshoot by a fraction of a
        // share and be rejected as "not enough shares" — leaving a position
        // the agent believes it closed.
        const exitTolerance = Math.max(1e-6, owned * 1e-4);
        if (Math.abs(shares - owned) <= exitTolerance) {
          shares = owned;
        } else if (shares > owned) {
          return `Not enough shares of ${ticker} to sell (own ${owned}, worth $${positionValue.toFixed(
            2
          )}). Pass close_all: true to exit the whole position.`;
        }

        // Reject trivial trims. The buy path has enforced a minimum order size
        // from the start; the sell path had none, which is how $1.75 sells of a
        // $22 position reached the broker.
        const sellVerdict = vetSell({
          ticker,
          notional: shares * price,
          positionValue,
          hoursSinceEntry: await positionAgeHours(ticker),
          config: riskConfig,
        });
        if (!sellVerdict.allowed) {
          log(`🛡️ Sell blocked for ${ticker}: ${sellVerdict.reason}`);
          return sellVerdict.reason;
        }

        if (!Number.isInteger(shares) && !(await isFractionable(ticker))) {
          shares = Math.floor(shares);
          if (shares < 1) return `${ticker} must be sold in whole shares.`;
        }
        shares = roundTo(shares, 9);

        const order = await placeOrder(ticker, { qty: shares }, "sell");
        log(`💸 SELL ${shares} ${ticker} — order ${order.id} (${order.status})`);
        return `Submitted SELL ${shares} ${ticker} @ market. Order ${order.id}, status ${order.status}, est. proceeds $${(
          shares * price
        ).toFixed(2)}.`;
      }

      case "get_stock_news":
        return await getStockNews(args.symbol);

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (error) {
    log(`❌ Tool ${name} failed: ${error}`);
    return `Tool ${name} failed: ${error}`;
  }
};

// ---------------------------------------------------------------------------
// Agent loop — a single trading session.
// ---------------------------------------------------------------------------

/**
 * Shrink the conversation before resending it.
 *
 * Every turn re-sends the entire history, so a news dump fetched on turn 2 is
 * paid for again on turns 3, 4, 5 and 6. The bulk of that history is stale tool
 * output the model has already acted on: it needs the prices it just looked up,
 * not the full text of eight articles it read three turns ago.
 *
 * Message SHAPE is preserved exactly — every tool result keeps its
 * `tool_call_id`, because dropping one would orphan its assistant tool call and
 * the request would be rejected. Only the body of older tool results is
 * replaced with a one-line stub.
 */
const KEEP_VERBATIM_TOOL_RESULTS = 4;

const pruneHistory = (
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => {
  const toolIndexes = messages
    .map((message, index) => (message.role === "tool" ? index : -1))
    .filter((index) => index >= 0);

  if (toolIndexes.length <= KEEP_VERBATIM_TOOL_RESULTS) return messages;

  const staleBefore = toolIndexes[toolIndexes.length - KEEP_VERBATIM_TOOL_RESULTS];

  return messages.map((message, index) => {
    if (message.role !== "tool" || index >= staleBefore) return message;
    const body = String(message.content ?? "");
    if (body.length <= 160) return message;
    return { ...message, content: `${body.slice(0, 160)}… [older result trimmed]` };
  });
};

/** One line of cost accounting, so a quota failure is diagnosable after the fact. */
const logUsage = (): void => {
  const total = modelUsage.promptTokens + modelUsage.completionTokens;
  log(
    `📊 Model usage: ${modelUsage.requests} request(s), ${modelUsage.promptTokens} prompt + ` +
      `${modelUsage.completionTokens} completion = ${total} tokens ` +
      `(budget ${MAX_MODEL_REQUESTS} requests/session).`
  );
};

const runTradingSession = async (): Promise<void> => {
  log("🚀 Starting Gemini trading session");

  // Establish the market regime BEFORE the exit sweep, so the briefing and all
  // sizing within this session agree on one view of conditions.
  sessionRegime = await detectCurrentRegime();

  // Enforce exits before the model gets a turn. Stops are not suggestions it
  // can reason its way out of. Note that a separate Cloudflare Worker runs this
  // same check every two minutes — this sweep is a belt-and-braces repeat for
  // the moment the session starts, not the primary protection it used to be.
  const exitSummary = await runExitSweep();

  const derisked = sessionDrawdownPct >= riskConfig.maxDrawdownPct;
  const riskBriefing =
    `RISK ENGINE REPORT (enforced automatically in code, before this session):\n` +
    `${exitSummary}\n\n` +
    `MARKET REGIME: ${sessionRegime.reason}\n` +
    `Effective this session: risk budget x${sessionRegime.riskMultiplier}, ` +
    `at most ${sessionRegime.maxPositions} open position(s).\n\n` +
    `Active limits — these are enforced by code, not by you:\n` +
    `- Exits run automatically EVERY TWO MINUTES in a separate process, not just when you are awake. ` +
    `A hard stop (${riskConfig.minStopPct}-${riskConfig.maxStopPct}%, scaled to each name's ATR), a trailing stop ` +
    `(${riskConfig.trailAtrMultiple}x ATR below the high since entry, armed once a position is +${riskConfig.trailActivatePct}%), ` +
    `and a +${riskConfig.takeProfitPct}% backstop. You do not need to babysit a position to protect it.\n` +
    `- Position size is set by VOLATILITY, not by your request: each position risks ` +
    `${riskConfig.riskPerTradePct}% of equity against its own stop, capped at ${riskConfig.maxPositionPct}% of equity. ` +
    `A high-ATR name therefore gets a smaller position, automatically.\n` +
    `- At most ${sessionRegime.maxPositions} open positions; a new name is refused once that is reached\n` +
    `- A new position must be at least $${riskConfig.minPositionNotional}; smaller stakes cannot cover their own round trip\n` +
    `- A ${riskConfig.cashReservePct}% cash reserve is held back and cannot be deployed\n` +
    `- At most ${riskConfig.maxBuysPerSession} buy orders per session, one per symbol\n` +
    `- Stocks under $${riskConfig.minSharePrice}/share cannot be bought at all\n` +
    `- Bid/ask spreads wider than ${riskConfig.maxSpreadPct}% are refused\n` +
    `- A ticker you sold cannot be re-bought for ${riskConfig.minRebuyHours}h\n` +
    `- A position cannot be sold discretionarily for ${riskConfig.minHoldHours}h after entry. ` +
    `Risk-engine exits ignore this, so a genuine breakdown is still handled without you.\n` +
    `- Partial sells under $${riskConfig.minSellNotional} are rejected; use close_all to exit a position\n` +
    `- Current drawdown from peak equity (${riskConfig.peakLookbackDays}-day window): ` +
    `${sessionDrawdownPct.toFixed(2)}% (position sizing halves at ${riskConfig.maxDrawdownPct}%)\n` +
    (derisked
      ? `\n⚠️ DE-RISK MODE IS ACTIVE: the per-position cap is halved this session. ` +
        `Buying is still allowed — recovering requires being invested — but size down and be selective.\n`
      : "") +
    `\nDo not fight these limits or retry a blocked order unchanged — adapt your plan to them.`;

  const systemPrompt = readFileSync("system-prompt.md", "utf-8");
  const etTime = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "full",
    timeStyle: "short",
  });
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `It's ${etTime} (US Eastern). The US stock market is OPEN, so live quotes and order execution are available.\n\n${riskBriefing}\n\nPlan the session with think, review the portfolio, price your shortlist in one batched call, check news on the names you're serious about, and act. Holding is a valid outcome — trade only if you can say what would make you exit. 📈`,
    },
  ];

  // The model in use for this session. Downgraded in place if the primary's
  // daily quota runs out mid-session.
  let activeModel = MODEL;

  // The turn limit tracks the request budget so neither silently shadows the
  // other: previously maxTurns was 5 against a budget of 5, and the budget
  // undercounted retries, so the real stopping condition was whichever broke
  // first — usually the quota, mid-decision.
  const maxTurns = MAX_MODEL_REQUESTS;
  for (let turn = 1; turn <= maxTurns; turn++) {
    if (modelUsage.requests >= MAX_MODEL_REQUESTS) {
      log(
        `⏹️  Model request budget spent (${modelUsage.requests}/${MAX_MODEL_REQUESTS}); ending session.`
      );
      logUsage();
      return;
    }

    const complete = (model: string) =>
      withRetry(async () => {
        // Count the ATTEMPT, not the success.
        //
        // This increment used to sit after `withRetry` returned, so only
        // successful calls were counted. Every 429-triggered retry was a real
        // request charged against the real quota and invisible to the budget —
        // which is how a session could log "3/5 requests" having actually spent
        // seven. The budget is only a budget if it counts what the provider
        // counts.
        if (modelUsage.requests >= MAX_MODEL_REQUESTS) {
          throw new Error(
            `Model request budget exhausted (${modelUsage.requests}/${MAX_MODEL_REQUESTS}) — ` +
              `refusing to send another request, including as a retry.`
          );
        }
        modelUsage.requests++;
        await paceRequest();
        return gemini.chat.completions.create({
          model,
          messages: pruneHistory(messages),
          tools,
          tool_choice: "auto",
          // Cast: `reasoning_effort` is a Gemini extension to the OpenAI schema.
          ...({ reasoning_effort: REASONING_EFFORT } as any),
        });
      }, `Gemini completion (turn ${turn}, ${model})`);

    let completion;
    try {
      completion = await complete(activeModel);
    } catch (error) {
      // A spent daily quota on the primary says nothing about the fallback's
      // own pool. Try once there before abandoning the session.
      if (!isDailyQuotaExhausted(error) || activeModel === FALLBACK_MODEL) throw error;
      log(`↩️  Falling back to ${FALLBACK_MODEL} for the rest of this session.`);
      activeModel = FALLBACK_MODEL;
      completion = await complete(activeModel);
    }

    // `modelUsage.requests` is incremented per ATTEMPT inside `complete`, so it
    // is deliberately not touched here. Only token accounting belongs on the
    // success path, since a failed attempt reports no usage.
    modelUsage.promptTokens += completion.usage?.prompt_tokens ?? 0;
    modelUsage.completionTokens += completion.usage?.completion_tokens ?? 0;

    const choice = completion.choices[0];
    const message = choice.message;
    const toolCalls = message.tool_calls || [];

    // The `think` tool used to make reasoning visible in the logs, at the cost
    // of a whole request per call — a fifth of the session budget to be told
    // "Recorded 3 reasoning step(s)". Logging the model's own commentary gets
    // the same visibility for free.
    if (message.content) log(`🧠 ${message.content}`);

    // Re-add the assistant turn (clean shape) so tool results can reference it.
    messages.push({
      role: "assistant",
      content: message.content ?? "",
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    if (toolCalls.length === 0) {
      log(`✅ Session complete after ${turn} turn(s).`);
      logUsage();
      return;
    }

    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      let parsedArgs: any = {};
      try {
        parsedArgs = call.function.arguments
          ? JSON.parse(call.function.arguments)
          : {};
      } catch (error) {
        log(`⚠️ Could not parse args for ${call.function.name}: ${error}`);
      }
      const result = await executeTool(call.function.name, parsedArgs);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  log(`⏹️  Reached max turns (${maxTurns}); ending session.`);
  logUsage();
};

// ---------------------------------------------------------------------------
// Main — validate, check market hours, run exactly one session, exit.
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  // Verify Alpaca paper credentials up front.
  try {
    const account = await getAccount();
    log(
      `✅ Alpaca paper account ${account.id} — status ${account.status}, buying power $${account.buying_power}`
    );
  } catch (error) {
    log(`❌ Failed to reach Alpaca paper account: ${error}`);
    process.exit(1);
  }

  // Check the market BEFORE verifying the model: a closed market costs nothing
  // to detect and saves the model-listing call entirely.
  if (!(await isMarketOpen())) {
    log("🕐 Market is closed — exiting cleanly without trading.");
    return;
  }

  // A late-arriving run decides for itself whether its slot is still usable,
  // before spending any Gemini quota on it.
  if (!(await isGoodTimeToTrade())) {
    log("👋 Done. No session run this slot.");
    return;
  }

  // Fail loudly if the configured model has been retired or rerouted, rather
  // than trading on whatever Google substitutes.
  try {
    await verifyModelAvailable();
  } catch (error) {
    log(`❌ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  await runTradingSession();
  log("👋 Done. Exiting (single-session mode).");
};

main().catch((error) => {
  log(`❌ Fatal error: ${error}`);
  process.exit(1);
});
