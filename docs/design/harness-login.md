---
id: harness-login
title: Can a harness login be driven from the UI?
---

# Can a harness login be driven from the UI?

**Status: BUILT.** The decision in §7 was taken and answered **yes**, and §3 is implemented — the
credential-state read, both harness flows, the five routes and the surface that drives them. Section 6
records which GAPs survived and what closed.
**The design was verified against `origin/main` at `81158ca3` (`release: 3.1.2`)**, and every claim
about behaviour BEFORE the build cites a file and line at that commit. Where the build learned something
the design could only assume, the assumption is replaced in place and the observation is dated — §4.2 is
the one that mattered.

It answers the owner's request:

> it would do good if you could do what cliproxyapi do -- where we can login and it can help us keep
> the account logged in via the ui, instead of need us to go in and do a /login -- that is WAY too
> troublesome!

The complaint is correct and the cost is real. An operator who declares six provider accounts must
today walk to the daemon's host, open a terminal, and run `fy fleet login` — a command that only
exists locally (§1.3) — and the browser they were using instead shows them the words `quota auth!`
with no control to resolve it (`packages/pwa/src/shell/quota-readout.tsx:78-86`,
`packages/pwa/src/components/quota-readout.tsx:32-40`).

---

## 0. The part that cannot be copied, first

**`cliproxyapi` keeps accounts logged in by holding their tokens. Ferretry must not, and the reason
is not squeamishness: `docs/secrets.md:38-42` states that no route, command or API returns a secret
value and that the property is enforced by the types rather than by a check. A daemon that received
an OAuth callback, exchanged the code and wrote the token file would be a credential store with a
web front end — which is exactly what `cliproxyapi` is, correctly, because it is a proxy that must
make provider calls itself.**

Ferretry never makes those calls. The harness does. So the whole feature reduces to one question,
and the answer is the design:

> Can the UI drive **the harness's own login** without the daemon ever holding a token?

**Yes.** The credential is written by the harness into the harness's own store, exactly as it is
today (§1.1), and the daemon's part is a verification URL out and one short-lived code back. That is
reconcilable with `use, never read`, and §3 is the shape.

**Two things make it easy to get wrong, and both are already in the tree.**

1. **A UI for this was already on `main`, and it was one sentence away from the wrong design.**
   `packages/pwa/src/features/fleet/remote-login-surface.tsx` was a complete URL-out / URL-back login
   panel — rendered only in the dev harness, dialling nothing, because no daemon route existed. Its header
   said "The daemon owns callback-origin and OAuth-state validation" and its form said "The daemon checks
   the callback origin and one-time state". Read as _the daemon is the OAuth client_, that is the design
   this section refuses.

   > **RETRACTED BY THE BUILD.** This section concluded "the component needs no change; the reading has to
   > be written down". That was wrong, and the reason is a fact neither reading had: running
   > `claude auth login --claudeai` shows `redirect_uri=https://platform.claude.com/oauth/code/callback`
   > — a HOSTED page that shows the reader a code. **There is no localhost callback in this flow at all**,
   > so the panel's "after the provider redirects to the daemon's localhost callback, copy the complete
   > address-bar URL" asked for something a person never sees, and its "the daemon checks the callback
   > origin and one-time state" described a check the daemon cannot perform — it holds no verifier and no
   > state. Neither sentence was salvageable by choosing a reading. The panel is **deleted**, and
   > `claude-login-panel.tsx` and `codex-login-panel.tsx` replace it, one per harness. What it got right
   > is kept: it cleared the field before the request settled, and it said so to the reader.

2. **The already-surveyed plan contains one recommendation that must be dropped for this flow.**
   `docs/migration/surveys/harness-login-flows.md:100-101` advises preferring
   `codex login --with-access-token` (stdin) over flags that take a secret as an argument. That is
   correct advice for a person at the host and wrong for a UI: a route that accepts an access token
   to feed those flags makes the daemon a credential conduit and the browser a credential form. Those
   two flags stay host-and-CLI-only, and §3.3 says so as a rule.

Everything else in this document is cost and sequencing.

---

## 1. What a harness login actually produces

### 1.1 Where the credential lands — three shapes, none of them Ferretry's

`packages/fleet/src/adapters/credential-store.ts:1-23` owns this and states the table:

| harness  | platform | location                                         |
| -------- | -------- | ------------------------------------------------ |
| `claude` | macOS    | keychain item `Claude Code-credentials-<suffix>` |
| `claude` | other    | `<home>/.credentials.json`                       |
| `codex`  | any      | `<home>/auth.json`                               |

`<suffix>` is the first eight hex digits of `sha256(<home>)` (`:284-287`), which is why the home path
must be the resolved absolute one. Files are written `0600` (`:60`, `:135-139`).

**Material never leaves that adapter** (`:16-18`). `read` returns a classification, `clone` copies end
to end, and the only method that yields bytes — `material` (`:194-206`) — is documented
adapter-to-adapter and exists because the usage probe genuinely needs a bearer token to ask a
provider about quota. The daemon constructs that store for exactly that purpose and no other
(`packages/daemon/src/lib/runtime/mounts/fleet.ts:1128-1139`). The port above it has two methods and
neither returns a secret (`packages/fleet/src/lib/identity.ts:414-424`).

### 1.2 Lifetime and shape — and they differ per harness

Both are OAuth access/refresh pairs, and the expiry is read from two different places:

