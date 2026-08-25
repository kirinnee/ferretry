# Account health

**"Is this account signed in, and when did we last look?" — answered without spending a cent.**

This document is the contract. Implement against it rather than against the code, and extend it here
rather than adding a second rule somewhere else.

## What changed, and why the old thing had to go

Health used to mean _"can this wrapper answer a sentinel prompt?"_. Answering it **launched the
account's agent and asked a model to reply with an exact string** — a real, billable turn, per
account, every time anybody looked. The daemon reached it on a fixed timer, so a fleet of thirty
accounts bought thirty model calls a tick, forever, on behalf of nobody. A `health.enabled` flag was
supposed to prevent that and did not.

`646596a7` cut the timer's reach into it. This replaces the question.

The new question is narrower and free:

> Was this account's **current credential** recently accepted by its provider?

So **`healthy` means "the credential works"** — not "this account has quota", not "every model is
entitled", not "the provider is up". Quota is a separate fact with its own fields. Conflating them is
how a reader concludes that an exhausted account needs a new login.

## Zero spend is structural, not a policy

Nothing in the health path launches a process, opens a socket, or sends a request:

- `packages/fleet/src/lib/health.ts` is pure. It takes a usage snapshot somebody else already
  collected plus a **local** credential classification, and returns a verdict. There is no seam to
  hang a spend on.
- The remote evidence is the **one read-only `GET /api/oauth/usage`** the quota pass already makes.
  It consumes no inference quota, and `QuotaRequest` is a bodyless `GET` in the type system, so a
  completion request is unrepresentable rather than merely absent.
- `GET /v1/fleet/health` is a **store read**. It checks nothing, which is why a browser may hydrate
  it on page load and why a restart serves the last known verdicts immediately.

**There is no health timer.** Health rides the free usage collection that already runs on
`usage.interval` (60 seconds by default), so a verdict refreshes as a side effect of a read the
daemon was making anyway. A second cadence would double the provider calls to learn nothing.

The seam is `MountedFleet.usage()`: it collects, then hands the snapshot to the health service. Every
caller of that method is already a free read — the unattended quota pass, `GET /v1/fleet/usage`, and
the explicit check. **A health failure never fails the quota read it rode in on**, because the feed,
the advisor and the warden are all waiting on that snapshot.

## The rules that matter most

**A confirmed Anthropic JSON `403` from the read-only usage endpoint is HEALTHY.**

It means the token lacks `user:profile`, which is permanent and expected for an inference-scoped
token, and it says nothing whatever about whether the account works. Reading it as a rejection sends
a person to re-login, forever, on a working account. So it is `healthy` / `usage_scope_unavailable`,
and the **quota** is what goes missing — never a quota bar drawn at 0 %.

The JSON qualification is load-bearing. A Cloudflare challenge can answer `403` with HTML, and that
proves neither acceptance nor rejection. The probe retains content type and a bounded structural
response fingerprint so equal statuses from the origin and the edge do not collapse into one claim.

**A bare OAuth-control-plane `401` is not a re-login instruction.** This HTTP client cannot yet
distinguish repudiation of the credential from refusal of the client itself, so the honest verdict is
`unknown` / `oauth_rejection_unconfirmed`. A strict secret-safe response fingerprint preserves what
the check saw for later diagnosis; it does not manufacture certainty the response did not carry.

## Verdicts

| Verdict             | Meaning                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `healthy`           | The current credential has recent conclusive provider acceptance.         |
| `needs_relogin`     | An interactive OAuth login is the applicable remedy.                      |
| `needs_credentials` | A non-login credential needs repair. **A login cannot fix this account.** |
| `unknown`           | No conclusive result. Never routeable evidence, and never "zero usage".   |

### The remedy has to actually work

`fy fleet health` prints `fy fleet login <accountId>` beside every `needs_relogin` row, and for a
while that command was the one thing guaranteed **not** to fix that account. A bare `fy fleet login`
takes the cheapest route to a signed-in fleet, which means it reads what the homes hold. The old
status-only rule turned every control-plane `401` into `oauth_token_rejected` even when the local
credential still classified as valid, so the identity looked `complete`, every lane was reported
`usable`, and nothing happened. A bare `401` is now inconclusive; this reauthentication route remains
for a rejection established by stronger evidence.

Naming an account is therefore a statement that what it holds is not working, and it selects a
different pass: see the `reauthenticate` mode in `packages/fleet/src/lib/login.ts`. It reaches the
provider rather than trusting the homes, it launches **that account's own wrapper**, and it reads that
account's own home afterwards before reporting it signed in. A renewal that succeeds still settles it
with no browser, and `--sync-only` still asks for nothing.

