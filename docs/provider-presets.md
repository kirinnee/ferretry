# Environment logins and provider presets

A **login** is either **sign-in based** (Claude's OAuth, Codex's device code) or **environment based**: a
named set of environment variables Ferretry puts into the CLI's process when it launches a ferret. That
is how Claude Code runs against Bedrock, Vertex, GLM or OpenRouter, and how Codex runs against an OpenAI
API key or any Responses-compatible provider. This page is the design note; the code is
`@ferretry/fleet`'s `account/environment.ts` and `presets/`, and the daemon's `lib/provider-probe/`.

## What an environment login holds

`logins/<id>.yaml` ([config-files.md](config-files.md)):

```yaml
harness: claude
store: environment
preset: zai-glm # display, Test and quota only
env:
  ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic # a plain value, shown
  ANTHROPIC_AUTH_TOKEN: ${secret:ZAI_API_KEY} # a secret, by NAME
cloudCredential: aws-profile:acme # optional: a credential this machine already has
codexProvider: # Codex only: the model provider it points Codex at
  id: kimi
  name: Kimi
  baseUrl: https://api.moonshot.ai/v1
  keyVariable: KIMI_API_KEY
```

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

Field names avoid `secret`, `key` and `envKey` on purpose: the raw-secret detector reads a long value
under a credential-shaped key as a pasted key, and `MOONSHOT_API_KEY` is a long value.

## Presets

A preset is a template: the variables and which are secrets, the cloud credential kinds it takes, the
Codex provider, a cheap **Test**, the **quota source** the usage subsystem reads, the pricing table, the
provider's documentation, and every fact that could not be confirmed there (`unverified`, shown in the
app before anyone relies on it). A login made from one copies what it needs into its own file, so a
preset edited or removed later never changes what a login launches with.

The built-in catalogue is `packages/fleet/presets/<id>.yaml`, shipped in the binary as text. A machine
adds its own — or replaces a built-in by its id — with a file of the same shape in
`$FY_HOME/config/presets/<id>.yaml`; it is a configuration file like any other (checked, last good wins,
`fy config schema preset`). To start from a built-in one, copy its file from the repository.

A preset that cannot be used here is listed with `unavailable: <why>` and the app shows the reason
instead of offering it.

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
never name a new host for a key.

## Clone

Clone ([account-model.md](account-model.md)) copies an environment login as its file: plain values,
secret NAMES, its preset, its references and its Codex provider. The preview lists what the target still
needs — "needs: ZAI_API_KEY", "uses your AWS profile acme on work-linux" — and a signed-in login still
becomes an empty slot that needs sign-in.

## The catalogue, verified 2026-10-16

Checked against each provider's current documentation. **H** read in the provider's own docs; **M**
community sources or search results only — and said so in the preset's `unverified`.

