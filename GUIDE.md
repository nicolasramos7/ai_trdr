# Deep Guide to `llm_trader`

A complete walkthrough of what this repo is, how it runs, the financial concepts it
encodes, why it is built the way it is, and where the sharp edges are.

Accurate as of commit `6da54b0` (`src/agent.ts` = 1111 lines, `src/risk.ts` = 290 lines).
Line references are clickable.

---

## Table of contents

1. [The one-paragraph mental model](#1-the-one-paragraph-mental-model)
2. [Repo map](#2-repo-map)
3. [Financial concepts glossary](#3-financial-concepts-glossary)
4. [Configuration and startup](#4-configuration-and-startup)
5. [The session lifecycle, step by step](#5-the-session-lifecycle-step-by-step)
6. [The risk engine in depth](#6-the-risk-engine-in-depth)
7. [Tool-by-tool reference](#7-tool-by-tool-reference)
8. [Market data: where prices come from](#8-market-data-where-prices-come-from)
9. [News and sentiment](#9-news-and-sentiment)
10. [Resilience: retries, backoff, fail-open](#10-resilience-retries-backoff-fail-open)
11. [Workflows: how it runs unattended](#11-workflows-how-it-runs-unattended)
12. [Testing](#12-testing)
13. [Running it yourself](#13-running-it-yourself)
14. [Known gotchas and unhandled cases](#14-known-gotchas-and-unhandled-cases)
15. [How to change common things](#15-how-to-change-common-things)
16. [Appendix: reading a real session log](#16-appendix-reading-a-real-session-log)

---

## 1. The one-paragraph mental model

An LLM (Google Gemini 2.5 Flash) is handed a set of trading tools and told to grow a small
**paper trading** account. Every ~30 minutes during US market hours, a GitHub Actions cron
job starts a fresh Node process. That process runs **exactly one trading session** and
exits. Before the model gets a single turn, a **deterministic risk engine written in plain
TypeScript** sweeps the portfolio and force-closes any position past its stop-loss or
take-profit. Then the model gets up to 8 turns of tool calls to analyse and trade. Every
buy it proposes is re-vetted by that same engine, which may shrink or refuse it. No state
is stored locally — the portfolio *is* whatever Alpaca says it is.

The governing design principle, stated in [src/risk.ts:8](src/risk.ts:8):

> **The agent proposes, this layer disposes.**

The LLM decides *what* to trade. Code decides *how much* and *when to get out*. That split
is the whole architecture. An LLM can be talked out of its own rules — by its own
reasoning, by a dramatic headline, by a hallucination about how much money it has. Pure
functions cannot.

```
GitHub Actions cron (13×/day, weekdays, America/New_York)
        │
        ▼
   node src/agent.ts  ──── one session, then exit
        │
        ├─ 1. verify Alpaca paper credentials         (exit 1 on failure)
        ├─ 2. market-hours gate                       (exit 0 if closed)
        ├─ 3. EXIT SWEEP   ← risk engine force-closes stops/targets
        ├─ 4. build risk briefing → injected into the model's first message
        ├─ 5. LLM loop (≤8 turns): think → look → trade
        │        every `buy` passes through vetBuy() before reaching Alpaca
        └─ 6. log everything to results/gemini/agent-gemini.log, exit
```

Two hard guard rails exist before any of that: missing credentials throw at import time
([src/agent.ts:42](src/agent.ts:42)), and a non-paper Alpaca URL throws outright
([src/agent.ts:51](src/agent.ts:51)). The program cannot be misconfigured into trading real
money.

---

## 2. Repo map

The repo is deliberately small. An earlier OpenAI-era stack (a `TradingService` class, a
terminal dashboard, a structured logger, an error-classification layer, a Docker setup) was
deleted in commit `fc09d9f`. What remains is everything that runs.

### Live code

| File | Lines | Role |
|---|---|---|
| [src/agent.ts](src/agent.ts) | 1111 | **Everything runtime.** Config, Alpaca client, Gemini client, market data, news, tool schemas, tool execution, the agent loop, logging. Imports only `risk.js` from the project. |
| [src/risk.ts](src/risk.ts) | 290 | The deterministic risk and exit engine. Pure functions, no I/O. |
| [system-prompt.md](system-prompt.md) | 123 | The model's standing instructions, read fresh from disk each session. |
| [.github/workflows/trading-agent.yml](.github/workflows/trading-agent.yml) | 63 | The actual scheduler. |
| [tests/risk.test.ts](tests/risk.test.ts) | 294 | 39 tests over the risk engine. |

### Supporting files

| File | Role |
|---|---|
| [.env.example](.env.example) | Every environment variable, documented. Copy to `.env`. |
| [package.json](package.json) | 4 runtime deps: `@alpacahq/alpaca-trade-api`, `dotenv`, `openai`, `tiny-invariant`. |
| [jest.config.js](jest.config.js) | ts-jest in ESM mode; only `tests/**/*.test.ts` runs. |
| [tsconfig.json](tsconfig.json) | `strict`, ESM, `noEmit` — `tsx` runs TypeScript directly, nothing is compiled to disk. |
| [README.md](README.md) | Short project summary + attribution. |
| [CLAUDE.md](CLAUDE.md) | **Stale.** Describes the deleted OpenAI architecture. See [§14](#14-known-gotchas-and-unhandled-cases). |
| [.github/workflows/claude.yml](.github/workflows/claude.yml), [claude-code-review.yml](.github/workflows/claude-code-review.yml) | Developer-tooling workflows (@claude mentions, automated PR review). Nothing to do with trading. |
| `results/<profile>/agent-<profile>.log` | Append-only session log. Gitignored. |

**Practical consequence:** to change trading behaviour you edit `src/agent.ts`,
`src/risk.ts`, or `system-prompt.md`. Nothing else affects what the bot does.

There is no build step, no database, no local portfolio file, no conversation store.

---

## 3. Financial concepts glossary

Every concept the code actually relies on, in plain terms, paired with the code that uses
it. If you read only one section, read this one — most of the design decisions in the repo
are downstream of these facts.

### Paper trading

A simulated brokerage account: fake money, real market data. Alpaca fills your orders
against its own simulation engine at realistic prices, so you get a faithful rehearsal of
execution without financial risk.

The code refuses to be anything else ([src/agent.ts:51](src/agent.ts:51)):

```ts
if (!/paper-api\.alpaca\.markets/.test(ALPACA_BASE_URL)) {
  throw new Error(`Refusing to run: ... is not the paper endpoint.`);
}
```

That is a hard failure at startup, not a warning. Even a mis-set CI secret cannot route an
order to live trading. The Alpaca client is *also* constructed with `paper: true`
([src/agent.ts:88](src/agent.ts:88)) — belt and braces.

### Bid, ask, spread, and mid price

- **Bid** — the highest price a buyer will currently pay.
- **Ask** — the lowest price a seller will currently accept.
- **Spread** — ask minus bid. The market maker's cut for standing ready to trade with you.
  You buy at the ask and sell at the bid, so a round trip costs you the spread *even if the
  price never moves*.
- **Mid** — `(bid + ask) / 2`. Not a price you can actually transact at; it is the fairest
  single-number estimate of "what is this worth right now."

The code prices everything at the mid ([src/agent.ts:188](src/agent.ts:188)):

```ts
const mid = (quote.BidPrice + quote.AskPrice) / 2;
```

**Why the spread drives real design decisions here.** For a liquid megacap like AAPL the
spread is roughly 0.01% of the price. For a $2 speculative name it can be 0.5% or worse —
fifty times more expensive per round trip. On a ~$100 account making several round trips a
day, spread cost alone can swamp any edge the model might have. That single fact explains
two otherwise-odd rules:

1. [system-prompt.md:9](system-prompt.md:9) tells the model to **actively avoid** stocks
   under ~$10/share.
2. [src/risk.ts:223](src/risk.ts:223) caps buys per session — *"excessive turnover loses
   more to spread than it gains."*

### Market order vs. limit order

- **Market order** — "fill me now at whatever the going price is." Guaranteed execution,
  no guaranteed price.
- **Limit order** — "fill me only at $X or better." Guaranteed price, no guaranteed
  execution.

This bot uses **market orders exclusively** ([src/agent.ts:424](src/agent.ts:424),
`type: "market"`). That is a deliberate simplicity trade: the agent runs in short bursts
and cannot babysit a resting limit order between sessions. A limit order that never fills
is worse than a market order that fills a cent wide, given the agent may not look at the
book again for 30 minutes.

### Time in force: `day` vs `gtc`

How long an unfilled order stays alive.

- **`day`** — cancelled automatically at the close if unfilled.
- **`gtc`** ("good till cancelled") — stays open indefinitely across sessions.

The code always uses `day` ([src/agent.ts:427](src/agent.ts:427)), for two reasons stated
in the comment above it:

1. **Required:** Alpaca rejects `gtc` on fractional and notional orders.
2. **Safer anyway:** a GTC market order placed near the close can rest overnight and fill
   into a **gap** — a price jump between one day's close and the next day's open, caused by
   after-hours news. You would be filled at a price nobody was quoting when you decided to
   trade.

### Order lifecycle and statuses

An Alpaca order returns immediately with a status like `pending_new`, `new`, `accepted`,
`partially_filled`, `filled`, `rejected`, or `canceled`. The logs in this repo mostly show
`pending_new` — **submission is not a fill**. The agent submits and moves on; the fill
lands milliseconds to seconds later, and it only ever sees the *consequence* in the next
`get_portfolio` call (or the next session).

This is why `getPortfolio()` filters trade history on `order.filled_at`
([src/agent.ts:305](src/agent.ts:305)) — an unfilled or rejected order is not a trade and
must not appear as one.

### Shares (`qty`) vs. dollars (`notional`)

Two ways to size the same order:

- **`qty`** — "buy 3 shares." Dollar cost depends on the share price.
- **`notional`** — "buy $30 worth." Share count depends on the share price, and usually
  comes out fractional.

The bot **prefers notional for buys** ([src/agent.ts:633](src/agent.ts:633)), and the
system prompt hammers the point:

> $30 of a $700 stock buys you 0.043 shares. A high share price is NEVER a reason to skip a
> stock.

**Why this matters more than it sounds.** A share price is an arbitrary number: market cap
divided by share count. A $3 stock does not have "more room to grow" than a $300 stock — a
1% move is 1% either way. But an LLM sizing a $100 account *in whole shares* gets pushed
toward penny stocks purely by arithmetic: it cannot afford one share of SPY at $745, so it
buys 50 shares of a $2 company instead. That is exactly what happened before the fix — see
the log excerpt in [§16](#16-appendix-reading-a-real-session-log), where the agent sold Ford
in order to load up on AMC because AMC was "affordable."

Notional orders sever the link between share price and affordability. The agent can then
judge companies on quality, and a $100 account can diversify across several names in
$20–30 slices instead of being forced all-in on one cheap ticker.

### Fractional shares

Owning 0.043 of a share. Not every asset supports it. The code checks per symbol via
Alpaca's asset endpoint and caches the answer for the session
([src/agent.ts:437](src/agent.ts:437)). On failure it **assumes whole-share-only**, because
an integer quantity is always accepted while a rejected fractional order loses the trade
entirely.

If a dollar budget lands on a non-fractionable asset, the code converts:
`Math.floor(notional / price)` ([src/agent.ts:856](src/agent.ts:856)). If that rounds to
zero shares, it tells the model plainly to pick another ticker or raise the amount rather
than failing silently.

Fractional trading also comes with restrictions that ripple through the design: day orders
only, market/limit only, no trailing stops, no shorting. Several "why doesn't it just…"
questions about this repo answer to that list.

### Long vs. short

- **Long** — you own the asset. You profit when it rises. Maximum loss is 100% (it goes to
  zero).
- **Short** — you borrow shares, sell them now, and must buy them back later ("cover").
  You profit when it *falls*. Maximum loss is **unbounded**: there is no ceiling on how
  high a price can go, so there is no floor on your loss.

The code models a short as a **negative quantity**
([src/agent.ts:293](src/agent.ts:293)): `side: shares < 0 ? "short" : "long"`. A short
position also carries a **negative market value**, which is why the money formatter
([src/agent.ts:708](src/agent.ts:708)) is written to render `-$480.00` readably rather than
forcing a `+`.

Alpaca requires **$40,000 equity** to short, enforced up front
([src/agent.ts:941](src/agent.ts:941)). On a ~$100 account `short_sell` and `cover_short`
are therefore permanently unreachable. They exist for a larger account, and the tool
description ends with `WARNING: unlimited loss potential.`

### Margin, buying power, and Regulation T

**Buying power** is how much you can actually deploy. On a margin account it exceeds your
cash, because the broker lends against your collateral (typically 2× for overnight
positions, 4× intraday for pattern day traders).

For shorts, US **Regulation T** requires you to post 50% of the position's value as margin.
The code checks exactly that ([src/agent.ts:948](src/agent.ts:948)):

```ts
if (buyingPower < orderValue * 0.5) { /* reject */ }
```

Note the subtlety that the risk engine's cash reserve is computed against **cash**
([src/risk.ts:233](src/risk.ts:233)) while the final order size is capped by **buying
power** ([src/agent.ts:830](src/agent.ts:830)). On a margin account those differ, and the
cash-based test is the conservative one — deliberately so.

### Cash vs. equity (net worth)

- **Cash** — uninvested dollars sitting in the account.
- **Equity** / **portfolio value** / **net worth** — cash **plus** the current market value
  of every position. This is the number that tells you whether you are winning.

Both come straight from Alpaca ([src/agent.ts:322](src/agent.ts:322)):
`cash: num(account.cash)`, `equity: num(account.portfolio_value)`.

Keeping them distinct is essential to the risk rules: the **cash reserve** is a percentage
of *equity* but must be satisfied out of *cash*. Hold $100 of stock and $2 of cash and you
have plenty of equity but nothing deployable — which is precisely the situation the reserve
rule exists to prevent you from reaching.

### Unrealized vs. realized P&L

- **Unrealized** — paper gain or loss on a position you still hold. It can evaporate.
- **Realized** — locked in by closing the position. Real.

Alpaca reports `unrealized_plpc` as a **fraction** (0.0772 means +7.72%), and the code
scales it to percent at exactly one place ([src/agent.ts:299](src/agent.ts:299)) so the
risk engine and the display can never disagree:

```ts
unrealizedPlPct: num(position.unrealized_plpc) * 100,
```

Getting that factor of 100 wrong in one of two places would mean a stop-loss that fires at
-700% (never) or -0.07% (constantly). Normalising once, at the boundary, is why it is
right.

**Average entry price** is the volume-weighted average of what you paid across all your
buys in a name — the reference point unrealized P&L is measured from. It is also the
closest thing this stateless agent has to a memory of its own decisions.

P&L is always rendered with an explicit sign ([src/agent.ts:700](src/agent.ts:700)) so the
model can never misread a loss as a gain from formatting alone.

### Stop-loss and take-profit

- **Stop-loss** — an automatic exit once a position is down X%. Caps the damage from a
  thesis that turned out to be wrong. Default here: **-7%**.
- **Take-profit** — an automatic exit once a position is up X%. Locks in the win before it
  gives it back. Default here: **+15%**.

The 7/15 asymmetry gives a **reward:risk ratio** of roughly 2:1. Why that matters: with a
2:1 payoff you only need to be right about 34% of the time to break even. The ratio is
doing work that stock-picking skill would otherwise have to do.

**Trailing stop** — a stop that ratchets upward as the price rises, protecting profit while
letting winners run. [src/risk.ts:83](src/risk.ts:83) explains why it is deliberately *not*
used, and the reasoning is worth reading: a trailing stop needs a per-position high-water
mark, the agent keeps no state between runs, and Alpaca's native trailing-stop orders do
not work on fractional positions. Two independent constraints, same conclusion.

### Drawdown and the high-water mark

**Drawdown** is how far below its all-time peak the account currently sits, in percent. It
is the standard measure of "how bad has this gotten," and it is what actually ends trading
accounts — not a single bad day, but a slide that keeps being averaged down into.

```
drawdown% = (peak − current) / peak × 100      — floored at zero
```

A new all-time high is a **0%** drawdown, not a negative one — hence the `Math.max(0, …)`
in [src/risk.ts:136](src/risk.ts:136).

The **peak** (high-water mark) is reconstructed from Alpaca's own 3-month daily equity
curve ([src/agent.ts:338](src/agent.ts:338)), because the bot stores nothing locally.
Current equity is folded into the max so a fresh high counts immediately, before it lands
in the history series.

Drawdown drives the **circuit breaker**: past 15% below peak, all new buys stop. Selling
never stops. That asymmetry is the entire point — stop *adding* risk while losing, without
ever trapping the agent in something it needs to exit.

### Position sizing, concentration, diversification

- **Concentration** — how much of your account sits in a single name. High concentration
  means one bad earnings report can take out the whole account.
- **Diversification** — spreading across names so no single failure is fatal.

Enforced as a hard cap: no position may exceed **25% of equity**
([src/risk.ts:244](src/risk.ts:244)). On a $100 account that is $25 per name, which forces
at least four positions if fully deployed. Fractional orders are what make this feasible at
all — without them a $100 account physically could not buy $25 slices of quality stocks.

Note the cap is computed on `Math.abs(market_value)` ([src/agent.ts:791](src/agent.ts:791)),
so a short position counts toward concentration too.

### Turnover and churn

**Turnover** is how much you trade. **Churn** is trading for its own sake. Every round trip
pays the spread, so high turnover is a guaranteed, compounding cost levied against an
uncertain edge. Capped at **4 buys per session** ([src/risk.ts:223](src/risk.ts:223)) —
and note it counts *buys only*. Exits are never rate-limited.

### Liquidity

How easily you can trade size without moving the price. Liquid names have tight spreads and
deep order books; illiquid ones punish you on entry *and* exit. For a bot that must be able
to exit on demand when a stop triggers, liquidity is a risk control, not a preference —
which is why the system prompt keeps steering toward it.

### Market hours, the opening auction, and gaps

US equities trade **9:30 AM – 4:00 PM ET on weekdays**. Outside those hours quotes are
stale and market orders do not fill sensibly, so [src/agent.ts:159](src/agent.ts:159) gates
the entire session:

```ts
const day = nowEt.getDay();
if (day === 0 || day === 6) return false;
const minutes = nowEt.getHours() * 60 + nowEt.getMinutes();
return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
```

`TESTING_MODE=true` bypasses this so a session can be exercised at any hour.

The **opening auction** (the first few minutes after 9:30) has the widest spreads and the
most erratic prices of the day, as overnight orders clear. That is why the cron schedule
starts at **9:41**, not 9:30. A **gap** is the price jump between one session's close and
the next session's open — the reason no order is ever left resting overnight.

Not handled: **market holidays and early closes**. See [§14](#14-known-gotchas-and-unhandled-cases).

### Pattern day trading and settlement (context, not code)

Two real-world rules this repo does not model, worth knowing because they would bite a live
version:

- **PDT rule** — a margin account under $25,000 that makes 4+ day trades (buy and sell the
  same name on the same day) in 5 business days gets flagged and restricted. With 13
  sessions a day on a ~$100 account, a live equivalent of this bot would trip that
  immediately.
- **T+1 settlement** — in a *cash* account, proceeds from a sale take a business day to
  settle, and spending unsettled cash causes a good-faith violation. Margin accounts do not
  have this problem, which is one reason Alpaca paper accounts are margin accounts.

Neither is enforced or simulated here. On paper it costs nothing; it is a real gap between
this and a live system.

### CAGR

**Compound Annual Growth Rate** — the annualised return that would take you from a starting
value to a current value:

```
CAGR = (current / start)^(1 / years) − 1
```

The current code does not compute it (an earlier version did). Worth knowing anyway,
because it is the number people reach for when evaluating a bot like this, and over short
windows it is meaningless in the extreme: a 1% gain in one day annualises to over 3,000%.
Judging a strategy on a handful of sessions is noise, which is why [README.md](README.md)
says so explicitly.

---

## 4. Configuration and startup

Everything comes from the environment; nothing is hardcoded. Load order
([src/agent.ts:30](src/agent.ts:30)):

1. `config()` — loads `.env`.
2. If `.env.gemini` exists, load it with `override: true` — the profile file wins.

### Required

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio key (free tier available) |
| `ALPACA_API_KEY` | Alpaca **paper** key ID |
| `ALPACA_SECRET_KEY` | Alpaca paper secret |

Missing any of these fails immediately via `tiny-invariant`
([src/agent.ts:42](src/agent.ts:42)) — before a single network call.

### Optional

| Variable | Default | Notes |
|---|---|---|
| `MODEL` | `gemini-2.5-flash` | Any model served by the configured base URL |
| `GEMINI_BASE_URL` | `…/v1beta/openai/` | Gemini's OpenAI-compatible shim |
| `PROFILE_NAME` | `gemini` | Names the log directory: `results/<profile>/` |
| `ALPACA_BASE_URL` | `https://paper-api.alpaca.markets` | Trailing `/v2` stripped; non-paper URLs throw |
| `FINNHUB_API_KEY` | — | Without it, `get_stock_news` returns a graceful "unavailable" string |
| `TESTING_MODE` | — | `true` bypasses the market-hours gate |
| `RISK_*` (6 vars) | see below | Risk engine overrides |

### Why Gemini through an OpenAI-shaped client

[src/agent.ts:79](src/agent.ts:79) instantiates the **`openai` SDK** pointed at Google's
endpoint:

```ts
const gemini = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
});
```

Google exposes an OpenAI-compatible surface, so the mature `openai` client, the standard
function-calling tool schema, and the standard message/tool-result loop all work unchanged.
Swapping providers later means changing a base URL and a key, not rewriting the agent loop.
The variable is named `gemini` but the code is provider-agnostic — the log at
`results/gemini/` shows a session that ran with `MODEL=gpt-4o` against the same client.

### Risk overrides

```bash
RISK_STOP_LOSS_PCT=7
RISK_TAKE_PROFIT_PCT=15
RISK_MAX_POSITION_PCT=25
RISK_CASH_RESERVE_PCT=10
RISK_MAX_DRAWDOWN_PCT=15
RISK_MAX_BUYS_PER_SESSION=4
```

The parser ([src/risk.ts:45](src/risk.ts:45)) accepts a value only if it is finite **and
positive**; anything else silently falls back to the default. This is a deliberate
fail-safe: a typo in a CI secret degrades to the safe default, never to an *unlimited*
setting. `RISK_MAX_POSITION_PCT=0` does not mean "no limit" — it means "use 25%." There is
deliberately no way to switch a limit off through configuration.

---

## 5. The session lifecycle, step by step

### Step 1 — Credential check ([src/agent.ts:1089](src/agent.ts:1089))

Fetch the Alpaca account and log its ID, status, and buying power. On failure,
`process.exit(1)`. Better to fail loudly at startup than halfway through an order sequence.

### Step 2 — Market-hours gate ([src/agent.ts:1099](src/agent.ts:1099))

If the market is closed, log and `return` — **exit code 0**, not an error. A closed market
is a normal outcome. A green CI run means "nothing to do here," and a red one should mean
something actually broke.

### Step 3 — Exit sweep ([src/agent.ts:366](src/agent.ts:366))

This runs **before the model exists in the conversation at all**:

1. Fetch the portfolio — account, positions, and the last 100 orders, in parallel.
2. Derive peak equity from Alpaca's 3-month history and compute the current drawdown.
3. Run `decideExits()` over every position.
4. Call `alpaca.closePosition(symbol)` for each breach — which closes the *whole* position
   regardless of side or fractional size, avoiding all the quantity arithmetic.
5. Build a human-readable summary string.

That summary is not decoration. Without it the model would call `get_portfolio`, find a
position it held last session simply gone, and have no idea why — exactly the kind of gap
an LLM fills with a confident, invented explanation. If an automatic close *fails*, the
message escalates ([src/agent.ts:393](src/agent.ts:393)):

> "AUTOMATIC CLOSE FAILED (…). Close this position yourself with the sell tool as your
> **first action**."

Code first, model as the fallback — never the other way round.

### Step 4 — Risk briefing ([src/agent.ts:1001](src/agent.ts:1001))

The exit summary, every active threshold, and the current drawdown are assembled into a
block prepended to the model's first user message. If the breaker is tripped it adds a loud
warning that buys will be rejected and redirects the model toward reviewing what it holds.
It closes with:

> "Do not fight these limits or retry a blocked order unchanged — adapt your plan to them."

That sentence is damage control for a real failure mode: an LLM that hits a wall tends to
retry the identical call, burning its scarce turns against a deterministic rejection.

The system prompt itself is read fresh from disk each session
([src/agent.ts:1017](src/agent.ts:1017)) — you can change the trading philosophy without
touching code or redeploying anything.

### Step 5 — The agent loop ([src/agent.ts:1032](src/agent.ts:1032))

A textbook function-calling loop, capped at **8 turns**:

```
for turn in 1..8:
    completion = gemini.chat.completions.create({ model, messages, tools, tool_choice: "auto" })
    push assistant message onto history
    if no tool calls:
        log the final prose, return          ← normal termination
    for each tool call:
        result = executeTool(name, args)     ← always returns a string
        push { role: "tool", tool_call_id, content: result }
```

Details worth noting:

- **The model ends the session**, by replying with prose instead of a tool call. The turn
  cap is a safety net, not the expected exit path. Real sessions in the log finish in 4–6
  turns.
- **Multiple tool calls per turn are supported and encouraged.** The system prompt pushes
  batching — all price lookups in one turn, all trades in another. Tool calls within a turn
  execute sequentially, in order.
- **Every tool result is a plain string, including errors.** `executeTool` wraps its whole
  body in try/catch ([src/agent.ts:983](src/agent.ts:983)) and returns `"Tool X failed: …"`
  as *content*. A tool failure never throws and never crashes the run — it becomes
  information the model can react to. This is the correct shape for agent tools generally.
- **The assistant message is rebuilt in a clean shape**
  ([src/agent.ts:1049](src/agent.ts:1049)) rather than pushed verbatim, normalising
  `content: null` to `""` — some providers reject a null-content assistant turn on replay.
- **Malformed tool arguments are survivable** ([src/agent.ts:1063](src/agent.ts:1063)): a
  JSON parse failure logs a warning and passes `{}`, letting the tool's own validation
  produce a useful message instead of an exception.

### Step 6 — Exit

Log and terminate. Nothing is written except the log file. The next session starts from
Alpaca's truth.

### Why statelessness is a feature

There is no `thread.json`, no local portfolio file, no conversation carried between
sessions. Consequences:

- **No drift.** A local portfolio file can disagree with the broker. A single source of
  truth cannot.
- **No corruption class.** [CLAUDE.md](CLAUDE.md) documents an elaborate apparatus for
  detecting and repairing corrupted thread files. That entire category of bug was deleted,
  not fixed.
- **CI-native.** A fresh checkout with no writable state is exactly what GitHub Actions
  provides, which is why the workflow needs only `contents: read`.
- **The trade-off:** the agent has no memory. It cannot recall *why* it bought something
  last Tuesday. Its only continuity is the position list, average entry prices, and trade
  history it reads back from Alpaca — which is exactly why `get_portfolio` returns all
  three. That is the memory substitute, and it is a thin one.

---

## 6. The risk engine in depth

[src/risk.ts](src/risk.ts) is the most carefully written file in the repo. Every function
is **pure** — no network, no clock, no randomness — so the same inputs always produce the
same decision, and every rule is exhaustively unit-testable. That purity is what makes 39
tests over 290 lines possible.

### `decideExits(positions, config)` — [src/risk.ts:92](src/risk.ts:92)

```ts
if (!Number.isFinite(position.unrealizedPlPct)) continue;       // skip garbage data
if (position.unrealizedPlPct <= -config.stopLossPct)      → stop_loss
else if (position.unrealizedPlPct >= config.takeProfitPct) → take_profit
```

The `if/else` ordering means stop-loss is checked first — the two thresholds cannot both
fire, and the loss-limiting branch wins by construction. Thresholds are **inclusive**
(exactly -7.00% exits), which the tests pin down explicitly. Non-finite P&L is *skipped*
rather than treated as zero: bad data should never be able to *trigger* a trade.

### `vetBuy(request)` — [src/risk.ts:198](src/risk.ts:198)

Every proposed buy passes through this before reaching Alpaca. The central design choice is
stated in the docblock and is worth internalising:

> Where possible this **CLAMPS rather than denies**: returning a smaller permitted amount
> lets the agent still act, whereas a hard denial burns one of its few turns.

With only 8 turns, "no" is expensive. "Yes, but smaller" keeps the session productive.

The rules, in evaluation order:

| # | Rule | Behaviour | Rationale |
|---|---|---|---|
| 0 | Amount must be a positive finite number | **Deny** | Input validation |
| 1 | **Drawdown breaker** — `drawdown ≥ 15%` | **Deny** | The account is in trouble; stop adding risk |
| 2 | **Turnover cap** — `buysThisSession ≥ 4` | **Deny** | Spread cost from churn exceeds the edge |
| 3 | **Cash reserve** — `cash − (equity × 10%) < $1` | **Deny** | Never deploy the last dollar |
| 4 | **Concentration cap** — `(equity × 25%) − existingValue < $1` | **Deny** | No single name may dominate |
| 5 | Otherwise | **Clamp** to `min(requested, deployableCash, headroom)` | Trade what is permissible |

Two details that show real care:

**Round *down* to cents** ([src/risk.ts:257](src/risk.ts:257)):

```ts
const approvedNotional = Math.floor(permitted * 100) / 100;
```

`Math.round` could round *up* and breach the very limit being enforced, by a fraction of a
cent. Flooring makes the limit inviolable rather than approximately respected.

**Half a cent of clamp slack** ([src/risk.ts:267](src/risk.ts:267)):

```ts
const clamped = approvedNotional < request.requestedNotional - 0.005;
```

Without this, floating-point noise would report a "RISK ADJUSTED" clamp on an order that was
not meaningfully reduced, telling the model to re-plan around a reduction that never
happened.

Every verdict carries a `reason` string — always populated, always fed back to the model,
even on success (`"Within risk limits."`). The engine explains itself, every time. When it
clamps, it also names **which** constraint bound ([src/risk.ts:277](src/risk.ts:277)), so
the model learns whether to free up cash or pick a different ticker.

### Sells are never vetted

Stated explicitly at [src/risk.ts:195](src/risk.ts:195):

> Sells are deliberately never vetted. Blocking an exit could **trap** the agent in a losing
> position, which is far more dangerous than any oversized buy.

This asymmetry runs through the whole design. Every limit in the system restricts *adding*
risk; nothing restricts *reducing* it. The worst case of a too-permissive buy rule is one
bad position. The worst case of a too-strict sell rule is an unbounded loss you cannot
escape.

### `peakEquity` and `drawdownPct` — [src/risk.ts:133](src/risk.ts:133)

`peakEquity(series, current)` walks Alpaca's equity history, skipping `null`/`NaN` samples,
and seeds the maximum with current equity. `drawdownPct` floors at zero and returns `0` for
non-finite or non-positive inputs.

The **fail-open** decision at [src/agent.ts:353](src/agent.ts:353) deserves attention: if
the portfolio-history call fails, the code treats current equity as the peak, which makes
the drawdown 0% and the breaker inactive for that session:

> "A history outage must not manufacture a phantom drawdown and freeze trading; the other
> position-level limits still apply."

An API outage should not halt the system, and four other rules still bind. This is a
judgement call rather than an oversight — and it is logged loudly whenever it happens.

### Where each limit is enforced (the two-layer structure)

| Layer | Enforces | Can the model bypass it? |
|---|---|---|
| **Code** (`risk.ts` + the sweep) | stop-loss, take-profit, position cap, cash reserve, buy cap, drawdown breaker | **No** |
| **Prompt** ([system-prompt.md:87](system-prompt.md:87)) | exit early on a broken thesis, diversify, don't retry blocked orders, prefer liquid names | Yes — it is advice |

The prompt describes the code layer accurately, which matters: the model needs to
understand the constraints in order to plan *within* them rather than fight them. And
[system-prompt.md:103](system-prompt.md:103) frames the relationship correctly:

> "The engine is a backstop for when your judgment fails, not a substitute for it — a thesis
> that has broken is worth exiting at -3% rather than waiting for the stop."

A stop-loss is a floor, not a strategy.

---

## 7. Tool-by-tool reference

Nine tools, declared at [src/agent.ts:572](src/agent.ts:572), executed at
[src/agent.ts:711](src/agent.ts:711). Tool *descriptions* are prompt surface too — the
`buy` description ([src/agent.ts:628](src/agent.ts:628)) spends four sentences arguing
against price-based stock selection, because that is where the model reads them.

### `think(thought_process: string[])`

No side effects; logs each step with a 🧠 prefix. The system prompt makes it mandatory
before any other tool and caps it at 2–3 uses per session.

Both halves matter. Forcing an explicit plan first produces visibly better sequencing.
Capping it prevents the pathological loop where the model thinks after every single tool
result and exhausts its 8 turns without placing a trade. It also leaves a readable audit
trail of *why* — invaluable when reviewing what the bot did while you slept.

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

Three things earn their place:

- **Per-position unrealized P&L in both dollars and percent** — this tells the model
  directly which positions are winners to let run and which are losers to cut. Without it
  the agent manages exits blind.
- **Average entry price** — the anchor P&L is measured from, and a stand-in for the memory
  a stateless agent does not have.
- **Last 15 trades**, oldest-first — enough to see recent activity, few enough not to flood
  the context window.

Internally `getPortfolio()` ([src/agent.ts:273](src/agent.ts:273)) fetches account,
positions, and orders in parallel with `Promise.all`, and parses defensively. Alpaca returns
every numeric field as a *string*, and some can be missing, so `num()`
([src/agent.ts:242](src/agent.ts:242)) coerces with a fallback — a `NaN` must never reach
the model's view of its own money. There is even a recovery for a missing `current_price`
([src/agent.ts:286](src/agent.ts:286)): back it out of `market_value / shares`, so the model
sees a live price rather than `$0.00`. A displayed $0.00 on a real position is exactly the
kind of thing that provokes a panic sell.

### `get_net_worth()`

Lighter than `get_portfolio` — equity, cash, and buying power in one line.

### `get_stock_price(ticker)`

Mid-price for one symbol. See [§8](#8-market-data-where-prices-come-from).

### `buy(ticker, notional?, shares?)`

The most complex tool, worth tracing end to end ([src/agent.ts:773](src/agent.ts:773)):

1. **Validate exclusivity** — exactly one of `notional` / `shares`. Both, or neither, gets a
   descriptive error rather than a guess.
2. **Fetch account + positions** in parallel; extract buying power and any existing position
   value in this ticker (`Math.abs` of market value, so a short counts toward the
   concentration cap too).
3. **Normalise to dollars.** If given `shares`, look up the price and multiply. *One set of
   risk rules then covers both paths* — a small unification that removes a whole class of
   bug.
4. **`vetBuy()`.** Denied → return the reason verbatim to the model. Clamped → log it and
   continue with the reduced amount.
5. **Check fractionability** — only now, once the trade is actually going ahead, to avoid a
   wasted API call on an order that was never going to be placed.
6. **Route:**
   - **Notional path** (also taken whenever the order was clamped): cap at buying power,
     round to 2dp, reject below $1. Fractionable → notional order. Non-fractionable →
     `floor(notional / price)` whole shares.
   - **Share-count path** (unclamped only): round to 9dp if fractionable, else floor to an
     integer; verify buying power covers the cost; place a `qty` order.
7. **Increment `buysThisSession`** — only after a successful submission, so a rejected order
   never consumes the turnover budget.
8. **Return the outcome**, appending the clamp note if there was one, so the model can
   re-plan the rest of its session around a smaller fill.

Note that a clamp reroutes a share-count request onto the notional path. That is correct:
once the dollar amount changes, the requested share count is no longer what the agent asked
for, and dollars are the more faithful expression of the reduced intent.

### `sell(ticker, shares)`

Long positions only — a negative quantity returns "No long position … to sell."

The subtle part is **exit tolerance** ([src/agent.ts:913](src/agent.ts:913)):

```ts
const exitTolerance = Math.max(1e-6, owned * 1e-4);
if (Math.abs(shares - owned) <= exitTolerance) shares = owned;
else if (shares > owned) return `Not enough shares …`;
```

Why it exists: fractional quantities do not round-trip cleanly through JSON serialisation
and display rounding. The model reads `0.043 shares`, asks to sell `0.043`, and the true
holding is `0.0430000012` — or the reverse, and the order is rejected as "not enough
shares," leaving the agent believing it closed a position it still holds. Snapping a
near-exact request to the true size (relative tolerance of 1 basis point, with an absolute
floor) turns an intended full exit into an actual full exit. This is precisely the class of
bug that only shows up in production, with real fractional fills.

Note the sell path never consults the risk engine, by design ([§6](#sells-are-never-vetted)).

### `short_sell(ticker, shares)` / `cover_short(ticker, shares)`

Whole shares only — Alpaca supports neither fractional nor notional sizing on the short
side. `short_sell` enforces the $40k equity minimum and the 50% Reg T margin check, and its
response ends with `WARNING: unlimited loss potential.` `cover_short` verifies a short
actually exists (`qty < 0`) and that you are not over-covering.

Both are unreachable on a ~$100 account, by design.

### `get_stock_news(symbol)`

See [§9](#9-news-and-sentiment).

---

## 8. Market data: where prices come from

`getStockPrice` ([src/agent.ts:178](src/agent.ts:178)) tries two sources in order:

1. **Alpaca latest quote** → `(bid + ask) / 2`, rounded to cents. Primary because it is the
   same venue that will fill the order — pricing off the venue you trade on avoids a whole
   category of discrepancy.
2. **Yahoo Finance** `query1.finance.yahoo.com/v8/finance/chart/<SYM>` →
   `meta.regularMarketPrice`. Unauthenticated, undocumented, free, and therefore not
   something to depend on — which is why it is second.

If both fail it **throws**: `Could not fetch a price for <SYM>`. That throw is caught by
`executeTool` and surfaced to the model as a string it can act on.

**Throwing here is the right behaviour**, and it is worth stating why: a trading system that
invents a price when it cannot find one will size a real order off fiction. There is
deliberately no third tier, no cached last-known price, no default. No price, no trade.

---

## 9. News and sentiment

`get_stock_news` ([src/agent.ts:499](src/agent.ts:499)) queries Finnhub's `company-news`
endpoint for the last 7 days, takes up to 8 articles, and scores each one.

### The sentiment scorer

Finnhub's real sentiment endpoint is a paid feature, so the code implements a **keyword
bag-of-words scorer** ([src/agent.ts:480](src/agent.ts:480)): ~30 bullish words (`surge`,
`beat`, `upgrade`, `record`) against ~35 bearish (`plunge`, `miss`, `downgrade`, `lawsuit`,
`probe`, `fraud`, `layoffs`). +1 per bullish hit, −1 per bearish, across headline plus
summary, then squashed:

```ts
return Math.max(-1, Math.min(1, score / Math.max(2, hits)));
```

The `Math.max(2, hits)` divisor is the interesting bit: a single strong word yields ±0.5,
two aligned words saturate at ±1.0, and mixed coverage cancels toward zero. Labels come from
a ±0.15 dead band → `bullish` / `bearish` / `neutral`
([src/agent.ts:493](src/agent.ts:493)). The per-article scores are averaged into an overall
figure shown at the top of the response.

**Be honest about what this is.** It is a crude heuristic with no notion of negation
("*failed to* beat"), sarcasm, subject attribution ("Apple *sues* Samsung" scores bearish
for both), or magnitude. What makes it acceptable is the layering: both the per-article
scores *and* the raw headlines and summaries go to the model, so the LLM can override the
keyword score by actually reading the text. The number is an input, not a decision.

### Graceful degradation

Every failure mode returns a plain descriptive string rather than throwing: no API key
configured, HTTP 429, non-OK status, empty array, network error. The model always gets an
answer it can reason about, and a missing Finnhub key degrades the agent rather than
breaking it.

---

## 10. Resilience: retries, backoff, fail-open

`withRetry` ([src/agent.ts:122](src/agent.ts:122)) wraps every network call — Alpaca and
Gemini alike. Five attempts, **exponential backoff with jitter**:

```ts
const waitMs = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
// 2s, 4s, 8s, 16s (+ up to 1s random)
```

Only **429** (rate limit) and **5xx** (server error) are retried. A 4xx like "insufficient
buying power" or "invalid symbol" is a permanent answer — retrying wastes time and, on an
order endpoint, risks duplicate submissions.

The **jitter** matters more than it looks: with 13 scheduled sessions and several concurrent
calls, synchronised retries create a thundering herd that re-triggers the same rate limit.
Randomising spreads them out.

`getStatusCode` ([src/agent.ts:115](src/agent.ts:115)) checks `error.status`, then
`error.response.status`, then regex-matches a 3-digit number out of the message — because
the Alpaca SDK, the OpenAI SDK, and raw `fetch` all report status differently.

### The layered failure philosophy

| Failure | Response | Why |
|---|---|---|
| Missing credentials | Throw at startup | Fail fast, before touching the network |
| Non-paper Alpaca URL | Throw at startup | Never risk real money |
| Alpaca unreachable | `exit(1)` | Cannot trade blind |
| Market closed | `return`, exit 0 | Normal, not an error |
| Portfolio history down | **Fail open** — breaker inactive | An outage shouldn't freeze trading; 4 other limits still bind |
| Fractionability check fails | Assume whole-share | An integer qty is always accepted |
| Alpaca quote fails | Fall back to Yahoo | Redundancy |
| Both price sources fail | Throw → string to model | Never invent a price |
| Automatic close fails | Escalate to the model as its first task | Code first, model as backup |
| Any tool throws | Return `"Tool X failed: …"` | Model reacts; run survives |
| Bad tool-call JSON | Warn, pass `{}` | Tool validation produces the message |
| Invalid `RISK_*` value | Use the default | Never degrade to unlimited |

The direction of each fallback is chosen against the *consequence* of being wrong, not for
uniformity. Some failures fail closed (credentials, live endpoint), some fail open (drawdown
history), some fail conservative (fractionability). That is what thinking about failure
modes individually looks like, and it is the single most transferable idea in this codebase.

---

## 11. Workflows: how it runs unattended

### The trading workflow

[.github/workflows/trading-agent.yml](.github/workflows/trading-agent.yml) — GitHub Actions
cron, **13 sessions per trading day**:

```yaml
- cron: "41 9 * * 1-5"          # 9:41 ET
  timezone: "America/New_York"
- cron: "11,41 10-15 * * 1-5"   # :11 and :41, 10:00–15:59 ET
  timezone: "America/New_York"
```

Design notes visible in the file:

- **`timezone:`** handles EDT/EST automatically. Without it you would hand-shift UTC offsets
  twice a year — a classic source of a bot silently trading an hour off after a DST change.
- **Odd minutes (`:11`, `:41`)** dodge GitHub's `:00`/`:15`/`:30` cron congestion, where
  scheduled jobs queue behind everyone else's and can be delayed by many minutes.
- **`9:41`, not `9:30`** skips the opening auction, where spreads are widest and prices most
  erratic.
- **`permissions: contents: read`** — least privilege, possible only because the agent is
  stateless and never commits back.
- **`concurrency: { group, cancel-in-progress: false }`** — a delayed run will not overlap
  the next, and an in-flight session is allowed to finish rather than being killed
  mid-order. Cancelling between "order submitted" and "log written" is the worst possible
  moment.
- **`timeout-minutes: 10`** bounds a hung session.
- **Logs uploaded as an artifact** with `if: always()` and 30-day retention — the only
  record that survives the ephemeral runner.
- **`workflow_dispatch`** lets you trigger a session by hand from the Actions tab.

Secrets required: `GEMINI_API_KEY`, `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`,
`FINNHUB_API_KEY`; optionally `ALPACA_BASE_URL`.

### The other two workflows

[claude.yml](.github/workflows/claude.yml) responds to `@claude` mentions in issues and PR
comments; [claude-code-review.yml](.github/workflows/claude-code-review.yml) runs an
automated review on every opened or updated PR. Both are developer tooling and have no
bearing on trading — they need an `ANTHROPIC_API_KEY` secret to do anything.

---

## 12. Testing

```bash
npm test                     # all tests (39, all in tests/risk.test.ts)
npm run test:coverage        # + coverage report into coverage/
npm run build                # tsc --noEmit — typecheck only
npx jest tests/risk.test.ts  # just the risk engine
```

[tests/risk.test.ts](tests/risk.test.ts) covers the pure risk functions using a
`baseRequest()` factory so each test varies exactly one input. It covers:

- **Config fallbacks** — empty env, no argument, valid overrides, and unparseable / zero /
  negative values falling back rather than disabling a limit.
- **Exit thresholds** — inside the band, past the stop, past the target, inclusive
  boundaries, one tick inside, mixed books, non-finite P&L, custom configs.
- **Drawdown** — new highs, falls from peak, nonsense input, null/NaN samples, empty
  series.
- **`vetBuy`** — every rule individually, the tightest-binding-constraint case, never
  approving more than requested, the $1 minimum, and round-down arithmetic. One test is
  named for the real incident it prevents: *"prevents the all-in trade seen in the logs."*

The important structural point: this is only testable because `risk.ts` is pure. The rules
that must never be wrong are also the rules that are trivially verifiable — that is not a
coincidence, it is the reason for the split. The agent loop and the Alpaca integration have
no unit tests; they are exercised by running a real session against paper.

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

One session, during market hours:

```bash
npm start
```

Force a session outside market hours:

```bash
TESTING_MODE=true npx tsx src/agent.ts
```

Watch the log:

```bash
tail -f results/gemini/agent-gemini.log
```

Emoji prefixes make it greppable: 🧠 reasoning, 🛠️ tool call, 💰 buy, 💸 sell, 📉 short,
📈 cover, 🛡️ risk engine, ⚠️ warning, ❌ error, 🤖 the model's final prose.

To run a different model against the same account:

```bash
MODEL=gemini-2.5-pro npm start
```

---

## 14. Known gotchas and unhandled cases

### `CLAUDE.md` describes a system that no longer exists

[CLAUDE.md](CLAUDE.md) documents the *previous* architecture almost entirely. It claims the
project uses OpenAI's Agents framework and GPT-5/GPT-5-mini (it uses Gemini via the `openai`
SDK); documents `npm run start:continuous`, `start:continuous:1h`, `test:agents`,
`test:trading` and a Docker setup (none exist); describes `thread.json` persistence,
corruption detection and thread trimming (all removed); describes CSV P&L reports,
`updateReadme()`, `generateCSVReport()`, `calculateCAGR()` (none exist); says the account
starts with $100,000 (it holds ~$100); and never mentions the risk engine, which is now the
most important part of the system. **Read the source, not `CLAUDE.md`.** Rewriting it is the
single highest-value cleanup left.

### `README.md` lists the risk env vars without their prefix

The table in [README.md:33](README.md:33) names `STOP_LOSS_PCT`, `TAKE_PROFIT_PCT`, and so
on. The code reads `RISK_STOP_LOSS_PCT`, `RISK_TAKE_PROFIT_PCT`, etc.
([src/risk.ts:53](src/risk.ts:53)). Setting the README's names has no effect at all, and
because invalid values fall back silently to defaults, you would get no error — just
defaults, quietly. [.env.example](.env.example) has the correct names.

### Turn count mismatch between prompt and code

[system-prompt.md:52](system-prompt.md:52) tells the model *"Your session will terminate
after 6 turns"* and line 51 says *"6 API calls or fewer"* — but line 72 is headed
`(EFFICIENT 8-TURN PATTERN)` and the code's `maxTurns` is **8**
([src/agent.ts:1031](src/agent.ts:1031)). Understating the budget is the safe direction to
be wrong (the model wraps up early rather than being cut off mid-trade), but the prompt
contradicts itself and neither number matches the code.

### Market holidays are not handled

`isMarketOpen` ([src/agent.ts:159](src/agent.ts:159)) checks only weekday and clock time. On
Thanksgiving, Christmas, July 4th and early-close days it will start a session and let
Alpaca reject the orders. Harmless but noisy, and it burns model tokens. Alpaca exposes
`getClock()` and a market-calendar endpoint that would fix this properly.

### Intra-session risk is unmonitored

The exit sweep runs **once**, at session start. A position that blows through its stop five
minutes later is not caught until the next session — up to ~30 minutes of unmanaged
exposure, or overnight and across the whole weekend after the last session on Friday. This
is the most significant real risk gap in the system. Alpaca supports native bracket and stop
orders that would hold continuously, but they are unavailable on fractional positions — the
same constraint that ruled out trailing stops ([src/risk.ts:83](src/risk.ts:83)).

### Session counters reset every run

`buysThisSession` ([src/agent.ts:105](src/agent.ts:105)) is module state, reset with each
process. With 13 sessions/day × 4 buys, the *daily* ceiling is 52 buys. The 4-buy cap limits
churn within a session, not across the day. If daily turnover is the concern, that needs a
different mechanism (Alpaca's order history could supply a same-day count).

### The drawdown breaker's peak is only a 3-month window

`getPortfolioHistory({ period: "3M" })` ([src/agent.ts:343](src/agent.ts:343)) means the
"all-time" high-water mark quietly rolls forward. A peak from four months ago no longer
counts, so a slow decline can escape the breaker by outliving the lookback window.

### Cash reserve is tested against cash, order size against buying power

`vetBuy` computes deployable funds from `cash` ([src/risk.ts:233](src/risk.ts:233)), while
the final order is capped at `buying_power` ([src/agent.ts:830](src/agent.ts:830)). On a
margin account buying power exceeds cash, so these can disagree. The cash-based test is the
tighter one, so the effect is conservative — but it is worth knowing which number is
binding when a clamp surprises you.

### Sentiment scoring is naive

No negation handling, no subject attribution, no magnitude. See
[§9](#9-news-and-sentiment) — mitigated by passing raw headlines to the model alongside the
score, but do not mistake the number for analysis.

### A Finnhub API key sits in `.claude/settings.local.json`

That file contains a literal API key inside an allow-listed command string. It is not
tracked, but only because a *global* gitignore rule on this machine excludes it — the repo's
own [.gitignore](.gitignore) does not mention `.claude/`. On a machine without that global
rule, `git add .` would stage the key. Worth adding to the repo's `.gitignore` and rotating
the key.

### Minor

- `results/gpt4o/` exists as an empty leftover directory; the log directory is chosen by
  `PROFILE_NAME`.
- `MODEL` and `PROFILE_NAME` are independent, so a `gpt-4o` run can write into the `gemini`
  log — visible at the tail of the current log file.
- Alpaca's paper simulator does not model slippage or partial fills the way a real venue
  would, so paper results flatter a strategy that trades illiquid names.

---

## 15. How to change common things

| Goal | Where |
|---|---|
| Loosen/tighten stops, caps, reserve | `RISK_*` env vars, or `DEFAULT_RISK_CONFIG` at [src/risk.ts:28](src/risk.ts:28) |
| Change trading style, strategy, tone | [system-prompt.md](system-prompt.md) — read fresh each session, no code change, no deploy |
| Add a tool | Add the JSON schema to the `tools` array ([src/agent.ts:572](src/agent.ts:572)), then a `case` in `executeTool` ([src/agent.ts:711](src/agent.ts:711)). Return a string; never throw. Document it in `system-prompt.md` too, or the model will use it badly. |
| Change the model | `MODEL` env var. A different provider needs a new `GEMINI_BASE_URL` + key. |
| Change the schedule | The `cron` entries in [.github/workflows/trading-agent.yml](.github/workflows/trading-agent.yml). Keep `timezone:`. |
| Add a risk rule | A pure function in [src/risk.ts](src/risk.ts) + tests in [tests/risk.test.ts](tests/risk.test.ts), then wire it into `vetBuy` or the sweep. Keep it pure. |
| More/fewer turns | `maxTurns` at [src/agent.ts:1031](src/agent.ts:1031) — and fix the prompt to match. |
| Handle market holidays | Replace `isMarketOpen` ([src/agent.ts:159](src/agent.ts:159)) with Alpaca's `getClock()`. |
| Debug a session | `TESTING_MODE=true npx tsx src/agent.ts`, then read `results/gemini/agent-gemini.log`. |

### If you extend this, in rough priority order

1. **Rewrite `CLAUDE.md`** to match reality, and fix the `RISK_*` names in `README.md`.
   Everything else is easier once the docs stop lying.
2. **Add intra-session risk coverage** — a mid-session sweep, or native stop orders if you
   move back to whole shares. This is the real exposure gap.
3. **Add holiday awareness** via Alpaca's clock.
4. **Reconcile the turn count** between prompt and code.
5. **Add a daily buy cap** derived from Alpaca's order history, if churn across sessions is
   a concern.
6. **Rotate the Finnhub key** and gitignore `.claude/`.

---

## 16. Appendix: reading a real session log

From [results/gemini/agent-gemini.log](results/gemini/agent-gemini.log), a session recorded
*before* the fractional-order and risk-engine work landed. It is the clearest available
illustration of what those changes were for:

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

Every pathology the later commits address is visible here:

- **Whole-share arithmetic pushing it into penny stocks.** *"low-priced stock … I can afford
  it"* — the agent is selecting on share price, not quality, because share price is what
  gates affordability when you can only buy whole shares.
- **Selling a reasonable holding purely to raise cash** for that trade.
- **Concentration.** A later session in the same file buys 48 shares of AMC in one order —
  effectively the entire account in one illiquid name. That is the trade
  `tests/risk.test.ts` now has a test named after.

An earlier session in the same file ends with the model refusing to trade at all, insisting
there had been *"a significant error in the portfolio initialization"* because $100 did not
match the $100,000 it expected. Another shows it calling a `web_search` tool that no longer
exists, then writing a plan for "the next market open" because it could not tell the market
was closed.

The commits that follow fix each one directly: notional orders plus explicit
anti-cheap-stock instructions; a system prompt stating that ~$100 is correct and expected,
not a bug; per-position P&L so exits are managed on merit rather than on which holding
happens to be sellable; and the deterministic risk engine so concentration is capped by code
rather than by hope.

Reading this log next to the current [system-prompt.md](system-prompt.md) is the fastest way
to understand why that file says what it says. Nearly every emphatic paragraph in it is a
scar from a specific session in this log.