`needs_credentials` is not a politer `needs_relogin`, and separating them is the point. An account
whose credential comes from an environment variable or a token file **cannot** be fixed by signing
in: the harness reads that value and never consults its own credential store, so a login would open
a browser, write a store nobody reads, and change nothing. Offering it is worse than offering
nothing. The distinction is read from the **declaration** by
`packages/fleet/src/lib/credential-source.ts`, never guessed from the host.

## The verdict table, in order

Order is the design. First match wins.

| #   | Condition                                                                                    | Verdict / reason                                                                                                             | Conclusive |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | manifest says unavailable                                                                    | `unknown` / `account_unavailable`                                                                                            | no         |
| 2   | local credential positively dead                                                             | `needs_relogin` / `oauth_access_expired` \| `oauth_credential_missing`, or `needs_credentials` / `static_credential_missing` | **yes**    |
| 3   | local access expired **with** a refresh token                                                | `unknown` / `oauth_refreshable`                                                                                              | no         |
| —   | **Codex: the remote signal is BLANKED here**, so no row below can give it a provider verdict | (falls through)                                                                                                              | —          |
| 4   | remote `200`                                                                                 | `healthy` / `provider_accepted`                                                                                              | **yes**    |
| 4   | confirmed Anthropic JSON `403`                                                               | `healthy` / `usage_scope_unavailable`                                                                                        | **yes**    |
| 4   | explicitly proven credential rejection (stronger than a bare status)                         | `needs_relogin` / `oauth_token_rejected`, or `needs_credentials` / `static_credential_rejected`                              | **yes**    |
| 5   | remote bare `401`                                                                            | `unknown` / `oauth_rejection_unconfirmed`                                                                                    | no         |
| 6   | credential unreadable, or nothing to ask with                                                | `unknown` / `credential_unreadable`                                                                                          | no         |
| 7   | Codex                                                                                        | `unknown` / `codex_liveness_unproven`                                                                                        | no         |
| 8   | remote timed out                                                                             | `unknown` / `check_timeout`                                                                                                  | no         |
| 9   | remote HTML `403` / `429` / `5xx` / other `4xx` / transport failure                          | `unknown` / `provider_unavailable`                                                                                           | no         |
| 10  | local valid, provider never asked                                                            | `unknown` / `provider_not_asked`                                                                                             | no         |
| 11  | nothing at all                                                                               | `unknown` / `never_checked`                                                                                                  | no         |

Three things that row order encodes:

1. **An unavailable account is not checked.** A credential verdict about it would be a claim nothing
   measured.
2. **A decisive LOCAL expiry classification outranks any remote answer.** The remote read was made
   against the credential _group_'s shared login through one representative home; a sibling whose own
   copy is absent does not become healthy because the representative answered. An expired access token
   with a refresh token is not dead either: a `401` against those stale bytes cannot condemn the
   non-interactive recovery path beside them.
3. **A locally valid token is not `healthy`.** It may have been revoked a minute ago. Local
   classification is structural evidence; only the provider can accept a credential.
4. **Codex's signal is blanked after local expiry, not checked at row 7.** Row 7 is where a Codex
   account _lands_; the blanking above is what makes it impossible for one to land anywhere else. It
   is deliberately a suppression rather than an early return, so the more specific unknown rows stay reachable for
   Codex — `credential_unreadable` is more useful than "Codex cannot be proved", and losing it would
   be paying for the safety with the diagnosis.

### `oauth_rejection_unconfirmed` — declared, and not yet produced

`oauth_rejection_unconfirmed` is a member of `FleetHealthReasonSchema` that **no row above emits
yet**. The decision that emits it — splitting a `401` that cannot be attributed out of row 3 — lands
separately. It is declared first because the terminal and the browser both render an **exhaustive**
map over this enum, so the code has to exist before either surface can be taught the words, and
before the branch that produces it can typecheck.

Everything about how it is PUBLISHED and RENDERED is settled here and does not move when the decision
lands:

- Its verdict is **`unknown`**, its evidence is `anthropic_usage`, and the check is **inconclusive**.
- **No surface offers a sign-in for it.** The terminal prints no `fy fleet login` line and the browser
  offers no control, both because `offersSignIn` and the terminal's remedy are keyed on
  `needs_relogin` and this is not that.
- It is rendered in the same visual class as every other `unknown` — muted, never a warning colour.

