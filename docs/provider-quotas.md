# Provider quotas for environment logins

An [environment login](provider-presets.md) shows its real quota or spend in the same places a Claude or
Codex sign-in does: the composer's quota chip, Info › Usage, the logins list, and the usage feed the
Warden and quota failover read. This page is the contract for how that number is found.

The code is `packages/daemon/src/lib/usage/provider-quota/`.

## One shape

Every provider maps to one reading (`ProviderQuotaReadingSchema` in `@ferretry/protocol`):

- **windows** — `5h`, `week`, `month`, `key` (an API key's own spending limit) or `tools` (a separate
  tool-call allowance), each with `used`, `limit`, `usedPercent` and `resetsAt` **only when the provider
  said so**, and the `unit` they count (`prompts`, `requests`, `tokens`, `usd`);
- **balance** — money left, `{ amount, currency }`, where that is how the provider bills;
- **spend** — what this machine's own sessions on the login cost this month, from the transcripts;
- **exhausted** — the provider said this login can do no more work now;
- **unverified** — the endpoint or its fields come from community sources, not the provider's docs.

**Missing is unknown, never 0.** A window with no `usedPercent` draws no bar and reads "not measured"; a
login with no reading at all says "usage unknown" and why.

The reading rides on the credential row as `usage.provider`, fills that row's 5-hour and weekly windows
when nothing else measured them, and lays itself over the usage feed's row for every runtime on the login
(`fiveHourPercent`, `weeklyPercent`, `atLimit`, `balance`, `spendUsd`). Failover and the Warden read that row.

## When it is read

Only when somebody is watching, and never inference:

- **Watchers**: `GET /v1/fleet/credentials` (the logins list on screen), `GET /v1/usage` (the PWA polls it
  while a quota chip or Info › Usage is showing), the Warden's sweep and quota failover. Each asks the
  reader first; the reader reads every environment login whose last attempt is **60 s** old or more, and
  concurrent watchers share one read.
- **Not watchers**: the daemon's unattended usage refresh timer, `GET /usage` and `GET /metrics` (both opt-in, `publicUsageFeed`;
  scraped on someone else's timer). They read the cached readings and ask no provider anything
  (`WatchedUsageFeed.unattended`).
- There is **no idle timer**. A daemon nobody looks at reads no quota.
- A quota, balance or key-info endpoint answers about the account. Nothing here sends a prompt.

## In which order

1. **The provider's endpoint**, through the outbound holder ([secrets.md](secrets.md)) — the key is put on
   that one request and never handed to the reader.
2. **Transcript × pricing** — the analytics index's equivalent cost of the sessions on the login's runtimes
   since the start of this UTC month. A session with no price is counted as unpriced, so the amount is a
   floor when any were.
3. **Usage unknown**, with the reason: no endpoint and nothing priced, the key refused, the key not in the
   store, or the endpoint not answering.

A blip (a timeout, a 5xx, an unreadable reply) keeps the last endpoint reading, with its own `at`; a
refused key replaces it.

**Declared gap — passive headers.** Rate-limit headers on the requests a ferret makes would sit between 1
and 2, but the CLI talks to its provider directly, so the daemon never sees them. There is no proxy.

## Where the key goes

The preset names a source from a closed set; the endpoint, header and reader of each are fixed in code, so
a preset file can only pick one, never name an address. The key is the variable the preset's Test sends,
else the Codex provider's, else the login's only whole `${secret:NAME}`. The endpoint's host must be one the
login already sends its key to, or that host's sibling under the same parent domain — unless the preset is
built in, whose pairing of source and key Ferretry ships.

## The adapters, verified 2026-10-16

| Source               | Endpoint                                                 | Maps to                                                                                    | Docs |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---- |
| `zai-coding-plan`    | `GET api.z.ai/api/monitor/usage/quota/limit`, bare key   | `TOKENS_LIMIT` entries → `5h` (sooner reset) and `week`; `TIME_LIMIT` → `tools`            | M    |
| `minimax-token-plan` | `GET www.minimax.io/v1/token_plan/remains`, Bearer       | `general` model: 5 h and week; `*_usage_count` is what **remains**, so used = total − it   | M    |
| `deepseek-balance`   | `GET api.deepseek.com/user/balance`                      | balance (USD when present, else the first currency); `is_available: false` → exhausted     | H    |
| `moonshot-balance`   | `GET api.moonshot.ai/v1/users/me/balance` (`.cn` in CNY) | `available_balance`                                                                        | H    |
| `openrouter-key`     | `GET openrouter.ai/api/v1/key`                           | `key` window from `usage`/`limit`, `month` from `usage_monthly`, balance `limit_remaining` | H    |
| `litellm-key-info`   | `GET <proxy>/key/info`                                   | `key` window from `spend`/`max_budget`, resets `budget_reset_at`                           | M    |
| `vercel-credits`     | `GET ai-gateway.vercel.sh/v1/credits`                    | balance                                                                                    | M    |
| `transcript-pricing` | —                                                        | spend this month                                                                           | —    |
| `none`               | —                                                        | "A local model has no quota and no bill."                                                  | —    |

**H** the provider's own documentation; **M** community sources only, shown as unverified in the app. The
MiniMax path is the one MiniMax-AI/MiniMax-M2#99 settled on (`api.minimax.io` answers the same route).
