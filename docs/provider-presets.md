# Environment logins and provider presets

A **login** is either **sign-in based** (Claude's OAuth, Codex's device code) or **environment based**: a
named set of environment variables Ferretry puts into the CLI's process when it launches a ferret. That
is how Claude Code runs against Bedrock, Vertex, GLM or OpenRouter, and how Codex runs against an OpenAI
API key or any Responses-compatible provider. A provider that serves **both** CLIs is **one** login with
**one** secret that drives either. This page is the design note; the code is `@ferretry/fleet`'s
`account/environment.ts`, `account/halves.ts` and `presets/`, and the daemon's `lib/provider-probe/`.

## What an environment login holds

`logins/<id>.yaml` ([config-files.md](config-files.md)), for a provider that serves one CLI:

```yaml
harness: claude
store: environment
preset: zai-glm # display, Test and quota only
env:
  ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic # a plain value, shown
  ANTHROPIC_AUTH_TOKEN: ${secret:ZAI_API_KEY} # a secret, by NAME
cloudCredential: aws-profile:acme # optional: a credential this machine already has
```

and for one that serves both — one login, one secret, a **half** per CLI:

```yaml
harness: claude # the CLI listed first: a runtime runs it when nothing else says
store: environment
preset: deepseek
env: # optional: given to both halves
  API_TIMEOUT_MS: '600000'
claude: # what Claude Code is given
  env:
    ANTHROPIC_BASE_URL: https://api.deepseek.com/anthropic
    ANTHROPIC_AUTH_TOKEN: ${secret:DEEPSEEK_API_KEY}
codex: # what Codex is given
  env:
    DEEPSEEK_API_KEY: ${secret:DEEPSEEK_API_KEY}
  codexProvider: # the model provider it points Codex at
    id: deepseek
    name: DeepSeek
    baseUrl: https://api.deepseek.com/
    keyVariable: DEEPSEEK_API_KEY
```

With halves, the top-level `env` is shared by both and a half's own variable of the same name wins;
`codexProvider` lives in `codex:`; `harness` must name one of the halves. A one-CLI login keeps the flat
shape, with `codexProvider` at the top for Codex.

Each variable is one of three kinds:

| Kind      | Written as                                                                | Travels as                                                                                          |
| --------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Plain     | the value                                                                 | the value                                                                                           |
| Secret    | `${secret:NAME}`                                                          | the NAME and whether the store holds it ("set ✓"); the value is put into that one child at launch   |
| Reference | `cloudCredential: aws-profile:<name>`, `gcloud-adc[:<path>]`, `azure-cli` | the reference; Ferretry hands the CLI `AWS_PROFILE` or `GOOGLE_APPLICATION_CREDENTIALS`, or nothing |