The reason the split exists: a `401` from that endpoint cannot distinguish a repudiated LOGIN from a
CLIENT the provider does not accept. Both arrive as the same status. Reading one as the other tells
somebody to sign in again over a login that is fine, which costs a browser approval and fixes
nothing — the worst outcome available here, and worse than saying plainly that it could not tell.

### `429` is deliberately not "authenticated, just throttled"

Tempting and wrong. `usageEndpointHttpVerdict` — the **quota** reading — reports `authOk: true` for a
`503`, a `500`, a `429` and a transport failure, and it is right to: do not condemn a credential over
a provider outage. Health asks a different question, and a provider that never answered accepted
nothing. Reusing the quota reading would publish a healthy verdict during any provider blip, so
health reads a separate closed classification, `FleetCredentialSignal`, produced once at the adapter
where the status actually is.

## Codex is honestly unknown, and that is the finished answer

There is no proven non-mutating Codex liveness signal:

- its usage endpoint answers `200` for tokens that are already **stale**, so a `200` cannot create
  `healthy`;
- a forced refresh _could_ prove it, but Codex refresh tokens **rotate and are single-use**, so
  refreshing to measure risks breaking the credential being measured, and would need a cross-process
  identity lock that does not exist;
- `account/read`, `getAuthStatus` without refresh and model-list are cached or local evidence.

So `unknown` / `codex_liveness_unproven` is the **correct published verdict**, not a gap in this
implementation. Inventing one would be worse than saying so.

**And it is enforced structurally, not by the probe's restraint.** `decideAccountHealth` blanks the
remote signal for Codex before reading it, so no `credentialSignal` — from any future probe — can
produce a Codex `healthy` or a Codex rejection. It used to depend on `AnthropicUsageProbe` declining
Codex and therefore supplying nothing; that is a collaborator's manners rather than a rule, and the
seam is public. The signal is **suppressed rather than short-circuited**, so the more specific rows
below it stay reachable: a Codex home whose credential could not be _read_ still reports
`credential_unreadable`, which is actionable, rather than "Codex cannot be proved", which is not. A
positively dead local credential still condemns itself, because that is a fact about the home rather
than a claim about the provider.

## Freshness

A conclusion is fresh for **15 minutes** (`FLEET_HEALTH_FRESH_MS`). Past that, the effective verdict
is `unknown` / `stale`, carrying `staleVerdict` so a reader is told what it _was_ rather than being
handed a bare unknown that looks like an account nobody ever checked.

It is a constant rather than configuration, because there is no cost to trade off any more. Against
the usage pass's one-minute default a conclusion is normally re-proved fourteen times before it could
expire, and a fleet whose provider is unreachable degrades to `unknown` rather than quietly showing
an hour-old verdict.

**It expires negative verdicts too.** Somebody who signs in again outside Ferretry — in a terminal, in
another tool — must not stay condemned by a `401` this daemon happened to observe first.

## The stale-401 guard

The dangerous sequence is ordinary: a provider read is in flight, the person signs in again, and the
read comes back `401` about the credential that no longer exists. Committing it marks a freshly
working account as needing re-login, and sends the person to do again the thing they just did.

So the head stores an **opaque digest** of the local credential material, and a **remote** negative is
committed only when that digest is unchanged since the previous observation. If it moved, the head
records `credential_changed_during_check` and keeps no conclusion; the next pass, at most one usage
interval later, settles it against the credential that is actually installed. It errs toward
`unknown`, never toward condemned.

The guard is deliberately **not** applied to a _local_ negative: that verdict was decided from the
very material just digested, so it cannot be about a credential since replaced — and applying it
there would discard the correct verdict for a sign-**out**, which changes the digest exactly as a
sign-in does.

The digest answers one question — _did this credential change?_ — and is compared only for equality
against another digest from the same function. It is a truncated SHA-256 over the whole material,
never a parsed token, and a read that found nothing has **no** digest at all, so "there is nothing
here" cannot compare equal to "there is something here".

## What is stored, and what is not

`$FY_HOME/fleet/account-health.json`, one head per published account:

```text
{ accountId, kind, verdict, reason, evidence, lastCheckedAt, verdictAt, lastCheckInconclusive, fingerprint, responseFingerprint }
```

Reason codes, verdicts, instants, one opaque credential digest and a strict provider-response
fingerprint. The latter contains status, normalized content type, header **names**, a closed allowlist
of scrubbed non-secret header values, body byte length/SHA-256, and parsed JSON key/type/error-code
shape. The body read is hard-capped at 64 KiB; an oversized response is cancelled and marked
`bodyTruncated`, and its length/digest honestly describe only the retained prefix. **No token,
authorization value, cookie, provider body, provider message, or harness output is stored** —
enforced by strict schemas rather than convention: there is no free-text field for one to travel in.

