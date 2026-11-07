# Model catalogs

Every login offers a curated list of models: an Anthropic login offers Opus, Sonnet and Haiku, a GLM
login the GLM coding models, a DeepSeek login DeepSeek's. The list, its labels, its tiers and the
reasoning efforts each model takes come from one **model catalog** per provider. Every model picker
reads it: the composer's chip, Info › Runtime, the new-session form, Settings › Warden and a lessons
scan. So does the launch: Claude Code's tier slots (`/model opus|sonnet|haiku`) are pinned to the
catalog's models, so a slash command and Ferretry's picker always land on the same model — and a Codex
runtime on a third-party provider is given the catalog as the list its own `/model` picker offers
(§ Codex's own picker).

## What a catalog says

One YAML file per provider, `packages/fleet/models/<id>.yaml`:

```yaml
label: GLM / Z.ai
docs: https://docs.z.ai/devpack/tool/claude # the provider's own model documentation
verified: '2026-10-18' # when it was last checked there
unverified: [] # each fact that could not be confirmed, in a sentence
customIds: false # true: the picker also offers "Custom id…"
claude: # what Claude Code is given
  tiers: # Claude Code's tier slots, pinned
    opus: glm-5.3
    sonnet: glm-5.3
    haiku: glm-5.3-flash
    # subagent: …  (CLAUDE_CODE_SUBAGENT_MODEL)
  models:
    - id: glm-5.3
      label: GLM-5.3
      tier: best # best | balanced | fast — how the picker groups it
      context: 1000000 # tokens
      efforts: [low, high, max] # the efforts it takes; leave it out for none
      defaultEffort: max
      default: true # exactly one per half: what a runtime launches with
    - id: glm-5.3-flash
      label: GLM-5.3-Flash
      tier: fast
      context: 1000000
      reasoning: true # it thinks, but its effort cannot be set
codex: # what Codex is given, the same shape without tiers
  models: []
```

- `suffix: "[1m]"` on a Claude Code model is the context suffix the provider tells Claude Code to use;
  it is part of the value the picker sends and the wrapper passes (`--model deepseek-flash[1m]`).
- A tier slot holds a model id, optionally with a context suffix, and must name one of the half's models.
- `detect: ollama` marks a local server whose own model list the daemon reads (§ Local models).
- `retires: '2027-01-31'` on a model is the day its provider retires it, when the provider has announced one.
  `GET /v1/models` carries it, with the model's `note` and its list price (input and output, USD per million
  tokens).

The check is the fleet library's zod schema (`packages/fleet/src/lib/models/schema.ts`), the same one
`fy config schema models` prints. The test suite refuses a build in which any provider preset lacks a
catalog, a half has no models or more than one default, or a tier slot names a model that is not there
(`packages/fleet/tests/unit/models.test.ts`).

## Which catalog a login reads

- A **sign-in** login reads its CLI's maker: Claude → `anthropic`, Codex → `openai`.
- An **environment** login reads the catalog its preset names (`catalog:` in
  `packages/fleet/presets/<id>.yaml`, [provider-presets.md](provider-presets.md)). An existing login
  follows its preset's catalog automatically; nothing is migrated, because a login only names its preset.
- A login made by hand, with no preset, reads none: its runtimes offer their profile's model set, as
  before catalogs.

## What a runtime gets

Decided at apply time by one pure function (`packages/fleet/src/lib/models/runtime.ts`), so the
manifest, the wrapper and the runtime list can never disagree:

- **The models** are exactly the catalog's for the runtime's CLI. The profile's model set no longer
  chooses the list (a profile is shared by logins on different providers), but **its default wins** when
  it names one of the catalog's models, by id or by a tier alias (`opus`).
