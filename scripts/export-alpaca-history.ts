/**
 * Export Alpaca paper-trading history to CSV for offline analysis.
 *
 * Usage:
 *   npx tsx scripts/export-alpaca-history.ts              # reads ./.env
 *   npx dotenv -e .env.other -- npx tsx scripts/export-alpaca-history.ts
 *
 * Optional env:
 *   EXPORT_DIR       output directory (default ./alpaca-export)
 *   EXPORT_START     ISO date to start from (default: account creation date)
 *   BENCHMARK        benchmark ticker for daily bars (default SPY)
 *
 * Writes:
 *   account.csv            one row: cash, equity, buying power, etc.
 *   positions.csv          current open positions
 *   orders.csv             every order ever submitted (incl. cancelled/expired)
 *   fills.csv              actual executions from the account activities feed
 *   equity_daily.csv       daily account equity curve (portfolio history)
 *   benchmark_daily.csv    daily bars for the benchmark ticker
 *
 * Read-only: this script never submits, replaces or cancels an order.
 */

import "dotenv/config"; // loads .env if present; never overrides real env vars
import fs from "node:fs";
import path from "node:path";

const KEY = process.env.ALPACA_API_KEY;
const SECRET = process.env.ALPACA_SECRET_KEY;
const RAW_BASE = process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets";
const BASE = RAW_BASE.replace(/\/+$/, "").replace(/\/v2$/, "");
const DATA_BASE = "https://data.alpaca.markets";
const OUT_DIR = path.resolve(process.env.EXPORT_DIR ?? "alpaca-export");
const BENCHMARK = process.env.BENCHMARK ?? "SPY";

if (!KEY || !SECRET) {
  console.error(
    "Missing ALPACA_API_KEY / ALPACA_SECRET_KEY.\n" +
      "Run with:  npx dotenv -e .env -- npx tsx scripts/export-alpaca-history.ts"
  );
  process.exit(1);
}

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
      console.warn(`  ${res.status} on ${url} — retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText} for ${url}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }
  throw new Error(`Gave up after 5 attempts: ${url}`);
}

/** CSV-quote a value: everything quoted, embedded quotes doubled. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return `"${String(v).replace(/"/g, '""')}"`;
}