| harness  | credential                | expiry                                                               |
| -------- | ------------------------- | -------------------------------------------------------------------- |
| `claude` | `claudeAiOauth` JSON blob | an `expiresAt` field (`identity.ts:146-156`)                         |
| `codex`  | `tokens` object           | the access token's own JWT `exp` claim (`identity.ts:158-166`, `80`) |

A design that assumed one shape would be wrong for the other, so the classifier is per-harness and
dispatched by kind (`identity.ts:168-171`).

Four states, not two (`identity.ts:51-58`): `valid`, `refreshable`, `missing`, `unreadable` — with
sixty seconds of clock skew before `valid` (`:49`) and the deliberate rule that an access token whose
expiry cannot be read is `unreadable` rather than guessed (`:104-120`).

**An API-key account has no login at all.** `decideIdentity` answers `no-login` with the reason "this
account authenticates with a key" and reads nothing (`identity.ts:377-383`, `456-463`). A UI that
offered a "Log in" button there would be offering a button for a thing that does not exist; changing
an API key is a secrets flow (`docs/secrets.md:91-111`), not this one.

### 1.3 What `fy fleet login` does today, and where it can run

- **It is local.** `fleetRoutes` mounts sixteen paths and none of them is a login
  (`fleet.ts:1223-1428`). The CLI verb resolves identities and runs the login **in this process**
  (`packages/cli/src/lib/fleet/controller.ts:217-235`), and `scoped()` adds only `--json`
  (`packages/cli/src/lib/fleet/commands.ts:22-24`, `120-142`). Nothing about it reaches a daemon.
- **It needs a terminal.** The spawn inherits all three streams
  (`packages/fleet/src/adapters/process-login.ts:89-97`) and the controller says why: "an approval is
  something a human does in this terminal" (`controller.ts:214-216`). That single line is the whole
  reason the feature is troublesome, and it is also the only line the new flow has to change.
- **It runs `<wrapper> /login` or `<wrapper> login`.** Two literals
  (`process-login.ts:24-27`), with a fallback to the bare CLI on `PATH` when the wrapper is missing
  (`:66-72`).
- **It strips provider identity from the environment first** (`:74-77`), because every command in this
  product runs inside an agent session that exports its own credentials
  (`packages/fleet/src/lib/harness-env.ts:1-21`); thirteen names plus a model-default pattern
  (`:28-50`), minus whatever the wrapper itself references (`:13-18`).
- **It refuses rather than guesses.** An identity nobody could classify reports `indeterminate` and is
  neither logged in nor overwritten (`packages/fleet/src/lib/login.ts:48-70`, `118-138`).

### 1.4 Most of the work is already done, which shrinks the UI

`fy fleet login` walks **identities**, not accounts: the freshest usable credential in an identity is
cloned onto the siblings that need one, and only an identity with no usable credential anywhere costs
a human an approval (`login.ts:1-16`). `pickDonor` will donate a merely `refreshable` credential on
purpose, because it renews itself the first time each sibling runs (`identity.ts:336-354`).

So thirty wrappers on six provider accounts are **six** interactions, not thirty — and the UI flow
inherits that arithmetic for free. It also inherits the check the panel on `main` already promises
("The daemon verifies the new credential before copying it",
the deleted panel, whose promise both replacements keep): `clone` re-reads and re-classifies the donor at copy time
(`credential-store.ts:166-192`), and a login that exits zero but leaves the identity with no usable
credential is reported as a failure, not a success (`login.ts:157-184`, `96`).

---

## 2. What `cliproxyapi` actually does, from the user's side

Established from its own management API documentation, not from its source:

1. The management UI asks the server for a login URL — `GET /anthropic-auth-url`,
   `GET /codex-auth-url` — and gets back `{ "status": "ok", "url": "…", "state": "…" }`.
2. The person opens that URL in whatever browser they have.
3. **The provider's callback is received by the server**, at `GET`/`POST /oauth-callback`, which the
   documentation describes as unauthenticated routes taking `provider`, `state` and `code`.
4. The UI polls `GET /get-auth-status?state=…` for `wait` / `ok` / `error`.
5. On success the **server** writes a token file under `auths/`, listed by `GET /auth-files`. The UI
   can also upload an `auth.json` directly.

