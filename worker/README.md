# Exit sweep Worker

A Cloudflare Worker that enforces stop-loss and trailing-stop exits **every two
minutes** during market hours. It shares `src/risk.ts` with the Node trading
agent — the same module, the same thresholds, the same unit tests — so there is
no second implementation to drift.

## Why this is not on GitHub Actions

Stops used to live only inside the trading agent's process, which ran a few
times a day on an Actions cron. Measured across 192 scheduled runs on this
repository, delivery was ~98% reliable but **arbitrarily late**: start times
sprawled from 10:00 to 22:20 ET, 40% of runs began after the 16:00 close, and
the worst delay was 7h25m. A stop that is only evaluated when a late cron job
happens to wake up is not a stop.

The obvious fix — a long-running Actions job polling internally — would work
technically (Actions allows 6 hours per job) but GitHub's Additional Product
Terms prohibit using Actions "as part of a serverless application" and anything
placing "a disproportionate burden" on their servers. A multi-hour mostly-idle
job polling a broker is exactly that shape.

Cloudflare Workers is built for this instead, and the whole job fits
comfortably in the free tier:

| Limit (free plan) | Allowance | This Worker uses |
|---|---|---|
| Requests/day | 100,000 | ~270 |
| CPU per cron invocation | 10 ms | sub-millisecond (time awaiting `fetch` does not count) |
| Subrequests per invocation | 50 | ~6 |
| Wall clock per invocation | 15 min | ~2 s |
| Cron triggers per account | 5 | 1 |

## What it does

Every two minutes, 13:00–21:00 UTC, weekdays:

1. `GET /v2/clock` — the broker's authoritative open/closed answer, which knows
   about federal holidays and half-days. Exits immediately if closed.
2. `GET /v2/positions` — exits immediately if flat.
3. `GET /v2/orders` — derives each holding's entry time from fills, so the
   trailing stop's high-water mark can be reconstructed without stored state.
4. One batched bars request — ATR and the high since entry for every holding.
5. `decideExits()` — the shared risk engine.
6. If anything breached: checks for working orders, then submits a market order
   to close, with a deterministic `client_order_id` so a repeat cannot double up.

**It only ever sells.** It cannot open a position, so the worst case from a bug
here is being flat, never being unexpectedly long.

## Deploying

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put ALPACA_API_KEY
npx wrangler secret put ALPACA_SECRET_KEY
npx wrangler deploy
```

Optional secrets:

- `ALPACA_BASE_URL` — defaults to the paper endpoint; the Worker refuses to run
  against live trading.
- `ALPACA_DATA_FEED` — `iex` (default, free) or `sip`.
- `SWEEP_TOKEN` — enables the dry-run HTTP endpoint (see below). Without it, the
  Worker's URL returns 404 to everyone.
- Any `RISK_*` variable from `.env.example`, to override a default. The names are
  identical to the agent's, so one set of values configures both.

## Checking it works

```bash
npx wrangler tail
```

Streams live logs. Each invocation logs a one-line summary; submissions, skips
and errors get their own lines. The dashboard also retains the 100 most recent
cron invocations under the Worker's **Cron Events** tab.

For an on-demand check without waiting for a cron tick, set `SWEEP_TOKEN` and
request the Worker's URL with it:

```bash
curl -H "x-sweep-token: YOUR_TOKEN" https://trader-exit-sweep.YOUR-SUBDOMAIN.workers.dev
```

That returns a JSON **dry-run** report — what the sweep would do right now,
including each position's ATR and computed stop — and places no orders.

## Known limitations

- **Cron punctuality is not contractual.** Cloudflare documents no delivery
  guarantee and says scheduled Workers "run on underutilized machines". Expect
  seconds of drift rather than the hours Actions produced, but it is not a
  promise.
- **Cron runs on UTC.** There is no timezone option, so the trigger window is
  widened to cover both EST and EDT and the precise decision is delegated to
  Alpaca's clock. Nothing needs changing at a DST boundary.
- **Config changes take up to 15 minutes to propagate**, and scheduled
  invocations can be missed until they do.
- **No polling frequency beats an overnight gap.** If a stock gaps through its
  stop at the open, the fill is at the open price, not the stop. This Worker
  shortens the window of exposure from hours to minutes; it does not abolish it.
