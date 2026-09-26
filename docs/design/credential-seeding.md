# Credential seeding and the refresh-token rotation hazard

Status: **design only — nothing here is built.** Owner decision needed on the recommendation in
[§5](#5-recommendation).

## 1. What happens today

A first run creates the default fleet (`claude-default`, `claude-auto-default`, `codex-default`,
`codex-auto-default`; see [fleet-defaults.md](../fleet-defaults.md)) and **seeds** each new home from
this host's own harness install — `~/.claude` (or its macOS keychain item) and `~/.codex`. The copy is
done by `packages/fleet/src/lib/credential-seed.ts`. It is an **import, not a sync**: one copy at one
moment, after which each home's credential belongs to that home.

The copy is the whole credential, **refresh token included**. So after an ordinary first run, three
homes hold one refresh token per harness: the host's own install, and the two fleet accounts on that
harness's login.

That is what makes "nobody logs in" work. It is also the hazard.

## 2. The hazard

An OAuth access token lives for hours; the refresh token beside it lives much longer and is what gets
a new access token. Some providers **rotate** refresh tokens: redeeming one returns a new one and
invalidates the old.

If the provider rotates, then **whichever copy renews first spends the token every other copy is
holding**:

- A Ferretry account renews first (an agent runs on it, `Renew now`, or `fy fleet login <id>`): the
  person's **own `claude` / `codex` CLI is signed out**. This is the case the owner ranked as
  unacceptable — Ferretry would have broken a login somebody made themselves and never handed over.
- The person's own CLI renews first (they just used it, as they do every day): the **Ferretry copy is
  dead**, and it still _reads_ as renewable, because a home is classified by whether a refresh token
  is present, never by whether it can still be redeemed. `fy fleet health` would say `READY` until an
  agent tries to use it.
- The two fleet accounts on one login hold the same token too, so one lane renewing can sign its
  sibling out. `fy fleet login` repairs siblings (it copies the fresher credential across the login);
  nothing repairs the host's own install, which is outside every login the fleet manages.

What is known:

| Harness | Rotation                                                                                             | Source                                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Codex   | **Proven** single-use, rotating refresh tokens.                                                      | `packages/fleet/src/lib/token-refresh.ts`, `health.ts` (why no Codex liveness probe exists).                                              |
| Claude  | **Unproven.** A replacement token is _stored_ on renewal; nobody has measured that the old one dies. | `packages/fleet/src/lib/seed-provenance.ts`. Separately, a refresh the provider REJECTS makes Claude Code zero its own credential (#375). |

What already exists to limit it:

- **No proactive refresh.** Nothing renews on a timer or at boot (owner rule). Renewal happens only
  when something is used, or when a person presses `Renew now` / runs `fy fleet login <id>`.
- **Disclosure.** `seed-provenance.ts` records a digest of each seeded copy, and `fy fleet health`
  says so under a still-seeded account. A Codex copy gets one plain line of its own — "first use signs
  your own Codex out on this machine — sign it back in once" — because there the consequence is
  proven. A Claude copy gets the conditional: whichever of the copy and the host install renews first
  may sign the other out.
- **No prompt to renew.** Since this change, a refreshable account is `READY` with no command beside
  it, so the report no longer nudges anybody into the renewal that triggers the hazard.

## 3. Constraints on any answer

1. **No proactive or unattended refresh**, from a timer, a boot, a route or a page load.
2. **Never impersonate a client.** No calling a provider's token endpoint as if Ferretry were the
   harness, and no minting grants the provider did not issue to the harness.
3. **Never read, print or move credential material outside the store adapter** (the existing
   use-never-read rule).
4. **Never break the person's own CLI silently.** If something Ferretry does can sign their own install
   out, they are told before it happens, not after.
5. The owner's goal: **a first run needs nobody to log in**, where that can be done honestly.

## 4. Options

### A. Reference the donor instead of copying it

The fleet account uses the host install's credential in place, so there is one copy and one renewer.

- **Symlink the credential file** into the account home. Rejected on evidence already in
  `credential-seed.ts`: both harnesses rewrite their credential by writing a temp file and renaming it
  over the old one, so the first renewal replaces the link with a private file and the fork is back —
  silently. On macOS, Claude's credential is a keychain item whose name derives from the config
  directory, so there is no file to link at all.
- **Point the account at the host's own config directory** (`CLAUDE_CONFIG_DIR=~/.claude`). One
  credential, genuinely shared, renewed by whoever runs first, and nobody signs anybody out. But the
  fleet _writes_ into every account home on apply (instructions, skills, settings, hooks), so this
  would have Ferretry rewriting the person's own `~/.claude`. It also shares history and settings
  between the person and every agent on that account. Rejected for the default fleet; it is a
  legitimate thing for an operator to choose deliberately, as an account whose home is their own.
- **An environment-variable credential** (for Claude, a `CLAUDE_CODE_OAUTH_TOKEN` from
  `claude setup-token`). No refresh token to rotate at all, and it already works through a profile's
  `${secret:NAME}` binding ([fleet-env-profiles.md](../fleet-env-profiles.md)). But it needs the person
  to run a command and store a secret — a login by another name — and it is inference-only. Codex has
  no equivalent for a subscription sign-in. Good as an opt-in, not as the default.

### B. Copy, then take sole ownership with a clear notice

Keep seeding as it is, and say at the moment of seeding what it means: "Ferretry copied your Codex
login. Codex sign-ins are single-use: whichever of your own `codex` and Ferretry's Codex renews first
signs the other out. If your own `codex` asks you to log in, that is why." Pair it with a confirmation
before any **person-initiated** renewal of a still-seeded copy (`Renew now`, `fy fleet login <id>`).

- Keeps "nobody logs in" on day one.
- Honest, and cheap: the digest, the rotation claim and the sentences already exist.
- Does not remove the hazard. For Codex it converts a surprise into a predictable breakage — of
  either the person's CLI or the fleet — usually within days, and an agent's ordinary run is itself a
  renewal, so the confirmation cannot cover every case.

### C. Separate logins per account, signed in from the browser

Do not seed; the first run offers one sign-in per login on the Accounts page, using the existing
harness-login flows ([harness-login.md](harness-login.md)): a pasted code for Claude, a device code
for Codex. Each sign-in is its own grant with its own refresh token, so nothing is shared with the
person's own install and nothing can sign it out.

- Removes the hazard completely, for both harnesses.
- Costs one approval per login — two for the default fleet — which is exactly the tax seeding was
  built to remove.
- The two lanes of one login still share one grant by copy inside the fleet, so the sibling half of
  the hazard remains for a rotating provider (repairable by `fy fleet login`, as today).

### D. Copy, then immediately renew the copy once so it has its own token

Rejected. It is a proactive refresh at boot (constraint 1), and for a rotating provider it is
precisely the act that signs the person's own install out.

### E. Per-harness split

Treat each harness by what is known about it instead of choosing one answer for both:

- **Claude: keep seeding (B)**, because rotation is unproven and seeding is what makes the first run
  work. Prove the question on a throwaway account, never on anybody's real login: seed a copy, renew
  the copy, then check whether the original can still renew. If Claude turns out to rotate, move
  Claude to the Codex answer.
- **Codex: do not copy the host's refresh token by default (C).** The hazard is proven and the victim
  is the person's own CLI. Offer the device-code sign-in on first run, and keep seeding from the host
  as an explicit, disclosed choice ("Copy my Codex login — my own `codex` may need to log in again").

## 5. Recommendation

**E — the per-harness split**, in this order:

1. **Now (this change):** a refreshable credential reads as `READY` with no command, so nothing nudges
   anybody into a renewal, and the seeded-copy disclosure names both directions of the hazard.
2. **Next:** for Codex, stop seeding the host's login by default. The first run declares the Codex
   accounts and the Accounts page offers one device-code sign-in for that login, with seeding kept as
   an opt-in that says plainly what it costs. That is one approval for Codex — a smaller cost than
   silently breaking somebody's own `codex`, which the owner ranked worse.
3. **Next:** for still-seeded copies of either harness, ask before a person-initiated renewal
   (`Renew now`, `fy fleet login <id>`) and say what it may sign out.
4. **Measure Claude** on a throwaway account (above). If rotation is confirmed, apply step 2 to Claude
   too; if it is refuted, record that in `seed-provenance.ts`, flip Claude's claim from `unproven`, and
   the conditional sentences become flat "does not" statements.

Why not the alternatives: A cannot be built without either losing the link on first renewal or having
Ferretry write into the person's own `~/.claude`; B alone keeps a proven breakage for Codex; C alone
charges Claude users an approval for a hazard nobody has shown exists there; D breaks two constraints.

## 6. Open questions for the owner

- Is one device-code approval for Codex on first run acceptable, given the alternative is Ferretry
  signing the person's own `codex` out? The recommendation assumes yes.
- Should the seeding opt-in live in the first-run boot text, the Accounts page, or both?
- Who runs the Claude rotation measurement, and on which throwaway account?

## 7. Declared gaps (true today)

- A seeded copy whose donor renewed first still reads `READY`. Classification is by presence of a
  refresh token; the provenance line says this may have happened, and nothing detects it before use.
- The host's own install is outside every fleet login, so nothing Ferretry does can repair it once a
  fleet renewal has spent its token.
- The PWA does not show the seeded-copy disclosure; only `fy fleet health` does. The PWA `Renew now`
  button on a still-seeded Codex copy is exactly the renewal that signs the host's own `codex` out.