Source: [Management API — CLIProxyAPI](https://help.router-for.me/management/api),
[router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

**Steps 1, 2 and 4 are the experience the owner is asking for, and Ferretry can have all three.**
Steps 3 and 5 are the part that makes the server a credential holder, and Ferretry needs neither: it
is not the thing that will use the token. Copying the felt shape without copying the token custody is
the entire proposal.

---

## 3. The design that keeps `use, never read`

### 3.1 The shape

One flow at a time per identity, started and read over HTTP, with the harness doing the exchange:

1. **Start.** The caller names an **account id** (never a command, never a path). The daemon resolves
   the identity and spawns **that account's own wrapper** — `chooseLoginDriver` returns the named
   member (`identity.ts`) — with **piped** stdio and the sanitized environment of §1.3, adding
   `--device-auth` for Codex.

   > **This used to launch the identity's interactive lane instead, and that was the defect.** A
   > harness writes its credential into the home of the wrapper that was launched, so signing
   > `claude-auto-default` in put the credential in `claude-default`'s home and left the account
   > somebody clicked signed out with nothing said. `chooseLoginMember`'s reasoning — "a browser
   > approval is interactive" — was about which WRAPPER can show a browser, and it was being used to
   > decide WHICH ACCOUNT gets the credential. The interactive preference survives only for a pass
   > that named nobody, where some lane has to be chosen because one approval covers the identity.

2. **Publish two fields and nothing else.** The daemon reads the child's output only to recognise a
   verification URL and, for Codex, a user code. Those two values are the whole wire projection.
3. **The human authorises anywhere.** Their own phone, their own laptop, their own browser.
4. **Finish.**
   - **Codex** needs no return trip: a device grant completes at the provider and the child exits.
   - **Claude** has no device grant, but its login already degrades to "print a URL, read a pasted
     code from stdin" — verified by reading the binary, `claude-code` 2.1.220
     (`docs/migration/surveys/harness-login-flows.md:36-61`). The pasted callback URL is submitted
     once and written straight into the child's stdin.
5. **Then the existing machinery finishes the job.** Re-survey the identity, clone to the siblings,
   report per-account outcomes — `FleetLoginService` does all of this — and then **read the named
   account's own home once more**. It has to hold a usable credential or that account's row is
   `failed` with a message naming it. A sibling's reading is never evidence about this account: two
   homes are two credentials, and on macOS Claude derives its keychain item name from the home path,
   so a copy that reports success can still have landed somewhere that is not this account's login.

   > **The flow is `reauthenticate`, not the cheapest pass.** A browser Sign in used to run the same
   > `full` pass `fy fleet login` runs with nobody named, which reads what the homes hold — and a
   > credential the provider answers `401` for still classifies as `valid`, because it has an access
   > token and its expiry is in the future. So the identity looked `complete`, every lane was reported
   > `usable`, and **no child was ever launched**: pressing Sign in on the one account the provider was
   > rejecting was guaranteed to do nothing. Naming the account makes it the pass's subject, and
   > `reauthenticate` reaches the provider rather than trusting the homes. A renewal that succeeds
   > still settles the pass with no browser, because a rotated refresh token IS the provider accepting
   > a credential again.

### 3.2 What the daemon holds, exactly, and for how long

This is the reconciliation, and it is worth stating in the narrow form or not at all:

| value                       | is it a credential?       | who can redeem it                                                |
| --------------------------- | ------------------------- | ---------------------------------------------------------------- |
| the verification URL        | no                        | anyone — completing it binds **their** account, see §4.4         |
| a Codex user code           | no                        | same                                                             |
| a Claude authorization code | **yes, for one exchange** | only a holder of the PKCE verifier, which lives inside the child |
| the access / refresh token  | yes                       | **never reaches the daemon** — the harness writes its own store  |

The authorization code is the only credential in the flow, it is bound to a verifier the daemon does
not have, and it is written to a pipe and dropped. **Non-retention is the protection here, not
redaction.** The secrets redactor masks values the vault holds (`docs/secrets.md:44-56`); this value
is never stored anywhere, so there is nothing for it to mask and nothing to depend on it.

**In transit it is no more exposed than the credential already reaching the daemon.** A phone off the
host reaches this product over the relay, and a relay carries `data` frames as AES-256-GCM ciphertext
that are opaque to it (`docs/relay-protocol.md:123-124`, `138`). The code therefore crosses exactly
the channel that already carries the device token every request on that session authenticates with —
so this flow adds no new party to the conversation. It is stated because "does the authorization code
cross a third-party rendezvous in the clear?" is the first question a reviewer should ask, and the
answer must be a citation rather than a reassurance.

### 3.3 Five rules the implementation does not get to negotiate

1. **No route accepts a token, and none returns one.** `codex login --with-api-key` and
   `--with-access-token` are excluded from this flow at every layer (retiring
   `harness-login-flows.md:100-101` for this path). They remain fine for a person at the host.
2. **The child's raw stream is never published, stored or journaled.** Only the two recognised fields
   in §3.1 reach the wire; a line the daemon cannot classify is dropped. Today `fy fleet login`
   inherits stdio and reads nothing (`process-login.ts:89-97`), so this flow makes the daemon a reader
   of harness output for the first time — that is the actual property change, and bounding it to two
   parsed fields is what keeps it small.
3. **The submitted value is write-only.** Never echoed into a status, an error message, a log line,
   the grant audit journal or a transcript. The panel on `main` already holds up its half — it clears
   the field before the request settles and says so to the reader
   (it did, and both replacement panels keep that behaviour and keep saying so to the reader).
4. **No `PATH` fallback in the daemon.** `process-login.ts:66-72` falls back to the bare `claude` /
   `codex` binary when a wrapper is missing. A daemon started by a service manager inherits no shell
   profile — `packages/daemon/src/lib/core/harness-readiness.ts:15-24` exists because of exactly that
   — so the daemon-side flow must launch the absolute wrapper the manifest publishes, and refuse with
   `fy fleet apply` named as the remedy when there is none.
5. **The flow is bounded and single-flight.** Bounded in minutes, like the browser login window's
   1-to-60 (`packages/protocol/src/lib/browser-login.ts:78`); single-flight per identity, because two
   logins into one identity race for the same homes. **Note the pre-existing gap this widens:** the
   fleet's only cross-process lock guards `apply` (`packages/fleet/src/adapters/apply-lock.ts:1-30`,
   used solely by the provisioner), so `fy fleet login` on the host and a daemon-side login already
   have nothing between them once both exist. Either the lock grows to cover credential writes or the
   refusal says which writer holds the identity.

---

## 4. The questions this has to answer

### 4.1 Where does the credential live, and who can read it?

**Unchanged: the harness's own per-home store (§1.1).** The daemon does not gain a credential store,
a copy, or a cache. What it gains is the ability to _start_ the program that writes one.

What a caller may learn is a separate decision, and today the answer is "almost nothing": no route
returns a `CredentialReading`, and no wire schema carries the word `refreshable`
(`rg -n --fixed-strings "refreshable" packages/protocol/src packages/pwa/src` is empty). A UI that
offers a login must be able to say **which accounts need one**, so this design needs a read that
returns the classification and never material — the port for it already exists and already refuses to
hand over bytes (`identity.ts:414-424`).

That read discloses "account X is signed in, and its token expires at T". It discloses no more than
the roster already does: `FleetManifestAccountSummarySchema` puts every account's `wrapper` and `home`
on the wire to any caller with `fleet.use` (`packages/protocol/src/lib/fleet-changes.ts:564-577`).

### 4.2 Can the flow work without the daemon ever holding the secret?

**Yes, for both harnesses, and that is the recommendation.** §3.2 is the whole argument: the daemon
holds a URL, possibly a user code, and — for Claude only — one authorization code that is useless
without a verifier it does not have. The token is minted inside the harness child and written by the
harness.

Two costs come with it, and neither is hypothetical:

- **The daemon reads harness stdout** (rule 2 above). Piping is what makes the flow remotable at all.
- **The Claude leg depends on the code being PKCE-bound, and this is now OBSERVED rather than assumed.**
  It was written here as an assumption that "cannot be cited from here". It can: running
  `claude auth login --claudeai` with piped stdio at **claude-code 2.1.220** (2026-08-19) prints an
  authorization URL carrying `code_challenge=…&code_challenge_method=S256`. The challenge is in the URL
  the child publishes, so the verifier is inside that child and the daemon could not redeem the code it
  forwards even if it kept one. The check a future reader owes is now narrower: not "is it PKCE-bound"
  but "is it STILL", on the version this host has — and the observation is repeatable in one command.

**The alternative considered and not taken:** instead of writing the code to stdin, the daemon could
replay the whole pasted callback URL at the child's own loopback listener — the harness has a
`callbackPort` setting (`harness-login-flows.md:55`) — so the daemon would never separate the code out
of the URL at all. That is marginally purer and needs a port the daemon must discover, on a path
nothing in this repository has read. Recommendation: **stdin**, because the paste prompt was actually
verified in the binary (`harness-login-flows.md:42-61`) and the port dance was not.

### 4.2a Two traps a second implementation had already hit

`kfleet`, the fleet manager this migration replaces, measures usage for providers this build does not,
and two of its findings are invisible to anybody who reads only the endpoint. They are recorded here
because both would be inherited by a future probe written from the obvious reading.

**A provider's usage endpoint may serve data on a STALE token, so `authOk` must not be judged from the
probe succeeding.** `kfleet` reads Codex usage from `GET https://chatgpt.com/backend-api/codex/usage`
and deliberately decides `authOk` from the access token's own JWT expiry instead, because that endpoint
answers for an expired one. Ferretry's `usageEndpointHttpVerdict` decides `authOk` from the HTTP status
(`packages/fleet/src/lib/quota.ts`), which is right for the endpoint it was written for and would report
a signed-out account as healthy if reused here. **Reporting an account healthy is worse than reporting
nothing**, because the failover has nothing to route around.

**An auth-failure code a provider returns transiently must be corroborated before a credential is
condemned.** MiniMax answers `1004` / `2049` for a bad key AND, under load, for a working one;
`kfleet` re-probes up to three times, spaced, before declaring one dead, and its comment records that a
single blip once condemned an account that sixty later probes found fine. A port written from the status
code alone would kill working accounts.

Neither probe is built here — see §6 — and both are written down so that whoever builds one starts from
the trap rather than from the endpoint.

### 4.3 Does a re-login flow need to reach the operator when a token expires?

**Mostly no, and the mechanism people reach for does not exist for this.**

- **An expiring access token usually costs nobody anything.** `refreshable` is a first-class state and
  a legitimate donor precisely because it renews itself on first use (`identity.ts:336-354`). What
  actually strands an account is a dead refresh token — `missing` across a whole identity — which is
  rarer than the fear suggests.

  > **The mechanism is no longer only "it renews itself on first use".** `fy fleet login` now RENEWS an
  > expired-but-refreshable credential deliberately, with no browser and no human, gated on a
  > zero-network local expiry check (#375). So the re-login gap this section argues about has a mechanism
  > with a commit behind it, and the fleet reports `renewed` as its own outcome. **One consequence lands
  > on the sign-in surface:** a rotation the provider REJECTS makes Claude Code zero its own credential,
  > so an account can move from `refreshable` to `missing` with nobody having touched it. That is
  > correct — a refresh token the provider refuses was worth nothing — and it is why the surface says a
  > refreshable credential renews itself _if the provider still accepts it_ rather than promising it will.

- **Something already notices.** The fleet feed carries `authOk`, the daemon composes the remedy
  string "run `fy fleet login` for this account"
  (`packages/daemon/src/lib/usage/quota.ts:12-17`), and the recommender excludes the account with that
  sentence attached (`packages/daemon/src/lib/core/team.ts:280`).
- **What is missing is not detection, it is a control.** The browser renders `quota auth!` with the
  title "this wrapper is not logged in" and nothing to press
  (`packages/pwa/src/shell/quota-readout.tsx:78-86`). Putting the login there is the whole ask.
- **Attention cannot carry this today, and should not be bent to.** Every board is session-scoped —
  `GET`/`POST /v1/sessions/:sessionId/attention` (`packages/daemon/src/lib/runtime/mounts/attention.ts:165-179`)
  — the `daemon` actor's causes are `source-reconciliation`, `warden-escalation` and `system`
  (`packages/daemon/src/lib/attention/state-machine.ts:20`), and **nothing in the daemon raises a
  daemon-caused item at all**: the only construction of that actor is when one is read back from disk
  (`state-machine.ts:429-432`). A signed-out account is not a fact about one session, so filing it
  against whichever session happened to be open would be a lie with an id on it.

**Recommendation: the control, not the notification.** Ship the affordance where the dead end is
today, and declare the push as a GAP (§6) — Web Push exists but is governed as device management
(`docs/grants.md:483-495`) and would need a daemon-level subject that no schema has.

### 4.4 What does a remote device get?

**The risk here is not token theft. It is account substitution**, and it is worth naming because it is
not the risk people look for:

> A caller who can start a login and submit its code can bind the fleet to a provider account **they**
> control. Every agent run afterwards authenticates as that account. Nothing leaked; the fleet was
> quietly re-pointed.

That is a change to how the host behaves, so:

- **Put both routes on `fleet.configure`, not `fleet.use`.** Both axes default to enabled for every
  capability (`packages/daemon/src/lib/grants/policy.ts:42-49`, `docs/grants.md:95-104`), so this is
  not a default change — it is which lock the operator's password reaches. A governed caller with
  `use` alone is never asked for anything (`policy.ts:219`); on `configure`, a machine with a password
  answers `locked` until an unlock is held (`policy.ts:226-229`). `configure` implies `use`
  (`policy.ts:208-209`), so nothing needs a second declaration.
- **Bind the operator password to the _start_, using the machinery that exists.**
  `POST /v1/fleet/proposals/:proposalId/apply` already asks a governed caller to prove the password
  against one exact staged change, spending one of the same five attempts, minting nothing
  (`docs/grants.md:289-318`). A login start is the same shape of artifact: a discrete, named,
  reviewable act ("log identity X in"). The machinery is not fleet-specific and is already three
  pieces: the flag a route reads (`CallerGovernance.confirmChange`,
  `packages/daemon/src/lib/api/capability.ts:110`, set at
  `packages/daemon/src/lib/grants/service.ts:161`), the check
  (`CapabilityGrantService.confirmChange`, `grants/service.ts:187`), and the `'operator-password'` /
  `'none'` answer a panel reads before somebody clicks (`fleet.ts:519`). The fleet's proposal apply
  wires all three today (`fleet.ts:236-239`, `792`), so this needs no new concept and no second
  refusal vocabulary.
- **Use the one prompt.** `features/settings/operator-unlock-dialog.tsx` is the only place a password
  is asked for, and `grants.md:259-272` records what happened the last time a capability grew its own
  inline field inside a staged-change card. The login panel raises that dialog or asks for nothing.
- **A local browser is governed until it unlocks, and `fy` on the host never is** (`grants.md:42-55`).
  So the operator standing at the machine sees no prompt, which is the behaviour `#358` established.
- **Keep the credential minimum where the other fleet routes have it.** Every fleet route is
  `minimum: 'operator'` (`fleet.ts:1226-1230`); an `admin-token` minimum would 403 the browser, which
  is always a paired device (`grants.md:117-121`), and the whole point is the browser.

### 4.5 What breaks if the harness changes its login?

This is somebody else's flow and it will change. Being specific about the blast radius:

| dependency                              | where it is                                        | if it changes                      |
| --------------------------------------- | -------------------------------------------------- | ---------------------------------- |
| `claude /login`, `codex login`          | `process-login.ts:24-27` (two literals, shipped)   | today's CLI login breaks too       |
| `codex login --device-auth`             | new, this flow only                                | Codex loses the remote leg         |
| Claude's paste prompt and its code URL  | new, this flow only, read at `claude-code` 2.1.220 | Claude loses the remote leg        |
| recognising a URL in the child's output | new, this flow only                                | the flow publishes nothing to open |

Three rules keep a third-party change from becoming an outage:

1. **The CLI path must not learn to depend on the parse.** `fy fleet login` keeps inheriting stdio and
   keeps working when every assumption above is false. The host command is the fallback for the whole
   feature, which is the same doctrine `grants.md:151-184` states for any control that can strand
   somebody: the way back is named at the point of failure.
2. **A flow that recognises nothing fails as itself.** It ends, reports that this host's harness did
   not offer a remotable login, and names `fy fleet login` — never a hang and never a bare exit code.
3. **Do not add a boot-time capability probe.** `harness-readiness.ts:22-24` forbids running anything
   to answer a readiness question, for the good reason that a `--version` that hangs hangs the boot.
   Whether this harness supports a remotable login is discovered **per flow**, by the flow.

---

## 5. The interface, so it can become a step later

A separate unit is rebuilding fleet onboarding as a stepper. This design requires nothing from it and
should be able to become one of its steps unchanged, which means the seam is four calls and no shared
state:

```
start(accountId)  -> { flowId, state: 'awaiting-url' | 'awaiting-code' | 'complete' | 'failed', url?, userCode? }
status(flowId)    -> the same projection, polled
submit(flowId, v) -> the same projection; v is write-only and single-use
cancel(flowId)    -> ends the child and the flow
```

Two precedents this should follow rather than reinvent:

- **The lifecycle vocabulary** of the browser login window: one path, GET reads and POST carries an
  explicit human intent, `noStore` because the status is short-lived material, and a state-
  discriminated projection so an absent field renders as absence
  (`packages/daemon/src/lib/runtime/mounts/browser-login.ts:26-74`,
  `packages/protocol/src/lib/browser-login.ts:32-76`).
- **The submission semantics** of `POST /v1/sessions/:sessionId/answer`: a bounded, once-only
  submission carrying a request id, whose failure taxonomy keeps `refused`, `conflict` and
  `unconfirmed` apart because they are three different next actions
  (`packages/daemon/src/lib/runtime/mounts/session-answer.ts:8-33`). A login submission needs the same
  `unconfirmed` honesty: "nobody can say whether that code reached the child" is a real outcome and
  must not read as a retry invitation.

Also worth knowing, because it looks like a shortcut and is not: **a session terminal cannot be
pointed at a command.** `CreateTerminalRequestSchema` carries a title, a size and an opener, and no
command (`packages/protocol/src/lib/terminal.ts:96-109`); terminals are shells attached to a session's
working directory (`packages/daemon/src/lib/runtime/mounts/terminals.ts:24-40`). "Just open a terminal
running the login" would mean widening that contract, and it would still put an interactive harness
UI in front of a phone.

---

## 6. Declared GAPs, restated against the shipped state

### Closed by the build

- **The dead end itself.** `quota auth!` had nothing to press. There is now a **Sign-in** settings tab
  beside Fleet that says which accounts need one and offers it, and both quota readouts name where to go.
  The control is there rather than inside the readout for the reason §7 gives: that component is rendered
  by the chat header, the fleet table, the session card and the folder sidebar.
- **`RemoteLoginSurface` was Claude-only, and it is gone rather than extended.** Its header claimed the
  daemon owns "callback-origin and OAuth-state validation" and its copy asked for a URL redirected to "the
  daemon's localhost callback". Neither is this design: the daemon holds no verifier and no state, and
  `redirect_uri` is `https://platform.claude.com/oauth/code/callback` — a hosted page that shows the
  reader a CODE, with no localhost callback anywhere in the path. A panel that told a person otherwise
  would have described the daemon as the OAuth client, which is what §0 refuses. It is replaced by
  `claude-login-panel.tsx` and `codex-login-panel.tsx` — one per harness, because a paste field and a
  device code are two shapes, not one with two options.
- **No route returned a credential classification.** `GET /v1/fleet/login` does, per identity and per
  lane, and it says where a credential comes from when a sign-in does not apply.

### Still open, and now with an owner where there is one

- **No notification when an account goes dead.** Unchanged, and still a decision rather than an omission:
  §4.3's argument holds, and a daemon-level attention subject still does not exist. The **control** shipped;
  the **push** did not.
- **No cross-process lock over credential writes.** Pre-existing (§3.3 rule 5) and now genuinely reachable
  from two places: `fy fleet login` on the host, and a flow here. The daemon-side service is single-flight
  **within itself** and its refusal says which flow holds an identity; it makes no claim about the host.
- **Nothing here helps an API-key account** (§1.2). Unchanged — and the build makes the ABSENCE legible
  rather than silent: such an account gets no control and a sentence naming the file or the variable its
  credential comes from. Rotating a key is still `docs/secrets.md`.
- **`unreadable` still needs a human.** Unchanged. The surface reports it as `Could not be read` with the
  daemon's own reason, and offers no sign-in for it, because the fleet's verdict for that identity is
  `indeterminate` rather than "needs a login".
- **No usage probe for Codex, z.ai/GLM, MiniMax, or a CLIProxy pool.** The sign-in surface SHOWS what this
  host measures and says **unknown** where nothing measured — never `0%`, and never "token-based", because
  a ChatGPT subscription does have windows and nobody read them. Each probe is a known technique with a
  recorded trap (§4.2a); `usage.cliProxy` is already a declared unimplemented capability that a
  configuration asking for it is REFUSED on, and building any of them is separate work.

### Found by verifying the shipped build, and deliberately not fixed here

Three defects. The first two are listed apart because a fix for the first makes the second moot while a
fix for the second would leave the first exactly where it is; the third is independent of both. All three
were measured on one host at **claude-code 2.1.220** and **codex-cli 0.145.0** — a measurement of somebody
else's CLI is only true at a version.

- **GAP: the generated wrapper prepends an account's session flags to a login SUBCOMMAND.**
  `renderWrapperScript` ends every wrapper with `exec <binary> <account flags> "$@"`
  (`packages/fleet/src/lib/wrappers.ts:259`), and both login paths launch `[wrapper, <login argv>]` — the
  daemon's flow at `packages/daemon/src/lib/fleet-login/service.ts:536` and `fy fleet login` at
  `packages/fleet/src/adapters/process-login.ts:78`. So a flag declared for a SESSION arrives in a
  position no harness promises to accept it in, and the two harnesses disagree about what happens next:

  ```
  codex login --device-auth                                            # prints a URL and a user code
  codex --full-auto login --device-auth                                # error: unexpected argument
                                                                       #        '--full-auto' found
  codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen login --device-auth   # works
  claude auth login --claudeai                                                            # works
  claude --dangerously-skip-permissions --disallowed-tools=AskUserQuestion auth login --claudeai  # works
  ```

  Codex's parser (clap) refuses an unknown ROOT argument outright; Claude's (commander) passes root flags
  through to the subcommand. **Both harnesses' shipped starter flags survive at these versions**
  (`lib/scaffold.ts` declares `--dangerously-skip-permissions` / `--disallowed-tools=AskUserQuestion` for
  Claude's auto lane and `--dangerously-bypass-approvals-and-sandbox` / `--no-alt-screen` for Codex's), so
  a default fleet is unaffected. What breaks is an operator-declared codex root-only flag — `--full-auto`,
  `--model`, `--sandbox`, `--cd` — or any future release that moves a flag which is tolerated today.
  **Its reach grew, deliberately.** `chooseLoginDriver` now launches the NAMED account's own wrapper,
  so signing an auto lane in reaches the auto lane's flags rather than borrowing an interactive
  sibling's. That is the correct trade: borrowing hid this defect by authenticating a **different
  account** and reporting success, whereas this fails loudly, names the account, and leaves the
  operator's own declared flag as the thing to fix. The composed argv is pinned by
  `packages/fleet/tests/integration/process-login.test.ts` — as a reproduction, not as a contract.
  Not fixed here because every honest fix — a login-safe path in the wrapper, a second flagless wrapper
  per account, or a login that bypasses the wrapper — changes the bytes of the executables Ferretry
  writes into somebody's home, which deserves its own change and its own review.

- **GAP: the failure that results names the wrong cause and a remedy that cannot work.** A harness that
  refuses the flag prints neither a URL nor a code, so the flow lands on §4.5 rule 2's "recognised
  nothing" path and reports _this host's codex did not offer a sign-in that can be driven from a browser_,
  remedy _sign this account in on the host with `fy fleet login`_. Both halves are wrong for this cause:
  the harness offered a sign-in and Ferretry's own wrapper prevented it, and `fy fleet login` composes the
  same flags and fails identically. The person is sent to the one command that cannot help, with nothing
  naming the flags. Pinned at
  `packages/daemon/tests/unit/fleet-login/service.test.ts` ("should end as itself when it recognised
  nothing it could publish"), whose comment names this defect so a green test is not read as approval.

- **GAP: a REJECTED code is indistinguishable from no attempt at all.** Driving the shipped spawn adapter
  against the real `claude auth login --claudeai` with a wrong code, the harness answers
  `Invalid code. Please make sure the full code was copied.` on its own output and keeps running. The
  write did land, so the daemon answers `accepted` — which is true about the write and is not the question
  the person is asking — and the flow stays `awaiting-code`, so the panel clears the field and shows the
  same paste form again **with nothing saying the previous attempt was refused**. Somebody who mistypes one
  character of a code sees a form reset and cannot tell "rejected, try again" from "nothing happened" from
  "still working"; the retry does work, which is the only reason this is a usability defect rather than a
  dead end.

  It follows from §3.3 rule 2 — only two recognised values may leave the reader — and that rule is right:
  forwarding arbitrary child output to a remote client is how a token escapes. But **"the harness refused
  the code" is a recognisable STATE, not arbitrary output.** A third recognised value carrying no child
  text at all would say it, so the rule that produced this gap does not stand in the way of closing it.
  Not fixed here for the same reason as the two above: it reaches the flow, the wire contract and the
  panel, and it is not what the change this was found in is about.

### Named because it has an owner now

- **Silent token renewal**, the mechanism that shrinks the notification gap by reducing how often anybody
  is asked at all: renew an expired-but-refreshable credential with no browser and no human, gated on a
  zero-network local expiry check. It is being built as its own unit (`feat/silent-token-refresh`) behind
  `FleetTokenRefreshService`, deliberately outside this change: it is a third spawn path with two more
  undocumented third-party dependencies. **One consequence lands on this surface and is worth knowing:** a
  rotation the provider REJECTS makes Claude Code zero its own credential, so an account can move from
  `refreshable` to `missing` with nobody having touched it — which is why this surface says a refreshable
  credential renews itself "if the provider still accepts it" rather than promising that it will.

---

## 7. The decision

The engineering is tractable and mostly already written. The trade is one question:

> **Do we build a daemon-orchestrated harness login in which (a) the daemon spawns the account's own
> wrapper with piped stdio and a sanitized environment, (b) the only values published are a
> verification URL and a device/user code, (c) the only value accepted back is one short-lived
> authorization code written straight to that child's stdin and retained nowhere, (d) no route ever
> accepts or returns a token — `--with-access-token` and `--with-api-key` stay host-only — and (e) the
> two routes sit on `fleet.configure` with the existing per-change operator-password confirmation on
> the start?**

**Yes** → the order was: the credential-state read (§4.1) so a surface can finally say who needs a
sign-in; then both harness legs; then the surface that drives them and the control where the dead end was.
**That last step was wider than it looks:** the `quota auth!` readout is one component deliberately shared
by the chat header, the fleet table, the session card and the folder sidebar
(`packages/pwa/src/shell/quota-readout.tsx:1-19`), so the control went **beside** it — a Sign-in tab
immediately after Fleet — rather than inside a readout four screens render. Both readouts gained one
sentence naming where to go, which is the only change either of them needed.

**No** → the honest alternatives, both coherent:

- **Be `cliproxyapi`.** The daemon receives the callback, exchanges the code and writes the token
  file. It is simpler, it is what was asked for literally, and it ends `use, never read` — choose it
  in those words, and amend `docs/secrets.md:38-42` in the same change or not at all.
- **Keep the login at the host and fix the signpost instead.** The panel says which accounts need a
  login and prints the exact command, and `fy fleet login` stays the only way to run one. That is a
  half-day of work and it does not answer the owner's actual complaint.

**The decision was taken and the answer was YES.** What shipped differs from the sketch above in three
places, each stated so a reader is not left comparing prose to code:

1. **One flow per harness, not one parameterised flow.** `claude-flow.ts` and `codex-flow.ts` are two sets
   of pure functions over two different stage unions, dispatched by a `switch`, with no base class and no
   shared driver. Codex needs a partial stage (two values arrive on two lines) and has no submission at
   all; Claude has a submission and no device code. A single flow would have needed both as options, which
   is a shape that can express a Codex sign-in waiting for a paste.
2. **A login is DECLARED per harness** — `packages/fleet/src/lib/harness-login.ts`. Both shipped harnesses
   declare one, and the `false` arm exists so that the day a harness that does not is added, the assumption
   is a compile error rather than an invisible one.
3. **The credential SOURCE decides whether a sign-in applies at all** —
   `packages/fleet/src/lib/credential-source.ts`, derived from the declared configuration and nothing read
   from the host. A credential that arrives from a token file, the environment or the configuration gets no
   control and a sentence naming where it does come from. This is not in §3 because §3 asked whether the
   flow was possible; this is what stops it being offered where it cannot succeed.

Five routes, not four: the §5 seam plus the credential-state read §4.1 asks for, which is the one that was
blocking everything else. The seam is otherwise unchanged and the stepper was not touched.

---

## Appendix A: what this document does not propose

- **No change to the credential store.** No new reader, no getter, no cache. `material` stays
  adapter-to-adapter (`credential-store.ts:194-206`).
- **No change to `fy fleet login`.** It keeps inheriting a terminal and stays the fallback for
  everything the remote flow cannot do.
- **No new capability.** `fleet` covers this; `docs/grants.md:151-184` sets the bar for a seventh and
  this does not meet it.
- **No use of the VNC login window.** `/v1/browser/login` primes an agent's Chrome profile, and its
  status is reached with a VNC client over the operator's own SSH tunnel
  (`packages/protocol/src/lib/browser-login.ts:14-30`). It is a good precedent for lifecycle shape
  (§5) and a bad answer for a phone.
- **No opinion on the stepper's screens.** §5 is a seam, not a layout.
- **No fix for the fleet's missing credential-write lock** (§6). It is pre-existing.

## Appendix B: the claims a reader is most likely to want to re-check

**Four rows below were TRUE BEFORE THE BUILD AND ARE FALSE NOW**, and they are marked rather than
deleted: a reader comparing this document to `main` needs to see which claims moved. A grep whose answer
has inverted is the dangerous kind — "no hits" reads as confirmation either way — so each says what the
answer is now.

| claim                                                                                                           | how to re-check it                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~no daemon route logs the fleet in~~ **NOW FALSE**: five do                                                    | `rg -n --fixed-strings "path: '/v1/fleet/login" packages/daemon/src/lib/runtime/mounts/fleet-login.ts`                                                                 |
| `fy fleet login` inherits a terminal                                                                            | `packages/fleet/src/adapters/process-login.ts:89-97`                                                                                                                   |
| the login command is two literals                                                                               | `rg -n --fixed-strings "HARNESS_LOGIN" packages/fleet/src/adapters/process-login.ts`                                                                                   |
| credential material never leaves the adapter                                                                    | `packages/fleet/src/adapters/credential-store.ts:16-18`, `194-206`                                                                                                     |
| ~~the wire carries no credential classification~~ **NOW FALSE**                                                 | `rg -n --fixed-strings "refreshable" packages/protocol/src packages/pwa/src` — `FleetCredentialReadingSchema` carries it                                               |
| the roster already puts `home` and `wrapper` on the wire                                                        | `packages/protocol/src/lib/fleet-changes.ts:564-577`                                                                                                                   |
| ~~a login UI already exists and dials nothing~~ **NOW FALSE**: it is deleted, and the two that replace it dial  | `rg -n --fixed-strings "startHarnessLogin" packages/pwa/src` — a grep for `RemoteLoginSurface` now finds NOTHING, which is the answer inverting rather than confirming |
| both fleet axes default to enabled                                                                              | `packages/daemon/src/lib/grants/policy.ts:42-49`                                                                                                                       |
| `use` is never password-gated; `configure` is                                                                   | `packages/daemon/src/lib/grants/policy.ts:211-229`                                                                                                                     |
| every attention board is session-scoped                                                                         | `rg -n --fixed-strings "path: '/v1/sessions/:sessionId/attention'" packages/daemon/src`                                                                                |
| nothing raises a daemon-caused attention item                                                                   | `rg -n --fixed-strings "kind: 'daemon'" packages/daemon/src` (state-machine read-back only)                                                                            |
| ~~the browser meets a dead end today~~ **NOW FALSE**: the readout names where to go, and a Sign-in tab is there | `rg -n --fixed-strings "Settings ▸ Fleet" packages/pwa/src`                                                                                                            |
| a relay cannot read a data frame                                                                                | `docs/relay-protocol.md:123-124`, `138`                                                                                                                                |
| the remedy the daemon composes is a host command                                                                | `packages/daemon/src/lib/usage/quota.ts:12-17`                                                                                                                         |
| a terminal cannot be pointed at a command                                                                       | `packages/protocol/src/lib/terminal.ts:96-109`                                                                                                                         |
| readiness never runs a harness to answer a question                                                             | `packages/daemon/src/lib/core/harness-readiness.ts:22-24`                                                                                                              |
| the harness flows were read out of the installed binaries                                                       | `docs/migration/surveys/harness-login-flows.md:10-16`                                                                                                                  |

Use `--fixed-strings` on every one of those greps. `rg -r` is `--replace`, so `rg -rn "pattern" path`
prints each hit with the pattern rewritten to `n` and reads as "it is not there" — the mistake
`docs/grants.md:186-190` records, and one made again while writing this document.
