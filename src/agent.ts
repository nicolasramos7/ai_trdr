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
  decideExits,
  describeExit,
  drawdownPct,
  hoursSinceLastSell,
  loadRiskConfig,
  peakEquity,
  vetBuy,
  vetSell,
  type FillRecord,
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
 * Sized against the Gemini FREE tier, which is far tighter than it looks:
 * 2.5 Flash allows ~5 requests per MINUTE and only a few dozen per DAY. Four
 * sessions must therefore share a daily budget of roughly 25 requests, so a
 * session gets 5 — with the rest held back as headroom, because a session that
 * overruns does not fail alone: it steals the quota belonging to the 15:00 ET
 * session, the one that positions the book before an 18-hour overnight gap.
 *
 * Raise this only alongside a paid tier.
 */
const MAX_MODEL_REQUESTS = Number(process.env.MAX_MODEL_REQUESTS) || 5;

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
 * Each model carries its OWN quota pool, so a Flash exhaustion does not imply a
 * Flash-Lite exhaustion. A cheaper model still reading the news beats the last
 * session of the day not running at all.
 */
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || "gemini-2.5-flash-lite";

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

const isMarketOpen = (): boolean => {
  // Escape hatch so a session can be exercised outside market hours (e.g. tests).
  if (process.env.TESTING_MODE === "true") return true;

  const nowEt = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );

  const day = nowEt.getDay(); // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) return false;

  const minutes = nowEt.getHours() * 60 + nowEt.getMinutes();
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
};

// ---------------------------------------------------------------------------
// Alpaca / market data helpers
// ---------------------------------------------------------------------------

const getStockPrice = async (ticker: string): Promise<number> => {
  const symbol = ticker.toUpperCase();

  // Primary: Alpaca latest quote.
  try {
    const quote = await withRetry(
      () => alpaca.getLatestQuote(symbol),
      `Alpaca quote ${symbol}`
    );
    if (quote && quote.BidPrice && quote.AskPrice) {
      const mid = (quote.BidPrice + quote.AskPrice) / 2;
      const price = Math.round(mid * 100) / 100;
      log(`✅ Price for ${symbol}: $${price} (Alpaca)`);
      return price;
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
        log(`✅ Price for ${symbol}: $${rounded} (Yahoo Finance)`);
        return rounded;
      }
    }
  } catch (error) {
    log(`⚠️ Yahoo Finance failed for ${symbol}: ${error}`);
  }

  throw new Error(`Could not fetch a price for ${symbol}`);
};

const getAccount = (): Promise<any> =>
  withRetry<any>(() => alpaca.getAccount(), "Alpaca getAccount");

const getPositions = (): Promise<any[]> =>
  withRetry<any[]>(() => alpaca.getPositions(), "Alpaca getPositions");

const getOrderHistory = (limit = 100): Promise<any[]> =>
  withRetry<any[]>(
    () =>
      alpaca.getOrders({
        status: "all",
        limit,
        nested: true,
        direction: "desc",
        until: null,
        after: null,
        symbols: null,
      } as any),
    "Alpaca getOrders"
  );

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
    getOrderHistory(100),
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
      }));
    return hoursSinceLastSell(ticker, fills);
  } catch (error) {
    // Fail open: an unreachable history must not block a legitimate buy.
    log(`⚠️ Could not check re-buy cooldown for ${ticker}: ${error}`);
    return undefined;
  }
};

