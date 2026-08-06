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

// ---------------------------------------------------------------------------
// Retry / backoff helper — a transient 429 (or 5xx) should not crash the run.
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const getStatusCode = (error: any): number | undefined => {
  if (typeof error?.status === "number") return error.status;
  if (typeof error?.response?.status === "number") return error.response.status;
  const match = String(error?.message || "").match(/\b(\d{3})\b/);
  return match ? parseInt(match[1], 10) : undefined;
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
      const isRetryable =
        status === 429 || (status !== undefined && status >= 500 && status < 600);

      if (isRetryable && attempt < retries - 1) {
        const waitMs = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
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
  holdings: Record<string, number>;
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

  const holdings: Record<string, number> = {};
  const openPositions: Position[] = positions
    .map((position: any): Position => {
      const shares = num(position.qty);
      if (shares !== 0) holdings[position.symbol] = shares;

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
    holdings,
    history,
  };
};

const placeOrder = (
  symbol: string,
  qty: number,
  side: "buy" | "sell"
): Promise<any> =>
  withRetry(
    () =>
      alpaca.createOrder({
        symbol,
        qty,
        side,
        type: "market",
        time_in_force: "gtc",
      }),
    `Alpaca ${side} ${symbol}`
  );

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

    const articles = data.slice(0, 8);
    let aggregate = 0;
    const lines = articles.map((a: any) => {
      const headline = a.headline || "";
      const summary = (a.summary || "").trim();
      const score = scoreSentiment(`${headline} ${summary}`);
      aggregate += score;
      const date = a.datetime
        ? new Date(a.datetime * 1000).toISOString().slice(0, 10)
        : "";
      const shortSummary =
        summary.length > 240 ? `${summary.slice(0, 240)}…` : summary;
      return `• [${sentimentLabel(score)} ${score.toFixed(
        2
      )}] ${headline} (${a.source || "?"}, ${date})\n  ${shortSummary}\n  ${
        a.url || ""
      }`;
    });

    const overall = aggregate / articles.length;
    return `Recent news for ${ticker} (overall sentiment: ${sentimentLabel(
      overall
    )} ${overall.toFixed(2)}, from ${articles.length} article(s)):\n\n${lines.join(
      "\n\n"
    )}`;
  } catch (error) {
    log(`⚠️ Finnhub news error for ${ticker}: ${error}`);
    return `News error for ${ticker}.`;
  }
};

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling schema, understood by Gemini's
// OpenAI-compatible endpoint).
// ---------------------------------------------------------------------------

