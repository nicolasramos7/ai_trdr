# AI Trading Agent (Gemini / Alpaca)

An autonomous paper-trading agent: Gemini 2.5 Flash decides *what* to trade via
function calling, and a deterministic risk layer decides *how much* and *when to
get out*. All execution is on Alpaca's paper endpoint — no real capital.

## Attribution

Forked from [matthewchung74/llm_trader](https://github.com/matthewchung74/llm_trader),
itself derived from work by Anand Chowdhary. MIT licensed; original copyright
retained in `LICENSE`.

**My contributions:**

- `src/risk.ts`: deterministic risk and exit engine (see below), with unit tests
- Migrated the model layer to Gemini via its OpenAI-compatible endpoint; removed
  the parallel OpenAI agent implementation
- Replaced the Brave Search tool with a Finnhub company-news pipeline, including
  keyword-based headline sentiment scoring (Finnhub's native sentiment endpoint
  is paywalled)
- Per-position unrealised P&L exposed through the `get_portfolio` tool
- Fractional / notional order execution, so position sizing is independent of
  share price
- Scheduled execution on GitHub Actions: 13 timezone-aware sessions per trading
  day, retry/backoff, concurrency guards, least-privilege permissions

## Risk engine

The agent proposes; `risk.ts` disposes. Every function in it is pure — no
network, no clock, no randomness — so the same inputs always produce the same
decision and the rules cannot be talked around by a model having an off session.

| Control | Default | Env var |
|---|---|---|
| Stop loss | 7% | `STOP_LOSS_PCT` |
| Take profit | 15% | `TAKE_PROFIT_PCT` |
| Max position size | 25% of equity | `MAX_POSITION_PCT` |
| Cash reserve floor | 10% | `CASH_RESERVE_PCT` |
| Drawdown circuit breaker | 15% from peak | `MAX_DRAWDOWN_PCT` |
| Buys per session | 4 | `MAX_BUYS_PER_SESSION` |

## Setup

1. Alpaca **paper** account → API key + secret
2. Gemini API key
3. Finnhub API key (free tier)
4. `cp .env.example .env`, fill in, then `npm install && npm start`

Runs one session and exits; scheduling is external (see
`.github/workflows/trading-agent.yml`).

## Tests

npm test

## Disclaimer

Paper trading only. Not investment advice, and not a validated strategy —
performance over short windows is indistinguishable from noise.