/** Close an entire position regardless of side or fractional quantity. */
const closeWholePosition = (symbol: string): Promise<any> =>
  withRetry(() => alpaca.closePosition(symbol), `Alpaca closePosition ${symbol}`);

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
const runExitSweep = async (): Promise<string> => {
  const portfolio = await getPortfolio();
  const peak = await getPeakEquity(portfolio.equity);
  sessionDrawdownPct = drawdownPct(portfolio.equity, peak);

  log(
    `🛡️ Equity $${portfolio.equity.toFixed(2)} | peak $${peak.toFixed(
      2
    )} | drawdown ${sessionDrawdownPct.toFixed(2)}%`
  );

  const exits = decideExits(portfolio.positions, riskConfig);
  if (exits.length === 0) {
    log("🛡️ Exit sweep: no positions breached stop-loss or take-profit.");
    return "No positions breached the stop-loss or take-profit thresholds.";
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

const placeOrder = (
  symbol: string,
  sizing: OrderSizing,
  side: "buy" | "sell"
): Promise<any> =>
  withRetry(
    () =>
      alpaca.createOrder({
        symbol,
        side,
        type: "market",
        // Fractional and notional orders are day-only — Alpaca rejects GTC on
        // them. Day is also the safer default for whole shares: a GTC market
        // order placed near the close can rest overnight and fill into a gap.
        time_in_force: "day",
        ...sizing,
      } as any),
    `Alpaca ${side} ${symbol}`
  );

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

        const [account, currentPositions] = await Promise.all([
          getAccount(),
          getPositions(),
        ]);
        const buyingPower = num(account.buying_power);
        const held = currentPositions.find((p: any) => p.symbol === ticker);
        const existingPositionValue = held ? Math.abs(num(held.market_value)) : 0;

        // Every buy is now priced, whether or not sizing needs it: the
        // penny-stock filter cannot run without a share price, and the sub-$10
        // names are exactly the ones this account must not be trading.
        const quotedPrice = await getStockPrice(ticker);

        // Price the request in dollars so one set of risk rules covers both
        // the notional and the share-count paths.
        let requestedNotional: number;
        if (hasNotional) {
          requestedNotional = Number(args.notional);
        } else {
          if (!(Number(args.shares) > 0)) return `Invalid share count for ${ticker}.`;
          requestedNotional = Number(args.shares) * quotedPrice;
        }

        const verdict = vetBuy({
          ticker,
          requestedNotional,
          equity: num(account.portfolio_value),
          cash: num(account.cash),
          existingPositionValue,
          buysThisSession,
          currentDrawdownPct: sessionDrawdownPct,
          hoursSinceLastSell: await recentSellAgeHours(ticker),
          sharePrice: quotedPrice,
          config: riskConfig,
        });

        if (!verdict.allowed) {
          log(`🛡️ Buy blocked for ${ticker}: ${verdict.reason}`);
          return verdict.reason;
        }
        if (verdict.clamped) {
          log(`🛡️ ${verdict.reason}`);
        }

        // Only worth an asset lookup once the trade is actually going ahead.
        const fractionable = await isFractionable(ticker);

        // --- Dollar-amount sizing (preferred) --------------------------------
        if (hasNotional || verdict.clamped) {
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
          const note = verdict.clamped ? `\n${verdict.reason}` : "";

          if (fractionable) {
            const order = await placeOrder(ticker, { notional }, "buy");
            buysThisSession++;
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

  // Enforce exits before the model gets a turn. Stop-loss and take-profit are
  // not suggestions it can reason its way out of.
  const exitSummary = await runExitSweep();

  const derisked = sessionDrawdownPct >= riskConfig.maxDrawdownPct;
  const riskBriefing =
    `RISK ENGINE REPORT (enforced automatically in code, before this session):\n` +
    `${exitSummary}\n\n` +
    `Active limits — these are enforced by code, not by you:\n` +
    `- Positions are auto-closed at -${riskConfig.stopLossPct}% (stop-loss) or +${riskConfig.takeProfitPct}% (take-profit)\n` +
    `- No single position may exceed ${riskConfig.maxPositionPct}% of equity; oversized buys are reduced automatically\n` +
    `- A ${riskConfig.cashReservePct}% cash reserve is held back and cannot be deployed\n` +
    `- At most ${riskConfig.maxBuysPerSession} buy orders per session\n` +
    `- Stocks under $${riskConfig.minSharePrice}/share cannot be bought at all\n` +
    `- A ticker you sold cannot be re-bought for ${riskConfig.minRebuyHours}h\n` +
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

  const maxTurns = 5;
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

    modelUsage.requests++;
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

  if (!isMarketOpen()) {
    log("🕐 Market is closed — exiting cleanly without trading.");
    return;
  }

  await runTradingSession();
  log("👋 Done. Exiting (single-session mode).");
};

main().catch((error) => {
  log(`❌ Fatal error: ${error}`);
  process.exit(1);
});