| Preset                        | Harness | Secret                                          | Test                                                                                                    | Quota source                                             |
| ----------------------------- | ------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Anthropic API key             | Claude  | `ANTHROPIC_API_KEY` (x-api-key)                 | `GET /v1/models` (H)                                                                                    | transcript × pricing                                     |
| Amazon Bedrock (AWS profile)  | Claude  | — (`aws-profile:`)                              | none: SigV4                                                                                             | transcript × pricing; Service Quotas are limits only (M) |
| Amazon Bedrock (API key)      | Claude  | `AWS_BEARER_TOKEN_BEDROCK`                      | none: no free read documented                                                                           | transcript × pricing                                     |
| Bedrock Mantle (AWS profile)  | Claude  | — (`aws-profile:`)                              | none: SigV4                                                                                             | transcript × pricing                                     |
| Google Vertex AI              | Claude  | — (`gcloud-adc`)                                | none: needs a Google token; count-tokens address unconfirmed                                            | transcript × pricing                                     |
| Microsoft Foundry (API key)   | Claude  | `ANTHROPIC_FOUNDRY_API_KEY`                     | one-token message (no free read, H)                                                                     | transcript × pricing                                     |
| Microsoft Foundry (Azure CLI) | Claude  | — (`azure-cli`)                                 | none: needs an Entra token                                                                              | transcript × pricing                                     |
| GLM / Z.ai                    | Claude  | `ANTHROPIC_AUTH_TOKEN`                          | quota read (M)                                                                                          | `zai-coding-plan` (M)                                    |
| Kimi / Moonshot               | Claude  | `ANTHROPIC_AUTH_TOKEN`                          | `GET /v1/models` (H)                                                                                    | `moonshot-balance` (H)                                   |
| MiniMax (Token Plan)          | Claude  | `ANTHROPIC_API_KEY` (as documented)             | `token_plan/remains` (H)                                                                                | `minimax-token-plan` — reports REMAINING (M)             |
| DeepSeek                      | Claude  | `ANTHROPIC_AUTH_TOKEN`                          | `GET /models` (H)                                                                                       | `deepseek-balance` (H)                                   |
| Qwen (Alibaba Coding Plan)    | Claude  | `ANTHROPIC_AUTH_TOKEN`                          | one-token message: messages only (H)                                                                    | transcript × pricing                                     |
| OpenRouter                    | Claude  | `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_API_KEY=""` | `GET /api/v1/key` (H)                                                                                   | `openrouter-key` (H)                                     |
| Vercel AI Gateway             | Claude  | `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_API_KEY=""` | `GET /v1/credits` (M)                                                                                   | `vercel-credits` (M)                                     |
| LiteLLM proxy                 | Claude  | `ANTHROPIC_AUTH_TOKEN`                          | `GET /v1/models` (M)                                                                                    | `litellm-key-info` (self-query M)                        |
| Custom gateway                | Claude  | `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_API_KEY=""` | `GET /v1/models`                                                                                        | transcript × pricing                                     |
| OpenAI API key                | Codex   | `OPENAI_API_KEY`                                | `GET /v1/models`                                                                                        | transcript × pricing                                     |
| Azure OpenAI                  | Codex   | `AZURE_OPENAI_API_KEY`                          | `GET …/openai/v1/models` (M)                                                                            | transcript × pricing                                     |
| OpenRouter                    | Codex   | `OPENROUTER_API_KEY`                            | `GET /api/v1/key` (H)                                                                                   | `openrouter-key`                                         |
| DeepSeek                      | Codex   | `DEEPSEEK_API_KEY`                              | `GET /models`                                                                                           | `deepseek-balance`                                       |
| Kimi / Moonshot               | Codex   | `KIMI_API_KEY`                                  | `GET /v1/models`                                                                                        | `moonshot-balance`                                       |
| MiniMax (Token Plan)          | Codex   | `MINIMAX_API_KEY`                               | `token_plan/remains`                                                                                    | `minimax-token-plan`                                     |
| GLM / Z.ai                    | Codex   | —                                               | **not offered**: Codex needs a `model_catalog_json` file Ferretry would have to write into a Codex home | —                                                        |
| Ollama (local)                | Codex   | —                                               | `GET localhost:11434/api/tags`                                                                          | none                                                     |

Codex accepts only `wire_api = "responses"` (`chat` was removed on 2026-02-01). Every Codex provider
above documents a Responses endpoint, so none is hidden for lacking one; the GLM entry is hidden for the
model catalogue file instead.

## Declared gaps

- **Cloud logins have no Test.** Bedrock and Mantle need SigV4, Vertex a Google access token and Foundry
  over Entra an Azure token; Ferretry signs none of them. The preset says which CLI command checks it.
- **No draft Test.** A login is tested once it is saved, so a key always goes where a saved login sends
  it; the app adds the login first, then offers Test.
- **Quota adapters are separate.** A preset names its quota source; reading it is the usage subsystem's —
  [provider-quotas.md](provider-quotas.md).
