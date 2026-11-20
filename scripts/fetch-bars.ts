/**
 * Download daily bars for the backtest universe and cache them on disk.
 *
 * Separate from the backtest itself so the backtest is deterministic and
 * offline: re-running it cannot silently pick up different data, and tuning
 * does not hammer the market-data API.
 *
 * Usage:
 *   npx tsx scripts/fetch-bars.ts
 *
 * Optional env:
 *   BARS_DIR     cache directory (default ./backtest-data)
 *   BARS_START   first date (default 2022-06-01 — extra history so the
 *                100-day regime MA is warm on the first tradeable day)
 *   BARS_END     last date (default today)
 *   ALPACA_DATA_FEED  iex (default, free on paper accounts) or sip
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const KEY = process.env.ALPACA_API_KEY;
const SECRET = process.env.ALPACA_SECRET_KEY;
const OUT_DIR = path.resolve(process.env.BARS_DIR ?? "backtest-data");
const START = process.env.BARS_START ?? "2022-06-01";
const END = process.env.BARS_END ?? new Date().toISOString().slice(0, 10);
const FEED = process.env.ALPACA_DATA_FEED ?? "iex";

if (!KEY || !SECRET) {
  console.error("Missing ALPACA_API_KEY / ALPACA_SECRET_KEY.");
  process.exit(1);
}

/**
 * Liquid large caps plus the benchmark.
 *
 * Chosen to be the kind of name the risk rules are written for (over $10,
 * tight spreads, fractionable) and to have existed for the whole window, so
 * the universe itself introduces no survivorship decisions mid-test.
 */
export const UNIVERSE = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "AMD", "AVGO",
  "JPM", "V", "UNH", "JNJ", "WMT", "PG", "HD", "COST", "LLY",
  "XOM", "TSLA", "NFLX",
];
export const BENCHMARK = "SPY";

const headers = {
  "APCA-API-KEY-ID": KEY,
  "APCA-API-SECRET-KEY": SECRET,
  accept: "application/json",
};

async function get<T>(url: string): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 429 || res.status >= 500) {
      const wait = 1000 * 2 ** attempt;
      console.warn(`  ${res.status} — retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }
  throw new Error(`Gave up after 5 attempts: ${url}`);
}

interface RawBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const symbols = [...UNIVERSE, BENCHMARK];
  console.log(
    `Fetching ${symbols.length} symbols, ${START} to ${END}, feed=${FEED}`
  );

  const all: Record<string, RawBar[]> = {};
  let pageToken: string | undefined;
  let pages = 0;

  // The multi-symbol endpoint pages across ALL symbols at once, so results
  // accumulate per symbol rather than per request.
  do {
    const url = new URL("https://data.alpaca.markets/v2/stocks/bars");
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", START);
    url.searchParams.set("end", END);
    url.searchParams.set("adjustment", "all");
    url.searchParams.set("feed", FEED);
    url.searchParams.set("limit", "10000");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const data = await get<{
      bars?: Record<string, RawBar[]>;
      next_page_token?: string | null;
    }>(url.toString());

    for (const [symbol, bars] of Object.entries(data.bars ?? {})) {
      (all[symbol] ??= []).push(...bars);
    }
    pageToken = data.next_page_token ?? undefined;
    pages++;
    process.stdout.write(`  page ${pages}\r`);
  } while (pageToken);

  console.log(`\n  fetched ${pages} page(s)`);

  let total = 0;
  for (const symbol of symbols) {
    const bars = (all[symbol] ?? []).sort((a, b) => a.t.localeCompare(b.t));
    if (bars.length === 0) {
      console.warn(`  ⚠️ ${symbol}: NO BARS`);
      continue;
    }
    fs.writeFileSync(
      path.join(OUT_DIR, `${symbol}.json`),
      JSON.stringify(bars),
      "utf8"
    );
    total += bars.length;
    console.log(
      `  ${symbol.padEnd(6)} ${String(bars.length).padStart(5)} bars  ${bars[0].t.slice(
        0,
        10
      )} → ${bars[bars.length - 1].t.slice(0, 10)}`
    );
  }

  fs.writeFileSync(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(
      { start: START, end: END, feed: FEED, symbols, benchmark: BENCHMARK, fetchedAt: new Date().toISOString() },
      null,
      2
    ),
    "utf8"
  );
  console.log(`\nDone. ${total} bars in ${OUT_DIR}`);
}

main().catch((error) => {
  console.error("Fetch failed:", error);
  process.exit(1);
});
