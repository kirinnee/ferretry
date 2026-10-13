# Ferretry's account model: Login, Home, History

Status: **design only — nothing here is built.** It refines the owner's direction rather than
re-opening it:

> "a login (credential) is separate from a home (rightfully so), but conversation history should ALL
> be the same"

It supersedes the copy-based first run in [fleet-defaults.md](../fleet-defaults.md) ("The fleet arrives
signed in") and closes the hazard [credential-seeding.md](credential-seeding.md) describes, by making
the copy unnecessary rather than safer.

Every harness claim below is marked **VERIFIED** (run or read in the harness's own code), **INFERRED**
(follows from code read but not run, or from absence), or **UNKNOWN**. Sources: the Claude Code
2.1.281 spike (`CLAUDE_SECURESTORAGE_CONFIG_DIR`), the codex-rs reading recorded in the brief, and a
read of Ferretry `main` at `fa4312888`.

## Contents

1. [Why: what adding one account costs today](#1-why-what-adding-one-account-costs-today)
2. [The three entities and their rules](#2-the-three-entities-and-their-rules)
3. [Configuration: before and after](#3-configuration-before-and-after)
4. [CLI: before and after](#4-cli-before-and-after)
5. [PWA information architecture](#5-pwa-information-architecture)
6. [Per-harness mechanisms](#6-per-harness-mechanisms)
7. [Safety](#7-safety)
8. [Migration](#8-migration)
9. [Build plan](#9-build-plan)
10. [Declared gaps and open questions](#10-declared-gaps-and-open-questions)

---

## 1. Why: what adding one account costs today

Measured on `main` (`packages/pwa/src/features/fleet/**`, `packages/fleet/src/lib/**`):

| Cost                          | Today                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reaching Accounts             | gear → Settings section **Daemons** → daemon picker → panel rail **Fleet** → **Accounts** (indented child). Panel selection is component state, so nothing links straight to it.                                                                                                                                                                  |
| Adding one Claude account     | Accounts → "Add an account" (jumps to Fleet) → "Add account" again → an **8-step** stepper (Harness, Account, Sign-in, Models, Instructions, Skills, Settings, Review) → staged-change review → password modal → back to Accounts to actually sign in. About **11 screens and 12+ decisions** on the common path, about 25 counting every branch. |
| First run                     | **4 accounts from 2 logins**: `claude-default`, `claude-auto-default`, `codex-default`, `codex-auto-default`, each a separate home holding a **copy** of the host's credential.                                                                                                                                                                   |
| What the config makes you say | a UUID, a wrapper name, a home and a mode per route; variants; profiles; `identity` to say two routes share a login; `sharedHistory` booleans that default to **off**.                                                                                                                                                                            |
| What a row shows              | wrapper name, mode badge, health, a credential sentence, quota, and a `<kind>:<identity>` plumbing line.                                                                                                                                                                                                                                          |

Three structural causes, each removed by one rule in §2:

1. **A login is not an entity.** It is inferred from `identity` grouping, and each home holds its own
   copy, so one sign-in has to be fanned out (`fy fleet login` syncs siblings) and a refresh in one
   copy can kill the others ([credential-seeding.md §2](credential-seeding.md#2-the-hazard)).
2. **Interactive and auto are two accounts.** A "mode" is a whole route with its own home, UUID and
   wrapper, although the two differ only in launch flags and one instruction document.
3. **History is per home unless you opt in**, so the same person's conversations are scattered across
   homes, and `sharedHistory` is a setting most people never find.

---

## 2. The three entities and their rules

```
            serves many                    writes to (always)
   LOGIN  ───────────────►  HOME  ───────────────────────────►  HISTORY POOL
 (credential,             (what it knows,     each home gets     (one per harness:
  stored once)             how it runs)        two LAUNCHERS      every home's
                                               "you" + "agent"    conversations)
```

### 2.1 Login

A **login** is one provider credential.

| Rule | Statement                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1   | A login is **stored exactly once** and **never copied**. Every home that uses it reads that one store.                                                                                                                                                                                                                                                                                                            |
| L2   | A login has one harness (`claude` or `codex`).                                                                                                                                                                                                                                                                                                                                                                    |
| L3   | A login has one of three **stores**: `ferretry` (Ferretry owns the directory, under `<FY_HOME>/fleet/logins/<login>/`), `host` (the person's own `~/.claude` / `~/.codex` login, **adopted in place** — Ferretry stores a pointer, not a credential), or `environment` (Advanced: the existing `${secret:NAME}` profile mechanism from [fleet-env-profiles.md](../fleet-env-profiles.md); nothing to sign in to). |
| L4   | A login publishes a **status** — `Ready`, `Needs sign-in`, `Refresh due`, `Checking` — and **usage** (5-hour and weekly windows). Both are per login, never per home: one login is one rate-limit pool and one credential.                                                                                                                                                                                        |
| L5   | Ferretry **never refreshes a token on a timer.** A refresh happens when the harness does it naturally, at a session launch that is due, or on an explicit **Check now**.                                                                                                                                                                                                                                          |
| L6   | Signing a login in or out affects **every home that uses it**, and every surface says so in those words.                                                                                                                                                                                                                                                                                                          |
| L7   | The sharing mechanism for each harness is pinned by a **CI guard** (§6.4) that fails when a harness update breaks it.                                                                                                                                                                                                                                                                                             |

`host` is the refinement that makes the first-run question honest. "Use its login?" means _Ferretry
uses the very login you already have_ — the person's own `claude` and every Ferretry home read the
same store, take the same lock and see the same refresh. Nothing forks, so the
[credential-seeding](credential-seeding.md) hazard (a refresh in one copy signs the other out) cannot
occur, and signing out in your own terminal visibly signs Ferretry out too.

### 2.2 Home

A **home** is what an agent knows and how it runs: settings file, MCP servers, skills, instructions,
hooks, default model.

| Rule | Statement                                                                                                                                                                                                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1   | A home uses **exactly one login**. A login serves any number of homes. Changing a home's login is a one-field edit and touches no credential.                                                                                                                                                                              |
| H2   | A home always gets **two launchers**, generated, never declared: **you** (interactive) and **agent** (unattended). They share the home's directory, skills, instructions and settings file, and differ **only in launch arguments** (§6.3).                                                                                |
| H3   | `fy start --agent <home>` resolves to that home's **agent** launcher through the link the manifest records (`launcher.home`, `launcher.role`). Nothing derives one name from another by string manipulation, and the daemon's unattended-launch policy reads `role: agent` instead of matching `-auto-` in a wrapper name. |
| H4   | A home's identity is its **name** (a safe slug). Opaque launcher ids still exist for joins, but they live in Ferretry's state, not in the config (§3).                                                                                                                                                                     |
| H5   | Identity and auth never come from a home's own files. A home directory never contains a credential of its own; for Codex it contains a link to the login's file (§6.2).                                                                                                                                                    |

What can differ per launcher on one shared home, and how (§6.3 has the per-harness detail):

| Field              | Per home                        | Per launcher (you / agent)                                                                                          |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| settings file      | yes (generated in the home)     | overlay only: Claude `--settings <overlay>`, Codex `-c key=value` / `-p <profile>`                                  |
| MCP servers        | yes                             | extra servers: Claude `--mcp-config`; Codex `-c mcp_servers.…`                                                      |
| skills             | yes (`<home>/skills/<item>`)    | no — shared per home                                                                                                |
| base instructions  | yes (`CLAUDE.md` / `AGENTS.md`) | **appended** addendum only: Claude `--append-system-prompt-file`; Codex `-c` instructions override (INFERRED, §6.3) |
| plugins            | yes                             | Claude `--plugin-dir`                                                                                               |
| model              | yes (default)                   | Claude `--model`, Codex `-m`                                                                                        |
| permission posture | —                               | the agent launcher's bypass flags (today's `variants.auto.flags`)                                                   |

### 2.3 History

| Rule | Statement                                                                                                                                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | There is **one history pool per harness**, `<FY_HOME>/fleet/shared/<harness>/` (the path today's opt-in pool already uses).                                                                                                                                                                                                                       |
| P2   | Pooling is **always on**. It is not a setting; `sharedHistory` leaves the schema. Every home of a harness links its history entries into the pool.                                                                                                                                                                                                |
| P3   | **One live writer per conversation**, enforced by a conversation lease (§7.3). A second process that tries to resume a conversation someone is writing is refused, naming the holder.                                                                                                                                                             |
| P4   | History never carries identity or auth. The pooled entry lists stay exactly as `shared-history.ts` defines them (Claude: `projects`, `sessions`, `session-env`, `file-history`, `plans`, `tasks`, `todos`, `shell-snapshots`, `paste-cache`, `history.jsonl`; Codex: `sessions`, `archived_sessions`, `history.jsonl`, plus `CODEX_SQLITE_HOME`). |

Consequence: a conversation started in one home can be resumed from another home — on another login —
because the transcript is in one place. That is the owner's "conversation history should ALL be the
same".

### 2.4 What disappears

| Today                                                               | After                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| route UUID in config                                                | launcher id in state (`fleet/ids.json`), migrated UUIDs preserved                          |
| `wrapper:` per route                                                | derived: you = `<home>`, agent = `<home>-agent`; migrated names kept as recorded overrides |
| `home:` per route                                                   | derived: `<FY_HOME>/fleet/homes/<home>`                                                    |
| `mode:` and `variants.auto`                                         | the two launchers every home has                                                           |
| `identity:`                                                         | `login:` on the home                                                                       |
| `sharedHistory:`                                                    | always on                                                                                  |
| copy-and-sync (`fy fleet login --sync-only`, `FleetFirstRunSeeder`) | nothing to sync: one store                                                                 |

Profiles, variants beyond you/agent, settings stacks, shared-document names, aliases, commands and the
PATH line remain — **under Advanced** (§3.3).

---

## 3. Configuration: before and after

### 3.1 Before: a first-run `config.yaml` today (abridged, real shape)

```yaml
shared:
  memory:
    claude-default: ./CLAUDE.md
    claude-auto: ./CLAUDE-auto.md
    codex-default: ./AGENTS.md
    codex-auto: ./AGENTS-auto.md
  settings:
    claude: ./templates/claude/settings.json
    codex: ./templates/codex/config.toml
profiles:
  base:
    claude: { memory: ./CLAUDE.md, settings: ./templates/claude/settings.json }
    codex: { memory: ./AGENTS.md, settings: ./templates/codex/config.toml }
variants:
  default: {}
  auto:
    mode: auto
    claude:
      memory: ./CLAUDE-auto.md
      flags: [--dangerously-skip-permissions, --disallowed-tools=AskUserQuestion]
      settings: [{ skipDangerousModePermissionPrompt: true }]
    codex:
      memory: ./AGENTS-auto.md
      flags: [--dangerously-bypass-approvals-and-sandbox, --no-alt-screen]
agents:
  - name: default
    kind: claude
    routes:
      default:
        id: 6f1c…-… # minted UUID, must never change
        wrapper: claude-default
        home: claude-default
        defaultModel: claude-opus-5-5
        models: [claude-opus-5-5]
      auto:
        id: 0b7e…-…
        wrapper: claude-auto-default
        home: claude-auto-default
        defaultModel: claude-opus-5-5
        models: [claude-opus-5-5]
  - name: default
    kind: codex
    routes: { default: { … }, auto: { … } } # two more UUIDs, wrappers, homes
sharedHistory: { claude: false, codex: false }
```

Four accounts, four homes, four credential copies, two `identity` groups inferred from agent names.

### 3.2 After: the same host

```yaml
logins:
  claude:
    harness: claude
    store: host # the person's own ~/.claude login, adopted in place
  codex:
    harness: codex
    store: host

homes:
  claude-default:
    login: claude
    model: claude-opus-5-5
  codex-default:
    login: codex
    model: gpt-6-sol
```

Everything else is derived:

| Derived fact   | Rule                                                                                                        | Owner (after the build) |
| -------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------- |
| home directory | `<FY_HOME>/fleet/homes/<home>`                                                                              | `paths.ts`              |
| launchers      | you = `<home>`, agent = `<home>-agent`, unless `fleet/ids.json` records a migrated name                     | `launchers.ts` (new)    |
| launcher ids   | minted once into `fleet/ids.json`, never in config                                                          | `launchers.ts`          |
| instructions   | `CLAUDE.md` / `AGENTS.md` starter in the asset tree, shared by every home that names none                   | `defaults.ts`           |
| agent addendum | starter `agent-addendum.claude.md` / `.codex.md`, appended by the agent launcher                            | `defaults.ts`           |
| settings       | starter template per harness, plus forced keys (Codex `cli_auth_credentials_store = "file"`, `sqlite_home`) | `settings.ts`           |
| history        | always pooled                                                                                               | `shared-history.ts`     |
| models offered | the home's `model` plus anything listed under `advanced`                                                    | `config.ts`             |

### 3.3 After: the full schema

```yaml
logins:
  <login>:                         # safe slug; also the directory name for store: ferretry
    harness: claude | codex
    store: ferretry | host | environment    # default ferretry
    label: Work                    # optional; otherwise the account email when known
    env: { ANTHROPIC_API_KEY: ${secret:WORK_KEY} }   # store: environment only

homes:
  <home>:
    login: <login>                 # required; harness comes from the login
    model: <id>                    # default model
    instructions: ./CLAUDE.md      # optional; default is the harness starter
    skills: [review, deploy]       # optional items from the skills store
    mcp: ./mcp/work.json           # optional
    settings: ./templates/claude/settings.json   # optional file or list of layers
    hooks: ./hooks/work.json       # optional
    agent:                         # optional per-launcher overrides (Advanced)
      addendum: ./agent-addendum.claude.md
      model: claude-sonnet-5-5
      flags: [--max-turns=200]
    you: { … same shape as agent … }

advanced:                          # everything a basic user never sees
  secretsFile: ~/.secrets
  shared: { … }                    # shared-document names, as today
  profiles: { … }                  # as today; a home may list `profiles: [name]`
  variants: { … }                  # extra lanes beyond you/agent, each a third launcher
  models: { <home>: [ … ] }        # multi-model availability declarations, as today
  aliases: { … }
  commands: [ … ]
  usage: { … }                     # intervals, as today
  path: { announce: true }         # the PATH line
```

Validation rules, each with a sentence naming the field (the existing style in `config.ts`):

- a home's `login` must name a declared login;
- `store: host` is allowed **once per harness** (there is one host login per harness);
- `store: environment` requires `env` and forbids sign-in;
- `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CODEX_SQLITE_HOME` and **`CLAUDE_SECURESTORAGE_CONFIG_DIR`**
  join `RESERVED_ENV_NAMES` — a profile that set the last one could point a home at another login's
  credential;
- `sharedHistory`, `agents`, `routes`, `identity` are refused by the new schema **with a migration
  sentence** ("run `fy fleet migrate`"), never silently accepted (§8.4).

---

## 4. CLI: before and after

The binary name is derived (`packages/cli/package.json` `bin`); `fy` below is that derived name.

### 4.1 Before

| Command                                                        | Purpose                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `fy fleet` / `fleet ls`                                        | list accounts from the manifest                                          |
| `fy fleet init [--first-account claude\|codex]`                | write the starter config                                                 |
| `fy fleet apply [--dry-run]`                                   | build homes, wrappers, settings, manifest                                |
| `fy fleet usage`                                               | quota per account                                                        |
| `fy fleet health`                                              | credential verdict per account                                           |
| `fy fleet sharing`                                             | shared documents report                                                  |
| `fy fleet login [id…] [--status] [--sync-only] [--no-refresh]` | sync copies within an identity, refresh, or force an interactive sign-in |
| `fy fleet recommend <task…>`                                   | routing suggestion                                                       |
| `fy start --agent <wrapper\|uuid>`                             | must be an `*-auto-*` wrapper; refused otherwise                         |

### 4.2 After

| Command                                                    | Purpose                                                                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `fy accounts`                                              | logins with status and usage, and the homes under each (the default view)                                   |
| `fy login add claude\|codex [--name N] [--host]`           | sign in (link + code / device code), or `--host` to adopt this machine's own login                          |
| `fy login ls`                                              | logins, status, usage, homes using each                                                                     |
| `fy login check [<login>]`                                 | **Check now**: prove the login (§6.1.3, §6.2.3). The only command that may cause a Codex refresh on purpose |
| `fy login signin <login>`                                  | sign in again; fixes every home on it                                                                       |
| `fy login signout <login>`                                 | signs out **every** home on it; asks to confirm and names them                                              |
| `fy login rm <login>`                                      | refused while any home uses it                                                                              |
| `fy home add <name> --login <login> [--model M]`           | create a home (and its two launchers)                                                                       |
| `fy home ls` / `fy home show <home>`                       | homes, their login, launchers, skills, instructions                                                         |
| `fy home set <home> --login <login>`                       | move a home to another login; touches no credential                                                         |
| `fy home rm <home>`                                        | remove a home; history stays in the pool                                                                    |
| `fy start --agent <home>`                                  | resolves to the home's agent launcher; launcher names and migrated UUIDs are still accepted                 |
| `fy fleet apply`, `fy fleet sharing`, `fy fleet recommend` | unchanged, Advanced                                                                                         |
| `fy fleet migrate [--dry-run]`                             | convert an old config and state home (§8)                                                                   |

Retired, each kept one release as an alias that prints its replacement:

| Old                                                | New                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `fy fleet ls`, `fy fleet usage`, `fy fleet health` | `fy accounts`                                                     |
| `fy fleet login <id>`                              | `fy login signin <login of that home>`                            |
| `fy fleet login --status`                          | `fy login ls`                                                     |
| `fy fleet login --sync-only`                       | removed: nothing to sync. Prints why                              |
| `fy fleet init --first-account`                    | `fy login add` + `fy home add` (the daemon's first run does both) |

`add` and `set` write the config **and apply** in one step, through the same reviewed-proposal path the
daemon uses, so a basic user never types `apply`.

---

## 5. PWA information architecture

### 5.1 Depth

| Destination                                                      | Before                                                            | After                                             |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| Accounts list                                                    | gear → Daemons → machine → Fleet → Accounts (**5**, not linkable) | gear → **Accounts** (**2**, linkable `#accounts`) |
| A login                                                          | inline panel under a row                                          | Accounts → login (**3**)                          |
| A home                                                           | Fleet configuration surface                                       | Accounts → home (**3**)                           |
| Add                                                              | Accounts → Fleet → Add → 8 steps → review → password              | Accounts → **Add** → 2–3 short steps              |
| Profiles, variants, settings stacks, shared documents, PATH line | Fleet panel, primary                                              | Accounts → **Advanced** (**3**)                   |

**Accounts moves out of the per-daemon panel rail** into the Settings section list (Appearance /
Behaviour / **Accounts** / Devices / Daemon…). A **machine picker** sits above the list **only when more
than one daemon is connected**; with one daemon it is not rendered at all. Fleet's other panels
(environment, sharing) move under Advanced.

### 5.2 Accounts (phone, 390 px)

```
┌────────────────────────────────────┐
│ ‹ Settings        Accounts         │
│ ┌────────────────────────────────┐ │
│ │ Machine: studio-mac          ▾ │ │  ← only with 2+ daemons
│ └────────────────────────────────┘ │
│                                    │
│ CLAUDE · you@example.com           │
│ ● Ready                 Check now  │
│ 5h   ▓▓▓▓▓▓░░░░░░░░  38%  2h 10m   │
│ Week ▓▓▓▓▓▓▓▓▓░░░░░  61%  Fri      │
│ ┌────────────────────────────────┐ │
│ │ claude-default      Opus 5.5 › │ │
│ │ claude-review     Sonnet 5.5 › │ │
│ └────────────────────────────────┘ │
│                                    │
│ CODEX · you@example.com            │
│ ◐ Refresh due           Check now  │
│ 5h   ▓▓░░░░░░░░░░░░  12%           │
│ ┌────────────────────────────────┐ │
│ │ codex-default          GPT-6 › │ │
│ └────────────────────────────────┘ │
│                                    │
│ ┌────────────────────────────────┐ │
│ │        + Add account           │ │
│ └────────────────────────────────┘ │
│ Advanced                         › │
└────────────────────────────────────┘
```

Rules for this screen:

- grouped by **login**, homes as rows under it — a sign-out visibly affects the whole group;
- status words are exactly `Ready`, `Needs sign-in`, `Refresh due`, `Checking`; an inconclusive check
  shows the last known word with its age ("Ready · checked 3h ago"), never a fifth word;
- usage shows "unknown" rather than 0% when it does not know (as today);
- **no** wrapper names, UUIDs, home paths, modes or `<kind>:<identity>` lines. Launcher names appear
  on the home screen only;
- `Needs sign-in` replaces the usage bars with one **Sign in** button.

### 5.3 First run

Shown once on a host whose daemon found a harness login and has no logins yet.

```
┌────────────────────────────────────┐
│ Accounts                           │
│                                    │
│ Found Claude on this machine,      │
│ signed in as you@example.com.      │
│                                    │
│ Use its login?                     │
│ Ferretry and your own `claude`     │
│ will share it: signing out in one  │
│ signs out both.                    │
│                                    │
│ ┌────────────────────────────────┐ │
│ │        Use this login          │ │
│ └────────────────────────────────┘ │
│   Sign in with a different account │
│                                    │
│ Also found Codex.     [Use it too] │
└────────────────────────────────────┘
```

"Use this login" creates `logins.claude: {store: host}` and `homes.claude-default`, applies, and lands
on §5.2 with one login and one home, **Ready**. "Different account" runs the add flow at step 2. No
operator password is asked on loopback (the host already has the host); a remote device gets the
existing one-time confirmation (§5.6).

When the daemon finds no harness login at all, the card says "Found Claude on this machine, not signed
in" and its button is **Sign in**.

### 5.4 Add account: step by step

Two decisions at most: which harness, and which login. Three screens.

**Step 1 — harness** (skipped when only one harness is installed)

```
┌────────────────────────────────────┐
│ ‹ Accounts       Add account       │
│                                    │
│ Which agent?                       │
│ ┌────────────────────────────────┐ │
│ │ Claude Code          ✓ found   │ │
│ └────────────────────────────────┘ │
│ ┌────────────────────────────────┐ │
│ │ Codex                ✓ found   │ │
│ └────────────────────────────────┘ │
└────────────────────────────────────┘
```

**Step 2 — login.** When the harness already has logins, they are offered first; otherwise the screen
opens straight on the sign-in panel.

```
┌────────────────────────────────────┐
│ ‹ Back           Add account       │
│                                    │
│ Which Claude login?                │
│ ┌────────────────────────────────┐ │
│ │ you@example.com      ● Ready   │ │
│ │ shares usage with 2 accounts   │ │
│ └────────────────────────────────┘ │
│ ┌────────────────────────────────┐ │
│ │ Sign in with another account › │ │
│ └────────────────────────────────┘ │
└────────────────────────────────────┘
```

Sign-in (the existing `claude-login-panel` / `codex-login-panel`, unchanged inside):

```
┌────────────────────────────────────┐
│ ‹ Back      Sign in to Claude      │
│                                    │
│ 1 · Open this link anywhere        │
│ ┌──────────────────────────┐┌────┐ │
│ │ https://claude.ai/oauth… ││Copy│ │
│ └──────────────────────────┘└────┘ │
│ 2 · Paste the code Claude showed   │
│ ┌────────────────────────────────┐ │
│ │                                │ │
│ └────────────────────────────────┘ │
│ ┌────────────────────────────────┐ │
│ │         Finish sign-in         │ │
│ └────────────────────────────────┘ │
└────────────────────────────────────┘
```

**Step 3 — ready**

```
┌────────────────────────────────────┐
│                Ready               │
│                                    │
│ Claude · work@example.com          │
│ ● Ready                            │
│                                    │
│ Name                               │
│ ┌────────────────────────────────┐ │
│ │ claude-work                    │ │
│ └────────────────────────────────┘ │
│ ┌────────────────────────────────┐ │
│ │        Start a session         │ │
│ └────────────────────────────────┘ │
│              Done                  │
└────────────────────────────────────┘
```

The home is created with defaults (the harness starter instructions, settings and model; no extra
skills). Its name is prefilled as `<harness>-<login label slug>` and stays editable here and later.
Models, instructions, skills, MCP and settings are edited **afterwards** on the home screen, never in
the add flow.

### 5.5 Home and login screens (depth 3)

```
┌────────────────────────────────────┐   ┌────────────────────────────────────┐
│ ‹ Accounts     claude-default      │   │ ‹ Accounts   Claude · you@ex…      │
│                                    │   │ ● Ready · checked 4m ago           │
│ Login        you@example.com     › │   │ 5h   ▓▓▓▓▓▓░░░░░░  38%  2h 10m     │
│ Model        Opus 5.5            › │   │ Week ▓▓▓▓▓▓▓▓▓░░░  61%  Fri        │
│ Instructions CLAUDE.md           › │   │ ┌────────────────────────────────┐ │
│ Skills       review, deploy      › │   │ │           Check now            │ │
│ MCP servers  2                   › │   │ └────────────────────────────────┘ │
│ Settings     settings.json       › │   │ Used by                            │
│ Hooks        none                › │   │   claude-default                   │
│                                    │   │   claude-review                    │
│ Launchers                          │   │ Stored in your own ~/.claude       │
│  You    claude-default             │   │                                    │
│  Agent  claude-default-agent       │   │ Sign in again                      │
│                                    │   │ Sign out everywhere (2 accounts)   │
│ Remove this account                │   │                                    │
└────────────────────────────────────┘   └────────────────────────────────────┘
```

### 5.6 Authority, unchanged in kind

Every write is still a daemon-derived proposal under `fleet.configure` with the existing per-change
operator-password confirmation for a governed caller ([grants.md](../grants.md)). What changes is the
presentation: the add flow stages **one** proposal (login + home) and asks for the password **once**,
before sign-in starts; the full operation ledger is behind a "Show what will change" disclosure
instead of being a screen. The first-run plan (`FleetFirstRunPlan`) becomes the §5.3 card.

### 5.7 Advanced

Accounts → Advanced lists, each as today's surface moved here: Profiles · Environment (secret
profiles, `store: environment` logins) · Settings stacks · Shared documents · Extra lanes (variants) ·
Models per home · Launcher names · PATH line · Raw `config.yaml` (read-only).

---

## 6. Per-harness mechanisms

### 6.1 Claude Code

#### 6.1.1 Login sharing — shared secure-storage directory

Every launcher of every home on login `L` exports:

```sh
export CLAUDE_CONFIG_DIR=<FY_HOME>/fleet/homes/<home>
export CLAUDE_SECURESTORAGE_CONFIG_DIR=<store dir of L>
```

| store      | `CLAUDE_SECURESTORAGE_CONFIG_DIR` | where the credential lives                                                                                                                 |
| ---------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ferretry` | `<FY_HOME>/fleet/logins/<L>`      | Linux: `<dir>/.credentials.json` (0600). macOS: keychain `Claude Code-credentials-<sha256(dir)[0:8]>`                                      |
| `host`     | **`""`** (empty string)           | Linux: `~/.claude/.credentials.json`. macOS: the **bare** keychain item `Claude Code-credentials` — the one the person's own `claude` uses |

| Claim                                                                                                                                                                     | Status                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| The variable moves the store away from `CLAUDE_CONFIG_DIR`; two config dirs pointing at one store both report `loggedIn: true`; nothing is written into either config dir | **VERIFIED** (Linux, 2.1.281, fake token, dead proxy)                                                                                 |
| The macOS keychain service name is hashed from the secure-storage dir when set, and is the bare name when set to `""`                                                     | **VERIFIED** by running the bundle's own `rw`/`iLe`; the keychain write path itself is **INFERRED** (compiled out of the Linux build) |
| Refresh takes a cross-process lock keyed on the storage dir, re-reads before POSTing, and re-reads after `invalid_grant`; running processes reload on file change         | **VERIFIED** by reading; not raced live                                                                                               |
| `host` must use `""`, not the absolute `~/.claude` path: on macOS an explicit path would hash to a **different** item than the one the person's own `claude` uses         | **VERIFIED** (table in the spike: `""` → bare service)                                                                                |
| Login display (`oauthAccount` in `.claude.json`) is per config dir, so a new home's `/status` may show no account name                                                    | **INFERRED**; Ferretry writes `oauthAccount` into each home's `.claude.json` at creation, display only                                |

Ferretry's own readers must follow: `credential-store.ts` `keychainService(home)` and
`keychainServices` hash the **storage** dir, not the home; `claudeFilePath` reads
`<storage dir>/.credentials.json`.

**Rejected:** symlinking `.credentials.json`. Claude writes temp + rename, so the first refresh forks
the link into a regular file (VERIFIED); locks are per config dir so two homes can POST one refresh
token at once (VERIFIED by reading); and the v5 store reads a symlink with `O_NOFOLLOW` and treats
`ELOOP` as **logged out** behind a server-side flag (VERIFIED by reading). Copying is today's design
and is what this replaces.

#### 6.1.2 Status

| Word            | Claude condition                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ready`         | credential present, and the last read of `GET /api/oauth/usage` answered `200`, or a confirmed Anthropic JSON `403` (scope-limited, healthy — the existing rule in [fleet-health.md](../fleet-health.md)) |
| `Refresh due`   | access token expired, refresh token present, nothing has proved it yet. Claude renews it itself on next use; Ferretry does nothing                                                                        |
| `Needs sign-in` | no credential, or a proven rejection under the existing digest guard (a stale `401` cannot condemn a fresh credential)                                                                                    |
| `Checking`      | a Check now or the first read is in flight                                                                                                                                                                |

The verdict is **per login**: one probe per login (today: one per identity group), so siblings no
longer "inherit" a reading — there is only one credential. The 15-minute horizon and the HTML/WAF
`403` / bare `401` inconclusive rules carry over unchanged. Check now for Claude is the same free
usage read (no refresh, no spend).

#### 6.1.3 Usage

Two sources, passive first:

1. **Passive (VERIFIED field, INFERRED plumbing):** Claude passes `rate_limits.five_hour` /
   `seven_day` `{used_percentage, resets_at}` on statusLine stdin. Each home's generated settings set
   `statusLine.command` to Ferretry's `fy-statusline`, which writes the block to
   `<FY_HOME>/fleet/logins/<L>/usage.json` (atomic) and then runs the person's own statusLine
   command, if their settings named one, passing stdin through. The login is known because the
   launcher exports `FY_LOGIN=<L>`, which the statusLine child inherits (INFERRED: Claude spawns
   statusLine with its own environment). Only interactive TUI sessions render a statusLine.
2. **Active (today's mechanism):** `GET /api/oauth/usage` on the existing usage pass, used when no
   passive reading is younger than the pass interval.

### 6.2 Codex

#### 6.2.1 Login sharing — one canonical `auth.json`, linked into homes

```
<FY_HOME>/fleet/logins/<L>/auth.json          ← the one file (0600)   [store: ferretry]
~/.codex/auth.json                            ← the one file           [store: host]
<FY_HOME>/fleet/homes/<home>/auth.json  ──►   symlink to the one file
```

Each Codex home's generated `config.toml` forces `cli_auth_credentials_store = "file"`, so Codex never
moves the credential into a keyring where the link cannot follow it.

| Claim                                                                                                                                                        | Status                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Codex rewrites `auth.json` **in place** (open + truncate + write through the path), so a symlinked path keeps pointing at the canonical file after a refresh | **VERIFIED** (codex-rs reading, per brief); not yet run against the pinned binary — the CI guard does that (§6.4)       |
| Codex reloads `auth.json` from disk before refreshing, so a process that finds a newer token adopts it instead of spending the old refresh token             | **VERIFIED** (codex-rs reading)                                                                                         |
| `cli_auth_credentials_store = "file"` forces file storage                                                                                                    | **VERIFIED** (codex-rs reading)                                                                                         |
| There is no cross-process lock around a Codex refresh; two processes reaching "due" in the same instant can both spend one single-use refresh token          | **INFERRED** from the absence of a lock; see §7.2                                                                       |
| `codex logout` in one home removes that home's **link**, not the canonical file                                                                              | **INFERRED** (`remove_file` on a symlink path unlinks the link). Whether logout also revokes server-side is **UNKNOWN** |
| `store: host` works only when the person's own Codex keeps a file. A host on keyring storage has no file to link                                             | **INFERRED**; the first-run card then offers "Sign in" instead of "Use this login"                                      |

This needs one narrow change to `StateFileSystem`'s symlink exemption
(`packages/daemon/src/adapters/filesystem/state-file-system.ts`): a link at
`fleet/homes/<home>/auth.json` may resolve into `fleet/logins/<L>/auth.json`, or to the host's
`~/.codex/auth.json` for a `host` login. Nothing else is admitted.

#### 6.2.2 Status

| Word            | Codex condition                                                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ready`         | `auth.json` present and readable, access JWT not within 5 minutes of `exp`, `last_refresh` younger than 8 days, and no failed refresh recorded since the last success                                          |
| `Refresh due`   | access JWT `exp` within 5 minutes, **or** `last_refresh` older than 8 days. Codex refreshes at its next start; a launch through Ferretry that is due goes through today's launch renewal (`launch-renewal.ts`) |
| `Needs sign-in` | no `auth.json`, or a refresh **observed** to fail permanently (Check now, or launch renewal, returned `refresh_token_expired` / `reused` / `invalidated`)                                                      |
| `Checking`      | a Check now refresh is in flight                                                                                                                                                                               |

The rule that shapes everything: **a Codex login is proved accepted only by a refresh, and a refresh
rotates the single-use token.** So:

- Ferretry **never** refreshes on a timer, and the usage endpoint is **never** read as login proof (it
  answers `200` for stale tokens — the reason today's health says Codex is `unknown`).
- A natural refresh is **observed**, not caused: when the canonical file's `last_refresh` advances,
  the login is recorded `Ready (accepted <time>)`.
- **Check now** is the explicit refresh (`codex app-server` → `getAuthStatus {refreshToken: true}`,
  today's `ProcessFleetTokenRefreshPort`) and its outcome is classified. With one canonical file this
  is finally safe: the rotated token lands in the one file every home reads, so no sibling copy dies.

This upgrades Codex from "honestly `unknown`" to a real status, because the thing that made a refresh
dangerous — copies — no longer exists.

#### 6.2.3 Usage

1. **Passive, zero network (VERIFIED source, INFERRED field names):** the newest `token_count` event's
   `rate_limits` (primary = 5-hour, secondary = weekly; `used_percent`, `resets_at`) in a rollout.
   Rollouts live in the shared pool, which mixes logins, so attribution goes through Ferretry's own
   session records: the transcript resolver already claims each rollout for one session, and the
   session records which home — and so which login — launched it. A rollout Ferretry did not launch
   is not attributed.
2. **Active, free:** `GET https://chatgpt.com/backend-api/wham/usage` with the login's bearer and
   `chatgpt-account-id`. **Not** login proof. Ferretry does **not** send `originator: codex_cli_rs`
   (kfleet did, against `…/codex/usage`; both choices are dropped).

### 6.3 Launchers: how "you" and "agent" differ on one home

Generated by `wrappers.ts` from the home and its login. Both export the same home and store variables;
the agent launcher adds arguments.

|                        | Claude                                                                                  | Codex                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| both                   | `CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `FY_LOGIN`, `FY_HOME_NAME`      | `CODEX_HOME`, `CODEX_SQLITE_HOME`, `FY_LOGIN`, `FY_HOME_NAME`                                                                     |
| agent permission flags | `--dangerously-skip-permissions --disallowed-tools=AskUserQuestion`                     | `--dangerously-bypass-approvals-and-sandbox --no-alt-screen`                                                                      |
| agent settings overlay | `--settings <home>/.fy/agent-settings.json` (`skipDangerousModePermissionPrompt: true`) | `-c key=value` pairs                                                                                                              |
| agent instructions     | `--append-system-prompt-file <agent addendum>`                                          | `-c` instruction-file override (**INFERRED**: key name to confirm against the pinned codex-rs; fallback is a separate home, §8.2) |
| per-launcher model     | `--model`                                                                               | `-m`                                                                                                                              |
| per-launcher MCP       | `--mcp-config`                                                                          | `-c mcp_servers.<name>…`                                                                                                          |
| per-launcher plugins   | `--plugin-dir`                                                                          | —                                                                                                                                 |

Flag existence is **VERIFIED** for every row (brief research). How `--settings` merges with the home's
own `settings.json` (overlay vs replace) is **INFERRED** overlay, and the CI guard asserts it.

Today the two lanes have whole separate instruction documents (`CLAUDE.md` / `CLAUDE-auto.md`). After,
the home has one document and the agent launcher **appends** a short addendum (the unattended
guidance). The starter addendum is the part of today's `-auto` starter that differs from the base
starter.

The manifest publishes each launcher with `{id, home, login, role: you | agent | <variant>, wrapper,
harness}`. `fy start --agent <home>` looks up `launchers.find(l => l.home === name && l.role ===
'agent')`, then falls back to an exact launcher name, then a launcher id. `unrunnableAccountRefusal`
and `authorizeSessionCommand` test `role === 'agent'` (or a variant declared unattended) instead of
`/^(?:claude|codex)-auto-/`.

### 6.4 The CI guard

A new CI job, `harness-contract`, runs against the **nix-pinned** `claude-code` and `codex` (the same
derivations the devshell provides), in a throwaway `HOME`, with fake tokens and `HTTPS_PROXY` pointed
at a dead port. It fails the build if a harness update breaks a mechanism this design relies on.

Claude:

1. Two config dirs with one `CLAUDE_SECURESTORAGE_CONFIG_DIR` holding a fake credential: `claude auth
status --json` reports logged in for both; neither config dir gains a credential file.
2. Without the variable, the second dir reports logged out (the variable is load-bearing).
3. The binary still contains the `CLAUDE_SECURESTORAGE_CONFIG_DIR` read in the store resolver
   (`rg -a`), so a rename fails here with a message naming the variable.
4. `--settings` overlay: a key set only in the overlay is visible to `claude config get`-style output
   (or the guard's equivalent read).

Codex:

1. A canonical `auth.json` with a fake, expired token, linked into two homes; a local HTTP server
   stands in for the token endpoint (`CODEX_REFRESH_TOKEN_URL_OVERRIDE`, **INFERRED** name to confirm
   in codex-rs; if absent, the guard stubs the endpoint by proxy).
2. Trigger one refresh (`codex app-server` → `getAuthStatus {refreshToken: true}`).
3. Assert: each home's `auth.json` is **still a symlink**, the canonical file holds the new token, and
   the other home reads it.
4. With `cli_auth_credentials_store = "file"`, no keyring call is attempted.

A second, scheduled run uses the **latest** published versions, so a break is seen before the pin
moves. At runtime the daemon compares each harness's reported version with the range the guard last
passed and says so on boot when outside it; it still runs (the mechanism may well work), and the
remedy it names is "sign each home in separately" (§7.5).

---

## 7. Safety

### 7.1 Rotation

- **Claude:** rotation is supported by its code but not proved (INFERRED). Either way it is safe with
  one store: the rotated token is written to the one store under the one lock.
- **Codex:** refresh tokens are single-use (seed provenance already records `rotation: single_use`).
  With copies, any refresh killed every other copy. With one canonical file, a refresh replaces the
  token for every home at once. This is the main safety gain of the design.

### 7.2 Races

| Race                                                   | Outcome                                                                                 | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two Claude homes refresh at once                       | One takes the lock; the other re-reads under the lock, sees a new token, skips the POST | Claude's own code (VERIFIED by reading)                                                                                                                                                                                                                                                                                                                                                                    |
| Two Codex homes reach "due" in one instant             | Both may POST one single-use token; one gets `refresh_token_reused`                     | Codex reloads before refreshing, so the window is the POST round trip (INFERRED). Ferretry renews a due login **at launch**, under a per-login lock in the daemon, so Ferretry's own launches never race each other. A loser that is a running process is recorded `Needs sign-in` only if the canonical file did not advance. **Declared residual** for two processes the person started outside Ferretry |
| Ferretry's Check now vs a running Codex refresh        | Same as above                                                                           | Check now takes the daemon's per-login lock and re-reads the file first (today's `token-refresh.ts` re-read)                                                                                                                                                                                                                                                                                               |
| Migration moves a credential while a harness writes it | A lost refresh                                                                          | Migration refuses while any session on that login is live (§8.3)                                                                                                                                                                                                                                                                                                                                           |

### 7.3 One live writer per conversation

Today nothing stops two processes appending to one Claude conversation file; the only guard is a
per-Ferretry-session queue. Pooling makes it more likely, so P3 is enforced:

- **Lease:** `<FY_HOME>/fleet/shared/<harness>/.leases/<conversation-id>` records the holder's pid and
  process start time. A lease whose holder is dead (or whose pid now has a different start time) is
  stale and may be taken. This reuses the daemon's existing state-home lock primitive rather than a new
  one.
- **Daemon:** every Ferretry session start, resume and fork claims the lease for the harness
  conversation id it launches with (`--session-id` / `--resume <id>`, the Codex rollout id the resolver
  claims). A held lease refuses with the holder named ("being written by session _X_ on
  _claude-review_ since 14:02").
- **Launchers:** before `exec`, a launcher whose arguments name a conversation explicitly
  (`--resume <id>`, `-r <id>`, `--session-id <id>`, `codex resume <id>`) runs `fy history claim <id>
--pid $$`; because the launcher then `exec`s, `$$` is the harness's own pid and no release is needed.
- **Declared gap:** `--continue`, `codex resume --last` and the in-app picker choose a conversation
  after launch, so neither layer can see the id in advance. The daemon additionally refuses to resume a
  conversation whose file was appended to in the last 30 seconds by a process holding no lease, and
  says why.

### 7.4 Logout kills all

| Harness | Effect of logging out in any one home                                                                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude  | Deletes the one credential and revokes the refresh token: **every home on that login is signed out**, and, for `store: host`, so is the person's own `claude` (VERIFIED: one store) |
| Codex   | Unlinks that home's link only; the canonical file and other homes survive (INFERRED). If logout also revokes server-side (UNKNOWN), all homes fail at their next refresh            |

So every surface treats sign-out as login-wide: the login screen says "Sign out everywhere (N
accounts)", `fy login signout` names the homes and asks to confirm, and when a Claude store vanishes
the status flips to `Needs sign-in` for the whole group at once, with one **Sign in** that fixes all of
them. The agent launcher cannot block `/logout` (it is a slash command, not a tool); that is stated,
not hidden.

### 7.5 Depending on an undocumented variable

`CLAUDE_SECURESTORAGE_CONFIG_DIR` is not documented and could be renamed or removed.

- The CI guard (§6.4) fails on the first harness version that breaks it.
- The runtime version check says so at boot.
- The **fallback is per-home sign-in** — exactly today's Claude behaviour without copies: each home
  becomes its own `store: ferretry` login. It costs N sign-ins, never a broken or forked credential.
  The migration tooling (§8) can perform that split.
- Never the fallback: symlinks (§6.1.1), copies (credential-seeding hazard), or a central refresher
  injecting `CLAUDE_CODE_OAUTH_TOKEN` (sessions die at expiry; impersonates the client's refresh).

### 7.6 Secrets and display

No route, command or log line returns a credential value (unchanged). `store: host` logins are shown
as "Stored in your own ~/.claude" so a person knows where it lives. A pairing code, QR or token never
appears in any wireframe or capture.

---

## 8. Migration

Goal: **no data loss and no sign-out** for every existing host.

### 8.1 What exists in the wild

| Case                          | Shape                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — default first run         | 1 agent per harness named `default`, routes `default` + `auto`, 4 homes, each with a **seeded copy** of the host credential (`seed-provenance.json` says `seeded_copy`) |
| B — first run plus edits      | as A, with edited `CLAUDE-auto.md`, extra skills or models per route                                                                                                    |
| C — hand-built fleets         | several agents, `identity` groups, custom variants, profiles                                                                                                            |
| D — environment-authenticated | `auth: api-key` or `${secret:…}` env profiles                                                                                                                           |
| E — shared history on or off  | `sharedHistory.<kind>` either way; a pool may exist already                                                                                                             |

### 8.2 Mapping rules

1. **Logins** — one per `<kind>:<identity>` group (the key `identity.ts` already computes).
   - If the host's own login exists and is readable, and seed provenance says every home in the group
     is a `seeded_copy` of it: `store: host`. The home copies are **retired**, not used.
   - Otherwise: `store: ferretry`, and the **freshest** credential in the group is **moved** (not
     copied) into `fleet/logins/<L>/` — Claude: the latest `expiresAt`; Codex: the latest
     `last_refresh` (with single-use rotation, it is the only one still alive). On macOS a move is
     read the freshest keychain item → write the item named for the store dir → verify by reading it
     back → delete the old item.
   - Case D groups become `store: environment` with the profile's `env`.
2. **Homes** — the routes of one agent merge into **one home** when they differ only in what the two
   launchers can express: mode flags, `skipDangerousModePermissionPrompt`, and an `-auto` instruction
   document that is the unedited starter. The interactive route's directory becomes the home; the
   auto route becomes that home's agent launcher.
   - Routes that differ in anything else (edited `-auto` document, different skills, MCP, settings,
     models) become **two homes on the same login**. Nothing is lost, and history is shared anyway.
   - Variants other than `default`/`auto` become `advanced.variants` (a third launcher) when mergeable,
     else separate homes.
3. **Launcher identity** — each launcher keeps its route's UUID and wrapper name, recorded in
   `fleet/ids.json`. So `claude-default` and `claude-auto-default` still exist and still mean what
   they meant, and every session record, task board and pricing row that references an account id
   still joins.
4. **History** — pooling is run for every harness where it was off, using today's rename-based
   migration (inode-preserving, journaled, collision-quarantining, cross-device refusing). An auto
   home being retired has its history entries pooled **before** it moves.
5. **Retirement** — retired homes and credential copies move to `fleet/retired/<timestamp>/` (0700,
   credentials 0600), listed in the migration report, and are deleted by an explicit `fy fleet migrate
--purge-retired` or after one release with a boot notice. Retired Claude keychain items are listed
   by name and deleted only by that purge.

### 8.3 Procedure

1. `fy fleet migrate --dry-run` (also offered as a proposal in Accounts › Advanced): prints logins,
   homes, launchers, which credential is kept and why, which copies retire, the history moves, and the
   new `config.yaml`.
2. Refused while any session on an affected login is live, naming the sessions (§7.2).
3. Apply: backs up `config.yaml` to `config.yaml.pre-account-model`, writes the mutation journal, moves
   credentials, pools history, rewrites the config, regenerates launchers, publishes the manifest.
4. Verify: each new login is read through the new mechanism (`claude auth status` with the store dir;
   Codex reads the linked file) **before** any old copy is retired. A login that fails verification
   rolls back to its old copies and is reported, leaving the rest migrated.
5. Report: per login, which credential was kept and from where; per home, its launchers and their
   old names.

### 8.4 Compatibility window

- For one release the daemon **reads** an old-schema config by converting it in memory with the same
  mapping and keeps running; boot and Accounts say "this fleet uses the old account format — Migrate".
  It never writes old-schema files.
- `fy start --agent <old wrapper name | old UUID>` keeps working forever via `fleet/ids.json`.
- The first run on a host with **no** fleet writes the new schema directly (§5.3), and
  `FleetFirstRunSeeder` is deleted: there is nothing to seed.

---

## 9. Build plan

File-disjoint units: no file is owned by two units. Ordering below.

| Unit                    | Owns (files)                                                                                                                                                                                                                                                                                                                  | Delivers                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **U1 Schema**           | `packages/fleet/src/lib/config.ts`, new `packages/fleet/src/lib/account-model.ts` (old→new conversion, pure), `packages/fleet/src/lib/manifest.ts`                                                                                                                                                                            | `logins`/`homes`/`advanced` schema, reserved env names, launcher rows with `role`/`home`/`login`; the in-memory converter used by U8 and by the compatibility read |
| **U2 Login stores**     | `packages/fleet/src/adapters/credential-store.ts`, `packages/fleet/src/adapters/credential-classifier.ts`, `packages/daemon/src/adapters/filesystem/state-file-system.ts`                                                                                                                                                     | Claude store-dir resolution and keychain naming from the storage dir (`""` for host); Codex canonical file + link; the narrowed symlink exemption                  |
| **U3 CI guard**         | new `packages/fleet/tests/contract/**`, `.github/workflows/ci.yaml` (new job), new scheduled workflow file                                                                                                                                                                                                                    | §6.4, both pinned and latest                                                                                                                                       |
| **U4 Launchers**        | `packages/fleet/src/lib/wrappers.ts`, new `packages/fleet/src/lib/launchers.ts`, `packages/fleet/src/lib/settings.ts`, `packages/fleet/src/lib/paths.ts`, `packages/fleet/src/lib/plan.ts`                                                                                                                                    | two launchers per home, store env vars, agent overlay/addendum, forced Codex keys, `fleet/ids.json`                                                                |
| **U5 Start resolution** | `packages/daemon/bin/fyd.ts` (`resolveStartAccount` only), `packages/daemon/src/lib/session/lifecycle/policy.ts`, `packages/daemon/src/lib/session/lifecycle/settings.ts`                                                                                                                                                     | home → agent launcher by recorded link; role-based policy replacing the `-auto-` regex                                                                             |
| **U6 History + lease**  | `packages/fleet/src/lib/shared-history.ts`, new `packages/daemon/src/lib/session/conversation-lease.ts`, `packages/daemon/src/lib/session/resume/policy.ts`, `packages/daemon/src/lib/session/lifecycle/service.ts`, new `packages/cli/src/lib/history/**` (`fy history claim`)                                               | always-on pooling, lease in daemon and launchers                                                                                                                   |
| **U7 Status + usage**   | new `packages/fleet/src/lib/login-status.ts`, `packages/fleet/src/lib/health.ts`, `packages/fleet/src/lib/usage.ts`, `packages/fleet/src/lib/token-refresh.ts`, new `packages/fleet/src/adapters/codex-usage-probe.ts`, new `packages/fleet/src/adapters/rollout-rate-limits.ts`, new `fy-statusline` entry in `packages/cli` | the four words per login, passive + active usage, Check now classification, per-login refresh lock                                                                 |
| **U8 Migration**        | new `packages/fleet/src/lib/migration.ts`, new `packages/fleet/src/adapters/migration-executor.ts`, `packages/fleet/src/lib/seed-provenance.ts`                                                                                                                                                                               | §8, dry run, verify-before-retire, rollback                                                                                                                        |
| **U9 First run**        | `packages/fleet/src/lib/defaults.ts`, `packages/fleet/src/lib/scaffold.ts`, `packages/fleet/src/lib/credential-seed.ts` (deleted), `packages/daemon/src/lib/fleet/boot-preparation.ts`, `packages/daemon/src/lib/fleet/harness-discovery.ts`                                                                                  | host-login detection, new starter config, boot sentences                                                                                                           |
| **U10 Daemon routes**   | `packages/daemon/src/lib/runtime/mounts/fleet.ts`, `packages/daemon/src/lib/runtime/mounts/fleet-login.ts`, `packages/daemon/src/lib/fleet/proposals.ts`, `packages/daemon/src/lib/fleet/launch-renewal.ts`, `scripts/validate/route-agreement-allowlist.txt`                                                                 | `/v1/fleet/logins`, `/v1/fleet/homes`, Check now, combined add proposal, migrate proposal                                                                          |
| **U11 CLI**             | `packages/cli/src/lib/fleet/**`, new `packages/cli/src/lib/accounts/**`, new `packages/cli/src/lib/login/**`, new `packages/cli/src/lib/home/**`                                                                                                                                                                              | §4.2 and the aliases                                                                                                                                               |
| **U12 PWA**             | `packages/pwa/src/features/fleet/**`, `packages/pwa/src/features/settings/settings-catalog.ts`, `packages/pwa/src/features/settings/settings-page.tsx`, `packages/pwa/src/features/settings/daemon-settings-frame.tsx`                                                                                                        | §5: Accounts at depth 2, first-run card, 3-step add, home/login screens, Advanced                                                                                  |
| **U13 Docs**            | `docs/fleet-defaults.md`, `docs/fleet-health.md`, `docs/fleet-sharing.md`, `docs/design/credential-seeding.md`, new `docs/account-model.md` (the contract, promoted from this design), `CLAUDE.md` index lines                                                                                                                | contracts updated in the same PRs as their units, final pass here                                                                                                  |

Ordering (a unit starts when everything it points at has merged):

```
U1 ──┬──► U2 ──┬──► U4 ──┬──► U5
     │         │         ├──► U6
     │         │         └──► U7 ──► U10 ──┬──► U11
     │         └──► U3                     └──► U12
     └──► U8 (needs U2, U4) ──► U9 ──────────────► U13
```

- **U1** first: everything reads the schema.
- **U2, U3** in parallel after U1. U3 lands **before** U4 ships so the mechanism is guarded from the
  first release that relies on it.
- **U4** then **U5, U6, U7** in parallel.
- **U8** after U2 + U4 (it moves credentials and regenerates launchers); **U9** after U8 (the first run
  and the migration share the starter).
- **U10** after U7 + U8; **U11** and **U12** in parallel after U10.
- **U13** closes; each earlier unit still edits the contract doc it changes (the route-and-dial rule:
  a route and its client land together, so U10's routes ship with at least a minimal U11/U12 consumer
  or wait for them in one PR).

---

## 10. Declared gaps and open questions

1. **macOS Claude keychain path is INFERRED.** The Linux build compiles the keychain branch out. The
   CI guard runs on Linux; a `macos-15` guard job is the remedy and is listed as a release gate for
   U2.
2. **Codex concurrent refresh** between two processes the person started themselves is a residual
   race (§7.2).
3. **`--continue` / picker resumes** are not leased (§7.3).
4. **Codex instruction override key** for the agent addendum is unconfirmed (§6.3); until confirmed, a
   Codex home whose agent launcher needs different instructions is migrated as two homes.
5. **Codex `store: host` on a keyring host** cannot link; first run offers sign-in instead.
6. **Server-side revoke on `codex logout`** is UNKNOWN (§7.4).
7. **Passive Claude usage needs an interactive session**; headless (`-p`) sessions fall back to the
   active read.
8. **Open question for the owner:** should `store: host` be the first-run default for Codex too, given
   that a person's own `codex` refresh and Ferretry's then share one single-use token stream? This
   design says yes (one file is the safe shape) and the first-run card says so in words.