function writeCsv(file: string, columns: string[], rows: Record<string, unknown>[]): void {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join(","));
  const target = path.join(OUT_DIR, file);
  fs.writeFileSync(target, lines.join("\n") + "\n", "utf8");
  console.log(`  wrote ${file.padEnd(20)} ${rows.length} row(s)`);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Exporting from ${BASE} into ${OUT_DIR}`);

  // ---- account snapshot -----------------------------------------------
  const account = await get<Record<string, unknown>>(`${BASE}/v2/account`);
  const accountCols = [
    "account_number", "status", "currency", "cash", "equity", "last_equity",
    "buying_power", "portfolio_value", "long_market_value", "short_market_value",
    "initial_margin", "maintenance_margin", "daytrade_count", "pattern_day_trader",
    "trading_blocked", "account_blocked", "created_at",
  ];
  writeCsv("account.csv", accountCols, [account]);
  console.log(
    `  cash=${account.cash} equity=${account.equity} currency=${account.currency} created=${account.created_at}`
  );

  const start =
    process.env.EXPORT_START ?? String(account.created_at ?? "").slice(0, 10) ?? "2024-01-01";

  // ---- open positions --------------------------------------------------
  const positions = await get<Record<string, unknown>[]>(`${BASE}/v2/positions`);
  writeCsv(
    "positions.csv",
    ["symbol", "side", "qty", "avg_entry_price", "current_price", "market_value",
     "cost_basis", "unrealized_pl", "unrealized_plpc", "change_today", "asset_class"],
    positions
  );

  // ---- every order, paginated backwards from now -----------------------
  const orders: Record<string, unknown>[] = [];
  let until: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 200; page++) {
    const url = new URL(`${BASE}/v2/orders`);
    url.searchParams.set("status", "all");
    url.searchParams.set("limit", "500");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("nested", "true");
    if (until) url.searchParams.set("until", until);
    const batch = await get<Record<string, unknown>[]>(url.toString());
    const fresh = batch.filter((o) => !seen.has(String(o.id)));
    for (const o of fresh) seen.add(String(o.id));
    orders.push(...fresh);
    if (batch.length < 500 || fresh.length === 0) break;
    until = String(batch[batch.length - 1].submitted_at);
    process.stdout.write(`  orders fetched: ${orders.length}\r`);
  }
  orders.sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));
  writeCsv(
    "orders.csv",
    ["id", "client_order_id", "symbol", "asset_class", "side", "type", "time_in_force",
     "qty", "notional", "filled_qty", "filled_avg_price", "limit_price", "stop_price",
     "status", "submitted_at", "filled_at", "canceled_at", "expired_at", "failed_at",
     "order_class", "extended_hours"],
    orders
  );

  // ---- fills (account activities) --------------------------------------
  const fills: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 500; page++) {
    const url = new URL(`${BASE}/v2/account/activities/FILL`);
    url.searchParams.set("page_size", "100");
    url.searchParams.set("direction", "asc");
    url.searchParams.set("after", `${start}T00:00:00Z`);
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const batch = await get<Record<string, unknown>[]>(url.toString());
    if (batch.length === 0) break;
    fills.push(...batch);
    pageToken = String(batch[batch.length - 1].id);
    if (batch.length < 100) break;
    process.stdout.write(`  fills fetched: ${fills.length}\r`);
  }
  writeCsv(
    "fills.csv",
    ["id", "activity_type", "transaction_time", "type", "symbol", "side",
     "qty", "price", "cum_qty", "leaves_qty", "order_id", "order_status"],
    fills
  );

  // ---- non-trade activity: regulatory fees, dividends, cash journals ---
  // Easy to overlook and material at this account size: dozens of one-cent
  // CAT/TAF/REG fee events add up to a real percentage of a $100 book.
  const activity: Record<string, unknown>[] = [];
  for (const type of ["FEE", "DIV", "JNLC", "CSD", "INT"]) {
    let token: string | undefined;
    for (let page = 0; page < 100; page++) {
      const url = new URL(`${BASE}/v2/account/activities/${type}`);
      url.searchParams.set("page_size", "100");
      if (token) url.searchParams.set("page_token", token);
      let batch: Record<string, unknown>[];
      try {
        batch = await get<Record<string, unknown>[]>(url.toString());
      } catch (err) {
        console.warn(
          `  activity ${type} unavailable (${(err as Error).message.slice(0, 80)})`
        );
        break;
      }
      if (!Array.isArray(batch) || batch.length === 0) break;
      activity.push(...batch);
      if (batch.length < 100) break;
      token = String(batch[batch.length - 1].id);
    }
  }
  activity.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  writeCsv(
    "activity.csv",
    ["id", "activity_type", "activity_sub_type", "date", "symbol", "qty",
     "per_share_amount", "net_amount", "description", "status"],
    activity
  );
  const feeTotal = activity
    .filter((a) => a.activity_type === "FEE")
    .reduce(
      (sum, a) => sum + Math.abs(parseFloat(String(a.net_amount ?? "0")) || 0),
      0
    );
  console.log(`  regulatory fees paid to date: $${feeTotal.toFixed(2)}`);

  // ---- daily equity curve ---------------------------------------------
  // Alpaca defaults this endpoint to a 1-month window, so `end` must be sent
  // explicitly or the curve is silently truncated.
  type History = {
    timestamp: number[];
    equity: (number | null)[];
    profit_loss: (number | null)[];
    profit_loss_pct: (number | null)[];
    base_value?: number;
  };
  const today = new Date().toISOString().slice(0, 10);
  const histUrl = new URL(`${BASE}/v2/account/portfolio/history`);
  histUrl.searchParams.set("start", start);
  histUrl.searchParams.set("end", today);
  histUrl.searchParams.set("timeframe", "1D");
  histUrl.searchParams.set("intraday_reporting", "market_hours");
  let hist = await get<History>(histUrl.toString());
  // Belt and braces: if it still comes back short of the benchmark window,
  // retry with the coarser `period` form.
  if ((hist.timestamp?.length ?? 0) < 40) {
    console.warn(`  portfolio history returned ${hist.timestamp?.length ?? 0} points — retrying with period=1A`);
    const alt = new URL(`${BASE}/v2/account/portfolio/history`);
    alt.searchParams.set("period", "1A");
    alt.searchParams.set("timeframe", "1D");
    const altHist = await get<History>(alt.toString());
    if ((altHist.timestamp?.length ?? 0) > (hist.timestamp?.length ?? 0)) hist = altHist;
  }
  const equityRows = (hist.timestamp ?? []).map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    timestamp: ts,
    equity: hist.equity?.[i],
    profit_loss: hist.profit_loss?.[i],
    profit_loss_pct: hist.profit_loss_pct?.[i],
  }));
  writeCsv("equity_daily.csv", ["date", "timestamp", "equity", "profit_loss", "profit_loss_pct"], equityRows);
  if (hist.base_value !== undefined) console.log(`  portfolio history base_value=${hist.base_value}`);

  // ---- benchmark daily bars -------------------------------------------
  const bars: Record<string, unknown>[] = [];
  for (const feed of ["sip", "iex"]) {
    bars.length = 0;
    let barToken: string | undefined;
    try {
      for (let page = 0; page < 100; page++) {
        const url = new URL(`${DATA_BASE}/v2/stocks/${BENCHMARK}/bars`);
        url.searchParams.set("timeframe", "1Day");
        url.searchParams.set("start", start);
        url.searchParams.set("adjustment", "all");
        url.searchParams.set("limit", "10000");
        url.searchParams.set("feed", feed);
        if (barToken) url.searchParams.set("page_token", barToken);
        const res = await get<{ bars?: Record<string, unknown>[]; next_page_token?: string | null }>(
          url.toString()
        );
        bars.push(...(res.bars ?? []));
        if (!res.next_page_token) break;
        barToken = res.next_page_token;
      }
      console.log(`  benchmark ${BENCHMARK} via feed=${feed}`);
      break;
    } catch (err) {
      console.warn(`  feed=${feed} failed (${(err as Error).message.slice(0, 120)}) — trying next`);
    }
  }
  writeCsv(
    "benchmark_daily.csv",
    ["t", "o", "h", "l", "c", "v", "n", "vw"],
    bars
  );

  console.log(`\nDone. Files are in ${OUT_DIR}`);
}

main().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
