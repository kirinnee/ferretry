# The account model

Ferretry runs Claude Code and Codex on a **machine** (one daemon). This page is the contract: what the
five things are, where they live, how to reach them, and what is refused. The reasons, the full rules,
the flows and the per-harness mechanisms are in [design/account-model.md](design/account-model.md);
where the two disagree, read that one and fix this one.

## The five things

| Thing          | Is                                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Machine**    | One daemon. Everything below belongs to exactly one machine. It owns **Agent permissions** (`auto` or `skip`) and knows which tools (Claude Code, Codex) are installed.                       |
| **Credential** | A login to Claude or Codex, stored once and never copied. Its store is `host` (your own `claude` / `codex` login, shared in place), `ferretry` (signed in through Ferretry) or `environment`. |
| **Component**  | A piece of setup saved once and referenced: Instructions, MCP servers, Skills, Settings, Hooks or a Model set.                                                                                |
| **Profile**    | An ordered list of layers, each a component or another profile. The newer layer wins.                                                                                                         |
| **Runtime**    | One credential plus one profile, under a name you type (`claude-default`). An **agent** runtime is one Ferretry may launch unattended; it gets a fixed layer applied last.                    |

A credential's status is one of **Ready**, **Refresh due**, **Needs sign-in** or **Checking**. Ferretry
never refreshes a login on a timer and never spends a model turn to learn a status. History is one pool
per harness, shared by every runtime of that harness.

## Where state lives

Under `<FY_HOME>/fleet/`:

| Path                   | Holds                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `config.yaml`          | the machine settings, credentials, components, profiles and runtimes (`version: 2`) |
| `assets/components/**` | component bodies                                                                    |
| `credentials/<id>/`    | a `ferretry`-store login (never a `host` one, which stays in your own home)         |
| `shared/<harness>/`    | the history pool                                                                    |
| `ids.json`             | each runtime's opaque id                                                            |
| `manifest.json`        | the runtimes Ferretry published, which launches read                                |

A change is a reviewed **proposal**: the person or agent proposes it, reads what it would do, and
applies it. No route, command or log line ever returns a credential value
([secrets.md](secrets.md)).

## Reaching it

**Browser:** Settings → **Machines** → a machine → Runtimes, Credentials, Profiles, Components,
Settings. The link is `#machines/<name>/<tab>`.

**Terminal** (`fy`; the name is derived from `packages/cli/package.json`):

| Verb                                                                                       | Does                                                           |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `fy setup` / `fy setup import`                                                             | the first run, and "import again"                              |
| `fy machine` / `fy machine set agent-permissions auto\|skip` / `fy machine install <tool>` | facts, Agent permissions, installing Claude Code or Codex      |
| `fy machine export` / `fy machine clone <file> [--replace]`                                | copy a setup to another machine (logins arrive as empty slots) |
| `fy runtimes` / `fy runtime add\|show\|set\|rm`                                            | runtimes                                                       |
| `fy credentials` / `fy credential add\|check\|signin\|signout\|label\|rm`                  | logins, their status and usage                                 |
| `fy profiles` / `fy profile show\|build\|edit\|rm`                                         | profiles                                                       |
| `fy components [kind]` / `fy component show\|add\|edit\|rm <kind>/<name>`                  | components                                                     |
| `fy start --agent <runtime>`                                                               | launch an agent runtime                                        |
| `fy fleet recommend <task…>`                                                               | which agent suits a piece of work (the only `fleet` verb)      |

## Routes

All under `/v1/fleet`. Reads need `fleet.use`; every write is `fleet.configure`, and a caller that is
not on the host also needs the per-change operator password ([grants.md](grants.md)).

| Route                                                                                | Does                                                              |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `GET /machine`                                                                       | settings, tools, setup state, and the caller's authority to apply |
| `POST /machine/tools/install`                                                        | install a named tool (the command is shown first)                 |
| `GET /setup/scan`                                                                    | what a first run would import (key names only, never a value)     |
| `GET /credentials`, `POST /credentials/:credentialId/check`                          | logins with status and usage; Check now                           |
| `POST /login`, `GET\|POST\|DELETE /login/:flowId`                                    | sign a credential in, through the harness's own flow              |
| `GET /components`, `GET /profiles`, `POST /profiles/preview`, `GET /runtimes`        | read the catalogue; preview a profile's stack before saving       |
| `GET /export`                                                                        | the clone bundle: no login, no history                            |
| `POST /proposals`, `GET /proposals/:proposalId`, `POST /proposals/:proposalId/apply` | stage, read and apply any change                                  |

## Version 1 is retired

A `config.yaml` with no `version` key, or `version: 1`, is **refused, never converted**. Nothing is
read from it and nothing is deleted. The same sentence reaches the daemon boot, `fy` and the browser:

> _path_ uses the old account format, which this Ferretry no longer reads. Move it aside (for example
> rename it to config.yaml.old) and restart the daemon; the first run then sets this machine up again
> from its own Claude Code and Codex.

A `config/daemon.json` that still has an `accountModel` key still boots; the key is ignored and the boot
says so once. Delete it.
