# Environment profiles

A profile can **authenticate an account instead of a login**: a named, reusable set of environment
variables, with the credential itself held in this daemon's secret store and never in the profile.

Read [Secrets](./secrets.md) first. This feature adds no new protection of its own — it makes an
account's credential one of the things that store already holds, and everything the threat model
there says applies here unchanged.

## The shape

```yaml
profiles:
  work:
    env:
      ANTHROPIC_BASE_URL: https://gateway.example.internal
      ANTHROPIC_API_KEY: '${secret:WORK_KEY}' # a reference. Never a value.
agents:
  - name: kirin
    kind: claude
    auth: api-key
    profiles: [work]
    routes:
      default:
        id: 5c2a1e14-9f0e-4a1a-9f7b-2b8d3f5a6c71
        wrapper: claude-kirin
        home: kirin
        defaultModel: claude-opus-5
        models: [claude-opus-5]
```

```bash
printf %s "$THE_KEY" | fy secret set WORK_KEY   # the value, once, on stdin
fy fleet apply                                  # wrappers and manifest, as usual
fy secret ls                                    # WORK_KEY, and the account that reaches for it
```

That account now runs with no sign-in. At launch the daemon resolves `${secret:WORK_KEY}` and puts
the value into the pane's environment; the fleet configuration, the generated wrapper and the
published manifest each carry the **name** `WORK_KEY` and nothing else.

**A profile is opt-in and a fresh account needs none.** An account that authenticates by an ordinary
login is untouched by every rule below, publishes an empty `secretEnv`, and never opens the store.

## There is no second profile system

A profile already existed. [`config.ts`](../packages/fleet/src/lib/config.ts) declares one,
[`profiles.ts`](../packages/fleet/src/lib/profiles.ts) composes several into one account, and `env`
has always been one of the fields they compose. What a profile could not carry was a **credential**,
because every value it held was written into a generated wrapper script in plain text — which is also
why `portableEnvironment` refused to copy a credential-named variable at all.

So this adds **one spelling to the value grammar** and nothing else. An environment value is now one
of three things:

| Spelling             | Where the value is when the wrapper runs                                   |
| -------------------- | -------------------------------------------------------------------------- |
| `${secret:NAME}`     | this daemon's secret store; the daemon puts it in the launch               |
| `$NAME` or `${NAME}` | the environment the wrapper is launched with, or the declared secrets file |
| anything else        | the fleet configuration, exported by the generated wrapper as a literal    |

A secret-backed variable composes exactly as a literal one does. Anyone who reads this as a parallel
mechanism will try to "simplify" the two into one; there is only one.

## Composition, and how to see it

**Right wins, and it is the composition profiles already had.** There is no second precedence rule:

```
base profile → agent.profiles → variant.profiles → variant inline → agent inline → account
```

`env` merges key by key, so the last slot to set a variable is the one whose value is used and a slot
that sets nothing takes nothing away. Inside one slot a `claude:`/`codex:` overlay beats that slot's
flat fields, and a later slot's flat field still beats an earlier slot's overlay.

**One owner: `compositionSlots`.** The report below READS that chain rather than restating the order.
Two hand-written orderings would eventually disagree exactly where it matters most — on an account
whose credential is not the one the report claims it is.

**Where a person sees it.** Every secret an account reaches for is a row in the daemon's secret
listing (`GET /v1/secrets`, and **Settings → this daemon → Secrets** in the PWA), whose origin names
the account, the variable, the slot that won and the slots it beat:

> `WORK_KEY ← fleet account claude-kirin → ANTHROPIC_API_KEY, set by this account, overriding the base profile and the profile "work"`

The winner alone would not be enough: told only that, a person cannot tell a deliberate override from
the same variable typed into two profiles by mistake. The listing also says whether the store actually
holds each one, so an account whose credential is missing is a line on a screen **before** anything
runs rather than a session that dies at start.

**Vocabulary.** These sentences say "the base profile", "the profile X", "the variant X", "the agent
X", "this account" — never "layer" and never "lane". Both words were removed from every screen in
`#384` after the owner asked what a layer was and said it was far too complicated, and a sentence
explaining where somebody's API key came from is the last place to bring one back. There is an
assertion enforcing it.

## Use, never read

**No route, command or error message returns a profile value.** A value reaches exactly one place:
the environment of the child process launched for that one account. Every reader, traced:

- `resolveSecretEnvironment` is the only function that touches a value, and its one production caller
  is `FleetLaunchEnvironment.forWrapper`.
- `forWrapper` has two production callers — the lifecycle launcher and the resume launcher — and both
  pass the result straight into the pane being launched. Nothing stores it, logs it, caches it or
  answers it.
- `MissingFleetSecretsError` names the account and the missing **secret names**.
- `fleetSecretReferences` answers names and the origin sentence above.
- `envComposition` answers a SHAPE — `literal`, `environment-reference` with the variable it reads, or
  `secret` with the names it binds. The `literal` arm deliberately carries **no text at all**: most
  literals are harmless, some are not, and there is no rule deciding which that stays right.
- The generated wrapper carries a **requirement** and no value (asserted byte for byte).
- The published manifest's `secretEnv` carries references only, **enforced by its schema** — an entry
  naming no secret refuses the whole manifest.
