# The account model

Ferretry runs Claude Code and Codex on a **machine** (one daemon). This page is the contract: what the
five things are, where they live, how to reach them, and what is refused. The reasons, the full rules,
the flows and the per-harness mechanisms are in [design/account-model.md](design/account-model.md);
where the two disagree, read that one and fix this one.

## The five things

| Thing          | Is                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Machine**    | One daemon. Everything below belongs to exactly one machine. It owns **Agent permissions** (`auto` or `skip`), the **default runtime for new agents** (optional; must be an agent runtime), **what agents may control** (terminals/browsers/files, each on by default; Ferretry settings, off by default), and knows which tools (Claude Code, Codex) are installed. |
| **Credential** | A login to Claude or Codex, stored once and never copied. Its store is `host` (your own `claude` / `codex` login, shared in place), `ferretry` (signed in through Ferretry) or `environment`.                                                                                                                                                                        |
| **Component**  | A piece of setup saved once and referenced: Instructions, MCP servers, Skills, Settings, Hooks or a Model set.                                                                                                                                                                                                                                                       |
| **Profile**    | An ordered list of layers, each a component or another profile. The newer layer wins. Its scope — Generic, Claude only or Codex only — is derived from its layers; Claude only + Codex only is refused.                                                                                                                                                              |
| **Runtime**    | One credential plus one profile, under a name you type (`claude-default`), running ONE CLI. An **agent** runtime is one Ferretry may launch unattended; it gets a fixed layer applied last. On a login that drives both CLIs it runs the one it names (`harness`), else the one its profile is scoped to, else the login's first.                                    |

A credential's status is one of **Ready**, **Refresh due**, **Needs sign-in** or **Checking**. Ferretry
never refreshes a login on a timer and never spends a model turn to learn a status. History is one pool
per harness, shared by every runtime of that harness.