- `lastCheckedAt` is **nullable**, and that is load-bearing. The contract it replaces required a
  number, so an account nobody had checked was published with a fabricated "now" — the same shape on
  the wire as a check that had just succeeded. Telling those apart is the whole feature.
- `verdictAt` can be **older** than `lastCheckedAt`: a newer inconclusive check moves the check time
  without disturbing a conclusion that still stands, and `lastCheckInconclusive` publishes the failed
  attempt beside it. Hiding that is how a fleet reads healthy while every provider call is failing.
- **Reading changes nothing.** A browser opening a panel, a daemon restarting, a scraper pulling
  metrics: none is a check.
- **No schema version field**, deliberately. Every row is disposable derived evidence with a
  fifteen-minute horizon and can be re-established for free by the pass that runs every minute. A
  shape this build cannot parse is discarded and re-collected, which is strictly better than a
  migration for a document whose contents are throwaway — and a version number would invite one.
- **`fleet/health-successes.json` is not migrated.** It recorded only _successes_, so it cannot
  express any of the four verdicts, and deriving one from it would be fabricating evidence. Nothing
  reads it; a leftover copy is inert and can be deleted by hand.

## The surfaces

| Route                    | Verb | What it does                                  |
| ------------------------ | ---- | --------------------------------------------- |
| `/v1/fleet/health`       | GET  | The stored snapshot. Checks nothing.          |
| `/v1/fleet/health/check` | POST | Collects the free evidence now, then answers. |

Both are `fleet.use`. The POST records a **reading**, not a change — it launches nothing and writes no
account — so putting it behind `fleet.configure` would gate somebody's own health check on the
operator password that guards writing executables into their home.

The browser and the terminal each own their own **words** for the codes
(`packages/pwa/src/lib/account-health-view.ts` and `packages/cli/src/lib/fleet/render.ts`), so the
daemon never ships UI copy and the two surfaces cannot describe the same account differently. Both
show the same four verdicts and the same last-checked instant; neither is a degraded view of the
other.

The PWA's control is **"Check now"**, and its copy states that it uses no inference quota. The copy it
replaces was accurate — "it starts each published account once and waits for a reply" — and that was
the problem: a live spend path in the UI, disclosed rather than removed. Somebody who used the old
button has every reason to assume this one still bills them, so the new copy answers that.

## GAPs — read these before describing what this protects against

1. **The credentialed provider path is not proved on a booted daemon.** The boot-lifecycle journey's
   home holds no credential, so the probe returns `absent` and issues no request — good for
   hermeticity, and it means that journey does not exercise the credentialed path. It is covered
   instead by `packages/fleet/tests/integration/anthropic-usage-probe.test.ts`, which asserts the
   whole request list (exactly one `GET`, never a `POST`) on every status including `403`. Neither
   test proves the conjunction on a real `fyd`, and that residual is the gap. It is **not** closable
   without making `ANTHROPIC_USAGE_URL` injectable — a setting that redirects where a bearer token is
   sent, which is a credential-exfiltration seam added to make a test easier. Refused deliberately.
2. **A sibling inherits the group's remote verdict.** The usage collector probes once per declared
   credential group and copies the reading to siblings, so a sibling's _remote_ evidence is the
   representative's. Its _local_ classification is still read per home, and a dead local copy
   overrides — but a sibling holding a stale-yet-parseable credential can read `healthy`. Fixing it
   needs per-home probing, which multiplies provider calls, or credential comparison, which means
   handling secrets to decide a grouping the author already wrote down.
3. **Real-use outcomes are not observed.** The strongest possible signal — a user-requested turn that
   the provider accepted — is not wired in. Current tmux delivery cannot tell provider success from an
   auth, rate or policy failure, so nothing here reads it.
4. **Refresh is never health evidence.** A successful OAuth refresh would prove the credential was
   accepted, but it mutates and (for Codex) rotates a single-use token, and doing it safely needs a
   cross-process identity lock that does not exist. Health never refreshes anything.
5. **Static-credential accounts have no positive proof.** Missing material and a provider rejection
   are actionable; mere key presence is not `healthy`, and there is no universal free endpoint to ask.
6. **No per-account check.** `POST /v1/fleet/health/check` covers the fleet, exactly as the read does.
   A per-account variant would be a second way to spell the same free collection.