- **The tier pins** are set in the wrapper's environment (`ANTHROPIC_DEFAULT_OPUS_MODEL`,
  `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`). A pin
  REPLACES the login file's value for that variable — that is how a login made before a model changed
  picks the change up — except for a variable the login's preset declares as the person's to fill in
  (Microsoft Foundry's deployment names), which stands. A profile's own settings environment still wins
  over both.
- **The efforts** a picker offers follow the model in force: its `efforts`, or none at all for a model
  that has none. A Warden investigation offers the Warden's levels (`low`, `medium`, `high`) that the
  model takes. A login with no catalog keeps Claude Code's own levels.
- **Custom ids** (`customIds: true`): the picker offers "Custom id…", and the daemon accepts any one-word
  id for an in-session switch on that login (the same grammar as a catalog id).

The daemon republishes the fleet — rewrites the wrappers and the manifest, writes no configuration file —
whenever what a catalog makes the runtimes offer would change: when it starts with a newer built-in
catalog, and whenever the configuration files are reloaded. A manifest that would read the same is left
alone.

## Codex's own picker

Codex lists the models in ITS catalog — the OpenAI models it ships — in its in-chat `/model` picker and
over its app-server, which is also where Ferretry's composer chip reads a live Codex session's choices
from. It knows nothing of what DeepSeek, Kimi or OpenRouter serve, so a runtime on one of those logins
used to offer GPT models its provider cannot run.

A Codex runtime whose login reads a catalog of someone else's models is therefore launched with
`-c model_catalog_json="<home>/.fy/codex-model-catalog.json"`, a file the apply writes from the login's
catalog (`packages/fleet/src/lib/models/codex-catalog.ts`). Then, in every place that asks Codex:

- Codex's `/model` picker lists exactly the catalog's models — by label, with the catalog's efforts per
  model and a one-line description (tier, context window, note);
- the composer chip lists the same set, since it reads the same app-server, and adds the catalog's tier
  grouping;
- the multi-agent tool's "available model overrides" name those models rather than OpenAI's;
- the context window and default effort in the catalog reach Codex, so its context meter and
  auto-compaction use the model's real window;
- Codex stops warning that it has no metadata for the model.

The model the runtime launches with is listed first, because Codex calls its first model the default.
A switch from either place lands on the same model: the chip drives Codex's own picker by the name the
row carries (the catalog's label), and the switch is confirmed the way it always was, by what the session
reports back (`thread_settings_applied`). A model with no efforts is switched to by its row alone; the
chip sends it without an effort.

**What the file carries.** Once a model has an entry, Codex stops using its fallback metadata for it and
the entry's `base_instructions` is the model's whole system prompt. Every other field therefore repeats
what Codex uses for a model it has no entry for, and the prompt is the one Codex sends in that case
(`packages/fleet/codex/default-instructions.txt`). Measured on Codex 0.145.0 and 0.156.1, the request a
runtime sends is byte-identical to the one it sent without the file — the system prompt, the tools —
except that the reasoning effort is now sent and the sub-agent tool names the right models. Borrowing an
OpenAI model's entry instead would give a DeepSeek model GPT's persona and code-mode-only tools.

**What gets no file.**

- A **sign-in** login, and a catalog of models Codex ships (`openai`, `azure-openai`): Codex's bundled
  entries are richer than anything written here, and a ChatGPT account's list is refreshed per account.
  They keep Codex's list; the catalog adds the label and tier in the chip as before.
- A login with no catalog, and a catalog whose models the login cannot use.
- A runtime whose profile settings already name a `model_catalog_json`: the person's own file is theirs,
  and it is also the way out should a future Codex ever refuse the file Ferretry writes.

**When it is written.** By every apply and republish, in the runtime's `.fy/` folder (Ferretry's own
corner, swept down to what the apply writes), and pointed at by its wrapper. The manifest publishes the
file's format (`codexCatalog`), so a machine that updated Ferretry rewrites its wrappers the first time
the daemon starts, without anyone editing a login. Changing what the renderer writes means bumping
`CODEX_CATALOG_FORMAT`; a test pins the text and fails until it is bumped.

**Keeping it valid.** Codex refuses to START on a catalog file it cannot parse, and ignores keys it does
not know, so the file carries the union of the keys the measured Codex versions require. After bumping
Codex, run both:

- `bun scripts/local/check-codex-model-catalog.ts --codex <codex>` — renders every built-in catalog's file
  and asks that Codex to load it and list the catalog's models, in order, with their efforts;
- `bun scripts/local/refresh-codex-default-instructions.ts --codex <codex>` — re-measures the system
  prompt Codex sends for an unknown model (against a local server, no account) and rewrites the file.

## Changing the list

**For everyone:** edit `packages/fleet/models/<id>.yaml`, check it against the provider's documentation,
update `verified:` and `unverified:`, and merge. Every paired daemon follows it within hours, without a release (§ Live updates).

**On one machine:** write `$FY_HOME/config/models/<id>.yaml` with the same shape (start from the
repository's file). It is a configuration file like any other — checked, last good wins, reported in
Settings › This machine › Files — and it **wins over the published and built-in catalogs of the same id**. A file with
a new id is a catalog for a preset of the machine's own (`catalog: <id>` in its preset file).

## Live updates

A model list changes without a release: Ferretry publishes the catalogs with the hosted app, and every
paired daemon follows them.

**Publishing.** The hosted app's build (`packages/pwa/scripts/build-model-catalog.ts`, run by
`pwa-pages.yaml` on every push to `main`) writes two files beside the app:

- `https://ferretry.pages.dev/catalog/version.json` — `{ "version": N }`;
- `https://ferretry.pages.dev/catalog/models.json` — `{ "version": N, "catalogs": { … }, "prices": { … } }`,
  every `packages/fleet/models/*.yaml` as JSON, with each model's price moved into `prices` (§ Prices).

`N` is the number of commits that changed `packages/fleet/models/`, so it moves exactly when a catalog
does (the Pages build checks out the full history for it, and fails rather than publish from a shallow
one). Both files are listed in the app's **signed release list** ([pwa-release-signing.md](pwa-release-signing.md)),
so `catalog/models.json` carries the same Ed25519 signature the app's own files do — no second key.

**Following.** A daemon reads `catalog/version.json` and compares it with the version it holds:

- **equal** — nothing else is downloaded;
- **different** — it reads `catalog/models.json`, `release-manifest.json` and `release-manifest.sig`,
  and takes the catalog only if the signature verifies with the release key compiled into the daemon
  (`packages/pwa/release-signing-key.pub`) and the signed list names the catalog's exact SHA-256. A
  catalog in it that does not check is left out on its own; anything else wrong refuses the whole
  update, and the catalog held — or the built-in one — stays in effect.

A taken catalog is kept in the state home (`state/model-catalog.json`), so a restart or an offline
machine starts from it. The daemon then republishes the fleet, so every runtime's models, default and
tier pins move with it.

**When it checks.** At boot, and whenever something reads the catalogs (a picker, the runtime list, an
apply) and the last check is older than six hours — never on an idle timer. `fy models refresh` checks
now. A check is plain GETs with no credential and no inference.

**Precedence.** `config/models/<id>.yaml` > the published catalog > the built-in one, per id.
`fy models list` shows which is in effect for each, and `fy models list --login <id>` the one a login
reads.

**Switches.** `FY_MODEL_CATALOG=off` follows no published catalog; `FY_MODEL_CATALOG_ORIGIN=<origin>`
reads it from another origin (a self-hosted app built from this repository). Every test tier runs with
`FY_MODEL_CATALOG=off`, `FY_LOCAL_MODELS=off`, `FY_RELAY_DIRECTORY_ORIGIN=off` and `FY_UPDATE_CHECK=off` (`packages/daemon/tests/support/offline-environment.ts`,
preloaded by each `bunfig.*.toml`), and refuses any in-process fetch to a Ferretry-hosted origin or GitHub's release API.

### How to update the model list

1. Edit `packages/fleet/models/<id>.yaml`: check each id against the provider's documentation, update
   `verified:`, and say what you could not confirm in `unverified:`.
2. `bun test packages/fleet/tests/unit/models.test.ts` — every preset must still have a catalog with
   models, exactly one default per CLI, and tier pins that name its models.
3. Merge to `main`. The Pages deploy publishes the new version within minutes; each daemon takes it at
   its next check (at most six hours, or now with `fy models refresh`). The next release also builds it
   in.

## Prices

Every catalog model may carry its **list price**, and analytics prices a session from it — the
"equivalent API cost" Insights shows: what the session's tokens would have cost at the provider's
published API price. It is never a bill. A subscription login (a Claude or ChatGPT sign-in) reads it as
exactly that, and a negotiated discount, a batch discount or a free tier is not in it.

```yaml
- id: claude-opus-5-5
  label: Opus 5.5
  price:
    provider: anthropic # whose billing rules apply: anthropic | openai | deepseek | moonshot | zai | minimax | alibaba
    input: 4 # USD per million tokens, to six decimals
    output: 20
    cacheRead: 0.2
    cacheWrite5m: 5 # Anthropic bills a cache write by how long it is kept …
    cacheWrite1h: 8 # … so an anthropic price states both; every other maker states one cacheWrite
    # reasoning: 20   (only when it differs from output; every maker here bills thinking as output)
    source: https://platform.claude.com/docs/en/about-claude/pricing # https, no credential, no fragment
    verified: '2026-10-20' # the day it was read there
```

**Every shipped model is priced**, or its catalog's `unverified:` says why not (`gpt-oss` on Ollama runs
locally and has no per-token price; MiniMax-M2.7 is not on MiniMax's pricing page) —
`packages/fleet/tests/unit/models-prices.test.ts` refuses a model that is neither. Every assumption a
price makes is in `unverified:` too: a long-prompt tier priced at its lower rate, a cache write charged as
input where a provider lists no cache-write price, a regional premium.

### Why every session read "Unpriced" before this

Analytics priced a session ONLY from the operator rates in `config/daemon.json`
(`analyticsPricing`), which default to empty — so on every machine nobody had typed rates into, every
session was `unknown_pricing_model`. With rates in place, four spellings and billing shapes decide
whether a session can be priced; the first was already handled, the other three were not:

- **`claude-opus-5-5[1m]`** — the selector's context suffix. Already removed by the shared model-identity
  rule (`packages/protocol/src/lib/analytics-model-identity.ts`), as is a dated revision
  (`claude-opus-5-5-20261001`, `…@20261001`).
- **Bedrock's `-v1:0`** — a Bedrock model version. It is now read as a revision too, so
  `us.anthropic.claude-opus-5-5-20261001-v1:0` is the identity `us.anthropic.claude-opus-5-5`. The
  region prefix (`us.`, `eu.`) is deliberately KEPT: a regional endpoint costs 10% more, and the
  `amazon-bedrock` catalog prices its `us.` ids at that rate.
- **Codex's reasoning tokens** (`gpt-6-astra`) — Codex reports them, and a rate with no reasoning price
  refuses such a session (`missing_reasoning_rate`). A catalog rate prices reasoning at `reasoning`, or
  at `output` when none is stated, because OpenAI bills reasoning as output.
- **Cache writes on a non-Anthropic maker** — an `anthropic` rate needs a session's 5-minute/1-hour cache
  write split, which a DeepSeek or Kimi endpoint behind Claude Code may not report. Naming every maker
  (`provider:`) instead of filing it under `anthropic` or `openai` charges those one `cacheWrite` price.

`packages/daemon/tests/unit/models/pricing.test.ts` prices a session for every priced fleet model under
each of those spellings.

### One row per model: the short tier names

A transcript may say `opus`, `sonnet` or `haiku` where another says `claude-opus-5-5`. Those three words
are the Anthropic catalog's tier slots (`tiers`), so they are **aliases of the model that catalog pins**:
`opus` prices and groups as `claude-opus-5-5`, and Analytics shows one row for it. Another catalog that
lists a model literally called `opus` (Microsoft Foundry does) does not make a second identity — only the
maker's own catalog decides what a tier name means (`anthropicTierAliases` in
`packages/daemon/src/lib/models/pricing.ts`; tests in `tests/unit/models/pricing.test.ts`).