An `environment` credential is no sign-in at all: a named set of variables put into the CLI at launch,
each a plain value, a `${secret:NAME}` reference or — for a cloud — a reference to a credential this
machine already has (`aws-profile:<name>`, `gcloud-adc`, `azure-cli`). It is usually made from a
**provider preset** (GLM, DeepSeek, Bedrock, OpenRouter…), has a **Test** instead of Check now, and is
copied by Clone as plain values and secret NAMES, and its keys follow in one sealed copy the source confirms with a
passkey ([secrets.md](secrets.md#sign-ins-are-not-copied-api-keys-are)). A provider that serves
both CLIs makes ONE environment login with a `claude:` and a `codex:` half and one secret, so it drives
either. Its scope chip — **Claude only**, **Codex only** or **Claude + Codex** — comes from the CLIs it
drives, and every place that picks a login for one CLI offers only logins with a half for it. A dual login
fits a Claude-only and a Codex-only profile alike: the runtime runs the CLI the profile is scoped to. See
[provider-presets.md](provider-presets.md).

## Where state lives

The configuration is **one human-editable YAML file per building block** under `<FY_HOME>/config/` —
`machine.yaml`, `logins/<id>.yaml`, `components/<kind>/<name>.yaml`, `profiles/<name>.yaml` (its
`contents:` are the layers), `runtimes/<name>.yaml` — and the files are the source of truth: the app,
`fy` and agents are all editors of them. How they are read, checked and edited, and what happens to a
broken one, is [config-files.md](config-files.md).

Under `<FY_HOME>/fleet/`:

| Path                   | Holds                                                                       |
| ---------------------- | --------------------------------------------------------------------------- |
| `assets/components/**` | component bodies                                                            |
| `credentials/<id>/`    | a `ferretry`-store login (never a `host` one, which stays in your own home) |
| `shared/<harness>/`    | the history pool                                                            |
| `ids.json`             | each runtime's opaque id                                                    |
| `manifest.json`        | the runtimes Ferretry published, which launches read                        |

A change is a reviewed **proposal**: the person or agent proposes it, reads what it would do, and
applies it. No route, command or log line ever returns a credential value
([secrets.md](secrets.md)).

## Setting a machine up

**Starting a daemon imports nothing.** A machine is _not set up_ (`GET /machine` answers
`setUp: false`) until somebody chooses what to bring in, and then it is one reviewed `setup.import`
change, like every other. There are three ways to choose, and they ask the same questions:

- **The app** opens the first run by itself for a machine that is not set up: right after pairing,
  and whenever Settings → Machines lands on it. One question per screen: install what is missing,
  then "We found Claude Code on _machine_. Use your login and setup?" (**Import** · **Skip**), the
  same for Codex, then the runtime names. A tool that is installed but not signed in offers **Sign
  in now**, which adds the person's own login (`credential.add` with `store: host`), signs it in
  there, and returns to the step; the import then reuses that login. Skipping both ends on "Nothing
  is set up on _machine_ yet", with the way back.
- **`fy daemon setup`** asks the same questions in a terminal, one at a time. With no terminal it
  refuses and names `fy daemon import`.
- **`fy daemon import claude|codex`** imports one tool with no questions, for scripts, under
  `--name <runtime>` or the suggested name (`claude-default`).

`fy daemon start` at a terminal on a machine that is not set up ends with one line naming the app and
`fy daemon setup`. There is no top-level `fy setup`.

## Reaching it

**Browser:** Settings → **Machines** → a machine → Runtimes, Credentials, Profiles, Components,
Settings. The link is `#machines/<name>/<tab>`.

**Terminal** (`fy`; the name is derived from `packages/cli/package.json`):

| Verb                                                                                       | Does                                                                       |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `fy daemon setup` / `fy daemon import claude\|codex [--name <runtime>]`                    | the first run and "import again", asked; or one tool, unasked              |
| `fy machine` / `fy machine set agent-permissions auto\|skip` / `fy machine install <tool>` | facts, Agent permissions, installing Claude Code or Codex                  |
| `fy machine export` / `fy machine clone <file> [--replace]`                                | copy a setup to another machine (a sign-in is never copied: an empty slot) |
| `fy runtimes` / `fy runtime add\|show\|set\|rename\|rm`                                    | runtimes                                                                   |
| `fy credentials` / `fy credential add\|check\|signin\|signout\|label\|rm`                  | logins, their status and usage (`fy logins` / `fy login …` too)            |
| `fy profiles` / `fy profile ls\|show\|build\|edit\|rm`                                     | profiles, each with its scope                                              |
| `fy components [kind]` / `fy component show\|add\|edit\|rm <kind>/<name>`                  | components                                                                 |
| `fy start --agent <runtime>`                                                               | launch an agent runtime                                                    |
| `fy fleet recommend <task…>`                                                               | which agent suits a piece of work (the only `fleet` verb)                  |

## Renaming and removing a runtime

**Browser:** each runtime's row and its own page carry **Rename** and **Remove**, both `fleet.configure`
acts ([grants.md](grants.md)): a device that may not make them sees them disabled with the reason.
**Terminal:** `fy runtime rename <name> <new-name>` and `fy runtime rm <name>`, each with `--dry-run`,
`-y` and `--json`.

### Renaming a runtime

A rename is one reviewed `runtime.rename` change. **Nothing restarts**: a running ferret keeps its
process, and its runtime label follows the runtime to the new name. The runtime's opaque id never
changes (R6), so everything keyed by the id stays exactly where it is.

| What                                                                  | On a rename                                                                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtimes/<name>.yaml`                                                | moved to `runtimes/<new-name>.yaml`, with your comments                                                                                                                        |
| `ids.json`                                                            | the same id under the new name; the old name is added to its `formerNames`, so `fy start --agent <old>` keeps starting it                                                      |
| `machine.yaml` default runtime, `advanced.commands[].runtime`         | re-pointed, in the same apply                                                                                                                                                  |
| `warden.yaml` Warden logins, `learning.yaml` lesson-miner runtime     | re-pointed, in the same apply (swapping the word loosens nothing, so nothing is held for confirmation)                                                                         |
| the wrapper on `PATH` (`<FY_HOME>/fleet/bin/<name>`)                  | renamed: the old wrapper is removed and the new one written by the same apply                                                                                                  |
| the config directory (`fleet/homes/<id>`), its login and history pool | **kept** — keyed by id                                                                                                                                                         |
| every session record on it (`config.agent`, `command[0]`)             | re-pointed at the new name and wrapper once the apply lands, ended sessions included; a record that cannot be rewritten still resolves through `ids.json`                      |
| usage and quota rows                                                  | follow it: they are built live from the published names and the re-pointed records                                                                                             |
| a running process's `FY_RUNTIME`                                      | **kept** as the old name until it next starts; it is read only for a sentence                                                                                                  |
| analytics history                                                     | **kept**: past sessions stay recorded under the name they ran as                                                                                                               |
| Warden failover strikes, the quota-failover pool                      | **not renamed**: strikes start over under the new name, and a quota-failover pool (`<FY_HOME>/quota-failover/config.json`, hand-edited) that lists the old name must be edited |

A new name follows the runtime-name rules and is refused when it is another runtime, a command, or a
name or id another runtime is still known by. Renaming back to a name it had before is allowed.

### Removing a runtime

The dry run says what removing it does **first**: how many ferrets are running on it, by name. They
keep running, but restarting one later needs another runtime. The app offers **Move them to …**,
which restarts each one on the picked runtime with its conversation (resumed on the same CLI,
converted across to the other) before removing; if any cannot be moved, nothing is removed. The
machine's **default runtime for new agents** is refused until another default is picked, and the app
offers that picker inline. Past sessions stay in history.

## Routes

All under `/v1/fleet`. Reads need `fleet.use`; every write is `fleet.configure`, and a caller that is
not on the host also needs a passkey step-up ([grants.md](grants.md)); nothing is typed.

| Route                                                                                | Does                                                                    |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `GET /machine`                                                                       | settings, tools, setup state, and the caller's authority to apply       |
| `POST /machine/tools/install`                                                        | install a named tool (the command is shown first)                       |
| `GET /setup/scan`                                                                    | what a first run would import (key names only, never a value)           |
| `GET /credentials`, `POST /credentials/:credentialId/check`                          | logins with status and usage; Check now                                 |
| `POST /credentials/:credentialId/test`, `GET /presets`                               | an environment login's Test; the provider presets (provider-presets.md) |
| `POST /login`, `GET\|POST\|DELETE /login/:flowId`                                    | sign a credential in, through the harness's own flow                    |
| `GET /components`, `GET /profiles`, `POST /profiles/preview`, `GET /runtimes`        | read the catalogue; preview a profile's stack before saving             |
| `GET /export`                                                                        | the clone bundle: no login, no history                                  |
| `POST /proposals`, `GET /proposals/:proposalId`, `POST /proposals/:proposalId/apply` | stage, read and apply any change                                        |

## The single file is retired

A `fleet/config.yaml` — any version — is **refused, never converted**, while it is there. Nothing is
read from it and nothing is deleted. The same sentence reaches `fy` and the browser:

> _path_ is the old single-file configuration, which this Ferretry no longer reads: each login,
> component, profile and runtime is now its own file under config/ in the state home. Move it aside (for
> example rename it to config.yaml.old), then set this machine up again from the app or with
> `fy daemon setup`.

The state home's layout version is 2. A version-1 home is upgraded in place — only its marker changes —
so paired devices, sessions and secrets survive, and an older Ferretry refuses the upgraded home rather
than acting on a configuration nobody edits.

A `config/daemon.json` that still has an `accountModel` key, or the retired `fleet.prepareDefaults`
key (which every earlier boot wrote itself), still boots; the key is ignored and the boot says so
once. Delete it.
