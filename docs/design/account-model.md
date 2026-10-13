# Ferretry's account model: Machines, Credentials, Components, Profiles, Runtimes

Status: **design only — nothing here is built.** The owner approved this model after a long
discussion and a clickable prototype ("looks good -- apply"). It replaces this document's earlier
"Login / Home / History" draft. From that draft it keeps the verified per-harness mechanisms (§8),
the safety analysis (§9) and the migration analysis (§10), each restated in the new words.

**The prototype is the UX spec:** [account-model-prototype.html](account-model-prototype.html), a
static reference page that is not shipped. Open it in a browser. Every flow in §4 and every edge case
in §11 can be clicked through from its catalogue. Where this document and the prototype disagree on
what a screen shows or says, the prototype wins, and this document is the bug.

It supersedes the copy-based first run in [fleet-defaults.md](../fleet-defaults.md) ("The fleet arrives
signed in"). It also closes the hazard [credential-seeding.md](credential-seeding.md) describes, by
removing the need to copy a credential at all.

Every harness claim is marked **VERIFIED** (run, or read in the harness's own code), **INFERRED**
(follows from code read but not run, or from absence) or **UNKNOWN**. Sources: the Claude Code
2.1.281 spike (`CLAUDE_SECURESTORAGE_CONFIG_DIR`), the codex-rs reading recorded in the original
brief, and a read of Ferretry `main` at `fa4312888` / `6eabb2e78`.

## Contents

1. [Why](#1-why)
2. [The vocabulary](#2-the-vocabulary)
3. [Entities and their rules](#3-entities-and-their-rules)
4. [UX: rules, tabs and flows](#4-ux-rules-tabs-and-flows)
5. [Configuration and storage: before and after](#5-configuration-and-storage-before-and-after)
6. [CLI: before and after](#6-cli-before-and-after)
7. [Daemon routes](#7-daemon-routes)
8. [Per-harness mechanisms (hidden implementation)](#8-per-harness-mechanisms-hidden-implementation)
9. [Safety](#9-safety)
10. [Migration from today's config and state](#10-migration-from-todays-config-and-state)
11. [Edge cases E1–E32](#11-edge-cases-e1e32)
12. [Later: moving a conversation between harnesses](#12-later-moving-a-conversation-between-harnesses)
13. [Build plan](#13-build-plan)
14. [Declared gaps and open questions](#14-declared-gaps-and-open-questions)

---

## 1. Why

Measured on `main` (`packages/pwa/src/features/fleet/**`, `packages/fleet/src/lib/**`):

| Cost                          | Today                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reaching Accounts             | gear → Settings section **Daemons** → daemon picker → panel rail **Fleet** → **Accounts** (indented child). Panel selection is component state, so nothing links straight to it.                                                                                     |
| Adding one Claude account     | Accounts → "Add an account" → "Add account" again → an **8-step** stepper (Harness, Account, Sign-in, Models, Instructions, Skills, Settings, Review) → staged-change review → password modal → back to Accounts to sign in. About **11 screens and 12+ decisions**. |
| First run                     | **4 accounts from 2 logins** (`claude-default`, `claude-auto-default`, `codex-default`, `codex-auto-default`), each holding a **copy** of the host's credential.                                                                                                     |
| What the config makes you say | a UUID, a wrapper name, a home and a mode per route; variants; profiles; `identity` to say two routes share a login; `sharedHistory` booleans that default to **off**.                                                                                               |

Four structural causes, each removed by a rule in §3:

1. **A login is not an entity.** It is inferred from `identity` grouping, and every home holds its
   own copy, so a refresh in one copy can kill the others
   ([credential-seeding.md §2](credential-seeding.md#2-the-hazard)). → a **Credential** is stored
   once and never copied (C1).
2. **Setup is not reusable.** Instructions, skills, MCP servers and settings are spelled per route.
   → a **Component** is saved once and referenced (K1), and a **Profile** stacks them (P1).
3. **Interactive and auto are two accounts.** → a **Runtime** is a Credential plus a Profile, and
   "launched as an agent" is a flag on it, not a second account (R3).
4. **History is per home unless you opt in.** → one **history pool per harness**, always on (H1).

---

## 2. The vocabulary

These are the only words the product uses. **"Home" is not a user-facing word**: it survives only
as an internal name for a runtime's materialised config directory (§8).

| Word                  | Means                                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Machine**           | One daemon. Everything below lives per machine. The UI has a **Machines** switcher, and each machine has its own setup.                                                                             |
| **Credential**        | A login to Claude or Codex. Tied to **one** machine. Never copied. Shows a status (**Ready** / **Refresh due** / **Needs sign-in** / **Checking**) and usage (5-hour and weekly).                   |
| **Component**         | A piece of setup saved once and referenced, so editing it updates everywhere. Kinds: **Instructions**, **MCP servers**, **Skills** (generic); **Settings**, **Hooks** (one harness); **Model set**. |
| **Profile**           | A stack of layers, each one another profile or a component. The **newer layer always overrides the older**.                                                                                         |
| **Runtime**           | **Credential + Profile**: the thing you launch (a CLI wrapper, e.g. `claude-default`). Carries the flag **"Ferretry launches this as an agent"**.                                                   |
| **Fixed layer**       | For **agent runtimes only**: a locked layer Ferretry applies **last**. It always wins and is shown read-only.                                                                                       |
| **Agent permissions** | A machine setting: **Auto mode** or **Skip all permission checks**, mapped per harness. Applies to new sessions.                                                                                    |
| **History**           | One pool per harness, shared by every runtime of that harness.                                                                                                                                      |
| **Clone machine**     | A **one-time** copy of components, model sets, profiles and runtimes from one machine to another. Credentials and history are not copied.                                                           |

A beginner who only imports never sees the word **Component**: the first run talks about "your
instructions", "settings", "MCP servers" and "skills" (§4.3).

---

## 3. Entities and their rules

```
                       ┌──────────── Machine (one daemon) ─────────────┐
                       │                                               │
   Components ──┐      │   Credential ─┐                               │
   (saved once) ├─► Profile ──────────┴─► Runtime ──► launches ──► History pool
   Profiles ────┘   (layers,             (+ "agent" flag              (one per harness)
                     newer wins)          ⇒ Fixed layer last)
                       └───────────────────────────────────────────────┘
```

### 3.1 Machine

| Rule | Statement                                                                                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1   | Every credential, component, profile, runtime and setting below belongs to **exactly one machine** (daemon). Nothing is shared between machines except by an explicit **Clone** (§3.7). |
| M2   | A machine is reached by the existing pairing and carrier. The Machines switcher lists every paired daemon with Online / Offline, its system, and its runtime count or "Not set up yet". |
| M3   | A machine that is not set up opens the **first run** (§4.3) when it is selected.                                                                                                        |
| M4   | A machine owns the **Agent permissions** setting (§3.6) and knows which harness tools are installed, with their versions.                                                               |
| M5   | While a machine is offline, every surface says so ("asleep or offline"), shows what Ferretry last saw, and pauses any open stepper with its progress kept and a **Retry** (E11).        |

### 3.2 Credential

| Rule | Statement                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1   | A credential is **stored exactly once** and **never copied**, not even by Clone. Every runtime that uses it reads that one store.                                                                                                                                                                                                                                |
| C2   | A credential has one harness (`claude` or `codex`) and belongs to one machine.                                                                                                                                                                                                                                                                                   |
| C3   | A credential's **store** is `host` (the person's own `~/.claude` / `~/.codex` login, **shared in place**: Ferretry keeps a pointer, never a copy), `ferretry` (a login Ferretry signed in, under `<FY_HOME>/fleet/credentials/<id>/`) or `environment` (Advanced: the existing `${secret:NAME}` mechanism of [fleet-env-profiles.md](../fleet-env-profiles.md)). |
| C4   | `host` is allowed **once per harness per machine**. Every surface that shows a `host` credential says it is **shared with `claude` / `codex` in your terminal**, and its sign-out says that it signs out both (E25).                                                                                                                                             |
| C5   | Status is exactly one of **Ready**, **Refresh due**, **Needs sign-in**, **Checking**. Usage is the 5-hour and weekly windows. Both are per credential, never per runtime: one credential is one rate-limit pool.                                                                                                                                                 |
| C6   | Ferretry **never refreshes a token on a timer.** A refresh happens when the harness does it naturally, at a launch that is due, or on an explicit **Check now**.                                                                                                                                                                                                 |
| C7   | Signing a credential in or out affects **every runtime that uses it**, and every surface says how many ("Finish sign-in for 3 runtimes", "3 runtimes will need sign-in").                                                                                                                                                                                        |
| C8   | An **empty slot** is a credential with no login yet: status **Needs sign-in**. Clone creates one per credential the source runtimes used (E31). Runtimes keep pointing at the slot, so one sign-in fixes all of them.                                                                                                                                            |
| C9   | Two credentials of one harness may share an email. Each then carries a **label** the person chose (`personal`, `work`) and the add flow asks for both labels, which must differ (E26). Labels are display only.                                                                                                                                                  |
| C10  | A credential cannot be removed while a runtime uses it.                                                                                                                                                                                                                                                                                                          |
| C11  | The sharing mechanism for each harness is pinned by a **CI guard** (§8.5) that fails when a harness update breaks it.                                                                                                                                                                                                                                            |

### 3.3 Component

| Rule | Statement                                                                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| K1   | A component is **saved once and referenced**. Editing it changes every profile and runtime that uses it; the edit screen says how many and the button reads **Save for all** (E20). Running sessions keep the old version until restarted.                         |
| K2   | Kinds and harness scope: **Instructions**, **MCP servers**, **Skills** are **generic**, adapted per harness by Ferretry (§8.3). **Settings** and **Hooks** belong to **one harness**. A **Model set** is named models plus a default.                              |
| K3   | A generic component may be narrowed to one harness. The import does this when `CLAUDE.md` and `AGENTS.md` differ: "Claude instructions" and "Codex instructions" (E9).                                                                                             |
| K4   | **Settings is where flags and environment live** (`env.LOG_LEVEL = debug`). There is no separate "flags" or "env" field anywhere. Secret values never sit in a component: they live in the secret store and the component holds a `${secret:NAME}` reference (E7). |
| K5   | A generic component that one harness can only partly honour carries **Partly supported on _harness_** with the reason (E22).                                                                                                                                       |
| K6   | A component can carry a **warning** that does not block saving it: "Command not found: uvx" (E8), "Check this path on _machine_" after a clone (E30). Editing the cause clears it.                                                                                 |
| K7   | A component cannot be deleted while a profile has it as a layer. The block names those profiles and the runtimes behind them, and offers **Remove from those first** (E21).                                                                                        |
| K8   | A model set's models are ids; the UI shows names. A model the runtime's credential cannot use is struck through as "Not available on this login", and the default falls back to the first available one, saying so (E23).                                          |

### 3.4 Profile

| Rule | Statement                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1   | A profile is an **ordered list of layers**, oldest first. A layer is a component or another profile (used as a base).                                                                                              |
| P2   | **The newer layer always overrides the older.** The same component reached twice counts once, at its **newest** position.                                                                                          |
| P3   | A profile can never include itself, directly or through a base. Bases that would are disabled with "Would include itself" (E19).                                                                                   |
| P4   | A **conflict** is two layers setting one key (per harness) to different values. Profiles show them as "`key`: _new_ (from _layer_) overrides _old_ (from _layer_)" (E18). A conflict is information, not an error. |
| P5   | A profile applies to a credential's harness by **skipping** the layers that belong to the other harness. A profile in which nothing applies is unavailable for that credential, with the reason (E14).             |
| P6   | A profile used by a runtime cannot be deleted until each such runtime picks another profile; a profile used as a base must be removed from those profiles first. Its components stay saved (E21).                  |

How each kind merges when several layers carry it (the newer layer is "later"):

| Kind         | Merge                                                                                               | Conflict key                       |
| ------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Instructions | all apply, concatenated oldest → newest, so newer guidance is read last                             | none (text is additive)            |
| MCP servers  | union by server name; a later server with the same name replaces the earlier                        | the server name                    |
| Skills       | union by item name; a later item with the same name replaces the earlier                            | the item name                      |
| Settings     | deep merge per harness; later key wins                                                              | the dotted key, per harness        |
| Hooks        | all apply, in layer order                                                                           | none                               |
| Model set    | the **newest** model set in the stack is the runtime's model set; earlier ones do not merge into it | `model` (the default), per harness |

### 3.5 Runtime

| Rule | Statement                                                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | A runtime is exactly **one credential + one profile**, and a **name**: letters, digits and dashes, unique on the machine. The name is the CLI wrapper you type (`claude-default`). A clash or invalid name gets a suggestion (E16). |
| R2   | The runtime's harness is the credential's harness. Changing the credential or the profile is a one-field edit that touches no credential.                                                                                           |
| R3   | A runtime carries one flag: **"Ferretry launches this as an agent"**. Only agent runtimes get the fixed layer (§3.6), and only they may be started unattended (`fy start --agent <runtime>`).                                       |
| R4   | Two runtimes may share a credential and a profile, but the add flow asks first ("already uses this login and profile. Add another anyway?", E15).                                                                                   |
| R5   | A runtime whose harness is not installed on the machine still exists; it shows "_Harness_ isn't installed here · Install" and cannot launch (E29). A runtime on a **Needs sign-in** credential cannot launch until it is signed in. |
| R6   | Runtime ids are opaque and live in Ferretry's state, not the config. Migrated runtimes keep their old route UUIDs and wrapper names (§10), so every session record, task board and pricing row still joins.                         |

### 3.6 Fixed layer and Agent permissions

| Rule | Statement                                                                                                                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1   | The fixed layer exists **only for agent runtimes**. It is applied **last** and **always wins**, including over settings the harness itself writes at run time (§8.4).                                                                           |
| F2   | It is shown **read-only** with a lock, and user values it overrides are shown struck through: "From your _Agent settings_ · Overridden for agents by Ferretry" (E24).                                                                           |
| F3   | Its contents: no trust prompt, no onboarding screens, and the permission mode from the machine's **Agent permissions**. Nothing in it is a credential or an identity.                                                                           |
| F4   | **Agent permissions** is per machine: **Auto mode** ("Agents work on their own and stop to ask before anything that looks risky") or **Skip all permission checks** ("Agents never stop to ask. They can change any file and run any command"). |
| F5   | A change **applies to new sessions**. With sessions running, the setting says "_N_ running sessions keep the old mode (_old_) until restarted" (E32).                                                                                           |

Per-harness mapping (§8.4 has the launch mechanics):

| Fixed-layer key    | Claude Code                                                                                             | Codex                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Auto mode          | `permissions.defaultMode = auto` (`--permission-mode auto`)                                             | `approval_policy = on-request`, `sandbox_mode = workspace-write`                                                        |
| Skip all checks    | `permissions.defaultMode = bypassPermissions`, plus `skipDangerousModePermissionPrompt = true`          | `approval_policy = never`, `sandbox_mode = danger-full-access` (what `--dangerously-bypass-approvals-and-sandbox` sets) |
| trust prompt = off | the launch directory recorded as trusted in the runtime's `.claude.json` (**INFERRED** key, CI-guarded) | `projects."<dir>".trust_level = "trusted"` as a `-c` override (**INFERRED**, CI-guarded)                                |
| onboarding = done  | `hasCompletedOnboarding = true` in the runtime's `.claude.json`                                         | — (Codex has no onboarding screen that blocks a launch; **INFERRED**)                                                   |

The prototype abbreviates the Codex rows to `approval_policy`; the sandbox key belongs to the same
mapping.

### 3.7 History

| Rule | Statement                                                                                                                                                                                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1   | There is **one history pool per harness per machine**, `<FY_HOME>/fleet/shared/<harness>/` (the path today's opt-in pool already uses), shared by **every runtime of that harness**. It is always on and not a setting.                                                                                                                       |
| H2   | **One live writer per conversation**, enforced by a conversation lease (§9.3).                                                                                                                                                                                                                                                                |
| H3   | History never carries identity or auth. The pooled entries stay exactly as `shared-history.ts` defines them (Claude: `projects`, `sessions`, `session-env`, `file-history`, `plans`, `tasks`, `todos`, `shell-snapshots`, `paste-cache`, `history.jsonl`; Codex: `sessions`, `archived_sessions`, `history.jsonl`, plus `CODEX_SQLITE_HOME`). |
| H4   | So a conversation started on one runtime can be resumed on another runtime of the same harness, even on another credential.                                                                                                                                                                                                                   |
| H5   | Continuing a Claude conversation in Codex, or the reverse, is a **separate, later design** (§12).                                                                                                                                                                                                                                             |

### 3.8 Clone machine

| Rule | Statement                                                                                                                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1   | Clone is a **one-time copy** of components, model sets, profiles and runtimes. Later changes on the source do not follow.                                                                                                                       |
| L2   | **Credentials are not copied.** Each credential the source runtimes use becomes an **empty slot** "Needs sign-in" on the target, keeping its email and label, and its runtimes keep pointing at it (C8).                                        |
| L3   | **History is not copied.** Past sessions stay on the source.                                                                                                                                                                                    |
| L4   | When the target already has profiles or runtimes, the person chooses **Add alongside** (keep what is there; a clashing name gets `-2`) or **Replace** (delete the target's components, profiles and runtimes first; **its logins stay**) (E28). |
| L5   | A component whose content names a path under `/Users/` or `/home/` is flagged **Check this path on _target_** (E30). A runtime whose harness is missing on the target is still copied and waits (E29).                                          |
| L6   | The source must be online and set up; otherwise it is listed but disabled, with the reason (E27).                                                                                                                                               |
| L7   | Secret **values** never travel. A copied `${secret:NAME}` reference stays a reference on the target (§14, gap G7).                                                                                                                              |

---

## 4. UX: rules, tabs and flows

### 4.1 UI rules

1. **One page = one concept.** A runtime's page is about that runtime; a credential's page is about
   that login.
2. **Steppers ask one decision per page**, show "_Step_ · _n_ of _m_" with a progress bar, and the
   page title says what is being made.
3. **Back always works.** Back from step 1 of a sub-stepper returns to the parent step; Back from step
   1 of a top-level stepper asks to confirm leaving.
4. **Cancel confirms**, says what will not be created, and lists anything already **saved for reuse**
   inside the flow, which is kept (E17).
5. **A missing thing is created in place, then you return**: no login → "+ Add a new login"; no
   fitting profile → "+ Build a new profile"; no component → "+ Create new …". Each opens a sub-stepper
   and comes back with the new thing picked.
6. **A beginner who imports never sees the word "Component".**
7. Status uses the four words and four shapes: ● Ready, ◐ Refresh due, ○ Needs sign-in, ◌ Checking.
8. No wrapper paths, UUIDs, config directories, `<kind>:<identity>` lines or the word "home" anywhere.

### 4.2 Information architecture

A **Machines switcher** sits at the top (the machine name with a caret). It opens **Machines**: every
paired daemon with Online/Offline, its system, its runtime count or "Not set up yet", and **Add
machine** (the existing `fy pair` flow).

Each machine has five tabs:

| Tab             | Shows                                                                                                                                             | Primary action               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **Runtimes**    | each runtime: status shape, name, credential email (+ label), profile, default model, **Agent** badge; a missing-harness note with Install        | **+ Add runtime**            |
| **Credentials** | grouped by harness: email, label, "Shared with claude in your terminal", "Copied slot from _machine_", status, "Used by _n_ runtimes", usage bars | **+ Add a login**            |
| **Profiles**    | name, layer count, "used by _n_ runtimes", "base for _n_ profiles"                                                                                | **+ Build a new profile**    |
| **Components**  | the six kinds with a one-line description and a count; each opens its list                                                                        | **+ New _kind_** (in a list) |
| **Settings**    | Agent permissions; Tools on _machine_ (installed + version, or Install); Setup (**Clone from another machine**, **Import again**); Machine facts  | —                            |

Detail pages (one concept each):

- **Runtime**: Credential row (opens it); Profile row plus its layer stack, newest on top, with
  "_n_ skipped on _harness_"; Model set with unavailable models struck through; for an agent runtime,
  the **Fixed layer** (locked) and the user values it overrides; a **Launch** button that reads
  "Install _harness_ to launch", "Sign in to launch" or "Waiting for _machine_" when it cannot.
- **Credential**: status with a sentence of explanation, usage, inline sign-in when it needs it,
  **Label**, **Used by**, **Check now**, **Sign out…** (with its consequences, E25).
- **Profile**: Layers, Conflicts, Where it is used, **Edit layers**, **Delete profile…**.
- **Component**: harness badge, partial-support and warning notes, Content (or Command for an MCP
  server), Used by, **Edit**, **Delete…**.

Where this surface mounts in the PWA's existing navigation is open question O1 (§14).

### 4.3 First run (per machine)

Shown when a machine is selected that is not set up. Five steps, each one decision.

1. **Check tools.** "Ferretry runs Claude Code and Codex on _machine_. First it checks they're
   installed." Each tool shows Installed · _version_ or Not installed. For missing ones: a checkbox
   per tool showing the **exact command** Ferretry will run on the machine (`brew install --cask
claude-code`, `npm install -g @openai/codex`, …; §8.6), and, from a phone or any governed
   caller, the **operator password**, "used once and not stored". Then **Install _n_ tools**, or
   **Skip, continue without them** (E1). A failed install says why and gives the command to run by
   hand, with **Retry** (E2).
2. **Claude Code.** "Ferretry found Claude Code on _machine_." A **Found on _machine_** list: Account
   (Signed in / refresh due / Not signed in), Instructions (`CLAUDE.md`, size), Settings
   (`settings.json`, "6 settings, 1 hook"), MCP servers (names), Skills (names), with warnings
   inline. **Import from Claude Code** or **Skip Claude Code**. "Importing copies your setup into
   Ferretry. Claude Code on _machine_ keeps working as before." Import creates: the credential
   (`store: host`, shared in place), one component per item found, and a **Default** profile that
   matches the person's setup (or a plain **Starter** profile with only a model set when nothing was
   found, E5). Because the login is shared in place, the screen says so in words: "Ferretry and your
   own `claude` share this login: signing out in one signs out both." (the prototype shows the shorter
   badge "Shared with claude in your terminal" on the credential). The result screen lists "Login · _email_" and "Default profile · Now has your
   instructions, settings, 3 MCP servers and 5 skills", plus notes (E6–E9).
3. **Codex.** The same, for Codex. When Claude was already imported, Instructions says "Same as your
   CLAUDE.md · one shared copy" or "Different from your CLAUDE.md · kept separately" (E9). When Codex
   is not installed this step is one quiet line and **Continue** (E3).
4. **Name runtimes.** "A runtime is a login plus a profile. It's what you launch. Name each one."
   One card per imported harness with a prefilled name (`claude-default`, `codex-default`: harness +
   profile name), validated as you type (E16). When an identical runtime already exists (Import
   again), "Add another anyway" is unchecked by default.
5. **Done.** "_machine_ is ready · 2 runtimes created", each with status, email, profile and model,
   then **Go to Runtimes**. With nothing imported: "Nothing was imported. That's fine." (E10).

**Import again** (Settings → Setup) runs steps 2–5 again and only adds what is new.

### 4.4 Add runtime

Four steps. The page title is "Add a runtime".

1. **Credential.** "Which login should this runtime use?" Radio rows: email, label, harness, status,
   "used by _n_ runtimes", and "isn't installed here" where true; then **+ Add a new login**. With no
   credentials the step is "Add a login first" with Sign in to Claude Code / Codex (E12). Picking a
   Needs-sign-in credential shows the sign-in panel inline and allows **Next, sign in later** (E13).
2. **Profile.** "Which profile should it use with _email_ on _harness_?" Profiles that cannot apply
   are disabled with the reason; mixed ones carry "Claude settings will be skipped on Codex" or
   "Partly supported on Codex" (E14). Then **+ Build a new profile** (§4.5), which returns here with
   the new profile picked. A duplicate pair asks first (E15).
3. **Name.** A summary row, **Runtime name** (validated, suggestion on clash, E16), and the checkbox
   **Ferretry launches this as an agent** — "Adds Ferretry's fixed layer last: no trust or onboarding
   prompts, and the machine's agent permissions." **Create runtime**.
4. **Done.** "_name_ is ready to launch" (or "Sign in before you launch"), "Also saved for reuse: …",
   **Back to Runtimes** / **Open _name_**.

### 4.5 Build a profile (also: Edit layers)

Eight steps: **Start from → Instructions → MCP → Skills → Settings → Model set → Review layers →
Name.**

- **Start from**: existing profiles as checkboxes (none = start from nothing), with a **Layer order ·
  later wins** list and ↑/↓ to reorder. While editing, the profile itself and any profile that
  includes it are disabled ("Would include itself", E19).
- **Instructions, MCP, Skills, Settings**: pick existing (multi-select), **Create new …** inline
  ("Save and use it"), or **Skip, add no …**. Badges show harness scope, partial support and warnings.
- **Model set**: single choice, or "No model set — use the one from a base layer, or the harness
  default".
- **Review layers**: the stack newest on top and its **Conflicts** (E18). An empty stack cannot
  continue.
- **Name**: validated against existing profiles; when this stepper was opened from Add runtime, the
  hint says "You go back to choosing a profile, with this one picked." **Save profile** / **Save
  changes**.

Hooks are picked from a profile's Edit layers or added as components; the build stepper does not ask
for them (the prototype's `BUILD_TYPES`).

### 4.6 Add a login

**Choose tool** (skipped when opened for a known harness) → **Sign in** → **Label** (only when the
same email already has a login of that harness, E26). Sign-in is the existing link-and-code panel
(Claude: open the page, paste the code; Codex: device code, §8.2). "The login is kept on _machine_."
The new credential is `store: ferretry`.

### 4.7 Clone from another machine

Settings → Setup → **Clone from another machine**. **Source** → **Preview** → **Existing setup**
(only when the target already has profiles or runtimes) → **Done**.

- **Source**: other machines; offline or not-set-up ones are disabled with the reason (E27).
- **Preview**: **Copies** (_n_ components, _n_ model sets, _n_ profiles, _n_ runtimes); **Doesn't
  copy** (_n_ logins — "Each becomes an empty slot on _target_ that needs sign-in. Runtimes keep
  pointing at their slot." — and History); **Check after copying** (paths, E30); a note when a
  harness is missing on the target (E29).
- **Existing setup**: Add alongside / Replace (E28). Replace is a danger button "Replace and copy".
- **Done**: what was copied, how many names got `-2`, **Sign in to use them** (each slot with "used
  by _n_ runtimes"), and a primary **Sign in once for _n_ runtimes** on the slot with the most
  runtimes (E31).

### 4.8 Other flows the prototype covers

- **Install a harness** from Settings or from a runtime's missing-harness note: the Step 0 panel
  alone.
- **Sign out**: a confirm card naming the consequences; the terminal sentence appears only for a
  `host` credential (E25).
- **Edit / delete a component or profile**: §3.3 K1/K7 and §3.4 P6 (E20, E21).
- **Signed in from a slot**: the credential page shows "Signed in. _n_ runtimes can launch now." and
  the runtime rows flip to Ready one by one (E31).

---

## 5. Configuration and storage: before and after

### 5.1 Before: a first-run `config.yaml` today (abridged, real shape)

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
      auto: { id: 0b7e…-…, wrapper: claude-auto-default, home: claude-auto-default, … }
  - name: default
    kind: codex
    routes: { default: { … }, auto: { … } } # two more UUIDs, wrappers, homes
sharedHistory: { claude: false, codex: false }
```

Four accounts, four homes, four credential copies, two `identity` groups inferred from agent names.

### 5.2 After: the same machine, imported

`<FY_HOME>/fleet/config.yaml`, `version: 2`:

```yaml
version: 2

machine:
  agentPermissions: auto # auto | skip

credentials:
  claude-you: { harness: claude, store: host } # shared in place with your own `claude`
  codex-you: { harness: codex, store: host }

components:
  instructions:
    main: { file: components/instructions/main.md } # generic: CLAUDE.md and AGENTS.md matched
  mcp:
    github: { command: npx, args: [-y, '@modelcontextprotocol/server-github'] }
    linear: { command: npx, args: [-y, mcp-remote, 'https://mcp.linear.app/sse'] }
  skills:
    my-skills: { items: [release-notes, pr-review, changelog, db-migrate, incident-summary] }
  settings:
    claude-settings: { harness: claude, file: components/settings/claude-settings.json }
    codex-settings: { harness: codex, file: components/settings/codex-settings.toml }
  hooks:
    format-on-save: { harness: claude, file: components/hooks/format-on-save.json }
  modelSets:
    claude-models: { models: [claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5], default: claude-opus-5-5 }
    codex-models: { models: [gpt-6], default: gpt-6 }

profiles:
  default:
    layers:
      - instructions/main
      - mcp/github
      - mcp/linear
      - skills/my-skills
      - settings/claude-settings
      - settings/codex-settings
      - hooks/format-on-save
      - modelSets/claude-models
      - modelSets/codex-models

runtimes:
  claude-default: { credential: claude-you, profile: default }
  codex-default: { credential: codex-you, profile: default }
```

A layered agent profile and runtime from the prototype's set-up machine:

```yaml
profiles:
  agent: { layers: [settings/agent-settings, modelSets/heavy] }
  agent-work: { layers: [profile/default, profile/agent] } # newer layer (agent) wins
runtimes:
  claude-agent: { credential: claude-you, profile: agent-work, agent: true }
```

### 5.3 The full schema

```yaml
version: 2
machine:
  agentPermissions: auto | skip # default auto
credentials:
  <id>: # safe slug; directory name for store: ferretry
    harness: claude | codex
    store: host | ferretry | environment # default ferretry
    label: work # optional, display only (C9)
    clonedFrom: studio-mac # set by Clone on an empty slot; display only
    env: { ANTHROPIC_API_KEY: ${secret:WORK_KEY} } # store: environment only
components:
  instructions: { <name>: { file: <path>, harness?: claude | codex } }
  mcp: { <name>: { command, args?, env?, url?, harness?: claude | codex } }
  skills: { <name>: { items: [<item>…], harness?: claude | codex } } # items from the skills store
  settings: { <name>: { harness: claude | codex, file: <path> } } # flags and env live here
  hooks: { <name>: { harness: claude | codex, file: <path> } }
  modelSets: { <name>: { models: [<model id>…], default: <model id> } }
profiles:
  <name>: { layers: [<kind>/<name> | profile/<name>, …] } # oldest first
runtimes:
  <name>: { credential: <id>, profile: <name>, agent?: false }
advanced: # everything a beginner never sees; carried over from today
  secretsFile: ~/.secrets
  aliases: { … }
  commands: [ … ]
  usage: { … } # intervals
  path: { announce: true } # the PATH line
```

Component files live in the asset tree, `<FY_HOME>/fleet/assets/components/<kind>/<name>.<ext>`, so
the existing link-not-copy materialisation ([fleet-sharing.md](../fleet-sharing.md)) makes "editing
updates everywhere" true on disk too.

Validation, each with a sentence naming the field (the existing style in `config.ts`):

- a runtime's `credential` and `profile` must exist; a profile layer must name an existing component
  or profile; a profile may not reach itself (P3);
- `store: host` at most once per harness (C4); `store: environment` requires `env` and has no sign-in;
- `settings` and `hooks` require `harness`; a model set's `default` must be one of its `models`;
- runtime names match the R1 grammar and are unique; component names are unique per kind;
- `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CODEX_SQLITE_HOME` and **`CLAUDE_SECURESTORAGE_CONFIG_DIR`**
  join `RESERVED_ENV_NAMES`: a settings component that set the last one could point a runtime at
  another credential;
- a version-1 document (`agents`, `routes`, `identity`, `variants`, `sharedHistory`) is **read** by
  converting it in memory (§10.4) and is never written back.

### 5.4 State on disk, after

| Path (under `<FY_HOME>/fleet/`) | Holds                                                                                                    | Owner                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `config.yaml`                   | §5.3                                                                                                     | the person, via proposals     |
| `assets/components/**`          | component bodies                                                                                         | the person, via proposals     |
| `credentials/<id>/`             | `store: ferretry` only: Claude secure-storage dir, or Codex canonical `auth.json`; `usage.json` (§8.1.3) | the harness                   |
| `homes/<runtime id>/`           | the runtime's materialised config dir (§8). **Internal name only**                                       | Ferretry (plan) + the harness |
| `shared/<harness>/`             | the history pool (H1) and `.leases/`                                                                     | the harness                   |
| `ids.json`                      | runtime name → opaque id, migrated UUIDs and old wrapper names (R6)                                      | Ferretry                      |
| `manifest.json`                 | published runtimes: `{id, name, harness, credential, profile, agent, wrapper, models, defaultModel}`     | Ferretry                      |
| `retired/<timestamp>/`          | migration leftovers until purged (§10.2)                                                                 | Ferretry                      |

What disappears from the config: route UUIDs (→ `ids.json`), `wrapper:` and `home:` (derived from the
runtime name and id), `mode:` and `variants` (→ the agent flag and the fixed layer), `identity:` (→
`credential:`), `sharedHistory:` (always on), `shared:` names (→ components), and copy-and-sync
(`fy fleet login --sync-only`, `FleetFirstRunSeeder`).

---

## 6. CLI: before and after

The binary name is derived from `packages/cli/package.json` `bin`; `fy` below is that derived name.
Every write goes through the same reviewed-proposal path the daemon uses and **applies in one step**,
so nobody types `apply`.

### 6.1 Before

| Command                                                        | Purpose                                             |
| -------------------------------------------------------------- | --------------------------------------------------- |
| `fy fleet` / `fleet ls`                                        | list accounts                                       |
| `fy fleet init [--first-account claude\|codex]`                | write the starter config                            |
| `fy fleet apply [--dry-run]`                                   | build homes, wrappers, settings, manifest           |
| `fy fleet usage` / `fy fleet health`                           | quota / credential verdict per account              |
| `fy fleet sharing`                                             | shared documents report                             |
| `fy fleet login [id…] [--status] [--sync-only] [--no-refresh]` | sync copies within an identity, refresh, or sign in |
| `fy fleet recommend <task…>`                                   | routing suggestion                                  |
| `fy start --agent <wrapper\|uuid>`                             | must be an `*-auto-*` wrapper; refused otherwise    |

### 6.2 After

| Command                                                                                    | Purpose                                                                                                |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `fy setup [--yes]`                                                                         | the first run (§4.3) in a terminal: tools, Claude import, Codex import, names                          |
| `fy setup import`                                                                          | Import again                                                                                           |
| `fy machine` / `fy machine set agent-permissions auto\|skip`                               | machine facts, tools, Agent permissions                                                                |
| `fy machine install claude\|codex`                                                         | install a harness tool (§8.6)                                                                          |
| `fy machine export > setup.json` / `fy machine clone setup.json [--replace]`               | Clone without a browser: export from the source, import on the target                                  |
| `fy runtimes`                                                                              | the Runtimes tab                                                                                       |
| `fy runtime add <name> --credential <id> --profile <name> [--agent]`                       | Add runtime                                                                                            |
| `fy runtime show <name>` / `set <name> --credential … --profile … --agent=…` / `rm <name>` | one runtime: stack, fixed layer, models                                                                |
| `fy credentials`                                                                           | the Credentials tab, with status and usage                                                             |
| `fy credential add claude\|codex [--label L]`                                              | Add a login (link + code, or device code)                                                              |
| `fy credential check <id>` / `signin <id>` / `signout <id>` / `label <id> <L>` / `rm <id>` | Check now; sign in again; sign out (names every runtime, confirms); label; remove (refused while used) |
| `fy profiles` / `fy profile show <name>`                                                   | layers, conflicts, where used                                                                          |
| `fy profile build <name> --layer <kind>/<name>…` / `edit <name> --layer …` / `rm <name>`   | Build / Edit layers / Delete (P6)                                                                      |
| `fy components [<kind>]` / `fy component show\|add\|edit\|rm <kind>/<name>`                | the Components tab                                                                                     |
| `fy start --agent <runtime>`                                                               | refused unless the runtime is an agent runtime; old wrapper names and UUIDs still resolve              |
| `fy fleet migrate [--dry-run] [--purge-retired]`                                           | convert a version-1 config and state (§10)                                                             |
| `fy fleet recommend <task…>`                                                               | unchanged                                                                                              |

Retired, each kept one release as an alias that prints its replacement:

| Old                                                   | New                                                    |
| ----------------------------------------------------- | ------------------------------------------------------ |
| `fy fleet ls`                                         | `fy runtimes`                                          |
| `fy fleet usage`, `fy fleet health`                   | `fy credentials`                                       |
| `fy fleet login <id>`                                 | `fy credential signin <its credential>`                |
| `fy fleet login --status`                             | `fy credentials`                                       |
| `fy fleet login --sync-only`                          | removed: there is nothing to sync. Prints why          |
| `fy fleet init`, `fy fleet apply`, `fy fleet sharing` | `fy setup`; applied automatically; `fy component show` |

---

## 7. Daemon routes

Reads are plain GETs. **Every write is a proposal** (`POST /v1/fleet/proposals`, then `…/apply`)
under `fleet.configure`, with the existing per-change operator-password confirmation for a governed
caller ([grants.md](../grants.md)). A stepper stages **one** proposal and asks for the password
**once**. No route returns a credential value (unchanged).

| Route                                          | Verb     | Capability      | Returns / does                                                                                                                                                                                                            |
| ---------------------------------------------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/fleet/machine`                            | GET      | fleet.use       | Agent permissions, tools installed + versions, setup state, running-session count                                                                                                                                         |
| `/v1/fleet/machine/tools/install`              | POST     | fleet.configure | start installing named harness tools (§8.6); progress on the existing fleet event socket                                                                                                                                  |
| `/v1/fleet/setup/scan`                         | GET      | fleet.configure | first-run preview per harness: account state, what was found, secret-looking key **names**, missing commands, instructions identical? — never a value                                                                     |
| `/v1/fleet/credentials`                        | GET      | fleet.use       | credentials with status, usage, "used by", `host` disclosure                                                                                                                                                              |
| `/v1/fleet/credentials/:id/check`              | POST     | fleet.use       | Check now (§8.1.2, §8.2.2)                                                                                                                                                                                                |
| `/v1/fleet/login`, `/v1/fleet/login/:flowId`   | POST/GET | fleet.configure | the existing harness sign-in flows, now targeting a credential id                                                                                                                                                         |
| `/v1/fleet/components`                         | GET      | fleet.use       | components by kind, with badges and "used by"                                                                                                                                                                             |
| `/v1/fleet/profiles`                           | GET      | fleet.use       | **repurposed**: layered profiles, each with its flattened stack and conflicts                                                                                                                                             |
| `/v1/fleet/runtimes`                           | GET      | fleet.use       | runtimes with the resolved stack per harness, model set, fixed layer, and launchability                                                                                                                                   |
| `/v1/fleet/export`                             | GET      | fleet.configure | the Clone bundle: components, model sets, profiles, runtimes and credential **descriptors** (harness, email, label) — no credential, no history                                                                           |
| `/v1/fleet/proposals` (+ `/:id`, `/:id/apply`) | POST/GET | fleet.configure | existing; new operation kinds: `credential.add/label/remove/signout`, `component.put/remove`, `profile.put/remove`, `runtime.put/remove`, `machine.settings`, `setup.import`, `clone.import {mode: alongside \| replace}` |

**Clone has no daemon-to-daemon path.** The browser holds both connections: it reads the source's
`/v1/fleet/export` and stages a `clone.import` proposal on the target with that bundle. Each daemon
authorizes its own half.

Retired with their PWA dials in the same change (the route-agreement rule): `/v1/fleet/accounts`,
`/v1/fleet/health` (+ `/check`), `/v1/fleet/usage`, `/v1/fleet/sharing`, `/v1/fleet/environment`, and
`/v1/fleet/permissions` (folded into `/v1/fleet/machine`).

---

## 8. Per-harness mechanisms (hidden implementation)

Nothing in this section is user-facing. Each runtime **materialises a config directory**,
`<FY_HOME>/fleet/homes/<runtime id>/`, from its credential and its resolved profile, and the
runtime's wrapper exports it. The internal word stays "home"; the product never shows it.

### 8.1 Claude Code

#### 8.1.1 Credential sharing — shared secure-storage directory

Every runtime on credential `C` exports:

```sh
export CLAUDE_CONFIG_DIR=<FY_HOME>/fleet/homes/<runtime id>
export CLAUDE_SECURESTORAGE_CONFIG_DIR=<store dir of C>
```

| store      | `CLAUDE_SECURESTORAGE_CONFIG_DIR` | where the credential lives                                                                                                                 |
| ---------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ferretry` | `<FY_HOME>/fleet/credentials/<C>` | Linux: `<dir>/.credentials.json` (0600). macOS: keychain `Claude Code-credentials-<sha256(dir)[0:8]>`                                      |
| `host`     | **`""`** (empty string)           | Linux: `~/.claude/.credentials.json`. macOS: the **bare** keychain item `Claude Code-credentials` — the one the person's own `claude` uses |

| Claim                                                                                                                                                                     | Status                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| The variable moves the store away from `CLAUDE_CONFIG_DIR`; two config dirs pointing at one store both report `loggedIn: true`; nothing is written into either config dir | **VERIFIED** (Linux, 2.1.281, fake token, dead proxy)                                                                                 |
| The macOS keychain service name is hashed from the secure-storage dir when set, and is the bare name when set to `""`                                                     | **VERIFIED** by running the bundle's own `rw`/`iLe`; the keychain write path itself is **INFERRED** (compiled out of the Linux build) |
| Refresh takes a cross-process lock keyed on the storage dir, re-reads before POSTing, and re-reads after `invalid_grant`; running processes reload on file change         | **VERIFIED** by reading; not raced live                                                                                               |
| `host` must use `""`, not the absolute `~/.claude` path: on macOS an explicit path would hash to a **different** item than the one the person's own `claude` uses         | **VERIFIED** (table in the spike: `""` → bare service)                                                                                |
| Login display (`oauthAccount` in `.claude.json`) is per config dir, so a new runtime's `/status` may show no account name                                                 | **INFERRED**; Ferretry writes `oauthAccount` into each runtime's `.claude.json` at creation, display only                             |

Ferretry's own readers must follow: `credential-store.ts` `keychainService(home)` and
`keychainServices` hash the **storage** dir, not the config dir; `claudeFilePath` reads
`<storage dir>/.credentials.json`.

**Never symlink a Claude credential file.** Claude writes temp + rename, so the first refresh forks
the link into a regular file (VERIFIED); locks are per config dir so two runtimes could POST one
refresh token at once (VERIFIED by reading); and the v5 store reads a symlink with `O_NOFOLLOW` and
treats `ELOOP` as **logged out** behind a server-side flag (VERIFIED by reading). Copying is today's
design and is what this replaces.

#### 8.1.2 Status

| Word            | Claude condition                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ready`         | credential present, and the last read of `GET /api/oauth/usage` answered `200`, or a confirmed Anthropic JSON `403` (scope-limited, healthy — the existing rule in [fleet-health.md](../fleet-health.md)) |
| `Refresh due`   | access token expired, refresh token present, nothing has proved it yet. Claude renews it itself on next use; Ferretry does nothing                                                                        |
| `Needs sign-in` | no credential (an empty slot included), or a proven rejection under the existing digest guard (a stale `401` cannot condemn a fresh credential)                                                           |
| `Checking`      | a Check now or the first read is in flight                                                                                                                                                                |

One probe per **credential**. The 15-minute horizon and the HTML/WAF `403` / bare `401` inconclusive
rules carry over unchanged; an inconclusive check shows the last known word with its age, never a
fifth word. Check now for Claude is the same free usage read (no refresh, no spend).

#### 8.1.3 Usage

1. **Passive (VERIFIED field, INFERRED plumbing):** Claude passes `rate_limits.five_hour` /
   `seven_day` `{used_percentage, resets_at}` on statusLine stdin. Each runtime's materialised
   settings set `statusLine.command` to `fy statusline`, which writes the block to the credential's
   `usage.json` (atomic) and then runs the person's own statusLine command, if their settings named
   one, passing stdin through. The wrapper exports `FY_CREDENTIAL=<C>`, which the statusLine child
   inherits (INFERRED). Only interactive TUI sessions render a statusLine.
2. **Active (today's mechanism):** `GET /api/oauth/usage` on the existing usage pass, used when no
   passive reading is younger than the pass interval.

### 8.2 Codex

#### 8.2.1 Credential sharing — one canonical `auth.json`, linked in

```
<FY_HOME>/fleet/credentials/<C>/auth.json        ← the one file (0600)   [store: ferretry]
~/.codex/auth.json                                ← the one file           [store: host]
<FY_HOME>/fleet/homes/<runtime id>/auth.json ──►  symlink to the one file
```

Every Codex runtime's materialised `config.toml` forces `cli_auth_credentials_store = "file"`, so
Codex never moves the credential into a keyring where the link cannot follow it.

| Claim                                                                                                                                                        | Status                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Codex rewrites `auth.json` **in place** (open + truncate + write through the path), so a symlinked path keeps pointing at the canonical file after a refresh | **VERIFIED** (codex-rs reading); not yet run against the pinned binary — the CI guard does that (§8.5)                  |
| Codex reloads `auth.json` from disk before refreshing, so a process that finds a newer token adopts it instead of spending the old refresh token             | **VERIFIED** (codex-rs reading)                                                                                         |
| `cli_auth_credentials_store = "file"` forces file storage                                                                                                    | **VERIFIED** (codex-rs reading)                                                                                         |
| There is no cross-process lock around a Codex refresh; two processes reaching "due" in the same instant can both spend one single-use refresh token          | **INFERRED** from the absence of a lock; see §9.2                                                                       |
| `codex logout` in one runtime removes that runtime's **link**, not the canonical file                                                                        | **INFERRED** (`remove_file` on a symlink path unlinks the link). Whether logout also revokes server-side is **UNKNOWN** |
| `store: host` works only when the person's own Codex keeps a file. A host on keyring storage has no file to link                                             | **INFERRED**; the first run then offers sign-in instead of sharing (gap G5)                                             |

This needs one narrow change to `StateFileSystem`'s symlink exemption
(`packages/daemon/src/adapters/filesystem/state-file-system.ts`): a link at
`fleet/homes/<id>/auth.json` may resolve into `fleet/credentials/<C>/auth.json`, or to the host's
`~/.codex/auth.json` for a `host` credential. Nothing else is admitted.

#### 8.2.2 Status

| Word            | Codex condition                                                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ready`         | `auth.json` present and readable, access JWT not within 5 minutes of `exp`, `last_refresh` younger than 8 days, and no failed refresh recorded since the last success                                          |
| `Refresh due`   | access JWT `exp` within 5 minutes, **or** `last_refresh` older than 8 days. Codex refreshes at its next start; a launch through Ferretry that is due goes through today's launch renewal (`launch-renewal.ts`) |
| `Needs sign-in` | no `auth.json` (an empty slot included), or a refresh **observed** to fail permanently (`refresh_token_expired` / `reused` / `invalidated`)                                                                    |
| `Checking`      | a Check now refresh is in flight                                                                                                                                                                               |

**A Codex login is proved accepted only by a refresh, and a refresh rotates the single-use token.**
So Ferretry never refreshes on a timer and never reads the usage endpoint as login proof (it answers
`200` for stale tokens). A natural refresh is **observed** (the canonical file's `last_refresh`
advances). **Check now** is the explicit refresh (`codex app-server` → `getAuthStatus {refreshToken:
true}`, today's `ProcessFleetTokenRefreshPort`); with one canonical file this is finally safe, because
the rotated token lands in the one file every runtime reads. This upgrades Codex from "honestly
`unknown`" to a real status.

#### 8.2.3 Usage

1. **Passive, zero network (VERIFIED source, INFERRED field names):** the newest `token_count`
   event's `rate_limits` (primary = 5-hour, secondary = weekly) in a rollout. The shared pool mixes
   credentials, so attribution goes through Ferretry's session records: the session records which
   runtime — and so which credential — launched it. A rollout Ferretry did not launch is not
   attributed.
2. **Active, free:** `GET https://chatgpt.com/backend-api/wham/usage` with the credential's bearer
   and `chatgpt-account-id`. **Not** login proof.

### 8.3 Adapting generic components per harness

| Component    | Claude Code (in the runtime's config dir)                                                                | Codex (in the runtime's config dir)                                    |
| ------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Instructions | `CLAUDE.md`: a **link** into the asset tree when the stack has one, generated concatenation when several | `AGENTS.md`, the same rule                                             |
| MCP servers  | `mcpServers` in the runtime's `.claude.json` (generated)                                                 | `[mcp_servers.<name>]` in `config.toml` (generated)                    |
| Skills       | `skills/<item>` links, per item (today's per-item rule)                                                  | `skills/<item>` links (**INFERRED** Codex skills location; CI-guarded) |
| Settings     | `settings.json`, deep-merged from the stack (the one generated field, as today)                          | `config.toml`, deep-merged                                             |
| Hooks        | the `hooks` block of `settings.json`                                                                     | — (harness-only: a Claude hook never reaches Codex)                    |
| Model set    | default → `--model`; the list → the manifest, for the model picker                                       | default → `-m`; the list → the manifest                                |

**Plumbing keys** are written into every runtime, agent or not, and are never shown as a layer
because they are not behaviour: Codex `cli_auth_credentials_store = "file"` and `sqlite_home`;
Claude `statusLine.command = fy statusline`. Partial support (K5) is a declared table per kind (for
example Claude skill frontmatter `allowed-tools`, which Codex ignores) owned by the adapter.

### 8.4 Launching, and the fixed layer

Generated by `wrappers.ts`. Both kinds of runtime export the config dir, the credential store
variables and `FY_CREDENTIAL` / `FY_RUNTIME`. An **agent** runtime's wrapper adds the fixed layer as
**launch arguments**, which outrank every file the harness or the person can edit — that is what
makes F1's "always wins" true while the harness rewrites its own settings:

|                    | Claude Code                                                                      | Codex                                                                                               |
| ------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| permission mode    | `--permission-mode auto` or `--permission-mode bypassPermissions`                | `-c approval_policy=… -c sandbox_mode=…` (or `--dangerously-bypass-approvals-and-sandbox` for Skip) |
| fixed settings     | `--settings <dir>/.fy/fixed.json` (`skipDangerousModePermissionPrompt` for Skip) | `-c` pairs                                                                                          |
| trust / onboarding | `.claude.json` keys re-asserted by the wrapper before `exec` (INFERRED names)    | `-c projects."<cwd>".trust_level="trusted"` (INFERRED)                                              |
| carried from today | `--disallowed-tools=AskUserQuestion` (open question O3)                          | `--no-alt-screen`                                                                                   |

The machine's Agent permissions is read **at launch**, so a change applies to new sessions only (F5).
`fy start --agent <runtime>` resolves the runtime by name, then by a recorded old wrapper name, then
by id; the daemon's unattended-launch policy (`unrunnableAccountRefusal`, `authorizeSessionCommand`)
tests the manifest's `agent: true` instead of matching `/^(?:claude|codex)-auto-/`.

How `--settings` merges with the config dir's own `settings.json` is **INFERRED** overlay, and the CI
guard asserts it. Whether Claude's pinned version accepts `--permission-mode auto` is asserted by the
guard too (O4).

### 8.5 The CI guard

A CI job, `harness-contract`, runs against the **nix-pinned** `claude-code` and `codex` in a
throwaway `HOME`, with fake tokens and `HTTPS_PROXY` pointed at a dead port. It fails the build when a
harness update breaks a mechanism this design relies on.

Claude:

1. Two config dirs with one `CLAUDE_SECURESTORAGE_CONFIG_DIR` holding a fake credential: `claude auth
status --json` reports logged in for both; neither config dir gains a credential file.
2. Without the variable, the second dir reports logged out (the variable is load-bearing).
3. The binary still contains the `CLAUDE_SECURESTORAGE_CONFIG_DIR` read (`rg -a`), so a rename fails
   here with a message naming the variable.
4. `--settings` overlay: a key set only in the overlay is visible in the effective settings.
5. `--permission-mode auto` and `bypassPermissions` are accepted; with the trust/onboarding keys
   written, a launch reaches the prompt without a trust or onboarding screen.

Codex:

1. A canonical `auth.json` with a fake, expired token, linked into two config dirs; a local HTTP
   server stands in for the token endpoint (`CODEX_REFRESH_TOKEN_URL_OVERRIDE`, **INFERRED** name; if
   absent, the guard stubs the endpoint by proxy).
2. Trigger one refresh (`codex app-server` → `getAuthStatus {refreshToken: true}`).
3. Assert: each config dir's `auth.json` is **still a symlink**, the canonical file holds the new
   token, and the other runtime reads it.
4. With `cli_auth_credentials_store = "file"`, no keyring call is attempted.
5. The trust `-c` override suppresses the trust prompt; skills under `skills/<item>` are listed.

A second, scheduled run uses the **latest** published versions, so a break is seen before the pin
moves. At runtime the daemon compares each harness's version with the range the guard last passed and
says so at boot when outside it; it still runs, and the remedy it names is "sign each runtime in
separately" (§9.5).

### 8.6 Installing a harness tool

The machine runs the install, never the browser. The daemon picks the manager from what it finds on
the machine — `brew` (macOS), then `npm`; `apt` only where a harness publishes an apt package — and
the step shows the **exact command** before anything runs. Exact package names (`claude-code` /
`codex` casks, `@anthropic-ai/claude-code` / `@openai/codex` on npm) are a declared table in one file.
A failure returns the reason and the command to run by hand (E2). Detection afterwards is
`locateHarnessCommand`'s, as today ([harness-paths.md](../harness-paths.md)).

---

## 9. Safety

### 9.1 Rotation

- **Claude:** rotation is supported by its code but not proved (INFERRED). Either way it is safe with
  one store: the rotated token is written to the one store under the one lock.
- **Codex:** refresh tokens are single-use. With copies, any refresh killed every other copy. With
  one canonical file, a refresh replaces the token for every runtime at once. This is the main safety
  gain of the design.

### 9.2 Races

| Race                                                   | Outcome                                                                                 | Mitigation                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Two Claude runtimes refresh at once                    | One takes the lock; the other re-reads under the lock, sees a new token, skips the POST | Claude's own code (VERIFIED by reading)                                                                                                                                                                                                                                                                                                                                                    |
| Two Codex runtimes reach "due" in one instant          | Both may POST one single-use token; one gets `refresh_token_reused`                     | Codex reloads before refreshing, so the window is the POST round trip (INFERRED). Ferretry renews a due credential **at launch**, under a per-credential lock in the daemon, so Ferretry's own launches never race each other. A loser is recorded `Needs sign-in` only if the canonical file did not advance. **Declared residual** for two processes the person started outside Ferretry |
| Check now vs a running Codex refresh                   | Same as above                                                                           | Check now takes the daemon's per-credential lock and re-reads the file first (today's `token-refresh.ts` re-read)                                                                                                                                                                                                                                                                          |
| Migration moves a credential while a harness writes it | A lost refresh                                                                          | Migration refuses while any session on that credential is live (§10.3)                                                                                                                                                                                                                                                                                                                     |
| A component edited while sessions run                  | Running sessions keep the old version                                                   | Stated on the edit screen (K1); a link-materialised component changes on disk immediately, and the harness reads it at its own next read — the doc says "until restarted" because that is the only guarantee                                                                                                                                                                               |

### 9.3 One live writer per conversation

Pooling makes two writers on one conversation more likely, so H2 is enforced:

- **Lease:** `<FY_HOME>/fleet/shared/<harness>/.leases/<conversation-id>` records the holder's pid
  and process start time. A lease whose holder is dead (or whose pid now has a different start time)
  is stale and may be taken. It reuses the daemon's existing state-home lock primitive.
- **Daemon:** every session start, resume and fork claims the lease for the harness conversation id
  it launches with. A held lease refuses with the holder named ("being written by session _X_ on
  _claude-review_ since 14:02").
- **Wrappers:** a wrapper whose arguments name a conversation explicitly (`--resume <id>`, `-r <id>`,
  `--session-id <id>`, `codex resume <id>`) runs `fy history claim <id> --pid $$` before `exec`.
- **Declared gap:** `--continue`, `codex resume --last` and the in-app picker choose a conversation
  after launch. The daemon additionally refuses to resume a conversation whose file was appended to in
  the last 30 seconds by a process holding no lease, and says why.

### 9.4 Sign-out signs out every runtime on the credential

| Harness | Effect of logging out from any one runtime                                                                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude  | Deletes the one credential and revokes the refresh token: **every runtime on that credential is signed out**, and for `store: host` so is the person's own `claude` (VERIFIED: one store) |
| Codex   | Unlinks that runtime's link only; the canonical file and other runtimes survive (INFERRED). If logout also revokes server-side (UNKNOWN), all fail at their next refresh                  |

So every surface treats sign-out as credential-wide (C7, E25), and when a Claude store vanishes the
status flips to `Needs sign-in` for every runtime at once, with one **Sign in** that fixes all of
them. An agent runtime cannot block `/logout` (a slash command, not a tool); that is stated, not
hidden.

### 9.5 Depending on an undocumented variable

`CLAUDE_SECURESTORAGE_CONFIG_DIR` is not documented and could be renamed or removed.

- The CI guard (§8.5) fails on the first harness version that breaks it; the runtime version check
  says so at boot.
- The **fallback is per-runtime sign-in**: each runtime gets its own `store: ferretry` credential. It
  costs N sign-ins, never a broken or forked credential.
- Never the fallback: symlinks (§8.1.1), copies (the credential-seeding hazard), or a central
  refresher injecting `CLAUDE_CODE_OAUTH_TOKEN`.

### 9.6 Installing software from a phone

Installing a tool runs a package manager on the machine, so it is a `fleet.configure` write with the
per-change operator password for any governed caller — the "from a phone it needs the operator
password" step in §4.3. The command is shown before it runs, comes only from the declared table
(§8.6), takes no free-text argument from the browser, and never runs `sudo`: a manager that needs
admin rights fails and hands the person the command (E2).

### 9.7 Import and clone never move a secret value

The first-run import moves secret-looking setting values into the secret store and leaves a
`${secret:NAME}` reference (E7); the scan route returns key **names** only. Clone copies references,
never values (L7). No route, command or log line returns a credential value. `host` credentials are
shown as "Shared with claude in your terminal" so a person knows where the login lives. A pairing
code, QR or token never appears in any wireframe, prototype or capture.

---

## 10. Migration from today's config and state

Goal: **no data loss and no sign-out** for every existing machine.

### 10.1 What exists in the wild

| Case                          | Shape                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — default first run         | 1 agent per harness named `default`, routes `default` + `auto`, 4 homes, each with a **seeded copy** of the host credential (seed provenance says `seeded_copy`) |
| B — first run plus edits      | as A, with edited `CLAUDE-auto.md`, extra skills or models per route                                                                                             |
| C — hand-built fleets         | several agents, `identity` groups, custom variants, profiles, shared documents                                                                                   |
| D — environment-authenticated | `auth: api-key` or `${secret:…}` env profiles                                                                                                                    |
| E — shared history on or off  | `sharedHistory.<kind>` either way; a pool may exist already                                                                                                      |

### 10.2 Mapping rules

1. **Credentials** — one per `<kind>:<identity>` group (the key `identity.ts` already computes).
   - If the host's own login exists and is readable, and seed provenance says every home in the group
     is a `seeded_copy` of it: `store: host`. The copies are **retired**, not used.
   - Otherwise `store: ferretry`, and the **freshest** credential in the group is **moved** (not
     copied) into `fleet/credentials/<C>/` — Claude: the latest `expiresAt`; Codex: the latest
     `last_refresh` (with single-use rotation, it is the only one still alive). On macOS a move is:
     read the freshest keychain item → write the item named for the store dir → read it back →
     delete the old item.
   - Case D groups become `store: environment` with the profile's `env`.
2. **Components** — every distinct document the old config referenced becomes one component, named
   from its file: `shared.memory` / route `memory` → Instructions; skills items → one Skills
   component per distinct item list; settings templates and settings layers → Settings (inline
   objects written to files); MCP files → MCP servers; hooks → Hooks; each route's
   `models`/`defaultModel` → a Model set (identical lists collapse into one).
3. **Profiles** — each old profile becomes a profile whose layers are its documents in today's
   composition order (`compositionSlots`), which already means "later overrides earlier". A route's
   own overrides become one more profile layered on top of its base.
4. **Runtimes** — **one runtime per route**, so nothing changes name or meaning. A route of the `auto`
   variant, or any variant with `mode: auto`, gets `agent: true`; its permission flags are dropped in
   favour of the fixed layer, and the machine's Agent permissions is set from them
   (`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` → **Skip all
   permission checks**). Its distinct `-auto` instructions document stays as an Instructions layer.
5. **Identity** — each runtime keeps its route's UUID and wrapper name, recorded in `ids.json`. So
   `claude-default` and `claude-auto-default` still exist and still mean what they meant, and every
   session record, task board and pricing row that references an account id still joins. The config
   dir stays where it is (`fleet/homes/<old home>`), recorded against the runtime id: nothing moves.
6. **History** — pooling runs for every harness where it was off, using today's rename-based
   migration (inode-preserving, journaled, collision-quarantining, cross-device refusing).
7. **Retirement** — retired credential copies move to `fleet/retired/<timestamp>/` (0700,
   credentials 0600), listed in the migration report, and are deleted by `fy fleet migrate
--purge-retired` or after one release with a boot notice. Retired Claude keychain items are listed by
   name and deleted only by that purge.

### 10.3 Procedure

1. `fy fleet migrate --dry-run` (also offered as a proposal on the machine's Settings tab): prints
   credentials, components, profiles, runtimes, which credential is kept and why, which copies
   retire, the history moves, and the new `config.yaml`.
2. Refused while any session on an affected credential is live, naming the sessions.
3. Apply: backs up `config.yaml` to `config.yaml.v1`, writes the mutation journal, moves credentials,
   pools history, writes the new config, regenerates wrappers, publishes the manifest.
4. Verify each new credential through the new mechanism (`claude auth status` with the store dir;
   Codex reads the linked file) **before** any old copy is retired. A credential that fails
   verification rolls back to its old copies and is reported, leaving the rest migrated.
5. Report per credential (which login was kept, from where) and per runtime (old and new names).

### 10.4 Compatibility window

- For one release the daemon **reads** a version-1 config by converting it in memory with the same
  mapping and keeps running; boot and the Settings tab say "this machine uses the old account format —
  Migrate". It never writes version-1 files.
- `fy start --agent <old wrapper name | old UUID>` keeps working forever via `ids.json`.
- A machine with **no** fleet runs the new first run (§4.3), which writes version 2 directly, and
  `FleetFirstRunSeeder` is deleted: there is nothing to seed.

---

## 11. Edge cases E1–E32

Exactly as the prototype handles them; open its catalogue and press **Show** on a row to see the
screen.

| ID  | Case                                              | What happens                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1  | Neither harness installed                         | Check tools lists both Not installed. "Install what's missing": a checkbox per tool showing the exact command, the operator password ("used once and not stored"), **Install 2 tools**. Continue waits; **Skip, continue without them**.                                                   |
| E2  | Install fails (needs admin)                       | "Couldn't install on _machine_": npm needs admin rights and the operator account isn't an admin. Shows `sudo npm install -g …` to run yourself, then **Retry** or **Skip, continue without them**.                                                                                         |
| E3  | Only Claude installed                             | The Codex step is one quiet line, "Codex isn't installed · Install later in Settings", and Continue.                                                                                                                                                                                       |
| E4  | Installed but not signed in                       | Account reads "Not signed in · Your setup can still be imported"; the sign-in panel is inline; the button reads **Import, sign in later**; the credential lands as Needs sign-in with a note.                                                                                              |
| E5  | Signed in, no config                              | "Nothing found"; a plain **Starter** profile with only a model set; "You can add to it later."                                                                                                                                                                                             |
| E6  | Token needs refresh                               | Import anyway; the credential is **Refresh due**; "Ferretry renews it the first time you launch."                                                                                                                                                                                          |
| E7  | Secret-looking values                             | Settings carries "2 secret values · go to the secret store, never shown"; after import the Settings component lists `env.NAME` as "In Ferretry's secret store · never shown".                                                                                                              |
| E8  | MCP command missing                               | The `notes` server is imported with the warning "Command not found: uvx" and a note to install uv on the machine; it starts working once installed.                                                                                                                                        |
| E9  | `CLAUDE.md` and `AGENTS.md` identical / different | Identical: one generic Instructions component, "one shared copy". Different: "Claude instructions" and "Codex instructions", each harness-only.                                                                                                                                            |
| E10 | Skipped everything                                | Done: "Nothing was imported. That's fine." Runtimes tab: "No runtimes on _machine_ yet" with **Add your first runtime**.                                                                                                                                                                   |
| E11 | Machine goes offline mid-stepper                  | "_machine_ is asleep or offline. Setup is paused. Your progress is kept." **Retry**.                                                                                                                                                                                                       |
| E12 | Add runtime with no credentials                   | Step 1 is "Add a login first" with Sign in to Claude Code / Codex (disabled when not installed); the login sub-stepper returns to Step 1 with it picked.                                                                                                                                   |
| E13 | Chosen login needs sign-in                        | The sign-in panel opens inline below the list; **Next, sign in later** is allowed.                                                                                                                                                                                                         |
| E14 | Claude-only parts on a Codex login                | A profile with only Claude parts is disabled: "Only Claude settings. Nothing here applies on Codex." Mixed: "Claude settings will be skipped on Codex"; partial: "Partly supported on Codex".                                                                                              |
| E15 | Same login and profile already a runtime          | "_name_ already uses this login and profile. Add another anyway?" with **Add another anyway** / **Pick a different profile**; Next waits for a choice.                                                                                                                                     |
| E16 | Name clash or invalid name                        | "_name_ is already a runtime on _machine_." or "Use only letters, digits and dashes.", each with **Use _suggestion_** (`-2`, or a slug).                                                                                                                                                   |
| E17 | Cancel mid-way                                    | "Stop adding a runtime? No runtime is created." plus "Saved for reuse: Profile Quick fixes" — what the sub-flow made is kept.                                                                                                                                                              |
| E18 | Layer conflicts                                   | Review layers: "`permissions.defaultMode` · Claude Code: acceptEdits (from Agent) overrides plan (from Default)".                                                                                                                                                                          |
| E19 | Loop                                              | While editing a profile, itself and any profile that includes it are disabled: "Would include itself".                                                                                                                                                                                     |
| E20 | Editing a component used elsewhere                | "Used by _n_ profiles and _m_ runtimes. Saving changes it everywhere. Running sessions keep the old version until restarted." The button reads **Save for all**.                                                                                                                           |
| E21 | Deleting something in use                         | Component: blocked, listing the profiles it is a layer in and the runtimes behind them, **Remove from those first** / **Keep it**, then confirm. Profile: blocked while it is a base; runtimes using it pick a replacement, **Switch _n_ runtimes and delete**; its components stay saved. |
| E22 | Generic component partly supported                | "Partly supported on Codex: release-notes limits which tools it may use. Codex ignores that limit and loads the rest."                                                                                                                                                                     |
| E23 | Model not available on this login                 | The model set lists unavailable models struck through, "Not available on this login"; the default falls back to the first available one, and the page says so.                                                                                                                             |
| E24 | User settings vs the fixed layer                  | The agent runtime shows the locked Fixed layer, and the user value it overrides struck through: "From your Agent settings · Overridden for agents by Ferretry".                                                                                                                            |
| E25 | Sign out of a login shared with the terminal      | "Sign out of _email_ (_label_)? This also signs out claude in your terminal on _machine_. 3 runtimes will need sign-in." **Sign out** / **Keep signed in**.                                                                                                                                |
| E26 | Two logins, same email                            | Both carry the labels the person chose; adding the second asks for a label for each, and they must differ.                                                                                                                                                                                 |
| E27 | Clone source is offline                           | The source is listed but disabled: "asleep or offline. Wake it to copy from it." A source not set up: "Nothing to copy".                                                                                                                                                                   |
| E28 | Clone target already set up                       | **Add alongside (rename clashes)** — copies get `-2`, e.g. `claude-default-2` — or **Replace** — the target's components, profiles and runtimes go first; its logins stay.                                                                                                                 |
| E29 | Clone target lacks a harness                      | Runtimes are copied anyway; the row says "Codex isn't installed here · Install", and Launch reads "Install Codex to launch".                                                                                                                                                               |
| E30 | Copied path                                       | Preview lists "Check after copying"; the component carries "Check this path on work-linux"; editing the path clears it.                                                                                                                                                                    |
| E31 | One slot, three runtimes                          | Done offers **Sign in once for 3 runtimes**; the credential's button reads "Finish sign-in for 3 runtimes"; after it, "Signed in. 3 runtimes can launch now." and each row flips to Ready.                                                                                                 |
| E32 | Agent permissions changed while sessions run      | "Applies to new sessions. 2 running sessions keep the old mode (Auto mode) until restarted."                                                                                                                                                                                               |

---

## 12. Later: moving a conversation between harnesses

**Out of scope for this build; scoped here so nothing above forecloses it.** "Migrating" means
continuing a Claude conversation in Codex, or the reverse.

- **What it is:** a new conversation in the target harness's pool, seeded from the source transcript,
  with a link back to the source. The source is never rewritten, so the move is reversible and H2
  still holds.
- **What it needs:** a transcript reader per harness (the daemon's session readers already parse both)
  and a writer that produces something the target harness can resume — a rollout file for Codex, a
  project transcript for Claude — or, more modestly, a summary handed to a fresh session.
- **Questions for its own design:** fidelity (tool calls, images, thinking blocks, file history);
  which runtime the continuation launches on; how history listings show the pair; whether the seed is
  a faithful replay or a summary. Today's `session-migrate` mount is the obvious host and should be
  read first.

---

## 13. Build plan

### 13.1 Rules

- **File-disjoint:** no file is owned by two units. Each unit lists what it owns; a unit may **read**
  anything.
- **One unit = one PR = one Opus 5.5 agent**, with its tests at the 100% unit and integration ledgers.
- **A route and its dial land in one PR** (the route-agreement gate), so each route unit also owns the
  PWA client file that dials it.
- **Seams first.** Barrels, the mount registry and the composition roots are the files every unit
  would otherwise touch. **U0** adds every new module's barrel line and registration once, pointing at
  empty seed files, so later units only fill their own files. A seed is the smallest reachable no-op
  the gates accept (an empty export, an empty route list); U0 proves each passes the gates. **A seed
  file is owned by the unit that fills it**, never by U0, which only creates it.
- A unit starts when every unit it depends on has merged. Docs other than this one are rewritten
  only in **U19**; until then this design is the source.

### 13.2 Units

Paths are relative to `packages/` unless they start with `docs/`, `scripts/` or `.github/`. "new"
marks a file the unit creates (or fills from U0's seed).

| Unit                                        | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                            | Delivers                                                                                                                                                                                                               | Depends on       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **U0 Seams**                                | `fleet/src/lib/index.ts`, `daemon/src/lib/runtime/mounts/index.ts`, `daemon/bin/fyd.ts`, `cli/bin/fy.ts`, `pwa/src/lib/index.ts`; creates (but does not own) `daemon/src/lib/fleet/start-resolution.ts` by moving `resolveStartAccount` out of `fyd.ts` unchanged, and every seed file the later units fill                                                                                                                                     | every later unit can land without touching a shared file                                                                                                                                                               | —                |
| **U1 Schema**                               | `fleet/src/lib/config.ts`, `fleet/src/lib/manifest.ts`; new `fleet/src/lib/account/schema.ts`, `fleet/src/lib/account/legacy.ts` (version-1 → version-2, in memory, pure)                                                                                                                                                                                                                                                                       | §5.3 schema and validation, reserved env names, manifest runtime rows, the converter U9 and the compatibility read use                                                                                                 | U0               |
| **U2 Layering**                             | new `fleet/src/lib/account/layering.ts`, `fleet/src/lib/account/fixed-layer.ts`                                                                                                                                                                                                                                                                                                                                                                 | flatten (newest position wins), loop detection, conflicts, per-harness applicability and partial support, model-set resolution and fallback, the fixed layer and the Agent-permissions mapping (§3.4, §3.6) — all pure | U1               |
| **U3 Credential stores**                    | `fleet/src/adapters/credential-store.ts`, `fleet/src/adapters/credential-classifier.ts`, `fleet/src/lib/credential-source.ts`, `daemon/src/adapters/filesystem/state-file-system.ts`; new `fleet/src/lib/account/credentials.ts`                                                                                                                                                                                                                | store resolution (`host` = `""` for Claude), keychain naming from the storage dir, Codex canonical file + link, the narrowed symlink exemption                                                                         | U1               |
| **U4 CI guard**                             | new `fleet/tests/contract/**`, `.github/workflows/ci.yaml`, new `.github/workflows/harness-contract-latest.yaml`                                                                                                                                                                                                                                                                                                                                | §8.5, pinned and latest                                                                                                                                                                                                | —                |
| **U5 Component adaptation**                 | `fleet/src/lib/settings.ts`, `fleet/src/lib/sharing.ts`, `fleet/src/lib/assets.ts`; new `fleet/src/lib/account/adapt.ts`                                                                                                                                                                                                                                                                                                                        | §8.3: per-harness files for each kind, link-vs-generate, plumbing keys, partial-support table                                                                                                                          | U2               |
| **U6 Materialise and wrappers**             | `fleet/src/lib/wrappers.ts`, `fleet/src/lib/plan.ts`, `fleet/src/lib/paths.ts`, `fleet/src/lib/provisioning.ts`, `fleet/src/adapters/file-provisioner.ts`; new `fleet/src/lib/account/materialise.ts`, `fleet/src/lib/account/ids.ts`                                                                                                                                                                                                           | one config dir + wrapper per runtime, credential env vars, the fixed layer as launch arguments (§8.4), `ids.json`                                                                                                      | U3, U4, U5       |
| **U7 Credential status and usage**          | `fleet/src/lib/health.ts`, `fleet/src/lib/usage.ts`, `fleet/src/lib/quota.ts`, `fleet/src/lib/token-refresh.ts`, `fleet/src/adapters/anthropic-usage-probe.ts`, `fleet/src/adapters/process-token-refresh.ts`; new `fleet/src/lib/account/credential-status.ts`, `fleet/src/adapters/codex-usage-probe.ts`, `fleet/src/adapters/rollout-rate-limits.ts`, `cli/src/lib/statusline/**`                                                            | the four words per credential, passive + active usage, Check now, per-credential refresh lock, `fy statusline`                                                                                                         | U3               |
| **U8 History pool and lease**               | `fleet/src/lib/shared-history.ts`, `fleet/src/adapters/file-shared-history.ts`, `daemon/src/lib/session/resume/policy.ts`, `daemon/src/lib/session/lifecycle/service.ts`; new `daemon/src/lib/session/conversation-lease.ts`, `cli/src/lib/history/**`                                                                                                                                                                                          | H1–H4 always-on pool, the lease in daemon and wrappers (§9.3)                                                                                                                                                          | U1               |
| **U9 Migration**                            | `fleet/src/lib/identity.ts`, `fleet/src/lib/seed-provenance.ts`, `fleet/src/adapters/seed-provenance-store.ts`, `fleet/src/adapters/mutation-journal.ts`; new `fleet/src/lib/account/migration.ts`, `fleet/src/adapters/migration-executor.ts`                                                                                                                                                                                                  | §10: dry run, credential moves, verify-before-retire, rollback, purge                                                                                                                                                  | U6, U7, U8       |
| **U10 Import scan**                         | `fleet/src/lib/defaults.ts`, `fleet/src/lib/scaffold.ts`, `fleet/src/lib/credential-seed.ts` (deleted), `fleet/src/adapters/file-scaffolder.ts`, `daemon/src/lib/fleet/boot-preparation.ts`, `daemon/src/lib/fleet/harness-discovery.ts`; new `fleet/src/lib/account/import.ts`, `fleet/src/adapters/host-harness-scan.ts`                                                                                                                      | read a host's Claude/Codex setup into credentials (`host`), components and a Default/Starter profile: secret detection, instruction dedupe, missing-command warnings (E4–E9); boot no longer seeds                     | U3, U5           |
| **U11 Tool install**                        | new `daemon/src/lib/fleet/tool-install.ts`, `daemon/src/adapters/process/package-install.ts`                                                                                                                                                                                                                                                                                                                                                    | §8.6 declared table, manager detection, failure reasons (E1, E2)                                                                                                                                                       | U0               |
| **U12 Launch policy**                       | `daemon/src/lib/fleet/start-resolution.ts`, `daemon/src/lib/session/lifecycle/policy.ts`, `daemon/src/lib/session/lifecycle/settings.ts`, `daemon/src/lib/fleet/launch-environment.ts`, `daemon/src/lib/fleet/launch-renewal.ts`                                                                                                                                                                                                                | `fy start --agent <runtime>` by name / old name / id; `agent: true` replaces the `-auto-` regex; renewal per credential                                                                                                | U6               |
| **U13 Credential routes + dial**            | `daemon/src/lib/runtime/mounts/fleet-login.ts`, new `daemon/src/lib/runtime/mounts/fleet-credentials.ts`, `daemon/src/lib/fleet/credentials-service.ts`, `pwa/src/features/fleet/harness-login-api.ts`, new `pwa/src/features/fleet/credentials-api.ts`                                                                                                                                                                                         | `/v1/fleet/credentials`, Check now, sign-in targeting a credential id                                                                                                                                                  | U7               |
| **U14 Catalogue routes + proposals + dial** | `daemon/src/lib/fleet/proposals.ts`, `daemon/src/lib/fleet/mutations.ts`, `daemon/src/lib/fleet/wire.ts`; new `daemon/src/lib/runtime/mounts/fleet-catalog.ts`, `pwa/src/features/fleet/catalog-api.ts`                                                                                                                                                                                                                                         | `/v1/fleet/machine`, `/components`, `/profiles` (repurposed), `/runtimes`; **every** new proposal kind, with ports for the setup and clone executors                                                                   | U2, U6, U12      |
| **U15 Setup and clone routes + dial**       | new `daemon/src/lib/runtime/mounts/fleet-setup.ts`, `daemon/src/lib/fleet/setup-service.ts`, `fleet/src/lib/account/clone.ts`, `pwa/src/features/fleet/setup-api.ts`                                                                                                                                                                                                                                                                            | `/v1/fleet/setup/scan`, `/machine/tools/install`, `/export`; executors for `setup.import` and `clone.import` (slots, `-2`, Replace keeps logins, path flags)                                                           | U10, U11, U14    |
| **U16 PWA shell**                           | `pwa/src/features/settings/settings-catalog.ts`, `pwa/src/features/settings/settings-page.tsx`, `pwa/src/features/settings/daemon-settings-frame.tsx`; new `pwa/src/features/fleet/shell/**` (Machines switcher, tabs, stepper primitive with Back / Cancel-confirm / saved-for-reuse / sub-stepper return, offline pause, status shapes)                                                                                                       | §4.1, §4.2 frame                                                                                                                                                                                                       | U13, U14         |
| **U17 PWA Runtimes + Credentials**          | new `pwa/src/features/fleet/runtimes/**`, `pwa/src/features/fleet/credentials/**`; `pwa/src/features/fleet/claude-login-panel.tsx`, `pwa/src/features/fleet/codex-login-panel.tsx`, `pwa/src/features/fleet/harness-login-model.ts`                                                                                                                                                                                                             | Runtimes and Credentials tabs and pages, Add runtime (§4.4), Add a login (§4.6), sign-out (E12–E17, E23–E26, E31)                                                                                                      | U16              |
| **U18 PWA Profiles + Components**           | new `pwa/src/features/fleet/profiles/**`, `pwa/src/features/fleet/components/**`                                                                                                                                                                                                                                                                                                                                                                | the two tabs and pages, Build a profile / Edit layers (§4.5), edit and delete (E18–E22)                                                                                                                                | U16              |
| **U19 PWA Settings, first run, clone**      | new `pwa/src/features/fleet/machine/**`, `pwa/src/features/fleet/setup/**`                                                                                                                                                                                                                                                                                                                                                                      | Settings tab, first run (§4.3), install, Clone (§4.7) (E1–E11, E27–E30, E32)                                                                                                                                           | U15, U16         |
| **U20 CLI**                                 | `cli/src/lib/fleet/**`; new `cli/src/lib/setup/**`, `cli/src/lib/machine/**`, `cli/src/lib/runtime/**`, `cli/src/lib/credential/**`, `cli/src/lib/profile/**`, `cli/src/lib/component/**`                                                                                                                                                                                                                                                       | §6.2 and the aliases                                                                                                                                                                                                   | U13, U14, U15    |
| **U21 Retire and document**                 | `daemon/src/lib/runtime/mounts/fleet.ts`, `daemon/src/lib/fleet/sharing.ts`, `pwa/src/features/fleet/fleet-api.ts`, `pwa/src/features/fleet/accounts-*.ts(x)`, `pwa/src/features/fleet/fleet-*.ts(x)`, `scripts/validate/route-agreement-allowlist.txt`, `docs/fleet-defaults.md`, `docs/fleet-health.md`, `docs/fleet-sharing.md`, `docs/fleet-env-profiles.md`, `docs/design/credential-seeding.md`, new `docs/account-model.md`, `CLAUDE.md` | delete the retired routes **with** their dials and the old Accounts UI; promote this design to the contract doc; update the index                                                                                      | U9, U12, U17–U20 |

U16 adds the new Machines surface **beside** today's Daemons → Fleet → Accounts entry, so the old
Accounts files stay reachable (and knip stays green) until U21 deletes them with their routes.

### 13.3 Waves

```
W0  U0 Seams ─────────────────────────┐   U4 CI guard
W1  U1 Schema                          │   U11 Tool install
W2  U2 Layering   U3 Credential stores   U8 History + lease
W3  U5 Adaptation   U7 Status + usage
W4  U6 Materialise + wrappers   U10 Import scan   U13 Credential routes
W5  U12 Launch policy   U9 Migration
W6  U14 Catalogue routes + proposals
W7  U15 Setup + clone routes   U16 PWA shell
W8  U17 Runtimes + Credentials   U18 Profiles + Components   U19 Settings + first run + clone   U20 CLI
W9  U21 Retire and document
```

- **U0 and U4 first.** U4 lands before U6 so the mechanism is guarded from the first release that
  relies on it.
- **The pure core (U1, U2) is the spine**: every later unit consumes the model through it, so the
  layering rules are written once.
- **Old and new coexist until U21.** U1's in-memory converter means the daemon runs on version-1
  configs throughout; the old Accounts UI keeps working until U21 deletes it in the same PR as its
  routes.
- Widest wave: W8, four agents in parallel.

---

## 14. Declared gaps and open questions

### Gaps (known, accepted)

- **G1 — macOS Claude keychain path is INFERRED.** The Linux build compiles it out. A `macos-15` guard
  job is a release gate for U3.
- **G2 — Codex concurrent refresh** between two processes the person started themselves is a
  residual race (§9.2).
- **G3 — `--continue` / picker resumes** are not leased (§9.3).
- **G4 — Server-side revoke on `codex logout`** is UNKNOWN (§9.4).
- **G5 — Codex `store: host` on a keyring host** cannot link; the first run offers sign-in instead.
- **G6 — Passive Claude usage needs an interactive session**; headless sessions fall back to the
  active read.
- **G7 — Secrets on clone.** References travel, values do not. The prototype does not show a target
  missing a referenced secret; the build should flag it like a missing command (K6) until designed.
- **G8 — Several INFERRED harness keys** (Claude trust/onboarding keys, Codex trust override, Codex
  skills directory) are pinned only by the CI guard, not by a read of the source.

### Open questions for the owner

- **O1 — Where the surface mounts.** The prototype is the whole surface on a phone. Proposal: the
  PWA's Settings list gets one **Machines** entry (depth 2, linkable `#machines/<name>/<tab>`) that
  replaces both "Daemons → Fleet → Accounts" and the per-daemon panel rail.
- **O2 — First run makes no agent runtime.** The prototype's first run creates `claude-default` and
  `codex-default` with the agent flag **off**, so `fy start --agent` has nothing to start until one is
  added. Options: keep it (agents are a deliberate choice), or tick the agent box on the first-run
  runtimes. This design keeps the prototype.
- **O3 — `--disallowed-tools=AskUserQuestion`** is in today's auto variant. Should it live in the
  Claude fixed layer, or become an ordinary Settings component?
- **O4 — Claude "Auto mode"** assumes the pinned Claude accepts `--permission-mode auto`; the guard
  asserts it. If a pinned version does not, should Auto mode map to `acceptEdits` or refuse?
- **O5 — Offline edits.** The prototype's offline banner says "Changes wait until it's back".
  Proposal: steppers keep their progress (E11) but nothing is queued; a write needs the machine.
- **O6 — Import again** adds only what is new. Should it also offer to update a component whose
  source file changed since the last import?