const tickerParam = {
  type: "object",
  properties: {
    ticker: { type: "string", description: "Stock ticker symbol, e.g. AAPL" },
    shares: { type: "number", description: "Number of shares (positive)" },
  },
  required: ["ticker", "shares"],
} as const;

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "think",
      description:
        "Record step-by-step reasoning. Use this before taking any other action.",
      parameters: {
        type: "object",
        properties: {
          thought_process: {
            type: "array",
            items: { type: "string" },
            description: "Ordered list of reasoning steps",
          },
        },
        required: ["thought_process"],
      },
    },
  },
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
      description: "Get the current market price for a ticker.",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string", description: "Stock ticker symbol" },
        },
        required: ["ticker"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buy",
      description: "Buy shares of a stock at market price (Alpaca paper).",
      parameters: tickerParam as any,
    },
  },
  {
    type: "function",
    function: {
      name: "sell",
      description: "Sell shares of a stock you own at market price (Alpaca paper).",
      parameters: tickerParam as any,
    },
  },
  {
    type: "function",
    function: {
      name: "short_sell",
      description:
        "Short sell shares (bet on a decline). Requires >= $40,000 account equity. Unlimited loss potential.",
      parameters: tickerParam as any,
    },
  },
  {
    type: "function",
    function: {
      name: "cover_short",
      description: "Cover (close) an existing short position by buying shares back.",
      parameters: tickerParam as any,
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
      case "think": {
        const thoughts: string[] = args.thought_process || [];
        thoughts.forEach((t) => log(`🧠 ${t}`));
        return `Recorded ${thoughts.length} reasoning step(s).`;
      }

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
        const price = await getStockPrice(args.ticker);
        return `${String(args.ticker).toUpperCase()}: $${price}`;
      }

      case "buy": {
        const ticker = String(args.ticker).toUpperCase();
        const shares = Number(args.shares);
        if (!(shares > 0)) return `Invalid share count for ${ticker}.`;
        const account = await getAccount();
        const price = await getStockPrice(ticker);
        const cost = shares * price;
        if (parseFloat(account.buying_power) < cost) {
          return `Not enough buying power for ${shares} ${ticker} (need ~$${cost.toFixed(
            2
          )}, have $${account.buying_power}).`;
        }
        const order = await placeOrder(ticker, shares, "buy");
        log(`💰 BUY ${shares} ${ticker} — order ${order.id} (${order.status})`);
        return `Submitted BUY ${shares} ${ticker} @ market. Order ${order.id}, status ${order.status}, est. cost $${cost.toFixed(
          2
        )}.`;
      }

      case "sell": {
        const ticker = String(args.ticker).toUpperCase();
        const shares = Number(args.shares);
        if (!(shares > 0)) return `Invalid share count for ${ticker}.`;
        const positions = await getPositions();
        const position = positions.find((p: any) => p.symbol === ticker);
        const owned = position ? parseFloat(position.qty) : 0;
        if (owned < shares) {
          return `Not enough shares of ${ticker} to sell (own ${owned}).`;
        }
        const price = await getStockPrice(ticker);
        const order = await placeOrder(ticker, shares, "sell");
        log(`💸 SELL ${shares} ${ticker} — order ${order.id} (${order.status})`);
        return `Submitted SELL ${shares} ${ticker} @ market. Order ${order.id}, status ${order.status}, est. proceeds $${(
          shares * price
        ).toFixed(2)}.`;
      }

      case "short_sell": {
        const ticker = String(args.ticker).toUpperCase();
        const shares = Number(args.shares);
        if (!(shares > 0)) return `Invalid share count for ${ticker}.`;
        const account = await getAccount();
        const equity = parseFloat(account.portfolio_value);
        const buyingPower = parseFloat(account.buying_power);
        if (equity < 40000) {
          return `Account equity $${equity.toFixed(
            2
          )} is below the $40,000 minimum required to short on Alpaca.`;
        }
        const price = await getStockPrice(ticker);
        const orderValue = shares * price;
        if (buyingPower < orderValue * 0.5) {
          return `Insufficient buying power for a short (need ~$${(
            orderValue * 0.5
          ).toFixed(2)}, have $${buyingPower.toFixed(2)}).`;
        }
        const order = await placeOrder(ticker, shares, "sell");
        log(`📉 SHORT ${shares} ${ticker} — order ${order.id} (${order.status})`);
        return `Submitted SHORT SELL ${shares} ${ticker} @ market. Order ${order.id}, status ${order.status}. WARNING: unlimited loss potential.`;
      }

      case "cover_short": {
        const ticker = String(args.ticker).toUpperCase();
        const shares = Number(args.shares);
        if (!(shares > 0)) return `Invalid share count for ${ticker}.`;
        const positions = await getPositions();
        const position = positions.find((p: any) => p.symbol === ticker);
        const qty = position ? parseFloat(position.qty) : 0;
        if (qty >= 0) return `No short position found for ${ticker}.`;
        const shortSize = Math.abs(qty);
        if (shares > shortSize) {
          return `Cannot cover ${shares} — only ${shortSize} ${ticker} shorted.`;
        }
        const order = await placeOrder(ticker, shares, "buy");
        log(`📈 COVER ${shares} ${ticker} — order ${order.id} (${order.status})`);
        return `Submitted BUY TO COVER ${shares} ${ticker} @ market. Order ${order.id}, status ${order.status}.`;
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

const runTradingSession = async (): Promise<void> => {
  log("🚀 Starting Gemini trading session");

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
      content: `It's ${etTime} (US Eastern). The US stock market is OPEN for trading right now, so real-time quotes and order execution are available. Time for your trading analysis! Use the think tool first, then review your portfolio and net worth, check prices for tickers you're interested in, and call get_stock_news for any ticker you're considering to factor in recent financial news + sentiment before you trade. Then execute trades to grow the portfolio. Good luck! 📈`,
    },
  ];

  const maxTurns = 8;
  for (let turn = 1; turn <= maxTurns; turn++) {
    const completion = await withRetry(
      () =>
        gemini.chat.completions.create({
          model: MODEL,
          messages,
          tools,
          tool_choice: "auto",
        }),
      `Gemini completion (turn ${turn})`
    );

    const choice = completion.choices[0];
    const message = choice.message;
    const toolCalls = message.tool_calls || [];

    // Re-add the assistant turn (clean shape) so tool results can reference it.
    messages.push({
      role: "assistant",
      content: message.content ?? "",
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    if (toolCalls.length === 0) {
      if (message.content) log(`🤖 ${message.content}`);
      log(`✅ Session complete after ${turn} turn(s).`);
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
