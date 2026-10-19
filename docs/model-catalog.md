# Model catalogs

Every login offers a curated list of models: an Anthropic login offers Opus, Sonnet and Haiku, a GLM
login the GLM coding models, a DeepSeek login DeepSeek's. The list, its labels, its tiers and the
reasoning efforts each model takes come from one **model catalog** per provider. Every model picker
reads it: the composer's chip, Info › Runtime, the new-session form, Settings › Warden and a lessons
scan. So does the launch: Claude Code's tier slots (`/model opus|sonnet|haiku`) are pinned to the
catalog's models, so a slash command and Ferretry's picker always land on the same model.

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
- `detect: ollama` marks a local server whose own model list a picker may read (see the gaps).

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

## Changing the list

**For everyone:** edit `packages/fleet/models/<id>.yaml`, check it against the provider's documentation,
update `verified:` and `unverified:`, and merge. The next build carries it.

**On one machine:** write `$FY_HOME/config/models/<id>.yaml` with the same shape (start from the
repository's file). It is a configuration file like any other — checked, last good wins, reported in
Settings › This machine › Files — and it **wins over the built-in catalog of the same id**. A file with
a new id is a catalog for a preset of the machine's own (`catalog: <id>` in its preset file).

## Declared gaps

- **Ollama's detected models are not read yet.** The Ollama catalog lists the gpt-oss models Ollama's
  Codex guide suggests and offers "Custom id…"; a live Codex session's picker already lists what Codex
  itself reports. Reading `localhost:11434/api/tags` into the other pickers is not built.
- **A live Codex session's list is Codex's own.** Codex switches models only through its own picker, so a
  running Codex session offers exactly what its app-server reports; the catalog adds the tier and name
  where an id matches.
- **Bedrock ids are the US inference profiles** (`us.anthropic.…`). A login whose `AWS_REGION` is outside
  the US needs the `eu.`, `au.`, `jp.` or `global.` ids, in `config/models/amazon-bedrock.yaml`.