### Unpriced is a gap in the evidence, not in the catalog

When a group reads "≥ $412.50 · 10 unpriced", the catalog had a rate for every one of its sessions. The
unpriced ones have no usable transcript (not found, unreadable, damaged, still being written), no model name
or incomplete token counts; the row says which, by count. The catalog's `validFrom` is 1970-01-01 by design —
a verified price is taken to hold back to the model's launch — so no session predates a rate's window.

### How a price reaches analytics

How a priced session is then queried — metrics, labels, ranges and the merge across machines — is
[the Insights query language](insights-query.md).

- **The same three sources, the same precedence.** A price lives in its catalog, so it follows the catalog:
  `config/models/<id>.yaml` > the published catalog > the built-in one, per catalog id. A machine's own
  copy of a catalog prices its models with whatever it says — including nothing. A published catalog
  that leaves a model unpriced (one published before prices existed, still held by a daemon, or a
  rollback to one) takes this build's built-in price for that same catalog and model; a published price
  still wins over it.
- **Published beside the catalogs, not in them.** `catalog/models.json` keeps `catalogs` in the shape it
  always had, with no `price` key, because a daemon older than prices reads every model strictly and would
  refuse the whole catalog. The prices travel in a top-level `prices` map
  (`{ "<catalog>": { "claude": { "<model id>": <price> }, "codex": … } }`) that those daemons never read
  and this one puts back on each model. A price that does not check is left off its model, never taking
  the catalog with it. Same version, same signature, same check schedule — no second fetch and no timer.