- The real-`fyd` journey asserts the fixture value appears nowhere in the secret listing's response.

If that makes a surface awkward, the surface is what changes. A getter added so a screen could show
the value would delete the property the subsystem exists for.

**`FleetLaunchEnvironment` is the third thing in this daemon that holds a `SecretVault`**, after the
redactor and the `use` executor. It is the same kind of holder as the second: it produces an
environment for one child and hands it to the thing that launches it.

## What is refused, and when

**At parse time, by name.** `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `CODEX_SQLITE_HOME` choose which
home a wrapper uses, so a profile that set one could point an account at another account's
credential. `EnvSchema` checks keys explicitly rather than through a key schema, precisely so the
message names the offender:

> `"CODEX_HOME" is reserved — an account's home is declared by its "home" field, not by the environment`

That refusal stands when the value is a secret reference too, so a profile cannot smuggle a home past
it.

**A malformed reference is refused, never treated as a literal.** `${secret:work_key}` matches no
reference, so exporting it verbatim would authenticate the harness with the text of the reference — a
credential failure invisible in every place a person would look. It fails the configuration instead,
quoting what was written.

**A missing secret refuses the launch, naming every one of them.** Never an empty string in its place:
a blank API key is a 401 twenty minutes later, from a remote service, with nothing on this machine to
point at. All the missing names at once, because one at a time turns one mistake into four round trips.

**A damaged vault also refuses**, for the same reason it refuses a redaction: a vault that cannot be
opened is not a vault with nothing in it, and launching as though the profile were empty would
authenticate the account as somebody else, or as nobody.

**The session wins over the profile.** A session's own document carries the credential a task board
issued it and any variable a grant delivered, and those name that one session; a profile is shared by
every account that lists it. A profile able to overwrite them could take a teammate's board
capability away, so precedence runs the only direction that cannot do that.

## The two halves read different documents, on purpose

The **launch** path reads the published manifest. The **reference listing** reads the fleet
configuration. That looks like an inconsistency and is not:

- A start must not depend on `config.yaml` parsing. A typo there would refuse every session on a host
  whose wrappers are perfectly good, and the manifest is written by the same apply that writes those
  wrappers, so it cannot describe an account differently from the wrapper that will run.
- The configuration is the only place that knows **which profile** set a variable, which is the whole
  answer somebody wants when an account reaches for a secret they have never heard of.

Both reasons are in the module headers. Do not unify them.

## Stated consequences

- **A wrapper started from a plain shell fails for a profiled account.** By design: the value is in
  the daemon's store and no generated script can produce one. The wrapper's own guard says which
  secret is missing and what to run, so a mis-wired daemon fails loudly rather than authenticating as
  nobody. Launch such an account through the daemon.
- **No login is offered for it, and that is the point.** A secret-backed credential is not an
  interactive login, so the sign-in surface reports `credential-is-not-a-login` and says where the
  credential does come from instead.
- **It costs nothing when nobody uses one.** An account that binds no secret answers `{}` without the
  store being opened at all, so a fleet of ordinary logins keeps working on a host whose vault is
  damaged. A test counts the opens.

## What is not built yet

- **No surface for creating a profile — GAP.** A profile is written in the fleet configuration today.
  The PWA half of this feature is a separate change and is not in this one.
- **The browser is told `environment`, not `secret-store` — GAP.** `credentialSourceOf` answers
  `secret-store` and every host-side surface reads it; the wire union has no such member, so the
  sign-in row narrows it to `environment` with the variable's name. That is TRUE of it — the daemon
  does put the value into the environment the wrapper is launched with, and the "nothing to sign in
  to" verdict is identical — and what the browser loses is the sentence naming Ferretry's own store.
  Widening the protocol union means a matching arm in the browser's copy: **do not add the member
  without that arm in the same commit**, or the browser renders its total fallback sentence
  ("the harness writes this account's credential into its own store when somebody signs in") for
  exactly the accounts this feature is for.
- **Composition is visible only for secret-backed variables — GAP.** The listing above is a listing of
  secrets, so a purely literal profile still composes with no surface reporting where its values came
  from. `envComposition` answers that for every variable and nothing renders it; the report a screen
  would need is a screen's worth of work, not a getter, and it belongs with the surface that shows it.
- **The resume path's composition-root line is typechecked, not executed — GAP.** A real-`fyd` journey
  proves the START path's wiring in `bin/fyd.ts`, and the resume adapter's own branch has integration
  coverage, but no test executes the one line in `bin/fyd.ts` that hands the resolver to the resume
  launcher. `bin/**` is in neither coverage ledger. The exposure is bounded — `agent` is a required
  field of the recorded lifecycle document, so a revive cannot silently lose which account it is — and
  the failure mode if that line is ever deleted is a revived pane with no credential, which the
  wrapper's own requirement guard refuses.
- **Secrets still do not travel between paired daemons, and are still not scoped per session.** Both
  are declared in [Secrets](./secrets.md) and a profile changes neither: every session this daemon runs
  could ask to use `WORK_KEY` by name, and a second host has to be given the value once itself.