A reference is never copied: the cloud SDK inside the CLI reads the credential where it already lives
(`~/.aws`, gcloud's application-default credentials, whoever `az login` signed in). A Codex provider is
given to the runtime as `-c model_providers.<id>.…` launch flags, so Ferretry never writes anybody's
`~/.codex`; its key is the variable `keyVariable` names (Codex's `env_key`), which is a secret like any
other. A `{VARIABLE}` in its base URL is filled from the login's plain values at launch. The provider's
`model` is the runtime's model only when the runtime's profile names none.

The provider's `queryParams` (extra query parameters such as `api-version` on an older Azure endpoint) travel as
`-c model_providers.<id>.query_params.<key>="<value>"` launch flags, which every local user can read in the process
list: **never put a key or token in `queryParams`** — give it as a login variable and name that variable in
`keyVariable`, so Codex sends it as a bearer token read from the environment, never from the command line.

Field names avoid `secret`, `key` and `envKey` on purpose: the raw-secret detector reads a long value
under a credential-shaped key as a pasted key, and `MOONSHOT_API_KEY` is a long value.

## One login, both CLIs

A runtime is one login plus one profile and runs **one** CLI. On a login with both halves it runs, in
this order:

1. the CLI the runtime names itself (`runtimes/<name>.yaml` `harness: codex`, `runtime.put.harness`);
2. else the CLI its profile is scoped to — a Codex-only profile runs Codex;
3. else the login's `harness`.

It is launched with that half only: Claude Code never sees the Codex half's variables, nor Codex the
Claude half's. The **profile scope rule** still holds — a Claude-only profile never runs on Codex — and a
dual login is compatible with both scopes, because the runtime picks the half the profile fits. Only a
runtime pinned to the other CLI is refused.

The login's **scope chip** says what it drives — **Claude only**, **Codex only** or **Claude + Codex**
(`FleetCredentialView.harnesses`). Every place that picks a LOGIN for one CLI (Add a runtime, Add a login
opened from a runtime) offers only logins with a half for it. The places that pick a RUNTIME — new
session, the model picker, Move to another login, the Warden's investigation login and failover list —
already pick something that runs one CLI, so a dual login appears there once per runtime on it.

## Presets

A preset is a template: the variables and which are secrets, the cloud credential kinds it takes, the
Codex provider, a cheap **Test**, the **quota source** the usage subsystem reads, the pricing table, the
provider's documentation, every fact that could not be confirmed there (`unverified`, shown in the app
before anyone relies on it), the `group` it is listed under in the app (`popular`, `cloud`, `self-hosted`), and the clues that **detect** it. A login made from one copies what it needs
into its own file, so a preset edited or removed later never changes what a login launches with.

A preset names its **model catalog** (`catalog: zai`): the models a login made from it offers, their
tiers and efforts, and the models Claude Code's tier slots are pinned to — [model-catalog.md](model-catalog.md).
A preset therefore no longer carries model ids or `ANTHROPIC_DEFAULT_*_MODEL` values of its own; a
machine's own preset file may still list `models`, which are shown when it names no catalog.

A provider that serves both CLIs has a `claude:` and a `codex:` half, each with its own `env`, `models`,
optional `docs` and — Codex — `codexProvider`; the Test, the quota source, the pricing and the detection
clues belong to the provider and sit beside them. A half that cannot be used says why in its own
`unavailable`, and the other half is still offered (GLM's Codex half). A preset for one CLI may keep the
older flat shape — `harness:` with `env`, `codexProvider` and `models` at the top — and a machine's own
file in that shape keeps working. A login from a two-half preset gets every offered half.

The built-in catalogue is `packages/fleet/presets/<id>.yaml`, shipped in the binary as text. A machine
adds its own — or replaces a built-in by its id — with a file of the same shape in
`$FY_HOME/config/presets/<id>.yaml`; it is a configuration file like any other (checked, last good wins,
`fy config schema preset`). To start from a built-in one, copy its file from the repository.

A preset that cannot be used here is listed with `unavailable: <why>` and the app shows the reason
instead of offering it.

## Detect

When a login is added from variables — pasted into Settings › Logins › Add login › **Paste variables**,
given as `fy login add --env NAME=VALUE`, or imported from the shell with `fy login add --from-env` — the
provider is detected by `detectProvider` (`@ferretry/fleet`, `presets/detect.ts`), a pure function whose
table is every preset's `detect:` block:

```yaml
detect:
  hosts: [api.deepseek.com] # a base URL on this host, or below it
  variables: [DEEPSEEK_*] # a variable only this provider uses; NAME_* for a family
  keyPrefixes: [sk-or-] # the documented start of its keys
```

A base URL's host (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, a Codex `model_providers.<id>.base_url`)
weighs most, a distinctive variable next, a key prefix least; the highest total wins and a tie is said
("or: …"). Nothing found is a **custom gateway**, with the variables that were recognised listed.

**No value leaves the detector.** It reports variable NAMES, the kind of clue, and — for a host — the
host as the PRESET wrote it, never the URL as the person did (a URL can carry a user and a password). A
key is only compared with a declared prefix. The browser runs the same function on a paste, so a pasted
block is never sent anywhere to be recognised; its secrets go to the secret store when the login is
added, like any other.

## One-click add

- **Settings › Logins › Add a login** shows them, under its two sign-in tiles, as a grid of compact provider tiles, one per preset,
  each with its name and scope chip, filed under the heading its preset's `group` names — **Popular**,
  **Cloud**, **Self-hosted**; a preset with no group (a machine's own file, Qwen, Vercel) is listed under
  **More providers**, after the clouds. Two tiles to a row on a phone, three or four on a desktop. More
  than eight tiles earn a search box, which matches every word against the name, the id and the summary.
  The summary is each tile's one line on what it is: shown on hover, keyboard focus or a long press, and
  always its accessible description. A tile that is not offered here stays focusable and a tap on it
  says why. Nothing is picked until somebody taps. One tap opens a minimal form, its key field first: only the secret(s) the preset needs — one field per
  secret NAME, however many variables carry it, "set ✓" when the store already has it — plus a required
  value the preset cannot know (an Azure resource, a gateway's address) and a cloud reference where one
  is taken. Everything else comes from the preset. **Add** stores each secret through `POST /v1/secrets`,
  adds the login as a reviewed change (and, from Add a login, its runtime when none runs that CLI —
  docs/design/account-model.md §4.6), then offers **Test**.
- **CLI:** `fy login add glm` (a preset id, or a word of one: `glm`, `kimi`, `deepseek`, `bedrock`…) asks
  for each missing secret with a hidden prompt, or reads it from stdin off a terminal — never from argv,
  so never from shell history — stores it, and adds the login. `--from-env` imports from the current
  shell, detecting the provider; `--test` runs the Test afterwards.

## Test

`POST /v1/fleet/credentials/:id/test` (`fleet.configure`, a passkey step-up off the machine, audited as
`secrets.used`) sends **one** request, the cheapest the provider allows, and answers a code and a fixed
sentence — never the provider's reply:

- `request` — one authenticated read that costs nothing (a model list, a balance, a quota);
- `inference` — one message capped at one output token, for a provider with no free read. It is sent
  only when the request carries `allowInference: true`; without it the answer is `consent_required` and
  nothing is sent;
- `local` — one unauthenticated read of a server on this machine (Ollama);
- `none` — not offered, with the reason (a cloud that needs request signing Ferretry does not do).

The key is spent through the outbound holder ([secrets.md](secrets.md)), and **only where the login
already sends it, or where a built-in preset says**: the request's host must be the host of one of the
login's own `https://` values (or `http://` to this machine), or a host a built-in preset wrote
literally. A `{VARIABLE}` in a test's host takes one DNS label. A preset file of this machine's own can
never name a new host for a key. The Test reads the login's variables of every half, so a two-CLI
login's one key is found in whichever half carries it.

## Clone

Clone ([account-model.md](account-model.md)) copies an environment login as its file: plain values,
secret NAMES, its preset, its references, its Codex provider and its halves. The keys it names follow in ONE
sealed copy the source confirms with a passkey, so the cloned runtime works on arrival; the preview lists them
("Copy 1 API key with the logins: ZAI*API_KEY") and what the target still needs ("uses your AWS profile acme
on work-linux"). A signed-in login is **not** copied — owner decision 2026-10-20, "don't copy sign-in, copy env
var credentials only" ([secrets.md](secrets.md#sign-ins-are-not-copied-api-keys-are)) — and becomes an empty slot
marked "Sign in on \_machine*". A runtime keeps the CLI it names.

## The catalogue, verified 2026-10-16

Checked against each provider's current documentation. **H** read in the provider's own docs; **M**
community sources or search results only — and said so in the preset's `unverified`.

| Preset                        | CLIs           | Secret (by its NAME in the store)               | Test                                 | Quota source                                             |
| ----------------------------- | -------------- | ----------------------------------------------- | ------------------------------------ | -------------------------------------------------------- |
| Anthropic API key             | Claude         | `ANTHROPIC_API_KEY` (x-api-key)                 | `GET /v1/models` (H)                 | transcript × pricing                                     |
| Amazon Bedrock (AWS profile)  | Claude         | — (`aws-profile:`)                              | none: SigV4                          | transcript × pricing; Service Quotas are limits only (M) |
| Amazon Bedrock (API key)      | Claude         | `AWS_BEARER_TOKEN_BEDROCK`                      | none: no free read documented        | transcript × pricing                                     |
| Bedrock Mantle (AWS profile)  | Claude         | — (`aws-profile:`)                              | none: SigV4                          | transcript × pricing                                     |
| Google Vertex AI              | Claude         | — (`gcloud-adc`)                                | none: needs a Google token           | transcript × pricing                                     |
| Microsoft Foundry (API key)   | Claude         | `ANTHROPIC_FOUNDRY_API_KEY`                     | one-token message (no free read, H)  | transcript × pricing                                     |
| Microsoft Foundry (Azure CLI) | Claude         | — (`azure-cli`)                                 | none: needs an Entra token           | transcript × pricing                                     |
| GLM / Z.ai                    | Claude (¹)     | `ZAI_API_KEY`                                   | quota read (M)                       | `zai-coding-plan` (M)                                    |
| Kimi / Moonshot               | Claude + Codex | `MOONSHOT_API_KEY`                              | `GET /v1/models` (H)                 | `moonshot-balance` (H)                                   |
| MiniMax (Token Plan)          | Claude + Codex | `MINIMAX_API_KEY` (x-api-key for Claude Code)   | `token_plan/remains` (H)             | `minimax-token-plan` — reports REMAINING (M)             |
| DeepSeek                      | Claude + Codex | `DEEPSEEK_API_KEY`                              | `GET /models` (H)                    | `deepseek-balance` (H)                                   |
| Qwen (Alibaba Coding Plan)    | Claude         | `DASHSCOPE_API_KEY`                             | one-token message: messages only (H) | transcript × pricing                                     |
| OpenRouter                    | Claude + Codex | `OPENROUTER_API_KEY` (+ `ANTHROPIC_API_KEY=""`) | `GET /api/v1/key` (H)                | `openrouter-key` (H)                                     |
| Vercel AI Gateway             | Claude         | `AI_GATEWAY_API_KEY` (+ `ANTHROPIC_API_KEY=""`) | `GET /v1/credits` (M)                | `vercel-credits` (M)                                     |
| LiteLLM proxy                 | Claude         | `LITELLM_API_KEY`                               | `GET /v1/models` (M)                 | `litellm-key-info` (self-query M)                        |
| Custom gateway                | Claude         | `GATEWAY_API_KEY` (+ `ANTHROPIC_API_KEY=""`)    | `GET /v1/models`                     | transcript × pricing                                     |
| OpenAI API key                | Codex          | `OPENAI_API_KEY`                                | `GET /v1/models`                     | transcript × pricing                                     |
| Azure OpenAI                  | Codex          | `AZURE_OPENAI_API_KEY`                          | `GET …/openai/v1/models` (M)         | transcript × pricing                                     |
| Ollama (local)                | Codex          | —                                               | `GET localhost:11434/api/tags`       | none                                                     |

(¹) GLM's Codex half is in the preset but **not offered**: Codex runs GLM only with a
`model_catalog_json` file. Ferretry now writes one for every third-party Codex login
([model-catalog.md](model-catalog.md#codexs-own-picker)), but GLM's Codex models have not been verified, so a
GLM login drives Claude Code only.

Codex accepts only `wire_api = "responses"` (`chat` was removed on 2026-02-01). Every Codex half above
documents a Responses endpoint, so none is hidden for lacking one; GLM's is hidden until its Codex models are
verified.

## Declared gaps

- **Cloud logins have no Test.** Bedrock and Mantle need SigV4, Vertex a Google access token and Foundry
  over Entra an Azure token; Ferretry signs none of them. The preset says which CLI command checks it.
- **No draft Test.** A login is tested once it is saved, so a key always goes where a saved login sends
  it; the app adds the login first, then offers Test.
- **Quota adapters are separate.** A preset names its quota source; reading it is the usage subsystem's —
  [provider-quotas.md](provider-quotas.md).
- **The retired `*-codex` presets are gone.** `deepseek-codex`, `kimi-codex`, `minimax-codex`,
  `openrouter-codex` and `zai-glm-codex` became the Codex halves of their providers' presets. A login
  that still names one shows "preset not on this machine" (no Test) until it is re-added; what it
  launches with is unchanged, because a login never reads its preset to launch.
- **A runtime with no CLI of its own follows its profile.** On a dual login, a runtime that names no
  `harness` runs the CLI its profile is scoped to, so re-scoping that profile moves the runtime to the
  other CLI at its next launch. Name the `harness` to pin it.