- **Operator rates win, per model.** The daemon's analytics pricing is the operator's rates ∪ one rate per
  priced catalog model, and a model any operator rate names — by id or alias — takes none of the catalog's,
  over any window. A model several catalogs list (Anthropic's ids are also the gateway's and Vertex AI's)
  takes its maker's catalog's price, else the first catalog's by id.
- **Provenance.** A catalog rate's source is `{ kind: 'model_catalog', catalog, sourceUrl }`, its
  `verifiedAt` the price's `verified` day, and it applies from the epoch with no end. An operator's
  `config/daemon.json` cannot hold one: only a daemon reading a catalog states that provenance.
- **Re-pricing.** The pricing catalog is read on every ingestion pass and its fingerprint is in each stored
  session's ingest signature, so a newer published price re-prices the sessions it changes on the next
  pass.
- **Settings › Pricing** lists the catalog prices no operator rate claims, read-only, with their source and
  verified day; **Override** starts a manual rate from one.

### How to update a price

Read the provider's pricing page, change the numbers, set `verified:` to today, and say in
`unverified:` anything the page did not confirm. `bun test packages/fleet/tests/unit/models-prices.test.ts`.
Merging publishes it like any other catalog change.

## Local models

A catalog with `detect: ollama` (the Ollama one) also offers what Ollama has **installed on this machine**.

**Reading.** `GET <address>/api/tags` — the same list `ollama list` prints — through the keyless, loopback-only
read a login Test makes (`ProviderProbePort`, a `local` plan): no credential, no cookie, no inference, nothing
spent. The address is `OLLAMA_HOST` in the forms Ollama itself takes (`127.0.0.1:11434`, `:9999`, `0.0.0.0`,
`http://localhost:12345`), or `http://127.0.0.1:11434`. **Only a server on this machine is ever read**: any
other address is answered `refused` and nothing is sent.

**When it reads.** Never on a timer. The daemon reads once at boot (so a fleet that starts with models
installed publishes them), and again when something asks: `POST /v1/models/local/refresh` — which the app calls
when Add a login or a login's settings opens, and from "Check again". Callers that arrive during a read share
it. The last answer is held in memory only, so a restart forgets it and the next read restores it.
`FY_LOCAL_MODELS=off` reads nothing (every test tier sets it; the answer is `disabled`).

**What it answers** (`LocalModels`): `state` — `found`, `none-pulled` (Ollama runs, nothing installed),
`not-running`, `unreadable` (something answered, not as Ollama does), `refused`, `disabled` — the models
(`id`, size, parameter size, quantization, family, when changed), one actionable `message`, and `pullCommand`,
the exact command that installs the catalog's default (`ollama pull gpt-oss:20b`). A server that is down is an
answer, never an error.

**What a runtime gets.** `runtimeModels` folds the answer in, so every picker and the launch agree:

- `found` — the runtime offers exactly the installed models, each marked `local`. The catalog still describes a
  model it knows (tier, context, efforts); a model it does not know is listed by id; a catalog model that is not
  installed is left out, because it could not launch. The default is the catalog's when installed, else the first
  installed model.
- any other state — the catalog's suggestions stay, and the runtime carries the snapshot (`models.local`) so a
  picker can say what is wrong and show the command.

Codex's own picker follows: the file written for the Ollama catalog (§ Codex's own picker) lists the installed
models too, so `/model` in a Codex session offers what Ollama has, not the two suggestions.

