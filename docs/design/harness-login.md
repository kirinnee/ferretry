---
id: harness-login
title: Can a harness login be driven from the UI?
---

# Can a harness login be driven from the UI?

**Status: PROPOSED. Nothing here is built, and this document changes no production code.**
**Verified against `origin/main` at `81158ca3` (`release: 3.1.2`).**
Every claim about current behaviour below cites a file and line at that commit.

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

1. **A UI for this is already on `main`, and it is one sentence away from the wrong design.**
   `packages/pwa/src/features/fleet/remote-login-surface.tsx` is a complete URL-out / URL-back login
   panel — rendered only in the dev harness (`packages/pwa/harness/main.tsx:630`), dialling nothing,
   because no daemon route exists. Its header says "The daemon owns callback-origin and OAuth-state
   validation" (`:1-8`) and its form says "The daemon checks the callback origin and one-time state"
   (`:281`). Read as _the daemon is the OAuth client_, that is the design this section refuses. Read
   as _the daemon checks the pasted URL belongs to the flow it started_, it is right and it is what
   §3 builds. The component needs no change; the reading has to be written down before somebody
   implements the other one.
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
`remote-login-surface.tsx:150-154`): `clone` re-reads and re-classifies the donor at copy time
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
   the identity, picks the member whose wrapper to launch — `chooseLoginMember` already prefers an
   interactive lane (`identity.ts:356-364`) — and spawns that wrapper with **piped** stdio and the
   sanitized environment of §1.3, adding `--device-auth` for Codex.
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
   report per-account outcomes — `FleetLoginService` already does all of this (`login.ts:157-184`).

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
   (`remote-login-surface.tsx:96-100`, `235-240`).
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
- **The Claude leg depends on the code being PKCE-bound.** That is a property of somebody else's OAuth
  client, not of this repository, and it cannot be cited from here. If it is ever false, the pasted
  code becomes independently redeemable while the daemon holds it for milliseconds — still not a
  stored credential, but a different claim from the one above. It is written down so a future reader
  checks it rather than inherits it.

**The alternative considered and not taken:** instead of writing the code to stdin, the daemon could
replay the whole pasted callback URL at the child's own loopback listener — the harness has a
`callbackPort` setting (`harness-login-flows.md:55`) — so the daemon would never separate the code out
of the URL at all. That is marginally purer and needs a port the daemon must discover, on a path
nothing in this repository has read. Recommendation: **stdin**, because the paste prompt was actually
verified in the binary (`harness-login-flows.md:42-61`) and the port dance was not.

### 4.3 Does a re-login flow need to reach the operator when a token expires?

**Mostly no, and the mechanism people reach for does not exist for this.**

- **An expiring access token usually costs nobody anything.** `refreshable` is a first-class state and
  a legitimate donor precisely because it renews itself on first use (`identity.ts:336-354`). What
  actually strands an account is a dead refresh token — `missing` across a whole identity — which is
  rarer than the fear suggests.
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

## 6. Declared GAPs

- **No notification when an account goes dead.** §4.3 argues the control matters more, and the
  notification needs a daemon-level subject that neither attention nor push has. Named so its absence
  is a decision.
- **No cross-process lock over credential writes.** Pre-existing (§3.3 rule 5); this flow makes it
  reachable from two places instead of one.
- **`RemoteLoginSurface` is Claude-only** (`remote-login-surface.tsx:20`, `55-56`) and its step union
  has no state for "a device code you type at the provider", which is Codex's whole flow. It is a
  state to add, not a rewrite.
- **Nothing here helps an API-key account** (§1.2). Rotating a key is `docs/secrets.md`.
- **`unreadable` still needs a human.** A locked keychain or a credential a newer harness wrote is
  refused, not overwritten (`identity.ts:19-34`), and no UI flow changes that: the correct answer to
  "I could not tell" is still a person looking.

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

**Yes** → the order is: the credential-state read (§4.1) so the fleet table can finally say who needs
a login; then Codex, because `--device-auth` needs no return trip; then Claude's paste leg; then wire
`RemoteLoginSurface` to it and put a control where the dead end is. **That last step is wider than it
looks:** the `quota auth!` readout is one component deliberately shared by the chat header, the fleet
table, the session card and the folder sidebar (`packages/pwa/src/shell/quota-readout.tsx:1-19`), so
the control belongs beside it in the fleet surface rather than inside a readout four screens render.

**No** → the honest alternatives, both coherent:

- **Be `cliproxyapi`.** The daemon receives the callback, exchanges the code and writes the token
  file. It is simpler, it is what was asked for literally, and it ends `use, never read` — choose it
  in those words, and amend `docs/secrets.md:38-42` in the same change or not at all.
- **Keep the login at the host and fix the signpost instead.** The panel says which accounts need a
  login and prints the exact command, and `fy fleet login` stays the only way to run one. That is a
  half-day of work and it does not answer the owner's actual complaint.

**Implementation is not authorised by this document.**

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

| claim                                                     | how to re-check it                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| no daemon route logs the fleet in                         | `rg -n --fixed-strings "path: '/v1/fleet" packages/daemon/src/lib/runtime/mounts/fleet.ts`  |
| `fy fleet login` inherits a terminal                      | `packages/fleet/src/adapters/process-login.ts:89-97`                                        |
| the login command is two literals                         | `rg -n --fixed-strings "HARNESS_LOGIN" packages/fleet/src/adapters/process-login.ts`        |
| credential material never leaves the adapter              | `packages/fleet/src/adapters/credential-store.ts:16-18`, `194-206`                          |
| the wire carries no credential classification             | `rg -n --fixed-strings "refreshable" packages/protocol/src packages/pwa/src` (no hits)      |
| the roster already puts `home` and `wrapper` on the wire  | `packages/protocol/src/lib/fleet-changes.ts:564-577`                                        |
| a login UI already exists and dials nothing               | `rg -n --fixed-strings "RemoteLoginSurface" packages/pwa` (harness and tests only)          |
| both fleet axes default to enabled                        | `packages/daemon/src/lib/grants/policy.ts:42-49`                                            |
| `use` is never password-gated; `configure` is             | `packages/daemon/src/lib/grants/policy.ts:211-229`                                          |
| every attention board is session-scoped                   | `rg -n --fixed-strings "path: '/v1/sessions/:sessionId/attention'" packages/daemon/src`     |
| nothing raises a daemon-caused attention item             | `rg -n --fixed-strings "kind: 'daemon'" packages/daemon/src` (state-machine read-back only) |
| the browser meets a dead end today                        | `packages/pwa/src/shell/quota-readout.tsx:78-86`                                            |
| a relay cannot read a data frame                          | `docs/relay-protocol.md:123-124`, `138`                                                     |
| the remedy the daemon composes is a host command          | `packages/daemon/src/lib/usage/quota.ts:12-17`                                              |
| a terminal cannot be pointed at a command                 | `packages/protocol/src/lib/terminal.ts:96-109`                                              |
| readiness never runs a harness to answer a question       | `packages/daemon/src/lib/core/harness-readiness.ts:22-24`                                   |
| the harness flows were read out of the installed binaries | `docs/migration/surveys/harness-login-flows.md:10-16`                                       |

Use `--fixed-strings` on every one of those greps. `rg -r` is `--replace`, so `rg -rn "pattern" path`
prints each hit with the pattern rewritten to `n` and reads as "it is not there" — the mistake
`docs/grants.md:186-190` records, and one made again while writing this document.
