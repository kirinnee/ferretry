# OpenCode V2 runtime spike — G1 / A-19 / W-146

Captured 2026-11-26 on Linux x64, OpenCode **2.4.2**. This PR contains runtime research fixtures only. It does **not** add an installed harness, runtime picker entry, transcript adapter or subscription guard. U9 still needs implementation after the harness/catalog seams land.

## Pinned install and capture

Downloaded the [official V2 release tarball](https://github.com/anomalyco/opencode/releases/download/v2.4.2/opencode-linux-x64.tar.gz) to a temporary prefix, verified its SHA-256, and extracted the binary there:

```text
452912288f934d1771bd5bd0d8611ba3a6adc3db3ac3333c37facf373770ba66
opencode v2.4.2
```

The plain `/install` URL and GitHub `releases/latest` still selected V1 during capture. Use the pinned V2 asset, the documented `/v2/install`, or `@opencode/cli`; never infer the major from the binary name. See the [installation docs](https://opencode.ai/docs/index.md).

All experiments ran outside the checkout in synthetic projects. OpenCode received temporary HOME, FY_HOME, all four XDG homes and OPENCODE_DB. CLAUDE_CONFIG_DIR and CODEX_HOME were unset; no host credentials were copied or inspected. Real provider calls ran through **`fy secret use --with DEEPSEEK_API_KEY -- …`**, as confirmed by the installed command's help. The positional secret name in the original brief is not the current CLI syntax. The Vault supplied the key directly to the child; no key value was requested, printed or written by the capture scripts.

Three short prompts produced five main provider steps; one earlier unavailable-model attempt made no provider step. OpenCode stats reported **$0.00160518**, 8,050 uncached input tokens, 272 output tokens, 298 reasoning tokens and 18,560 cached-read tokens. The two successful session exports total **$0.00167868**, including $0.00007350 absent from stats and visible assistant steps. Both are local price estimates, not independently measured account debits; report the higher total for this spike. No quota/balance claim is made. See `tests/fixtures/spike/stats.json` and `capture.json`.

IDs and scratch paths in committed captures are stable fake replacements. Counts, costs, event order, model IDs and transcript contents retain the captured values. The synthetic denied file contained only `SYNTHETIC_DENIED_CONTENT`.

## 1. Isolation: use all XDG homes, an absolute DB and standalone mode

`debug paths` resolved config, data, state, cache and the database under home A. A successful real model call was traced with `strace -f -e trace=%file`; **zero filesystem calls named the protected real OpenCode, Ferretry, Claude or Codex home paths**. The trace captured filenames, not file contents or environment values. We deliberately did not inspect whether the real configs exist.

Home B's standalone session list was `[]`; exporting A's session ID from B returned exit 1 and `Session not found`. The same export from A succeeded. This proves separation for the tested process launches, not a security sandbox against tools deliberately accessing other paths.

**Additional finding:** the proposed variables initially left `debug paths tmp` at shared `/tmp/opencode`. Set **TMPDIR per ferret too**; the tested wrapper then resolved it to `/fixture/opencode/a/tmp/opencode`. Clear inherited OPENCODE_CONFIG, OPENCODE_CONFIG_CONTENT, OPENCODE_CONFIG_DIR and OPENCODE_SERVER so a caller cannot redirect config/server selection. Keep `--standalone` on run, TUI, export, list and stats; [the default otherwise discovers or starts a shared per-user service](https://opencode.ai/docs/cli.md).

Evidence: `paths.txt`, `filesystem.txt`, `isolation.json`.

## 2. Autonomy and screens

Both headless `run` and the full TUI accept **`--auto`**. The synthetic project used this native V2 policy:

```json
{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "read", "resource": "denied.txt", "effect": "deny" }
  ],
  "agents": { "build": { "steps": 2 } }
}
```

With `--auto`, `shell` executed `printf FERRETRY_TOOL_OK` without a permission question despite its `ask` rule. A separate prompt's `read denied.txt` failed with `permission.rejected`; `--auto` **did not override deny**. The synthetic two-step cap caused a final maximum-steps summary; that text is not a permission or login dialog.

Two no-prompt TUI launches reached the composer directly: no onboarding, login, folder trust or autonomy confirmation appeared. One used the default free model label; the second used the configured DeepSeek label. This is terminal-text evidence, not a screenshot review or comprehensive dialog coverage. No paid TUI prompt, quota-limit screen, interactive permission screen or OAuth flow was exercised. U9 must capture those screens separately before claiming their dialog rules work.

Evidence: `resume.jsonl`, `deny.jsonl`, `export-deny.json`, `config-sources.json`, `startup.txt`. Rule syntax and precedence: [permissions](https://opencode.ai/docs/permissions.md).

## 3. Transcript reader: session export, not the run stream

`opencode session export <id> --standalone` returns one JSON document:

- `info`: session ID, project ID, model `{id, providerID, variant}`, cumulative `cost`, `tokens`, outcome, timestamps and location.
- `messages[]`: stable IDs and discriminated `type` values. Observed **user**, **assistant** and **idle**. Idle is a separate record with an outcome.
- Assistant `content[]`: text, reasoning and tools. An exported tool uses `name`, `state.input`, `state.output` or structured `state.error`, plus timing. The JSONL stream instead uses a `part` wrapper and `tool` field; it is a different schema.
- Per-assistant cost/tokens and session aggregate cost/tokens both exist. Count one level, **never both**. Tokens include `input`, `output`, `reasoning` and `cache.{read,write}`. The explicitly titled session's cost equals the sum of its assistant costs. The auto-titled denial session's aggregate is **$0.000411498**, while its assistant costs sum to **$0.000337998**; it also has 470 extra input and 5 extra output tokens in the aggregate. Background title generation is a plausible explanation (inference, not separately traced). Stats still excludes that difference after completion. U9 must preserve the distinction and avoid silently equating stats, session totals and visible-step totals.

Three unchanged standalone exports were each **5,721 bytes**, taking **446 / 457 / 426 ms** end to end (fresh CLI/private server per poll). All three were byte-identical to the post-resume export. No provider call was used for export. These are measurements for one small transcript, not a large-history benchmark or a CPU measurement. Polling rewrites the whole snapshot; begin without byte-tail support, deduplicate by message/content identity and timestamps, and avoid subsecond polling. Benchmark growth before choosing a production interval.

`--sanitize` is available, but these captures use ordinary export so tool inputs/outputs and schema remain visible. No untrusted secret-bearing session should be exported into logs. The public fixtures contain only the controlled prompts and synthetic tool data.

Evidence: `export-before.json`, `export-after.json`, `export-deny.json`, `polling.jsonl`, `export-help.txt`. Command reference: [session export](https://opencode.ai/docs/cli/commands.md).

## 4. Resume by ID

`run --session <id> --standalone --auto --model deepseek/deepseek-flash --format json <prompt>` resumed the first session. Its ID stayed the same; message count grew from **3 to 7**, retaining the original user/assistant/idle records. Cost grew from $0.00098550 to $0.001267182. The CLI process exited between the first turn, exports and resume; this was persisted database state, not one running process's memory.

The run event stream provides `sessionID` on the first event, which the harness can record. Help also says `--session` can create a missing session ID; **do not use run/resume as an existence check**. B's failed export is the observed missing-session behavior. Do not use `--continue` in a multi-session harness.

Evidence: `run.jsonl`, `resume.jsonl`, `export-before.json`, `export-after.json`, `run-help.txt`.

## 5. Provider/model selection

The available native DeepSeek IDs were `deepseek/deepseek-flash` and `deepseek/deepseek-v4-pro`. `deepseek/deepseek-chat` returned `provider.no-route` / `Model unavailable`; the old alias must not be assumed available. The successful export identifies provider `deepseek`, model `deepseek-flash`, variant `default`.

Headless run supports `--model provider/model#variant`. Full-screen root help has **no `--model` flag**: set `"model": "deepseek/deepseek-flash"` in the isolated config. A real TUI startup then displayed `DeepSeek V4.1 Flash 1017 DeepSeek`. Model variant parsing is advertised by help but non-default variants and live model switching were not exercised.

Evidence: `deepseek-models.txt`, `model-unavailable.jsonl`, `run-help.txt`, `startup.txt`. Config reference: [model](https://opencode.ai/docs/config.md).

## 6. Refuse Anthropic subscription logins before credential use

This is a **Ferretry acceptance requirement**, not an observed OpenCode refusal. No Anthropic account or OAuth/subscription credential was used. On the inspected base, `packages/plugins/logins/daemon/lib/kinds.ts` already keeps `HARNESSES.anthropic` at `[harnessKey('claude')]`; preserve that restriction when opening the harness registry.

U9 needs an explicit check when resolving its launch login, **before** calling login `env`, requesting a SharedCredential, preparing auth state or spawning OpenCode: refuse login kind `anthropic` with a clear subscription-not-supported explanation. Also filter it out of the runtime/login picker. Do not reject all provider IDs named `anthropic`: an ordinary Anthropic **API key** is a different login kind. The guard must depend on kind, not a model/provider substring.

`anthropic-refusal.json` is labelled as **proposed acceptance cases**, not fabricated live evidence: an `anthropic` subscription has zero env/credential/spawn calls; an `api-key` login does not trigger the subscription-specific refusal. The future harness must add executable tests for both. There is no OpenCode harness implementation in this PR to test that guard against.

## Validation and remaining work

For A-19 and W-146, the base had no OpenCode evidence bundle. The same offline capture-verification script failed there on the missing fixtures and passed against this branch: JSON/JSONL parse, stable resume prefix, aggregate-vs-message costs, allowed shell, denied read, two-home isolation, polling sizes/times and unavailable-model error. This is evidence **red → green**, not runtime-feature red → green; the runtime request remains open for U9.

Reproduce provider calls only through the Vault wrapper; set the child environment **after** Vault lookup so FY_HOME does not point secret resolution at the synthetic store:

```sh
fy secret use --with DEEPSEEK_API_KEY -- \
  env -u CLAUDE_CONFIG_DIR -u CODEX_HOME \
  -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT -u OPENCODE_CONFIG_DIR -u OPENCODE_SERVER \
  HOME="$scratch/home" FY_HOME="$scratch/fy" \
  XDG_CONFIG_HOME="$scratch/config" XDG_DATA_HOME="$scratch/data" \
  XDG_STATE_HOME="$scratch/state" XDG_CACHE_HOME="$scratch/cache" \
  OPENCODE_DB="$scratch/data/private.db" TMPDIR="$scratch/tmp" \
  "$opencode" run --standalone --auto --model deepseek/deepseek-flash \
  --format json 'Reply exactly: FERRETRY_SPIKE_OK. Do not use tools.'
```

Here `$opencode` is the verified binary's absolute path and `$scratch` is a new temporary project/home root; create those directories and run from its synthetic project. The actual capture also cleared unrelated Anthropic/OpenAI/OpenRouter key variables. Use the identical isolated environment for all session operations and TUI launches. Never point any of these commands at host OpenCode storage.

Remaining U9 work: implement the harness and transcript/usage adapter; enforce the subscription guard; test long-session export cost and concurrent live export; capture additional TUI dialogs and define their rules. No product UI changed in this spike.