A read that changes what a runtime offers republishes the fleet (as a newer catalog does); one that does not
changes nothing.

## Declared gaps

- **Only Ollama on this machine is detected.** Another host (a GPU box on the network) is refused, not
  dialled, and LM Studio and other local servers are not read. The address comes from the daemon's own
  `OLLAMA_HOST`, which a service started outside a shell may not have.
- **A live Codex session's list is Codex's own for OpenAI's models.** Codex switches models only through its
  own picker, so a running session offers exactly what its app-server reports. On a third-party login that
  is the catalog (§ Codex's own picker); on a sign-in or an OpenAI/Azure key it is Codex's bundled list,
  and the catalog adds the tier and name where an id matches.
- **A Codex session only learns a changed catalog when it restarts.** The file is read when Codex starts, so
  a catalog update reaches new sessions; a running one keeps the list it started with.
- **A model typed with "Custom id…" is not in Codex's picker.** Codex has no entry for it and uses fallback
  metadata, as it did before this file existed.
- **Z.ai's Codex half is still not offered.** The file it needed now exists, but its models, efforts and
  Responses endpoint have not been verified against Z.ai's documentation for Codex.
- **A release-key rotation pauses updates.** A daemon trusts the key it was built with. After the hosted
  app rotates its release key, an older daemon refuses newer catalogs (and keeps the one it holds) until
  it is upgraded.
- **A list price is not per request.** Analytics prices a session's totals, so a price that rises with a
  request's prompt length (Haiku 5.5 over 100K tokens, GPT-6 over 272K, Qwen, MiniMax-M3) is charged at
  its lower tier, and DeepSeek at its peak rate; each catalog's `unverified:` names its case.
- **Kimi's 1-hour cache write is priced as its 5-minute one.** Only Anthropic's billing splits cache writes
  in analytics.
- **A gateway's resolved spelling is not priced.** OpenRouter may record `anthropic/claude-opus-5.5`
  rather than the `~anthropic/claude-opus-latest` alias it was given, and a Foundry transcript names your
  deployment rather than `opus`; such a session stays unpriced unless an operator rate's alias names it.
- **Mantle, Vertex regional and Azure Data Zone premiums** are not in the prices (`unverified:` says which).
- **A browser tab older than this daemon cannot read its pricing view.** The view is strict and now carries
  `modelCatalogRates`; the hosted app deploys before any release does, so this is a stale tab — reload it.
- **Bedrock ids are the US inference profiles** (`us.anthropic.…`). A login whose `AWS_REGION` is outside
  the US needs the `eu.`, `au.`, `jp.` or `global.` ids, in `config/models/amazon-bedrock.yaml`.
