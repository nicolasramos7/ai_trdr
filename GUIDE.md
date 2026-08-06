# Deep Guide to `llm_trader`

A complete walkthrough of what this repo is, how it runs, the financial concepts it
encodes, and where the sharp edges are.

---

## Table of contents

1. [The one-paragraph mental model](#1-the-one-paragraph-mental-model)
2. [File map: what's alive and what's dead](#2-file-map-whats-alive-and-whats-dead)
3. [Financial concepts glossary](#3-financial-concepts-glossary)
4. [Configuration and startup](#4-configuration-and-startup)
5. [The session lifecycle, step by step](#5-the-session-lifecycle-step-by-step)
6. [The risk engine in depth](#6-the-risk-engine-in-depth)
7. [Tool-by-tool reference](#7-tool-by-tool-reference)
8. [Market data: where prices come from](#8-market-data-where-prices-come-from)
9. [News and sentiment](#9-news-and-sentiment)
10. [Resilience: retries, backoff, fail-open](#10-resilience-retries-backoff-fail-open)
11. [Scheduling: how it runs unattended](#11-scheduling-how-it-runs-unattended)
12. [Testing](#12-testing)
13. [Running it yourself](#13-running-it-yourself)
14. [Known staleness and gotchas](#14-known-staleness-and-gotchas)
15. [How to change common things](#15-how-to-change-common-things)

---

## 1. The one-paragraph mental model

An LLM (Google Gemini 2.5 Flash) is given a set of trading tools and told to grow a
small **paper trading** account. Every ~30 minutes during US market hours, a GitHub
Actions cron job starts a fresh Node process. That process runs **exactly one trading
session** and exits. Before the model gets a single turn, a **deterministic risk engine
written in plain TypeScript** sweeps the portfolio and force-closes any position past its
stop-loss or take-profit. Then the model gets up to 8 turns of tool calls to analyze and
trade. Every buy it proposes is re-vetted by the same risk engine, which may shrink or
reject it. No state is stored locally — the portfolio *is* whatever Alpaca says it is.

The governing design principle, stated in [`src/risk.ts:8`](src/risk.ts:8):

> **The agent proposes, this layer disposes.**

The LLM decides *what* to trade. Code decides *how much* and *when to get out*. This
split matters because an LLM can be talked out of its own rules — by its own reasoning,
by a bad news headline, by a hallucination. Pure functions cannot.

```
GitHub Actions cron (13×/day, weekdays)
        │
        ▼
   node src/agent.ts  ──── one session, then exit
        │
        ├─ 1. verify Alpaca paper credentials
        ├─ 2. market-hours gate (exit cleanly if closed)
        ├─ 3. EXIT SWEEP  ← risk engine force-closes stops/targets
        ├─ 4. build risk briefing → injected into the model's first message
        ├─ 5. LLM loop (≤8 turns): think → look → trade
        │        every `buy` passes through vetBuy() first
        └─ 6. log everything to results/gemini/agent-gemini.log, exit
```

---

## 2. File map: what's alive and what's dead

This is the single most important thing to understand about the repo, and nothing in
`CLAUDE.md` tells you: **the project was rewritten and most supporting files are
leftovers from the previous version.**

### Live code (what actually trades)

| File | Lines | Role |
|---|---|---|
| [`src/agent.ts`](src/agent.ts) | 1118 | **Everything.** Config, Alpaca client, Gemini client, market data, tool definitions, tool execution, the agent loop, logging. Self-contained — imports only `risk.js` from the project. |
| [`src/risk.ts`](src/risk.ts) | 290 | The deterministic risk engine. Pure functions, no I/O. The only module `agent.ts` depends on. |
| [`system-prompt.md`](system-prompt.md) | 123 | The model's standing instructions, read fresh from disk each session. |
| [`.github/workflows/trading-agent.yml`](.github/workflows/trading-agent.yml) | — | The actual scheduler. |
| [`tests/risk.test.ts`](tests/risk.test.ts) | 294 | Real, current tests covering the risk engine. |

### Legacy / orphaned code

| File | Status |
|---|---|
[`src/trading.ts`](src/trading.ts) | A `TradingService` class from the OpenAI-era version. **Not imported by `agent.ts`.** Only `dashboard.ts` uses it. Contains a hardcoded fake-price table (see gotchas). |
| [`src/dashboard.ts`](src/dashboard.ts) | An interactive terminal UI (`npm run dashboard`) for manually viewing the portfolio and placing trades. Still functional but requires `OPENAI_API_KEY` and assumes a $100,000 starting balance. |
| [`src/logger.ts`](src/logger.ts) | A structured logger used only by `trading.ts`/`error-handler.ts`. `agent.ts` has its own 10-line `log()` instead. |
| [`src/error-handler.ts`](src/error-handler.ts) | Error classification/statistics machinery used only by `trading.ts`. `agent.ts` has its own `withRetry`. |
| [`src/trading-simple.ts`](src/trading-simple.ts) | A stub with mocked methods, used only by `trading-simple.test.ts`. |
| [`tests/trading.test.ts`](tests/trading.test.ts), [`tests/agents.test.ts`](tests/agents.test.ts) | Test the legacy service and shell out to the agent; largely disconnected from current behavior. |
| [`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml) | Reference `npm run start:continuous`, a script that **no longer exists**. Broken as written. |
| [`CLAUDE.md`](CLAUDE.md) | Describes the *previous* architecture (OpenAI Agents SDK, `thread.json` persistence, CSV P&L reports, `--continuous` mode, GPT-5 profiles). Almost none of it matches the code. |
| [`README.md`](README.md) | Contains a single `.` character. |

**Practical consequence:** when you want to change trading behavior, you edit
`src/agent.ts`, `src/risk.ts`, or `system-prompt.md`. Nothing else. Editing
`src/trading.ts` changes nothing about how the bot trades.

---

## 3. Financial concepts glossary

Every concept the code actually relies on, in plain terms, with the code that uses it.

### Paper trading

A simulated brokerage account with fake money and real market data. Alpaca fills your
orders against its own simulation engine at realistic prices. Nothing here touches real
money — and the code refuses to let it. [`src/agent.ts:50`](src/agent.ts:50) throws
outright if `ALPACA_BASE_URL` isn't the paper endpoint:

```ts
if (!/paper-api\.alpaca\.markets/.test(ALPACA_BASE_URL)) {
  throw new Error(`Refusing to run: ... is not the paper endpoint.`);
}
```

This is a hard guard rail, not a warning. Even a mis-set secret cannot route orders to
live trading.

### Bid, ask, spread, and mid price

- **Bid** — the highest price a buyer will currently pay.
- **Ask** — the lowest price a seller will currently accept.
- **Spread** — ask minus bid. The market maker's cut. You buy at the ask and sell at the
  bid, so a round trip costs you the spread even if the price never moves.
- **Mid** — `(bid + ask) / 2`. Not a price you can actually trade at; it's the fairest
  single-number estimate of "what is this worth right now."

The code prices everything at the mid ([`src/agent.ts:187`](src/agent.ts:187)):

```ts
const mid = (quote.BidPrice + quote.AskPrice) / 2;
```

**Why the spread drives real design decisions here.** For a liquid megacap like AAPL the
spread is ~0.01% of the price. For a $2 penny stock it can be 0.5%+. On a $100 account
making several round trips a day, spread cost alone can swamp any edge. That's the entire
reason [`system-prompt.md:9`](system-prompt.md:9) tells the model to *avoid* low-priced
stocks, and the reason the risk engine caps buys per session
([`src/risk.ts:223`](src/risk.ts:223)) — *"excessive turnover loses more to spread than
it gains."*

### Market order vs. limit order

- **Market order** — "fill me now at whatever the going price is." Guaranteed to execute,
  not guaranteed a price.
- **Limit order** — "fill me only at $X or better." Guaranteed price, not guaranteed
  execution.

This bot uses **market orders exclusively** ([`src/agent.ts:430`](src/agent.ts:430),
`type: "market"`). That's a deliberate simplicity trade: the agent runs in short bursts
and cannot babysit a resting limit order between sessions.

### Time in force: `day` vs `gtc`

How long an unfilled order stays alive.

- **`day`** — cancelled automatically at the close if unfilled.
- **`gtc`** ("good till cancelled") — stays open indefinitely across sessions.

The live code always uses `day` ([`src/agent.ts:434`](src/agent.ts:434)), for two stated
reasons:

1. **Required:** Alpaca rejects `gtc` on fractional and notional orders.
2. **Safer anyway:** a GTC market order placed near the close can rest overnight and fill
   into a **gap** — a price jump between the close and the next open, caused by
   after-hours news. You'd get filled at a price nobody quoted when you decided to trade.

(The legacy `src/trading.ts` still uses `gtc` — another sign it's stale.)

### Shares (`qty`) vs. dollars (`notional`)

Two ways to size the same order:

- **`qty`** — "buy 3 shares." The dollar cost depends on the share price.
- **`notional`** — "buy $30 worth." The share count depends on the share price, and comes
  out fractional.

The bot **prefers notional for buys** ([`src/agent.ts:635`](src/agent.ts:635)). This is
the single most important sizing insight in the repo, and the system prompt hammers it:

> $30 of a $700 stock buys you 0.043 shares. A high share price is NEVER a reason to skip
> a stock.

**Why this matters so much.** A share price is an arbitrary number — it's market cap
divided by share count. A $3 stock does not have "more room to grow" than a $300 stock.
But an LLM sizing a $100 account in whole shares gets *pushed* toward penny stocks purely
by arithmetic: it can't afford one share of SPY at $745, so it buys 50 shares of a $2
distressed company instead. That's exactly what happened before the fix — the git log's
`fractional/notional orders; no "prefer cheap stocks"` commit, and the archived session in
`results/gemini/agent-gemini.log` where the agent sold Ford to buy AMC, then loaded up on
48 more shares of AMC.

Notional orders sever the link between share price and affordability, which lets the agent
judge companies on quality instead of sticker price — and lets a $100 account diversify
across several names in $20–30 slices.

### Fractional shares

Owning 0.043 of a share. Not every asset supports it. The code checks per-symbol via
Alpaca's asset endpoint and caches the answer for the session
([`src/agent.ts:444`](src/agent.ts:444)). On failure it **assumes whole-share-only**,
because an integer quantity is always accepted while a rejected fractional order loses
the trade entirely.

If a dollar budget lands on a non-fractionable asset, the code converts:
`Math.floor(notional / price)` ([`src/agent.ts:863`](src/agent.ts:863)). If that's zero
shares, it tells the model plainly to pick another ticker or raise the amount.

### Long vs. short

- **Long** — you own the asset. You profit when it rises. Maximum loss is 100% (it goes
  to zero).
- **Short** — you borrow shares, sell them now, and must buy them back later. You profit
  when it *falls*. Maximum loss is **unbounded** — there's no ceiling on how high a price
  can go, so there's no floor on your loss.

The code models a short as a **negative quantity**
([`src/agent.ts:299`](src/agent.ts:299)): `side: shares < 0 ? "short" : "long"`. A short
position also carries a **negative market value**, which is why the formatter
([`src/agent.ts:715`](src/agent.ts:715)) is built to render `-$480.00` readably.

Alpaca requires **$40,000 equity** to short, and the code enforces it up front
([`src/agent.ts:948`](src/agent.ts:948)). On a ~$100 account, `short_sell` and
`cover_short` are therefore permanently unreachable. They exist for a larger account.

### Margin, buying power, and Reg T

**Buying power** is how much you can deploy — which on a margin account exceeds your cash,
because the broker lends against your collateral. For shorts, US **Regulation T** requires
you to post 50% of the position's value as margin. The code checks exactly that
([`src/agent.ts:955`](src/agent.ts:955)):

```ts
if (buyingPower < orderValue * 0.5) { /* reject */ }
```

### Cash vs. equity (net worth)

- **Cash** — uninvested dollars sitting in the account.
- **Equity** / **portfolio value** / **net worth** — cash **plus** the current market
  value of every position. This is the number that measures whether you're winning.

Both are read straight from Alpaca ([`src/agent.ts:324`](src/agent.ts:324)):
`cash: num(account.cash)`, `equity: num(account.portfolio_value)`.

Keeping these distinct is essential to the risk rules: the **cash reserve** is a fraction
of *equity* but must be satisfied out of *cash*. Hold $100 of stock and $2 of cash and you
have plenty of equity but nothing deployable.

### Unrealized vs. realized P&L

- **Unrealized** — paper gain/loss on a position you still hold. It can evaporate.
- **Realized** — locked in by closing the position. Real.

Alpaca reports `unrealized_plpc` as a **fraction** (0.0772 = +7.72%), and the code scales
it to percent at exactly one place ([`src/agent.ts:302`](src/agent.ts:302)) so the risk
engine and display never disagree:

```ts
unrealizedPlPct: num(position.unrealized_plpc) * 100,
```

**Average entry price** is the volume-weighted average of what you paid across multiple
buys — the reference point unrealized P&L is measured from.

The code goes out of its way to render P&L with an explicit sign
([`src/agent.ts:707`](src/agent.ts:707)) so the model can never misread a loss as a gain
from formatting alone. A small thing that prevents a catastrophic misread.

### Stop-loss and take-profit

- **Stop-loss** — an automatic exit once a position is down X%. Caps the damage from a
  broken thesis. Default here: **-7%**.
- **Take-profit** — an automatic exit once a position is up X%. Locks in the win before it
  gives back. Default here: **+15%**.

The 7/15 asymmetry gives a favorable **reward:risk ratio** of roughly 2:1 — you can be
right less than half the time and still come out ahead.

**Trailing stop** — a stop that ratchets upward as the price rises, so it protects profit
while letting winners run. [`src/risk.ts:83`](src/risk.ts:83) explains why it's *not*
used, and this is a genuinely instructive comment: a trailing stop needs a per-position
high-water mark, the agent keeps no state between runs, and Alpaca's native trailing-stop
orders don't work on fractional positions. Two independent constraints ruled it out.

### Drawdown and the high-water mark

**Drawdown** is how far below its all-time peak the account currently sits, in percent.
It's the standard measure of "how bad has this gotten."

```
drawdown% = (peak − current) / peak × 100     — floored at zero
```

A new all-time high is a **0%** drawdown, not a negative one — hence the `Math.max(0, …)`
in [`src/risk.ts:136`](src/risk.ts:136).

The **peak** (high-water mark) is reconstructed from Alpaca's own 3-month daily equity
curve, because the bot stores nothing locally ([`src/agent.ts:342`](src/agent.ts:342)).
Current equity is folded into the max so a fresh high counts before it lands in the
history series.

Drawdown drives the **circuit breaker**: past 15% below peak, all new buys stop. Selling
never stops. The asymmetry is the point — the whole purpose is to stop *adding* risk while
losing, without ever trapping the agent in a position it needs to exit.

### Position sizing, concentration, and diversification

- **Concentration** — how much of your account sits in one name. High concentration means
  one bad earnings report can take out the whole account.
- **Diversification** — spreading across names so no single failure is fatal.

Enforced as a hard cap: no position may exceed **25% of equity**
([`src/risk.ts:244`](src/risk.ts:244)). On a $100 account that's $25 max per name, forcing
at least four positions if fully deployed. Fractional orders are what make this feasible —
without them, a $100 account physically couldn't buy $25 slices of quality stocks.

### Turnover and churn

**Turnover** is how much you trade. **Churn** is trading for its own sake. Every round
trip pays the spread, so high turnover is a guaranteed, compounding cost against an
uncertain edge. Capped at **4 buys per session**
([`src/risk.ts:223`](src/risk.ts:223)) — note it counts *buys only*; exits are never
restricted.

### CAGR

**Compound Annual Growth Rate** — the annualized return that would take you from your
starting value to your current value:

```
CAGR = (current / start)^(1 / years) − 1
```

Implemented in the legacy [`src/trading.ts:244`](src/trading.ts:244). Worth knowing: over
periods much shorter than a year this number is meaningless in the extreme — a 1% gain in
one day annualizes to over 3,000%. The code partly guards this by refusing to compute it
under one day, but a two-day CAGR is still noise.

### Liquidity

How easily you can trade size without moving the price. Liquid names have tight spreads
and deep order books; illiquid ones punish you on entry *and* exit. The system prompt
repeatedly steers toward liquid names — for a bot that must be able to exit on demand when
a stop triggers, liquidity is a risk control, not a preference.

### Market hours, gaps, and holidays

US equities trade **9:30 AM – 4:00 PM ET, weekdays**. Outside those hours quotes are stale
and market orders don't fill sensibly, so [`src/agent.ts:158`](src/agent.ts:158) gates the
whole session:

```ts
const day = nowEt.getDay();
if (day === 0 || day === 6) return false;
const minutes = nowEt.getHours() * 60 + nowEt.getMinutes();
return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
```

`TESTING_MODE=true` bypasses this so you can exercise a session at any hour.

**This check does not know about market holidays or early closes.** On Thanksgiving the
session will start and Alpaca will simply reject the orders. Harmless, but noisy — see
gotchas.

---

## 4. Configuration and startup

Everything comes from the environment; nothing is hardcoded. Config load order
([`src/agent.ts:29`](src/agent.ts:29)):

1. `config()` — loads `.env`
2. If `.env.gemini` exists, load it with `override: true` — profile file wins

### Required

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio key (free tier available) |
| `ALPACA_API_KEY` | Alpaca **paper** key ID |
| `ALPACA_SECRET_KEY` | Alpaca paper secret |

Missing any of these fails immediately via `tiny-invariant`
([`src/agent.ts:41`](src/agent.ts:41)) — fail fast, before any network call.

### Optional

| Variable | Default | Notes |
|---|---|---|
| `MODEL` | `gemini-2.5-flash` | Any model on the Gemini OpenAI-compatible endpoint |
| `GEMINI_BASE_URL` | `…/v1beta/openai/` | Gemini's OpenAI-compatible shim |
| `PROFILE_NAME` | `gemini` | Names the log directory: `results/<profile>/` |
| `ALPACA_BASE_URL` | `https://paper-api.alpaca.markets` | Trailing `/v2` stripped; non-paper URLs throw |
| `FINNHUB_API_KEY` | — | Without it, `get_stock_news` returns a graceful "unavailable" string |
| `TESTING_MODE` | — | `true` bypasses the market-hours gate |
| `RISK_*` (6 vars) | see below | Risk engine overrides |

### Why Gemini through an OpenAI-shaped client

[`src/agent.ts:78`](src/agent.ts:78) instantiates the **`openai` SDK** pointed at
Google's endpoint:

```ts
const gemini = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
});
```

Google exposes an OpenAI-compatible surface, so the mature `openai` client, the standard
function-calling tool schema, and the standard message/tool-result loop all work
unchanged. Swapping models later means changing a base URL and a key, not rewriting the
agent loop. (`package.json` also lists `@openai/agents` and `litellm` — both unused
leftovers.)

### Risk overrides

```bash
RISK_STOP_LOSS_PCT=7
RISK_TAKE_PROFIT_PCT=15
RISK_MAX_POSITION_PCT=25
RISK_CASH_RESERVE_PCT=10
RISK_MAX_DRAWDOWN_PCT=15
RISK_MAX_BUYS_PER_SESSION=4
```

The parser ([`src/risk.ts:45`](src/risk.ts:45)) accepts a value only if it's finite **and
positive**; anything else silently falls back to the default. This is a deliberate
fail-safe: a typo in a CI secret degrades to the safe default, never to an *unlimited*
setting. `RISK_MAX_POSITION_PCT=0` does not mean "no limit" — it means "use 25%."

---

## 5. The session lifecycle, step by step

### Step 1 — Credential check ([`src/agent.ts:1094`](src/agent.ts:1094))

Fetch the Alpaca account. On failure, `process.exit(1)`. Better to fail loudly at startup
than mid-order.

### Step 2 — Market-hours gate

If closed, log and `return` — **exit code 0**, not an error. A closed market is a normal
outcome, and a green CI run means "nothing to do here," not "something broke."

### Step 3 — Exit sweep ([`src/agent.ts:370`](src/agent.ts:370))

This runs **before the model exists in the conversation at all**. It:

1. Fetches the portfolio (account + positions + last 100 orders, in parallel).
2. Derives peak equity and computes the current drawdown.
3. Runs `decideExits()` over every position.
4. Calls `alpaca.closePosition(symbol)` for each breach — which closes the *whole*
   position regardless of side or fractional size.
5. Builds a human-readable summary string.

That summary is essential. Without it, the model would call `get_portfolio`, find a
position it remembered holding simply gone, and have no idea why — which is exactly the
kind of gap an LLM fills with a confabulated explanation. If an automatic close *fails*,
the message escalates ([`src/agent.ts:396`](src/agent.ts:396)):

> "AUTOMATIC CLOSE FAILED (…). Close this position yourself with the sell tool as your
> **first action**."

Code first, model as the fallback.

### Step 4 — Risk briefing ([`src/agent.ts:1008`](src/agent.ts:1008))

The exit summary, the active thresholds, and the current drawdown are assembled into a
block prepended to the user message. If the breaker is tripped it adds a loud warning that
buys will be rejected and redirects the model toward reviewing what it holds. It closes
with:

> "Do not fight these limits or retry a blocked order unchanged — adapt your plan to them."

This is prompt engineering doing damage control for a real failure mode: an LLM that hits
a wall tends to retry the identical call, burning its scarce turns on a deterministic
rejection.

### Step 5 — The agent loop ([`src/agent.ts:1039`](src/agent.ts:1039))

A textbook function-calling loop, capped at **8 turns**:

```
for turn in 1..8:
    completion = gemini.chat.completions.create({ model, messages, tools, tool_choice: "auto" })
    push assistant message onto history
    if no tool calls:
        log final text, return          ← normal termination
    for each tool call:
        result = executeTool(name, args)
        push { role: "tool", tool_call_id, content: result }
```

Details worth noting:

- **The model ends the session**, by replying with prose instead of a tool call. The turn
  cap is a safety net, not the expected exit.
- **Multiple tool calls per turn are supported and encouraged.** The system prompt pushes
  batching — all price lookups in one turn, all trades in another.
- **Every tool result is a plain string**, including errors. `executeTool` wraps its whole
  body in try/catch ([`src/agent.ts:990`](src/agent.ts:990)) and returns
  `"Tool X failed: …"` as *content*. A tool failure never throws, never crashes the run —
  it becomes information the model can react to. This is the right shape for agent tools.
- **The assistant message is rebuilt in a clean shape**
  ([`src/agent.ts:1056`](src/agent.ts:1056)) rather than pushed verbatim, normalizing
  `content: null` to `""` — some providers reject a null-content assistant turn on
  replay.
- **Malformed tool arguments are survivable**
  ([`src/agent.ts:1070`](src/agent.ts:1070)): a JSON parse failure logs a warning and
  passes `{}`, letting the tool's own validation produce a useful message.

### Step 6 — Exit

Log and terminate. No state written except the log file. Next session starts from Alpaca's
truth.

### Why statelessness is a feature

There's no `thread.json`, no local portfolio file, no conversation carried between
sessions. Consequences:

- **No drift.** A local portfolio file can disagree with the broker; a single source of
  truth cannot.
- **No corruption.** `CLAUDE.md` documents an elaborate apparatus for detecting and
  repairing corrupted thread files. That entire class of bug was deleted, not fixed.
- **CI-native.** A fresh checkout with no writable state is exactly what GitHub Actions
  provides, which is why the workflow needs only `contents: read`.
- **The tradeoff:** the agent has no memory. It cannot remember *why* it bought something
  last Tuesday. Its only continuity is the position list and trade history it reads back
  from Alpaca — which is why `get_portfolio` returns average entry prices and the last 15
  trades. That's the memory substitute.

---

## 6. The risk engine in depth

[`src/risk.ts`](src/risk.ts) is the most carefully written file in the repo. Every
function is **pure** — no network, no clock, no randomness — so the same inputs always
produce the same decision, and every rule is exhaustively unit-testable. That's what
makes 294 lines of tests possible.

### `decideExits(positions, config)` — [`src/risk.ts:92`](src/risk.ts:92)

```ts
if (!Number.isFinite(position.unrealizedPlPct)) continue;      // skip garbage data
if (position.unrealizedPlPct <= -config.stopLossPct)  → stop_loss
else if (position.unrealizedPlPct >= config.takeProfitPct) → take_profit
```

The `if/else` ordering means stop-loss is checked first — the two thresholds can't both
fire, and the loss-limiting branch wins by construction. Non-finite P&L is skipped rather
than treated as zero: bad data should never *trigger* a trade.

### `vetBuy(request)` — [`src/risk.ts:198`](src/risk.ts:198)

Every proposed buy passes through this before reaching Alpaca. The central design choice
is stated in the docblock and is worth internalizing:

> Where possible this **CLAMPS rather than denies**: returning a smaller permitted amount
> lets the agent still act, whereas a hard denial burns one of its few turns.

With only 8 turns, "no" is expensive. "Yes, but smaller" keeps the session productive.

The rules, in order:

| # | Rule | Behavior | Rationale |
|---|---|---|---|
| 0 | Amount must be a positive finite number | **Deny** | Input validation |
| 1 | **Drawdown breaker** — `drawdown ≥ 15%` | **Deny** | The account is in trouble; stop adding risk |
| 2 | **Turnover cap** — `buysThisSession ≥ 4` | **Deny** | Spread cost from churn exceeds the edge |
| 3 | **Cash reserve** — `cash − (equity × 10%) < $1` | **Deny** | Never deploy the last dollar |
| 4 | **Concentration cap** — `(equity × 25%) − existingValue < $1` | **Deny** | No single name may dominate |
| 5 | Otherwise | **Clamp** to `min(requested, deployableCash, headroom)` | Trade what's permissible |

Two details that show real care:

**Round *down* to cents** ([`src/risk.ts:257`](src/risk.ts:257)):

```ts
const approvedNotional = Math.floor(permitted * 100) / 100;
```

`Math.round` could round *up* and breach the very limit being enforced by a fraction of a
cent. Flooring makes the limit inviolable.

**Half a cent of clamp slack** ([`src/risk.ts:267`](src/risk.ts:267)):

```ts
const clamped = approvedNotional < request.requestedNotional - 0.005;
```

Without this, floating-point noise would report a "RISK ADJUSTED" clamp on an order that
wasn't meaningfully reduced — confusing the model about a reduction that didn't happen.

Every verdict carries a `reason` string, always populated, always fed back to the model.
Even `"Within risk limits."` The engine explains itself.

### Sells are never vetted

Stated explicitly at [`src/risk.ts:195`](src/risk.ts:195):

> Sells are deliberately never vetted. Blocking an exit could **trap** the agent in a
> losing position, which is far more dangerous than any oversized buy.

This asymmetry runs through the entire design. Every limit in the system restricts *adding
risk*. Nothing restricts *reducing* it. The worst case of a too-permissive buy rule is a
bad position; the worst case of a too-strict sell rule is an unbounded loss you cannot
escape.

### `peakEquity` and `drawdownPct` — [`src/risk.ts:133`](src/risk.ts:133)

`peakEquity(series, current)` walks Alpaca's equity history, skipping `null`/`NaN`
samples, and seeds the max with current equity. `drawdownPct` floors at zero and returns
`0` for non-finite or non-positive inputs.

The **fail-open** decision at [`src/agent.ts:354`](src/agent.ts:354) deserves attention:
if the portfolio-history call fails, the code treats current equity as the peak, which
makes the drawdown 0% and the breaker inactive for that session:

> "A history outage must not manufacture a phantom drawdown and freeze trading; the other
> position-level limits still apply."

An API outage shouldn't halt the system, and the other four rules still bind. This is a
judgment call, not an oversight — and it's logged loudly when it happens.

### Where the limits are enforced (the two-layer structure)

| Layer | Enforces | Can the model bypass it? |
|---|---|---|
| **Code** (`risk.ts` + the sweep) | stop-loss, take-profit, position cap, cash reserve, buy cap, drawdown breaker | **No** |
| **Prompt** ([`system-prompt.md:87`](system-prompt.md:87)) | Exit early on a broken thesis, diversify, don't retry blocked orders, prefer liquid names | Yes — it's advice |

The prompt describes the code layer accurately, which matters: the model needs to
understand the constraints to plan within them rather than fight them. And
[`system-prompt.md:103`](system-prompt.md:103) frames the relationship correctly —

> "The engine is a backstop for when your judgment fails, not a substitute for it — a
> thesis that has broken is worth exiting at -3% rather than waiting for the stop."

A stop-loss is a floor, not a strategy.

---

## 7. Tool-by-tool reference

Nine tools, defined at [`src/agent.ts:579`](src/agent.ts:579), executed at
[`src/agent.ts:718`](src/agent.ts:718).

### `think(thought_process: string[])`

No side effects; logs each step with a 🧠 prefix. The system prompt makes it mandatory
before any other tool, and caps it at 2–3 uses per session.

Both halves matter. Forcing an explicit plan first produces visibly better sequencing.
Capping it prevents the pathological loop where the model thinks after every single tool
result and exhausts its 8 turns without placing a trade. It also gives you a readable
audit trail of *why* — invaluable when reviewing what the bot did overnight.

### `get_portfolio()`

The model's primary window on reality. Returns:

```
Cash: $86.48
Equity (cash + positions): $101.23

Open positions (2):
  - NVDA: 0.12 shares (long)
      avg entry $198.40 → now $203.11 | value $24.37 | unrealized +$0.57 (+2.37%)
  - F: 1 shares (long)
      avg entry $14.02 → now $13.50 | value $13.50 | unrealized -$0.52 (-3.71%)

Total unrealized P&L: +$0.05

Recent trades:
  - 2026-07-08T17:35:16Z sell 1 F @ $13.5
  … (last 15)
```

Three things earn their place here:

- **Per-position unrealized P&L in both dollars and percent.** The prompt calls this out
  twice: it tells the model directly which positions are winners to let run and which are
  losers to cut. Before this existed (commit `94242c5`), the agent was managing exits
  blind.
- **Average entry price** — the anchor P&L is measured from, and a stand-in for the memory
  the stateless agent doesn't have.
- **Last 15 trades**, oldest-first — enough to see recent activity, few enough not to
  flood the context.

Internally, `getPortfolio()` ([`src/agent.ts:273`](src/agent.ts:273)) fetches account,
positions, and orders in parallel with `Promise.all`, and parses defensively. Alpaca
returns every numeric field as a *string*, and some can be missing, so `num()`
([`src/agent.ts:241`](src/agent.ts:241)) coerces with a fallback — a `NaN` must never
reach the model's view of its own money. There's even a recovery for a missing
`current_price` ([`src/agent.ts:289`](src/agent.ts:289)): back it out of
`market_value / shares`, so the model sees a live price rather than `$0.00`. A displayed
$0.00 price on a real position is exactly the kind of thing that provokes a panic sell.

### `get_net_worth()`

Lighter than `get_portfolio` — returns equity, cash, and buying power in one line.

### `get_stock_price(ticker)`

Mid-price for one symbol. See [§8](#8-market-data-where-prices-come-from).

### `buy(ticker, notional?, shares?)`

The most complex tool, and worth tracing end to end
([`src/agent.ts:780`](src/agent.ts:780)):

1. **Validate exclusivity** — exactly one of `notional` / `shares`. Both, or neither, is a
   descriptive error.
2. **Fetch account + positions** in parallel; extract buying power and any existing
   position value in this ticker (`Math.abs` of market value, so a short counts toward the
   concentration cap too).
3. **Normalize to dollars.** If given `shares`, look up the price and multiply. *One set
   of risk rules then covers both paths* — a small unification that removes a whole class
   of bug.
4. **`vetBuy()`.** Denied → return the reason verbatim. Clamped → log it and continue.
5. **Check fractionability** — only now, once the trade is actually going ahead, to avoid
   a wasted API call on a rejected order.
6. **Route:**
   - **Notional path** (also taken whenever the order was clamped): cap at buying power,
     round to 2dp, reject below $1. Fractionable → notional order. Non-fractionable →
     `floor(notional / price)` whole shares.
   - **Share-count path** (unclamped only): round to 9dp if fractionable, else floor to an
     integer; verify buying power covers the cost; place a `qty` order.
7. **Increment `buysThisSession`** — only after a successful submission, so a rejected
   order doesn't consume the turnover budget.
8. **Return the outcome**, appending the clamp note if there was one, so the model can
   re-plan the rest of its session around a smaller fill.

Note that a clamp reroutes a share-count request onto the notional path. That's correct:
once the dollar amount changes, the requested share count is no longer what the agent
asked for, and dollars are the more faithful expression of the reduced intent.

### `sell(ticker, shares)`

Long positions only (a negative quantity returns "No long position … to sell").

The subtle part is **exit tolerance** ([`src/agent.ts:920`](src/agent.ts:920)):

```ts
const exitTolerance = Math.max(1e-6, owned * 1e-4);
if (Math.abs(shares - owned) <= exitTolerance) shares = owned;
else if (shares > owned) return `Not enough shares …`;
```

Why this exists: fractional quantities don't round-trip cleanly through JSON serialization
and display rounding. The model reads `0.043 shares`, asks to sell `0.043`, and the true
holding is `0.0430000012` — or vice versa, and the order is rejected as "not enough
shares." The agent then believes it closed a position it still holds. Snapping a
near-exact request to the true size (relative tolerance, 1bp, with an absolute floor)
turns an intended full exit into an actual full exit. This is precisely the class of bug
that only appears in production with real fractional fills.

### `short_sell(ticker, shares)` / `cover_short(ticker, shares)`

Whole shares only — Alpaca supports neither fractional nor notional sizing on the short
side. `short_sell` enforces the $40k equity minimum and the 50% Reg T margin check, and
its response ends with `WARNING: unlimited loss potential.` `cover_short` verifies a short
actually exists (`qty < 0`) and that you're not over-covering.

Unreachable on a ~$100 account, by design.

### `get_stock_news(symbol)`

See [§9](#9-news-and-sentiment).

---

## 8. Market data: where prices come from

`getStockPrice` ([`src/agent.ts:177`](src/agent.ts:177)) tries two sources in order:

1. **Alpaca latest quote** → `(bid + ask) / 2`, rounded to cents. Primary because it's the
   same venue that will fill the order.
2. **Yahoo Finance** `query1.finance.yahoo.com/v8/finance/chart/<SYM>` →
   `meta.regularMarketPrice`. Unauthenticated, undocumented, free.

If both fail it **throws**: `Could not fetch a price for <SYM>`. That throw is caught by
`executeTool` and surfaced to the model as a string.

**Throwing here is the correct behavior**, and the contrast with the legacy code makes the
point. [`src/trading.ts:100`](src/trading.ts:100) has a third tier: a hardcoded table of
stale prices (`'AAPL': 224.50`), and for unknown symbols
`50 + Math.random() * 200` — **a random number**. A trading system that invents a price
when it can't find one will size a real order off fiction. The live agent has no such
path. (The legacy tier is reachable only through `npm run dashboard`.)

---

## 9. News and sentiment

`get_stock_news` ([`src/agent.ts:506`](src/agent.ts:506)) queries Finnhub's
`company-news` endpoint for the last 7 days, takes up to 8 articles, and scores each.

### The sentiment scorer

Finnhub's real sentiment endpoint is a paid feature, so the code implements a **keyword
bag-of-words scorer** ([`src/agent.ts:473`](src/agent.ts:473)): ~30 bullish words
(`surge`, `beat`, `upgrade`, `record`) against ~35 bearish (`plunge`, `miss`, `downgrade`,
`lawsuit`, `probe`, `fraud`, `layoffs`). +1 per bullish hit, −1 per bearish, over headline
plus summary, then squashed:

```ts
return Math.max(-1, Math.min(1, score / Math.max(2, hits)));
```

The `Math.max(2, hits)` divisor is the interesting bit: a single strong word yields ±0.5,
two aligned words saturate at ±1.0, and mixed coverage cancels toward zero. Labels come
from a ±0.15 dead band → `bullish` / `bearish` / `neutral`
([`src/agent.ts:500`](src/agent.ts:500)).

**Be honest about what this is.** It's a crude heuristic with no notion of negation
("*failed to* beat"), sarcasm, subject ("Apple *sues* Samsung" scores bearish for both),
or magnitude. It's a cheap, dependency-free, zero-cost directional hint, and both the
per-article scores *and* the raw headlines go to the model — so the LLM can override the
keyword score by actually reading the text. That layering is what makes a weak signal
acceptable: it's an input, not a decision.

### Graceful degradation

Every failure mode returns a plain descriptive string rather than throwing: no API key,
HTTP 429, non-OK status, empty array, network error. The model always gets an answer it
can reason about.

---

## 10. Resilience: retries, backoff, fail-open

`withRetry` ([`src/agent.ts:121`](src/agent.ts:121)) wraps every network call — Alpaca and
Gemini alike. Five attempts, **exponential backoff with jitter**:

```ts
const waitMs = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
// 2s, 4s, 8s, 16s (+ up to 1s random)
```

Only **429** (rate limit) and **5xx** (server error) retry. A 4xx like "insufficient
buying power" or "invalid symbol" is a permanent answer — retrying it wastes time and, on
an order endpoint, risks duplicate submissions.

The **jitter** matters more than it looks: with 13 scheduled sessions and multiple
concurrent calls, synchronized retries create a thundering herd that re-triggers the same
rate limit. Randomizing spreads them out.

`getStatusCode` ([`src/agent.ts:114`](src/agent.ts:114)) checks `error.status`, then
`error.response.status`, then regex-matches a 3-digit number out of the message — because
the Alpaca SDK, the OpenAI SDK, and raw `fetch` all report status differently.

### The layered failure philosophy

| Failure | Response | Why |
|---|---|---|
| Missing credentials | Throw at startup | Fail fast before touching the network |
| Non-paper Alpaca URL | Throw at startup | Never risk real money |
| Alpaca unreachable | `exit(1)` | Can't trade blind |
| Market closed | `return`, exit 0 | Normal, not an error |
| Portfolio history down | **Fail open** — breaker inactive | An outage shouldn't freeze trading; 4 other limits still bind |
| Fractionability check fails | Assume whole-share | Integer qty always accepted |
| Alpaca quote fails | Fall back to Yahoo | Redundancy |
| Both price sources fail | Throw → string to model | Never invent a price |
| Automatic close fails | Escalate to the model as its first task | Code first, model as backup |
| Any tool throws | Return `"Tool X failed: …"` | Model reacts; run survives |
| Bad tool-call JSON | Warn, pass `{}` | Tool validation produces the message |
| Invalid `RISK_*` value | Use the default | Never degrade to unlimited |

Note that the direction of each fallback is chosen against the *consequence* of being
wrong, not for uniformity. Some failures fail closed (credentials, live endpoint), some
fail open (drawdown history), some fail conservative (fractionability). That's what
thinking about failure modes individually looks like.

---

## 11. Scheduling: how it runs unattended

[`.github/workflows/trading-agent.yml`](.github/workflows/trading-agent.yml) — GitHub
Actions cron, **13 sessions per trading day**:

```yaml
- cron: "41 9 * * 1-5"          # 9:41 ET
  timezone: "America/New_York"
- cron: "11,41 10-15 * * 1-5"   # :11 and :41, 10:00–15:59 ET
  timezone: "America/New_York"
```

Design notes visible in the file:

- **`timezone:`** handles EDT/EST automatically. Without it you'd hand-shift UTC offsets
  twice a year — a classic source of a bot silently trading an hour off after a DST
  change.
- **Odd minutes (`:11`, `:41`)** dodge GitHub's `:00`/`:15`/`:30` cron congestion, where
  scheduled jobs queue behind everyone else's and can be delayed many minutes.
- **`9:41` not `9:30`** skips the opening auction, where spreads are widest and prices
  most erratic.
- **`permissions: contents: read`** — least privilege, possible only because the agent is
  stateless and never commits back.
- **`concurrency: { group, cancel-in-progress: false }`** — a delayed run won't overlap the
  next, and an in-flight session is allowed to finish rather than being killed mid-order.
  Cancelling a session between "order submitted" and "log written" is the worst possible
  moment.
- **`timeout-minutes: 10`** bounds a hung session.
- **Logs uploaded as an artifact** with `if: always()` and 30-day retention — the only
  record that survives the ephemeral runner.

Secrets required: `GEMINI_API_KEY`, `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`,
`FINNHUB_API_KEY`, optionally `ALPACA_BASE_URL`.

---

## 12. Testing

```bash
npm test                    # all tests
npm run test:coverage       # + coverage report to coverage/
npx jest tests/risk.test.ts # just the risk engine
npm run build               # tsc --noEmit — typecheck only
```

**[`tests/risk.test.ts`](tests/risk.test.ts) is the one to care about.** 294 lines against
the pure risk functions, using a `baseRequest()` factory so each test varies exactly one
input. It covers config fallbacks (unparseable, zero, negative, empty), exit thresholds
and their boundaries, drawdown edge cases, and each `vetBuy` rule plus the clamp
arithmetic. This is only possible *because* `risk.ts` is pure — and it's a good argument
for the architecture: the rules that must never be wrong are also the rules that are
trivially testable.

The other suites are legacy. `trading.test.ts` and `trading-simple.test.ts` test the
orphaned `TradingService`; `agents.test.ts` shells out to the agent and reads its source as
text. [`tests/setup.ts`](tests/setup.ts) mocks `fetch`, `fs`, `chalk`, and injects fake
credentials so nothing real is ever called; [`tests/mocks/`](tests/mocks) holds Alpaca and
Yahoo response fixtures.

---

## 13. Running it yourself

```bash
npm install
cp .env.example .env
# fill in GEMINI_API_KEY, ALPACA_API_KEY, ALPACA_SECRET_KEY, FINNHUB_API_KEY
```

Keys: Gemini at [aistudio.google.com/apikey](https://aistudio.google.com/apikey), Alpaca
paper at [app.alpaca.markets/paper](https://app.alpaca.markets/paper/dashboard/overview),
Finnhub free at [finnhub.io](https://finnhub.io).

One session (during market hours):

```bash
npm start
```

Force a session outside market hours:

```bash
TESTING_MODE=true npx tsx src/agent.ts
```

Interactive dashboard (legacy; also needs `OPENAI_API_KEY`):

```bash
npm run dashboard
```

Watch the log:

```bash
tail -f results/gemini/agent-gemini.log
```

Emoji prefixes make it greppable: 🧠 reasoning, 🛠️ tool call, 💰 buy, 💸 sell,
🛡️ risk engine, ⚠️ warning, ❌ error, 🤖 the model's final prose.

---

## 14. Known staleness and gotchas

Real inconsistencies in the repo as it stands. Nothing here is broken *trading* logic
(with one exception noted), but each will mislead you.

### Documentation that describes a system that no longer exists

**[`CLAUDE.md`](CLAUDE.md)** documents the previous architecture almost entirely. It
claims the project uses OpenAI's Agents framework and GPT-5/GPT-5-mini (it uses Gemini via
the `openai` SDK); documents `npm run start:continuous`, `start:continuous:1h`,
`start:continuous:4h`, `trade-once`, `test:agents`, `test:trading` (only some exist —
`start:continuous*` does not); describes `thread.json` persistence, corruption detection,
and thread trimming (all removed); describes CSV P&L reports, `updateReadme()`,
`generateCSVReport()`, `calculateCAGR()` in the agent (none exist in `agent.ts`); says the
account starts with $100,000 (it holds ~$100); and never mentions the risk engine, which
is now the most important part of the system. **Read the source, not `CLAUDE.md`.**

**[`README.md`](README.md)** contains a single `.` character.

### Turn count mismatch

[`system-prompt.md:52`](system-prompt.md:52) tells the model *"Your session will terminate
after 6 turns"*, and line 51 says *"6 API calls or fewer"* — but line 72 is headed
`(EFFICIENT 8-TURN PATTERN)` and the code's `maxTurns` is **8**
([`src/agent.ts:1038`](src/agent.ts:1038)). Understating the budget is the safe direction
to be wrong (the model wraps up early rather than getting cut off mid-trade), but the
prompt contradicts itself and neither number is the real one.

### Docker is broken

Both [`Dockerfile`](Dockerfile) (`CMD ["npm", "run", "start:continuous"]`) and all three
[`docker-compose.yml`](docker-compose.yml) services reference `npm run start:continuous`,
which doesn't exist in `package.json`. The container will exit immediately. The compose
file also expects `.env.gpt5mini` / `.env.gpt5` profiles from the old OpenAI setup. The
`HEALTHCHECK` greps for a long-running `agent.ts` process, which contradicts the
single-session model entirely — Docker here was designed for a continuous-loop agent that
no longer exists.

### Random fallback prices in the legacy service

[`src/trading.ts:117`](src/trading.ts:117):

```ts
const fallbackPrice = mockPrices[ticker.toUpperCase()] || (50 + Math.random() * 200);
```

If both real price sources fail, this returns a **random number** — or a hardcoded stale
price — and `buyStock`/`sellStock` will size a real paper order off it. Not reachable from
`agent.ts`, but reachable from `npm run dashboard`. This is the one genuinely dangerous
line in the repo.

### Market holidays aren't handled

`isMarketOpen` ([`src/agent.ts:158`](src/agent.ts:158)) checks only weekday and clock
time. On Thanksgiving, Christmas, July 4th, and early-close days it will start a session
and let Alpaca reject the orders. Harmless but noisy. Alpaca exposes a
`getClock()` / calendar endpoint that would fix this properly.

### Intra-session risk is unmonitored

The exit sweep runs **once**, at session start. A position that blows through its stop
five minutes later isn't caught until the next session — up to 30 minutes of unmanaged
exposure, or overnight and through the weekend after the last session of the week. Alpaca
supports native bracket/stop orders that would hold continuously; they're unavailable on
fractional positions, which is the same constraint that ruled out trailing stops
([`src/risk.ts:83`](src/risk.ts:83)).

### `MIN_NOTIONAL` is defined twice

[`src/agent.ts:405`](src/agent.ts:405) and [`src/risk.ts:11`](src/risk.ts:11) both declare
`MIN_NOTIONAL = 1`. `agent.ts` imports six things from `risk.js` but not this one. Harmless
today; a silent divergence waiting to happen.

### A Finnhub key is sitting in `.claude/settings.local.json`

That file contains a literal API key inside an allow-listed command string. It is
**untracked but not gitignored**, so a `git add .` would stage it. Worth adding `.claude/`
(or that file) to `.gitignore` and rotating the key.

### Unused dependencies

`package.json` lists `@openai/agents` and `litellm`; neither is imported anywhere in
`src/`. `zod` is used only by the legacy `trading.ts` / `trading-simple.ts`.

### Sentiment scoring is naive

No negation handling, no subject attribution, no magnitude. See [§9](#9-news-and-sentiment)
— mitigated by passing raw headlines to the model alongside the score, but don't mistake
the number for analysis.

### Session-scoped counters reset every run

`buysThisSession` ([`src/agent.ts:104`](src/agent.ts:104)) is module state, reset each
process. With 13 sessions/day × 4 buys, the *daily* ceiling is 52 buys. The 4-buy cap
limits churn within a session, not across the day. If daily turnover is the concern, this
needs a different mechanism.

---

## 15. How to change common things

| Goal | Where |
|---|---|
| Loosen/tighten stops, caps, reserve | `RISK_*` env vars, or `DEFAULT_RISK_CONFIG` at [`src/risk.ts:28`](src/risk.ts:28) |
| Change trading style, strategy, tone | [`system-prompt.md`](system-prompt.md) — read fresh each session, no code change |
| Add a tool | Add the JSON schema to the `tools` array ([`src/agent.ts:579`](src/agent.ts:579)), then a `case` in `executeTool` ([`src/agent.ts:718`](src/agent.ts:718)). Return a string; never throw. Document it in `system-prompt.md` too or the model won't use it well. |
| Change the model | `MODEL` env var. A different provider needs a new `GEMINI_BASE_URL` + key. |
| Change the schedule | The `cron` entries in [`.github/workflows/trading-agent.yml`](.github/workflows/trading-agent.yml). Keep `timezone:`. |
| Add a risk rule | A pure function in [`src/risk.ts`](src/risk.ts) + tests in [`tests/risk.test.ts`](tests/risk.test.ts), then wire it into `vetBuy` or the sweep. Keep it pure. |
| More/fewer turns | `maxTurns` at [`src/agent.ts:1038`](src/agent.ts:1038) — and fix the prompt to match. |
| Handle market holidays | Replace `isMarketOpen` ([`src/agent.ts:158`](src/agent.ts:158)) with Alpaca's `getClock()`. |
| Debug a session | `TESTING_MODE=true npx tsx src/agent.ts`, then read `results/gemini/agent-gemini.log`. |

### If you extend this, in rough priority order

1. **Rewrite `CLAUDE.md` and `README.md`** to match reality. Everything else in this list
   is easier once the docs stop lying.
2. **Delete or quarantine the legacy files** — `trading.ts`, `logger.ts`,
   `error-handler.ts`, `trading-simple.ts`, and their tests. Especially the random price
   fallback.
3. **Fix or delete the Docker setup.**
4. **Reconcile the turn count** between prompt and code.
5. **Add holiday awareness** via Alpaca's clock.
6. **Consider intra-session risk** — a mid-session sweep, or native stop orders if you
   move back to whole shares.

---

## Appendix: reading a real session

From [`results/gemini/agent-gemini.log`](results/gemini/agent-gemini.log), a session
recorded *before* the fractional-order and risk-engine work landed. It's the best
available illustration of what those changes were for:

```
✅ Alpaca paper account … — status ACTIVE, buying power $86.48
🚀 Starting Gemini trading session
🛠️  Tool: think({…})
🧠 My cash balance is very low ($86.48), so I need to be extremely cautious…
🧠 Given the small capital, I will likely focus on … a low-priced stock…
🛠️  Tool: get_stock_price({"ticker":"F"})
✅ Price for F: $13.5 (Alpaca)
🛠️  Tool: sell({"ticker":"F","shares":1})
💸 SELL 1 F — order … (pending_new)
🛠️  Tool: get_stock_price({"ticker":"AMC"})
✅ Price for AMC: $1.94 (Alpaca)
🧠 I will buy 4 shares of AMC, as it is a low-priced stock and I can afford it…
💰 BUY 4 AMC — order … (pending_new)
```

Every pathology the later commits address is visible here. The agent reasons *"low-priced
stock … I can afford it"* — whole-share arithmetic pushing it into AMC, a stock whose
percentage spread is enormous. It sells a reasonable holding (Ford) purely to raise cash
for it. An earlier session in the same file ends with the model refusing to trade at all,
insisting there had been *"a significant error in the portfolio initialization"* because
$100 didn't match the $100,000 it expected.

The three commits that follow fix each one directly: notional orders and explicit
anti-cheap-stock instructions; a system prompt stating that ~$100 is correct and expected,
not a bug; and per-position P&L so exits are managed on merit rather than on which holding
happens to be sellable. Reading this log next to the current `system-prompt.md` is the
fastest way to understand why that file says what it says.
