# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

> This file was substantially out of date before the risk-engine-v2 change: it
> described OpenAI GPT-5 models, Docker Compose deployment, `thread.json`
> conversation persistence, a `think` tool, and a dozen npm scripts that do not
> exist. None of that was true. Treat anything here as authoritative only if it
> matches the code.

## Project overview

An autonomous AI trading agent that paper-trades a **~$100** Alpaca account. It
runs on GitHub Actions, uses Google Gemini via the OpenAI-compatible endpoint,
and is split into two halves:

- **The agent** (`src/agent.ts`) — up to 3 sessions per trading day. Decides
  what to own. Needs Gemini.
- **The exit sweep** (`worker/src/index.ts`) — a Cloudflare Worker running every
  two minutes during market hours. Decides what to get out of. No model, no
  Gemini, no judgement.

Both import the same `src/risk.ts`.

The goal is **risk-adjusted** return: beating buy-and-hold SPY after accounting
for drawdowns, not maximising raw profit.

## Architecture

```
src/risk.ts          Pure risk engine. ZERO imports — see the portability
                     contract at the top of the file. Runs in Node AND in the
                     Cloudflare Worker.
src/agent.ts         Gemini session: tools, prompting, order placement, pacing.
worker/src/index.ts  Two-minute exit sweep. Only ever SELLS.
scripts/             Operational scripts (see below).
tests/               117 tests, all against src/risk.ts.
```

### `src/risk.ts` — the portability contract

**This file must never gain an import, and must never touch `process`, the
filesystem or the network.** Config arrives as an injected object. Breaking this
breaks the Worker build, and the point of the constraint is that there is
exactly one implementation of the exit rules rather than two that drift.

Key exports: `loadRiskConfig`, `atrPercent`, `highWaterSince`,
`stopDistancePct`, `trailDistancePct`, `sizePosition`, `detectRegime`,
`vetSpread`, `decideExits`, `vetBuy`, `vetSell`, `hoursSinceEntry`,
`hoursSinceLastSell`, `drawdownPct`, `peakEquity`.

### How risk actually works

- **Sizing is volatility-targeted**, not a flat percentage: `notional = equity *
  riskPerTradePct / stopPct`, capped at `maxPositionPct`. A name needing a wide
  stop gets a small position, so every position carries the same dollar risk.
- **Stops scale to the instrument** (`atrStopMultiple` × ATR, clamped into
  `[minStopPct, maxStopPct]`), falling back to the flat `stopLossPct` when no
  bar data is available.
- **The trailing stop needs no stored state.** Its high-water mark is
  reconstructed from bars on every call (`highWaterSince`), which is what makes
  it possible for a stateless process holding fractional shares. Alpaca's native
  trailing-stop *order* type is unavailable on fractional positions.
- **The regime filter** (`detectRegime`) scales gross exposure from the
  benchmark's trend. It fails to `neutral`, never to `risk_off`, so a data
  outage cannot silently halt the strategy.
- **The model cannot override any of this.** It proposes; the engine disposes.

## Commands

```bash
npm start                  # one trading session, then exit
npm test                   # 117 tests (risk engine)
npm run build              # tsc --noEmit
npm run fetch-bars         # cache historical bars for the backtest
npm run backtest           # before/after metrics across three windows
npm run backtest:sweep     # parameter sweep on the tuning window
npm run export-history     # export the live account to CSV (read-only)
npm run worker:deploy      # deploy the exit sweep
npm run worker:tail        # stream Worker logs
```

Run with a profile env file when credentials live outside `.env`:

```bash
npx dotenv -e .env.gemini -- npm start
```

### Safe testing

`DRY_RUN=true` runs a complete session — risk engine, Gemini, decisions — and
submits **no orders**. It is also the only way to run outside market hours.

Do **not** reintroduce a flag like the old `TESTING_MODE`, which worked by making
`isMarketOpen()` return `true` unconditionally. That disabled the only gate
between the agent and a closed market, and eight orders in the account's history
were submitted outside 09:30–16:00 ET as a result.

## Things that are load-bearing and easy to break

1. **The market-hours gate asks the broker** (`/v2/clock`), not the local clock.
   A hand-rolled weekday-and-time check knows nothing about federal holidays
   (three sessions ran on Labor Day 2026) or half-days. It **fails closed**: an
   unreachable clock means no trading.

2. **Every order carries a `client_order_id`.** Alpaca rejects duplicates, which
   makes it an idempotency key. Without one, `withRetry` on the order path can
   double-submit when a 5xx hides a successful submission — the history contains
   two identical AMC sells four seconds apart, both filled.

3. **Model requests are counted per ATTEMPT, not per success.** Retries consume
   real quota. Counting only successes meant a session could log "3/5 requests"
   having actually spent seven.

4. **The model is verified at startup.** Google retires Gemini ids on a schedule
   and reroutes some silently (`gemini-2.5-flash` → `gemini-3.5-flash-lite` from
   2026-12-01). The agent lists available models and refuses to start if the
   configured one is missing.

5. **Order history is paginated.** It was a single `limit: 100` call against an
   account that had 97 orders. The re-buy cooldown and holding-period rules are
   derived from that history and would have begun failing open.

6. **The keepalive workflow must COMMIT, not merely run.** GitHub disables
   scheduled workflows on public repos after 60 days of no repository activity.
   This account's agent was running four jobs a day right up to the moment it
   was disabled — workflow runs do not count as activity. That outage cost five
   weeks of no risk management and ~11% of the account.

7. **Gemini free-tier limits are not published any more.** Do not hard-code a
   figure; `MAX_MODEL_REQUESTS` is a repo variable to be set from
   https://aistudio.google.com/rate-limit. Quotas apply per *project*, not per
   key, and the `FALLBACK_MODEL` path is best-effort only — the docs do not
   promise per-model quota pools.

## Backtesting

`npm run backtest` compares the old and new risk layers over three windows
(tuning, out-of-sample, full) against buy-and-hold SPY, with a cost model
calibrated to this account's measured fees.

Read it with two caveats firmly in mind:

- **It tests the risk layer, not the stock picking.** Both engines get the same
  momentum-rank entry signal standing in for the model, so differences are
  attributable to risk rules alone. There is no way to replay what Gemini would
  have chosen.
- **The universe is 20 megacaps chosen in 2026**, so absolute returns are
  inflated by selection bias. Only the *relative* comparison is meaningful.

The `--sweep` output exists to check the parameters are not pathological, **not**
to pick them. The surface is noisy enough that adjacent values swing Sortino by
0.7, so the shipped defaults deliberately sit in the middle of a stable region
rather than at the in-sample maximum.

## Data files

- `results/{profile}/agent-{profile}.log` — session logs (gitignored)
- `alpaca-export/*.csv` — account export from `npm run export-history`
  (gitignored)
- `backtest-data/*.json` — cached bars (gitignored)

There is **no** `thread.json` and no conversation persistence. Each session is
stateless by design; everything that needs to survive is derived from Alpaca.

## Required configuration

Secrets: `GEMINI_API_KEY`, `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`,
`FINNHUB_API_KEY`, optionally `ALPACA_BASE_URL`.

Repo variables: `MODEL`, `FALLBACK_MODEL`, `MAX_MODEL_REQUESTS`.

Cloudflare Worker secrets: `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, optionally
`SWEEP_TOKEN` and any `RISK_*` override.

See `.env.example`, which documents every risk parameter with its real shipped
default.
