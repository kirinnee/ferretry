# Ferretry's account model: Machines, Credentials, Components, Profiles, Runtimes

Status: **built.** Units U0–U21 shipped as PRs #433–#456 plus the U21 retirement PR, and the account
model is the only account behaviour there is. The owner approved it after a long discussion and a
clickable prototype ("looks good -- apply"). The short contract — what each thing is, the routes, the
verbs, where state lives — is [../account-model.md](../account-model.md); **this document is the
why**, with the full rules, flows and per-harness mechanisms. The owner's U21 decision ("just clean up
everything … we dont need to care about backward compatibility") means nothing here is optional or
switched: the old account system is deleted, not deprecated (§10).

**The prototype is the UX spec:** [account-model-prototype.html](account-model-prototype.html), a
static reference page that is not shipped. Open it in a browser. Every flow in §4 and every edge case
in §11 can be clicked through from its catalogue. Where this document and the prototype disagree on
what a screen shows or says, the prototype wins, and this document is the bug.

Every harness claim is marked **VERIFIED** (run, or read in the harness's own code), **INFERRED**
(follows from code read but not run, or from absence) or **UNKNOWN**. Sources: the Claude Code
2.1.281 spike (`CLAUDE_SECURESTORAGE_CONFIG_DIR`), the codex-rs reading recorded in the original
brief, and a read of Ferretry `main` at `fa4312888` / `6eabb2e78`.

## Contents

1. [Why](#1-why)
2. [The vocabulary](#2-the-vocabulary)
3. [Entities and their rules](#3-entities-and-their-rules)
4. [UX: rules, tabs and flows](#4-ux-rules-tabs-and-flows)
5. [Configuration and storage](#5-configuration-and-storage)
6. [CLI](#6-cli)
7. [Daemon routes](#7-daemon-routes)
8. [Per-harness mechanisms (hidden implementation)](#8-per-harness-mechanisms-hidden-implementation)
9. [Safety](#9-safety)
10. [Version 1 is retired](#10-version-1-is-retired)
11. [Edge cases E1–E32](#11-edge-cases-e1e32)
12. [Later: moving a conversation between harnesses](#12-later-moving-a-conversation-between-harnesses)
13. [Build plan (as built)](#13-build-plan-as-built)
14. [Declared gaps and resolved questions](#14-declared-gaps-and-resolved-questions)

---

## 1. Why

What the old account system (version 1, deleted in U21) cost, measured on `main` before the account model was built:

| Cost                          | Before                                                                                                                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reaching Accounts             | gear → Settings section **Daemons** → daemon picker → panel rail **Fleet** → **Accounts** (indented child). Panel selection is component state, so nothing links straight to it.                                                                                     |
| Adding one Claude account     | Accounts → "Add an account" → "Add account" again → an **8-step** stepper (Harness, Account, Sign-in, Models, Instructions, Skills, Settings, Review) → staged-change review → password modal → back to Accounts to sign in. About **11 screens and 12+ decisions**. |
| First run                     | **4 accounts from 2 logins** (`claude-default`, `claude-auto-default`, `codex-default`, `codex-auto-default`), each holding a **copy** of the host's credential.                                                                                                     |
| What the config makes you say | a UUID, a wrapper name, a home and a mode per route; variants; profiles; `identity` to say two routes share a login; `sharedHistory` booleans that default to **off**.                                                                                               |

Four structural causes, each removed by a rule in §3:

1. **A login is not an entity.** It is inferred from `identity` grouping, and every home holds its
   own copy, so a refresh in one copy can kill the others (a Codex refresh token is single-use, so
   one refresh in one copy signs out every other copy). → a **Credential** is stored once and never
   copied (C1).
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
| **Clone machine**     | A **one-time** copy of components, model sets, profiles and runtimes from one machine to another. Sign-ins and history are not copied; an API-key login's keys follow, sealed.                      |

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

| Rule | Statement                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1   | A credential is **stored exactly once** and **never copied**, not even by Clone. Every runtime that uses it reads that one store.                                                                                                                                                                                                                                                                                                        |
| C2   | A credential has one harness (`claude` or `codex`) and belongs to one machine.                                                                                                                                                                                                                                                                                                                                                           |
| C3   | A credential's **store** is `host` (the person's own `~/.claude` / `~/.codex` login, **shared in place**: Ferretry keeps a pointer, never a copy), `ferretry` (a login Ferretry signed in, under `<FY_HOME>/fleet/credentials/<id>/`) or `environment` (Advanced: the `${secret:NAME}` references of [secrets.md](../secrets.md): the runtime launches with the variable set from the secret store, and the value never touches a file). |
| C4   | `host` is allowed **once per harness per machine**. Every surface that shows a `host` credential says it is **shared with `claude` / `codex` in your terminal**, and its sign-out says that it signs out both (E25).                                                                                                                                                                                                                     |
| C5   | Status is exactly one of **Ready**, **Refresh due**, **Needs sign-in**, **Checking**. Usage is the 5-hour and weekly windows. Both are per credential, never per runtime: one credential is one rate-limit pool.                                                                                                                                                                                                                         |
| C6   | Ferretry **never refreshes a token on a timer.** A refresh happens when the harness does it naturally, at a launch that is due, or on an explicit **Check now**.                                                                                                                                                                                                                                                                         |
| C7   | Signing a credential in or out affects **every runtime that uses it**, and every surface says how many ("Finish sign-in for 3 runtimes", "3 runtimes will need sign-in").                                                                                                                                                                                                                                                                |
| C8   | An **empty slot** is a credential with no login yet: status **Needs sign-in**. Clone creates one per credential the source runtimes used (E31). Runtimes keep pointing at the slot, so one sign-in fixes all of them.                                                                                                                                                                                                                    |
| C9   | Two credentials of one harness may share an email. Each then carries a **label** the person chose (`personal`, `work`) and the add flow asks for both labels, which must differ (E26). Labels are display only.                                                                                                                                                                                                                          |
| C10  | A credential cannot be removed while a runtime uses it.                                                                                                                                                                                                                                                                                                                                                                                  |
| C11  | The sharing mechanism for each harness is pinned by a **CI guard** (§8.5) that fails when a harness update breaks it.                                                                                                                                                                                                                                                                                                                    |

### 3.3 Component

| Rule | Statement                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1   | A component is **saved once and referenced**. Editing it changes every profile and runtime that uses it; the edit screen says how many and the button reads **Save for all** (E20). Running sessions keep the old version until restarted.                                                                                                                                                                                            |
| K2   | Kinds and harness scope: **Instructions**, **MCP servers**, **Skills** are **generic**, adapted per harness by Ferretry (§8.3). **Settings** and **Hooks** belong to **one harness**. A **Model set** is named models plus a default.                                                                                                                                                                                                 |
| K3   | A generic component may be narrowed to one harness. The import does this when `CLAUDE.md` and `AGENTS.md` differ: "Claude instructions" and "Codex instructions" (E9). Every component shows its **scope** — Generic, Claude only or Codex only — derived, never set: Settings and Hooks from their harness, a narrowed component from its narrowing, a model set from its model ids (one harness's ids only make it that harness's). |
| K4   | **Settings is where flags and environment live** (`env.LOG_LEVEL = debug`). There is no separate "flags" or "env" field anywhere. Secret values never sit in a component: they live in the secret store and the component holds a `${secret:NAME}` reference (E7).                                                                                                                                                                    |
| K5   | A generic component that one harness can only partly honour carries **Partly supported on _harness_** with the reason (E22).                                                                                                                                                                                                                                                                                                          |
| K6   | A component can carry a **warning** that does not block saving it: "Command not found: uvx" (E8), "Check this path on _machine_" after a clone (E30). Editing the cause clears it.                                                                                                                                                                                                                                                    |
| K7   | A component cannot be deleted while a profile has it as a layer. The block names those profiles and the runtimes behind them, and offers **Remove from those first** (E21).                                                                                                                                                                                                                                                           |
| K8   | A model set's models are ids; the UI shows names. A model the runtime's credential cannot use is struck through as "Not available on this login", and the default falls back to the first available one, saying so (E23).                                                                                                                                                                                                             |

### 3.4 Profile

| Rule | Statement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1   | A profile is an **ordered list of layers**, oldest first. A layer is a component or another profile (used as a base).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| P2   | **The newer layer always overrides the older.** The same component reached twice counts once, at its **newest** position.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| P3   | A profile can never include itself, directly or through a base. Bases that would are disabled with "Would include itself" (E19).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| P4   | A **conflict** is two layers setting one key (per harness) to different values. Profiles show them as "`key`: _new_ (from _layer_) overrides _old_ (from _layer_)" (E18). A conflict is information, not an error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| P5   | A profile applies to a credential's harness by **skipping** the layers that belong to the other harness. A profile in which nothing applies is unavailable for that credential, with the reason (E14). Since P7 only a profile written before it can hold the other harness's layers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| P6   | A profile used by a runtime cannot be deleted until each such runtime picks another profile; a profile used as a base must be removed from those profiles first. Its components stay saved (E21).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| P7   | A profile's **scope** is **Generic**, **Claude only** or **Codex only**, DERIVED from its layers and never set by hand (owner decision, 2026-10-16): the union of its layers' scopes (K3), a base profile counting as its own derived scope. Generic + Claude only is Claude only. **Claude only + Codex only is refused** — by the builder, the API and the CLI — in one sentence naming the two layers: "Profile _work_ can't be both Claude only and Codex only: settings _a_ is Claude only and settings _b_ is Codex only." A change that would make a profile mixed indirectly (narrowing a component, editing a base) or leave a runtime on a profile for the other harness is refused the same way. A runtime only takes a Generic profile or one of its login's harness. A profile mixed before P7 still reads and launches (P5 skips the other harness's layers), shows **Mixed** with that sentence, and cannot be saved until it is split. |

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
| R6   | Runtime ids are opaque and live in Ferretry's state, not the config. Every session record, task board and pricing row still joins on the id, never on the name a person types.                                                      |

### 3.6 Fixed layer and Agent permissions

| Rule | Statement                                                                                                                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1   | The fixed layer exists **only for agent runtimes**. It is applied **last** and **always wins**, including over settings the harness itself writes at run time (§8.4).                                                                           |
| F2   | It is shown **read-only** with a lock, and user values it overrides are shown struck through: "From your _Agent settings_ · Overridden for agents by Ferretry" (E24).                                                                           |
| F3   | Its contents: no trust prompt, no onboarding screens, and the permission mode from the machine's **Agent permissions**. Nothing in it is a credential or an identity.                                                                           |
| F4   | **Agent permissions** is per machine: **Auto mode** ("Agents work on their own and stop to ask before anything that looks risky") or **Skip all permission checks** ("Agents never stop to ask. They can change any file and run any command"). |
| F5   | A change **applies to new sessions**. With sessions running, the setting says "_N_ running sessions keep the old mode (_old_) until restarted" (E32).                                                                                           |

Per-harness mapping (§8.4 has the launch mechanics):

| Fixed-layer key         | Claude Code                                                                                                                                                                                                                                                 | Codex                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Auto mode               | `permissions.defaultMode = auto` (`--permission-mode auto`)                                                                                                                                                                                                 | `approval_policy = on-request`, `sandbox_mode = workspace-write`                                                        |
| Skip all checks         | `permissions.defaultMode = bypassPermissions`, plus `skipDangerousModePermissionPrompt = true`                                                                                                                                                              | `approval_policy = never`, `sandbox_mode = danger-full-access` (what `--dangerously-bypass-approvals-and-sandbox` sets) |
| trust prompt = off      | the launch directory recorded as trusted in the runtime's `.claude.json` (**INFERRED** key, CI-guarded)                                                                                                                                                     | `projects."<dir>".trust_level = "trusted"` as a `-c` override (**INFERRED**, CI-guarded)                                |
| onboarding = done       | `hasCompletedOnboarding = true` in the runtime's `.claude.json`                                                                                                                                                                                             | — (Codex has no onboarding screen that blocks a launch; **INFERRED**)                                                   |
| Remote Control = off    | `remoteControlAtStartup = false` in the `--settings` overlay, so an imported `true` (or the account's default) never publishes the session; `--rc` is the explicit opt-in                                                                                   | — (Codex has no Remote Control; its `remote_control` feature was removed in 0.156.1)                                    |
| one-shot dialogs = seen | `hasSeenAutoDefaultNudge`, the effort nudge and the fullscreen upsell recorded as seen in `.claude.json`, and the permission mode named again in the `--settings` overlay (**MEASURED**, CI-guarded: the auto-mode dialog otherwise parks a bypass runtime) | `-c notice={hide_…=true}` for the full-access warning, rate-limit nudge and model-migration prompts                     |

The prototype abbreviates the Codex rows to `approval_policy`; the sandbox key belongs to the same
mapping.

### 3.7 History

| Rule | Statement                                                                                                                                                                                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1   | There is **one history pool per harness per machine**, `<FY_HOME>/fleet/shared/<harness>/` (the path the old opt-in pool used), shared by **every runtime of that harness**. It is always on and not a setting.                                                                                                                               |
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
5. **A missing thing is created in place, then you return**: no login → "+ Add a new login", which
   opens under the list and comes back with the new login picked. **A step never holds a stepper**
   (owner, 2026-10-18): New machine setup is one rail, and Add runtime is one form.
6. **A beginner who imports never sees the word "Component".**
7. Status uses the four words and four shapes: ● Ready, ◐ Refresh due, ○ Needs sign-in, ◌ Checking.
8. No wrapper paths, UUIDs, config directories, `<kind>:<identity>` lines or the word "home" anywhere.

### 4.2 Information architecture

**Which machine** is chosen one level up (usability redesign, 2026-10-14): the Settings sidebar on a
desktop and the Machines card on a phone list every paired daemon by name with a status line (Online ·
_n_ runtimes, Not set up yet, Offline, Locked) and **Add a machine** (the existing `fy pair` flow). The
old Daemons section is merged in: each machine is ONE place, its connection and security panels on its
**Machine** tab. A machine that is not set up shows a **Finish setting up _machine_** banner above its tabs.

Each machine has six views, drawn as underlined tabs in sentence case (they scroll sideways on a
phone, keeping the current one centred):

| Tab             | Shows                                                                                                                                                                                                                                                                                              | Primary action               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **Runtimes**    | each runtime: status shape, name, credential email (+ label), profile, default model, **Agent** badge; a missing-harness note with Install                                                                                                                                                         | **+ Add runtime**            |
| **Credentials** | grouped by harness: email, label, "Shared with claude in your terminal", "Copied slot from _machine_", status, "Used by _n_ runtimes", usage bars                                                                                                                                                  | **+ Add a login**            |
| **Profiles**    | each row leads with the name and a **scope badge** (Generic, Claude only, Codex only; Mixed for one written before P7) and ONE line, "Claude only · 4 parts · Used by 2 runtimes"; the layer stack, conflicts and per-harness detail open behind a tap (owner: the old tab was "VERY complicated") | **+ Build a new profile**    |
| **Components**  | the six kinds with a one-line description and a count; each opens its list                                                                                                                                                                                                                         | **+ New _kind_** (in a list) |
| **Browser**     | Browser mode (Headless / Real window); Browser proxy (address, bypass list, secret-name credentials) with **Test proxy**; the honest user-agent line; a status line (running or stopped, via proxy or direct)                                                                                      | **Test proxy**               |
| **Machine**     | Agent permissions; Tools on _machine_ (installed + version, or Install); Setup (**Clone from another machine**, **Import again**); Connection and security (Warden, Secrets, devices, grants, Security, Security log, Carrier, Host checks…); About this machine                                   | —                            |

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

Where this surface mounts (open question O1, now resolved, §14): the PWA Settings list has one **Machines** entry, linkable as `#machines/<name>/<tab>`.

### 4.3 First run (per machine): New machine setup's Claude Code and Codex steps

A FULL SCREEN OF ITS OWN, outside Settings and with no app chrome (`/d/<id>/setup`, usability redesign
2026-10-14): it opens by itself right after pairing a machine that is not set up, and from the
"Finish setting up" banner. Starting a daemon never imports anything, so a fresh machine is not set up
until somebody chooses.

**ONE RAIL, NO STEPPER INSIDE A STEP** (owner, 2026-10-18: "the first step is to create a runtime, but
that is a nested stepper"). New machine setup is ten steps on one progress rail — Pair · Start from ·
**Claude Code** · **Codex** · Speed-ups · Voice · Warden · Learning · Agent controls · Done — every one
skippable and revisitable, with Finish later keeping the place, the states and the runtime names typed.
There is no Check tools step, no Name runtimes step and no runtime wizard. Each CLI's step is ONE
screen, top to bottom:

1. **Installed?** Installed, or Not installed with the install in place: the **exact command** Ferretry
   will run on the machine (`brew install --cask claude-code`, `npm install -g @openai/codex`, …; §8.6),
   a **passkey confirmation** from a phone or any governed caller, and **Skip** (E1). A failed install
   says why and gives the command to run by hand, with **Retry** (E2). Not installed and skipped is one
   quiet line (E3).
2. **Found on _machine_**: Account (Signed in / refresh due / Not signed in), Instructions
   (`CLAUDE.md`, size), Settings (`settings.json`, "6 settings, 1 hook"), MCP servers (names), Skills
   (names), with warnings inline. On Codex, when Claude Code is already imported, Instructions says
   "Same as your CLAUDE.md · one shared copy" or "Different from your CLAUDE.md · kept separately" (E9).
3. **Sign in now**, when the person's own login is installed but not signed in: it adds that login
   (`credential.add`, `store: host`), runs the existing sign-in in place, and the step reads the
   machine again, so the import reuses that login.
4. **Runtime name**, prefilled with the daemon's own suggestion — `claude-default` / `codex-default`
   (harness + profile), `-starter` when nothing was found (E5), `-2` on a clash — validated as you type
   (E16). When a runtime already uses this login and profile (Import again), "Also add another runtime"
   is unchecked by default and no name is asked (E15).
5. **What changed** (Import again only): each update offered, none ticked (O6).
6. **Import and create _name_** ("…, sign in later" when not signed in, E4): ONE reviewed change,
   `setup.import` with `include: [<this harness>]` and `names: { <harness>: <name> }`. It creates the
   credential (`store: host`, shared in place), one component per item found, and a **Default** profile
   FOR THIS HARNESS (`claude-default`, Claude only; Codex gets its own `codex-default`, so no profile
   mixes the two, P7) — and the runtime, under the name in the field. The step then says "_name_ is
   ready" (or **Sign in before you launch**) with the notes (E6–E9). "Importing copies your setup into
   Ferretry. Claude Code on _machine_ keeps working as before", and "Ferretry and your own `claude`
   share this login: signing out in one signs out both."
7. **Use a provider key instead** (collapsed): the provider grid (§4.6) for this CLI. The login it adds
   gets its runtime right there — a name field and **Create** (`runtime.put`) on the profile this CLI's
   import made; without one, it says to import first.

A CLI's step is **set** once that CLI has a runtime on the machine; Continue past one that was not
imported counts as skipped, and Done says which runtime each CLI has, with **Set up later** → Runtimes
for a skipped one. More runtimes are Settings › Runtimes › Add runtime (§4.4).

The runtimes this makes are **agent runtimes** (O2). **The daemon never runs this import itself**: an
earlier build imported at the first boot (`fleet.prepareDefaults`), and that key is now retired —
tolerated in an old `config/daemon.json` and said once in the boot trail. The same questions are
`fy daemon setup` in a terminal; `fy daemon import claude|codex` is the no-questions form for scripts.

**Import again** (Settings › Machine › Setup) opens the same full screen on its Claude Code step, and
an import only adds what is new.

### 4.4 Add runtime

ONE FORM on one page (no stepper; owner, 2026-10-18). The page title is "Add a runtime".

- **Login.** Radio rows: email, label, scope chip, status, "used by _n_ runtimes", and "isn't installed
  here" where true; then **+ Add a new login**, which opens IN PLACE under the list — Sign in to Claude
  Code / Codex (one tap makes the login and starts its sign-in; **Use it, sign in later**) or a
  **Provider key** from the provider grid — and comes back picked (E12). Picking a Needs-sign-in login
  shows the sign-in panel inline; the runtime can be created before it is signed in (E13).
- **Runs**, for a login that drives both CLIs.
- **Profile.** Each profile shows its scope badge, and only Generic profiles and those of the login's
  harness can be picked (P7); one for the other harness, or a Mixed one, is disabled with the reason.
  One that cannot apply is disabled the same way, and one partly supported carries "Partly supported on
  Codex" (E14). Profiles are built on the Profiles tab, linked from here. A duplicate pair needs
  "Add another anyway" (E15).
- **Name** (prefilled harness + profile, validated, suggestion on clash, E16) and the checkbox
  **Ferretry launches this as an agent** — "Adds Ferretry's fixed layer last: no trust or onboarding
  prompts, and the machine's agent permissions."
- **Create runtime**, then "_name_ is ready to launch" (or "Sign in before you launch"), **Back to
  Runtimes** / **Open _name_**.

### 4.5 A profile as a bag of components (supersedes the Build a profile stepper)

There is no stepper and no fixed layer slots (R5). A profile is ONE ordered list of contents —
instructions, MCP servers, skills, settings, hooks, model sets and other profiles, any number of each —
and order matters only for override: **a later item overrides an earlier one** where both set the same
key. The profile page and **+ New profile** open the same editor:

- **Library** (desktop, left): every component and every other profile, with search and a kind filter.
  Drag a row in (it lands where the line shows) or press its **Add**. On a phone the contents' **Add**
  opens the same library as a picker sheet.
- **Contents** (right): the list, numbered. Reorder by drag, or with ↑/↓ (keyboard-accessible; focus
  stays on the moved row). Remove with ✕ or by dragging the row back onto the library. A row that wins
  over an earlier one carries an **"overrides ‹X› · ‹key›"** chip.
- **Resolved**: every final value per tool — MCP servers, skills, settings keys, environment, flags,
  hooks, the model — with the item it came from and the values it overrode struck through. This and
  the chips are the daemon's answer (`POST /v1/fleet/profiles/preview`, its additive `resolved`), never
  a browser re-reading of the merge rules (§3.4). Secret-looking values arrive as `‹hidden›`.
- **Scope** is derived from the contents. Adding a Claude-only item to a Codex-only profile (or the
  reverse) is refused at once, naming the items to blame; so is a profile that contains this one
  ("would contain itself", E19).
- **Save** sends the whole list as one `profile.put`; **Discard changes** goes back to the saved list.
  A saved profile also offers **Edit as YAML** on its file, `config/profiles/<name>.yaml`.

Profiles are built here only; Add runtime links to this tab rather than opening the editor inside its
form. Components are created on the Components tab; the editor only arranges what exists.

### 4.6 Add a login

**One screen, no stepper.** The providers are tiles: **Sign in** (Claude Code, Codex — a subscription;
a tool that is not installed says so and opens nothing), then every API-key provider the machine offers
(docs/provider-presets.md § One-click add) and **Paste variables…**. A tap folds the tiles to the one
chosen (**Change** while nothing is made) and shows under it only what that provider needs, and ONE
button. It adds the login and, when no runtime on the machine runs that CLI yet, the runtime on it — the
profile a runtime of that CLI already uses, else the first that fits, under the suggested name; a
checked box says which, and turns it off or on. No fitting profile: no runtime, said in place.

- **Sign in**: the same click makes the empty login (`store: ferretry`) and starts the harness's sign-in;
  the existing link-and-code panel appears under it (Claude: open the page, paste the code; Codex: device
  code, §8.2). "The login is kept on _machine_." Signed in to an email that already has a login of that
  harness asks for both **labels** in place (E26).
- **API key**: the provider's minimal form; the key is stored first, then the login added, then
  **Test** is offered.

Progress is the button's own words ("Creating claude-default…", "Starting sign-in…"); a refusal is
one sentence beside it. A refused runtime keeps the login and says so. Leaving once a provider is
chosen asks first; a machine asleep or offline pauses the screen (O5).

### 4.7 Clone from another machine

Settings → Setup → **Clone from another machine**. **Source** → **Preview** → **Existing setup**
(only when the target already has profiles or runtimes) → **Done**.

- **Source**: other machines; offline or not-set-up ones are disabled with the reason (E27).
- **Preview**: **Copies** (_n_ components, _n_ model sets, _n_ profiles, _n_ runtimes); **Logins and
  keys** (each API-key login "Copies with its key", each sign-in "Sign in on _target_", and one ticked box
  "Copy _n_ API keys with the logins" — sealed, one passkey on the source; owner decision 2026-10-20);
  **Doesn't copy** (_n_ sign-ins — "A refresh token on two machines would sign one of them out. Each
  becomes an empty slot on _target_; sign in there. Runtimes keep pointing at their slot." — and History); **Check after copying** (paths, E30); a note when a
  harness is missing on the target (E29).
- **Default runtime for new agents** (Preview and Existing setup): a select over the agent runtimes the
  copy brings, plus "None (automatic)" and, on a plain copy, "Keep what it has now". Rule T makes the
  default name an agent runtime that exists, and Replace deletes the target's runtimes while its machine
  settings stay, so a default left alone would dangle and the target could no longer read its own
  configuration. The choice is therefore always concrete and always shown: the person's pick; else the
  source's own default when its runtime is copied (the "controls" item); else the target's own default when
  a plain copy leaves it standing; else `claude-default`, then a runtime of the replaced default's family,
  then the first by name (`suggestCloneDefault`, one function for the app and the planner). It travels on
  `clone.import` as `defaultRuntime` (a source runtime name, `null` for none, absent to let the planner
  decide with the same rule) and is mapped through any `-2` rename. The planner keeps rule T as the guard:
  a `defaultRuntime` that is not a copied agent runtime is refused with the runtimes to pick from, and the
  copy's description says when the target's default was replaced. After the fleet copy the "controls" item
  re-reads this machine's default instead of re-applying the source's, so it cannot undo the choice. The
  sentences name machines by the person's name for them (`names` on the change), never a hostname.
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

## 5. Configuration and storage

### 5.1 The old format (version 1) is not read

The old `config.yaml` had no `version` key. It spelled a UUID, a wrapper name, a home and a mode per
route, plus variants, profiles, `identity` groups and `sharedHistory` flags: four accounts and four
credential copies from two logins on a default first run. A machine whose `config.yaml` is still in
that shape is **refused, never converted** (§10).

### 5.2 A machine, imported

`<FY_HOME>/fleet/config.yaml`, `version: 2`:

```yaml
version: 2

machine:
  agentPermissions: auto # auto | skip
  defaultRuntime: claude-default # optional; must name an agent runtime (T); unset falls back to claude-default if it is one
  agentControl: { terminals: true, browsers: true, files: true } # "What agents may control" (T), default all on
  # Turning one of the three OFF asks nothing beyond the ordinary fleet.configure step-up; turning one
  # back ON from a remote device always wants a passkey proved for that act (docs/grants.md, owner decision).

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

profiles: # one per harness (P7): the generic parts plus that harness's own
  claude-default: # Claude only
    layers:
      - instructions/main
      - mcp/github
      - mcp/linear
      - skills/my-skills
      - settings/claude-settings
      - hooks/format-on-save
      - modelSets/claude-models
  codex-default: # Codex only
    layers:
      - instructions/main
      - mcp/github
      - mcp/linear
      - skills/my-skills
      - settings/codex-settings
      - modelSets/codex-models

runtimes:
  claude-default: { credential: claude-you, profile: claude-default, agent: true } # first-run runtimes are agents (O2)
  codex-default: { credential: codex-you, profile: codex-default, agent: true }
```

A layered agent profile and runtime from the prototype's set-up machine:

```yaml
profiles:
  agent: { layers: [settings/agent-settings, modelSets/heavy] }
  agent-work: { layers: [profile/claude-default, profile/agent] } # newer layer (agent) wins; Claude only
runtimes:
  claude-agent: { credential: claude-you, profile: agent-work, agent: true }
```

### 5.3 The full schema

```yaml
version: 2
machine:
  agentPermissions: auto | skip # default auto
  defaultRuntime: <name> # optional; "Default runtime for new agents" (T) — must be an agent runtime; the daemon resolves `claude-default` when unset and that name is one
  agentControl: { terminals: bool, browsers: bool, files: bool } # "What agents may control" (T), each default true
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
advanced: # everything a beginner never sees
  secretsFile: ~/.secrets
  aliases: { … }
  commands: [ … ]
  usage: { … } # intervals
  path: { announce: true } # the PATH line
```

Component files live in the asset tree, `<FY_HOME>/fleet/assets/components/<kind>/<name>.<ext>`, so
the link-not-copy materialisation (a file in the asset tree is linked into a runtime, never copied) makes "editing
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
- a document with no `version` key, or `version: 1` (`agents`, `routes`, `identity`, `variants`,
  `sharedHistory`), is **refused whole** with the sentence in §10; nothing reads it and nothing
  converts it.

### 5.4 State on disk

| Path (under `<FY_HOME>/fleet/`) | Holds                                                                                                    | Owner                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `config.yaml`                   | §5.3                                                                                                     | the person, via proposals     |
| `assets/components/**`          | component bodies                                                                                         | the person, via proposals     |
| `credentials/<id>/`             | `store: ferretry` only: Claude secure-storage dir, or Codex canonical `auth.json`; `usage.json` (§8.1.3) | the harness                   |
| `homes/<runtime id>/`           | the runtime's materialised config dir (§8). **Internal name only**                                       | Ferretry (plan) + the harness |
| `shared/<harness>/`             | the history pool (H1) and `.leases/`                                                                     | the harness                   |
| `ids.json`                      | runtime name → opaque id (R6)                                                                            | Ferretry                      |
| `manifest.json`                 | published runtimes: `{id, name, harness, credential, profile, agent, wrapper, models, defaultModel}`     | Ferretry                      |

What the config no longer says: route UUIDs (→ `ids.json`), `wrapper:` and `home:` (derived from the
runtime name and id), `mode:` and `variants` (→ the agent flag and the fixed layer), `identity:` (→
`credential:`), `sharedHistory:` (always on), `shared:` names (→ components). There is no copy of a
login to keep in sync, so nothing syncs.

---

## 6. CLI

The binary name is derived from `packages/cli/package.json` `bin`; `fy` below is that derived name.
Every write goes through the same reviewed-proposal path the daemon uses and **applies in one step**,
so nobody types `apply`. Every verb is a plain word a person would say; a read takes `--json`, a write
takes `--dry-run` and `--yes`.

| Command                                                                                                    | Purpose                                                                                                |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `fy daemon setup`                                                                                          | the first run (§4.3) in a terminal, one question at a time; Import again on a machine already set up   |
| `fy daemon import claude\|codex [--name <runtime>]`                                                        | one tool's own login and setup, no questions (for scripts); refuses a tool that is not installed       |
| `fy machine` / `fy machine set agent-permissions auto\|skip`                                               | machine facts, tools, Agent permissions                                                                |
| `fy machine install claude\|codex`                                                                         | install a harness tool (§8.6); shows the command first                                                 |
| `fy machine export > setup.json` / `fy machine clone setup.json [--replace]`                               | Clone without a browser: export from the source, import on the target                                  |
| `fy runtimes`                                                                                              | the Runtimes tab                                                                                       |
| `fy runtime add <name> --credential <id> --profile <name> [--agent] [--add-another]`                       | Add runtime                                                                                            |
| `fy runtime show <name>` / `set <name> [--credential …] [--profile …] [--agent\|--no-agent]` / `rm <name>` | one runtime: stack, fixed layer, models                                                                |
| `fy credentials`                                                                                           | the Credentials tab, with status and usage                                                             |
| `fy credential add claude\|codex [--label L] [--id <id>] [--no-sign-in]`                                   | Add a login (link + code, or device code)                                                              |
| `fy credential check <id>` / `signin <id>` / `signout <id>` / `label <id> <L>` / `rm <id>`                 | Check now; sign in again; sign out (names every runtime, confirms); label; remove (refused while used) |
| `fy profiles` / `fy profile ls` / `fy profile show <name>`                                                 | scope (Generic, Claude only, Codex only), layers, conflicts, where used                                |
| `fy profile build <name> --layer <kind>/<name>…` / `edit <name> --layer …` / `rm <name>`                   | Build / Edit layers / Delete (P6)                                                                      |
| `fy components [<kind>]` / `fy component show\|add\|edit\|rm <kind>/<name>`                                | the Components tab                                                                                     |
| `fy start --agent <runtime>`                                                                               | refused unless the runtime is an agent runtime                                                         |
| `fy fleet recommend <task…>`                                                                               | the routing suggestion; **the only verb `fleet` keeps**                                                |

The old `fy fleet init`, `apply`, `ls`, `usage`, `health`, `sharing`, `login` and `migrate` are
deleted, with no alias: `fy runtimes` and `fy credentials` answer what `ls`, `usage` and `health`
did, `fy credential signin <id>` is the sign-in, and a write applies itself.

---

## 7. Daemon routes

Reads are plain GETs. **Every write is a proposal** (`POST /v1/fleet/proposals`, then `…/apply`)
under `fleet.configure`, which a governed caller reaches with a passkey step-up ([grants.md](../grants.md)).
A stepper stages **one** proposal, and one step-up covers it. No route returns a credential value.

| Route                                                          | Verb                   | Capability      | Returns / does                                                                                                                                                                                              |
| -------------------------------------------------------------- | ---------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/fleet/machine`                                            | GET                    | fleet.use       | Agent permissions, tools installed + versions, setup state, running-session count, and the caller's **authority** (may it apply, and why not — a governed caller needs a passkey step-up)                   |
| `/v1/fleet/machine/tools/install`                              | POST                   | fleet.configure | start installing named harness tools (§8.6); progress on the existing fleet event socket                                                                                                                    |
| `/v1/fleet/setup/scan`                                         | GET                    | fleet.configure | first-run preview per harness: account state, what was found, secret-looking key **names**, missing commands, instructions identical? — never a value                                                       |
| `/v1/fleet/credentials`                                        | GET                    | fleet.use       | credentials with status, usage, "used by", `host` disclosure                                                                                                                                                |
| `/v1/fleet/credentials/:credentialId/check`                    | POST                   | fleet.use       | Check now (§8.1.2, §8.2.2)                                                                                                                                                                                  |
| `/v1/fleet/login`, `/v1/fleet/login/:flowId`                   | POST + GET/POST/DELETE | fleet.configure | the harness sign-in flows, targeting a credential id; there is no readiness read                                                                                                                            |
| `/v1/fleet/components`                                         | GET                    | fleet.use       | components by kind, with badges and "used by"                                                                                                                                                               |
| `/v1/fleet/profiles` (+ `/preview`)                            | GET / POST             | fleet.use       | the layered profiles, each with its flattened stack and conflicts; `preview` flattens a stack that is not saved yet                                                                                         |
| `/v1/fleet/runtimes`                                           | GET                    | fleet.use       | runtimes with their `id` and `wrapper`, the resolved stack per harness, model set, fixed layer, the agent flag and launchability                                                                            |
| `/v1/fleet/export`                                             | GET                    | fleet.configure | the Clone bundle: components, model sets, profiles, runtimes and credential **descriptors** (harness, email, label) — no credential, no history                                                             |
| `/v1/fleet/proposals` (+ `/:proposalId`, `/:proposalId/apply`) | POST/GET/POST          | fleet.configure | operation kinds: `credential.add/label/remove/signout`, `component.put/remove`, `profile.put/remove`, `runtime.put/remove`, `machine.settings`, `setup.import`, `clone.import {mode: alongside \| replace}` |

There is no `/v1/fleet/permissions` and no `/v1/fleet/migration`: the caller's authority is part of
`GET /v1/fleet/machine`, and nothing is migrated (§10). `GET /v1/fleet/machine` reports the
caller's own authority, step-up included, so a caller that has stepped up reads its stepped-up authority.

**Clone has no daemon-to-daemon path.** The browser holds both connections: it reads the source's
`/v1/fleet/export` and stages a `clone.import` proposal on the target with that bundle. Each daemon
authorizes its own half.

Everything else the old `/v1/fleet/*` surface served — `/accounts`, `/harnesses`, `/config`,
`/environment`, `/plan`, `/usage`, `/health` (+ `/check`), `/apply`, `/permissions`, `/sharing`,
`/assets`, `/migration`, `/renew`, and the old readiness read at `GET /v1/fleet/login` — is deleted
with its dial.

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
treats `ELOOP` as **logged out** behind a server-side flag (VERIFIED by reading). Copying was the old
design and is what the account model replaced.

#### 8.1.2 Status

| Word            | Claude condition                                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ready`         | credential present, and the last read of `GET /api/oauth/usage` answered `200`, or a confirmed Anthropic JSON `403` (scope-limited, healthy — the token merely lacks the `user:profile` scope, which an inference-scoped token never has) |
| `Refresh due`   | access token expired, refresh token present, nothing has proved it yet. Claude renews it itself on next use; Ferretry does nothing                                                                                                        |
| `Needs sign-in` | no credential (an empty slot included), or a proven rejection under the existing digest guard (a stale `401` cannot condemn a fresh credential)                                                                                           |
| `Checking`      | a Check now or the first read is in flight                                                                                                                                                                                                |

One probe per **credential**. The 15-minute horizon and the HTML/WAF `403` / bare `401` inconclusive
rules carry over unchanged; an inconclusive check shows the last known word with its age, never a
fifth word. Check now for Claude is the same free usage read (no refresh, no spend).

`Checking` is a word for a person looking **now**. A reader that keeps the answer — the daemon's usage
feed, which caches its rows for one `usage.interval` — lists credentials **settled**: a credential being
read is given its last known word, because a cached "Checking" outlives the read it describes. Before
this rule the usage pass, which lists and reads credentials at the same time, cached its own in-flight
reads as "not known" for a whole interval.

**How often a store is read.** A status needs only facts about the login — which tokens are there, when the
access token expires, Codex's `last_refresh`, plan and email — plus the truncated digest the digest guard
compares. The daemon keeps exactly those (`CachedCredentialReads`, never the material, never a token) and
re-reads a store only when it may have changed: a file store when its stamp (inode, size, change and
modification times) moves, a macOS keychain item after one `usage.interval`. Expiry is judged at the moment
of each view from the kept expiry, so a kept login still turns **Refresh due** on time. A free usage read
reads the store once, takes its digest and its bearer token from that one read, and refreshes the kept facts;
Check now's Codex refresh always reads the file itself. So an idle Claude login costs one store read per
interval (on macOS one `security` process), and listing logins costs none.

#### 8.1.3 Usage

1. **Passive (VERIFIED field, INFERRED plumbing):** Claude passes `rate_limits.five_hour` /
   `seven_day` `{used_percentage, resets_at}` on statusLine stdin. Each runtime's materialised
   settings set `statusLine.command` to `fy statusline`, which writes the block to the credential's
   `usage.json` (atomic) and then runs the person's own statusLine command, if their settings named
   one, passing stdin through. The wrapper exports `FY_CREDENTIAL=<C>`, which the statusLine child
   inherits (INFERRED). Only interactive TUI sessions render a statusLine.
2. **Active:** `GET /api/oauth/usage` on the existing usage pass, used when no
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

| Word            | Codex condition                                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ready`         | `auth.json` present and readable, access JWT not within 5 minutes of `exp`, `last_refresh` younger than 8 days, and no failed refresh recorded since the last success                                      |
| `Refresh due`   | access JWT `exp` within 5 minutes, **or** `last_refresh` older than 8 days. Codex refreshes at its next start; a launch through Ferretry that is due goes through the launch renewal (`launch-renewal.ts`) |
| `Needs sign-in` | no `auth.json` (an empty slot included), or a refresh **observed** to fail permanently (`refresh_token_expired` / `reused` / `invalidated`)                                                                |
| `Checking`      | a Check now refresh is in flight                                                                                                                                                                           |

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

|                                   | Claude Code                                                                                                                                | Codex                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| permission mode                   | `--permission-mode auto` or `--permission-mode bypassPermissions`                                                                          | `-c approval_policy=… -c sandbox_mode=…` (or `--dangerously-bypass-approvals-and-sandbox` for Skip) |
| fixed settings                    | `--settings <dir>/.fy/fixed.json` (the permission mode; `skipDangerousModePermissionPrompt` for Skip, `skipAutoPermissionPrompt` for Auto) | `-c` pairs                                                                                          |
| trust / onboarding                | `.claude.json` keys re-asserted by the wrapper before `exec` (INFERRED names)                                                              | `-c projects."<cwd>".trust_level="trusted"` (INFERRED)                                              |
| carried from the old auto variant | `--disallowed-tools=AskUserQuestion` (O3, resolved in §14)                                                                                 | `--no-alt-screen`                                                                                   |

The machine's Agent permissions is read **at launch**, so a change applies to new sessions only (F5).
`fy start --agent <runtime>` resolves the runtime by name, then by a recorded old wrapper name, then
by id; the daemon's unattended-launch policy (`unrunnableAccountRefusal`, `authorizeSessionCommand`)
tests the manifest's `agent: true` instead of matching `/^(?:claude|codex)-auto-/`.

How `--settings` merges with the config dir's own `settings.json` is **INFERRED** overlay, and the CI
guard asserts it. Whether Claude's pinned version accepts `--permission-mode auto` is asserted by
the guard too (O4, resolved in §14).

### 8.5 The CI guard

A CI job, `harness-contract` (in the realworld tier's workflow), runs against the **nix-pinned** `claude-code` and `codex` in a
throwaway `HOME`, with fake tokens and `HTTPS_PROXY` pointed at a dead port. It fails the build when a
harness update breaks a mechanism this design relies on.

Claude:

1. Two config dirs with one `CLAUDE_SECURESTORAGE_CONFIG_DIR` holding a fake credential: `claude auth
status --json` reports logged in for both; neither config dir gains a credential file.
2. Without the variable, the second dir reports logged out (the variable is load-bearing).
3. The binary still contains the `CLAUDE_SECURESTORAGE_CONFIG_DIR` read (`rg -a`), so a rename fails
   here with a message naming the variable.
4. `--settings` overlay: a key set only in the overlay is visible in the effective settings, and a
   `remoteControlAtStartup: false` in it outranks `true` in the config dir's `settings.json` (the
   bridge's `[bridge:` debug lines appear with the control and not with the overlay).
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

| Race                                          | Outcome                                                                                 | Mitigation                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Two Claude runtimes refresh at once           | One takes the lock; the other re-reads under the lock, sees a new token, skips the POST | Claude's own code (VERIFIED by reading)                                                                                                                                                                                                                                                                                                                                                    |
| Two Codex runtimes reach "due" in one instant | Both may POST one single-use token; one gets `refresh_token_reused`                     | Codex reloads before refreshing, so the window is the POST round trip (INFERRED). Ferretry renews a due credential **at launch**, under a per-credential lock in the daemon, so Ferretry's own launches never race each other. A loser is recorded `Needs sign-in` only if the canonical file did not advance. **Declared residual** for two processes the person started outside Ferretry |
| Check now vs a running Codex refresh          | Same as above                                                                           | Check now takes the daemon's per-credential lock and re-reads the file first (today's `token-refresh.ts` re-read)                                                                                                                                                                                                                                                                          |
| A component edited while sessions run         | Running sessions keep the old version                                                   | Stated on the edit screen (K1); a link-materialised component changes on disk immediately, and the harness reads it at its own next read — the doc says "until restarted" because that is the only guarantee                                                                                                                                                                               |

### 9.3 One live writer per conversation

Pooling makes two writers on one conversation more likely, so H2 is enforced:

- **Lease:** `<FY_HOME>/fleet/shared/<harness>/.leases/<conversation-id>` records the holder's pid
  and process start time. A lease whose holder is dead (or whose pid now has a different start time)
  is stale and may be taken. Every read-decide-write runs under an exclusive `flock(2)` on
  `.leases/.lock`, which the kernel drops when its holder closes it or dies. The pool is the agents' to
  write, so `.leases` is opened through the state-home guard and the lock and every lease are reached
  through that held folder, never by path ([secrets.md](../secrets.md#what-the-state-home-fence-refuses));
  where that is not possible the lease is refused, not made by path.
- **Declared one-update gap:** the lock was an exclusive SQLite transaction on the same `.lock` file
  before this release. While an update is under way, an older `fy` (SQLite's lock) and a newer one
  (`flock`) do not exclude each other, so two claims that race at that moment can both be granted.
  Every lease is still written whole by rename in its held folder, so a lease file is never corrupted:
  at worst one conversation is briefly double-assigned, until the older process is gone.
- **Daemon:** every session start, resume and fork claims the lease for the harness conversation id
  it launches with. A held lease refuses with the holder named ("being written by session _X_ on
  _claude-review_ since 14:02").
- **Wrappers:** a wrapper whose arguments name a conversation explicitly (`--resume <id>`, `-r <id>`,
  `--session-id <id>`, `codex resume <id>`) runs `fy history claim <id> --pid $$` before `exec`. A held
  conversation exits 75 (`HISTORY_CLAIM_HELD_EXIT_CODE`), and the wrapper stops only on that status: any
  other failure of `fy` (missing binary, a damaged store) prints one warning line and launches anyway, so a
  lease bug can never stop the person's own CLI from starting.
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
- Never the fallback: symlinks (§8.1.1), copies (the hazard in §1), or a central
  refresher injecting `CLAUDE_CODE_OAUTH_TOKEN`.

### 9.6 Installing software from a phone

Installing a tool runs a package manager on the machine, so it is a `fleet.configure` write with the
passkey step-up for any governed caller — the "from a phone it needs a passkey
confirmation" step in §4.3. The command is shown before it runs, comes only from the declared table
(§8.6), takes no free-text argument from the browser, and never runs `sudo`: a manager that needs
admin rights fails and hands the person the command (E2).

### 9.7 Import and clone never move a secret value

The first-run import moves secret-looking setting values into the secret store and leaves a
`${secret:NAME}` reference (E7); the scan route returns key **names** only. Clone copies references; the keys
of API-key logins follow only in a sealed copy no caller can read, and a sign-in never moves (L7, secrets.md). No route, command or log line returns a credential value. `host` credentials are
shown as "Shared with claude in your terminal" so a person knows where the login lives. A pairing
code, QR or token never appears in any wireframe, prototype or capture.

---

## 10. Version 1 is retired

The owner's decision for U21 was to clean up everything and not care about backward compatibility,
because nobody was using the old account system. So the design's earlier migration — credential
moves, conversion rules, a dry run, a compatibility window — was **never built, and the code that
read a version-1 configuration is deleted.**

What happens to a machine whose `config.yaml` is still version 1 (no `version` key, or `version: 1`):

- It is **refused, never converted, never deleted.** The daemon, `fy` and the browser all say the same
  sentence, with the real path: "_path_ uses the old account format, which this Ferretry no longer
  reads. Move it aside (for example rename it to config.yaml.old) and restart the daemon; the first
  run then sets this machine up again from its own Claude Code and Codex."
- It reaches people through the paths that already say "this configuration is unreadable": the
  catalog, setup and credentials refusals, the browser's machine row, and a boot notice. The daemon
  keeps running, and nothing on disk is touched.
- An empty document, or `{}`, has no `version` either, so it is refused the same way.
- Recovery is by hand: move the file aside and restart. The first run (§4.3, run once at boot with
  `store: host`) imports the person's own Claude Code and Codex again. Old homes, credential copies
  and history stay where they were, and nothing reads them.

One tolerance exists. A `config/daemon.json` that still has an `accountModel` key does not stop
boot: the key is dropped and the boot says once that it is no longer read, because the account model
is always on. Delete the key.

---

## 11. Edge cases E1–E32

Exactly as the prototype handles them; open its catalogue and press **Show** on a row to see the
screen.

| ID  | Case                                              | What happens                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1  | Neither harness installed                         | Each CLI step says Not installed, with its install in place: the exact command, a passkey confirmation, **Install**, or **Skip**. Nothing below it is asked until it is installed.                                                                                                         |
| E2  | Install fails (needs admin)                       | "Couldn't install on _machine_": npm needs admin rights and the operator account isn't an admin. Shows `sudo npm install -g …` to run yourself, then **Retry** or **Skip, continue without them**.                                                                                         |
| E3  | Only Claude installed                             | The Codex step is one quiet line, "Codex isn't installed · Install later in Settings", and Continue.                                                                                                                                                                                       |
| E4  | Installed but not signed in                       | Account reads "Not signed in · Your setup can still be imported"; the sign-in panel is inline; the button reads **Import, sign in later**; the credential lands as Needs sign-in with a note.                                                                                              |
| E5  | Signed in, no config                              | "Nothing found"; a plain **Starter** profile with only a model set; "You can add to it later."                                                                                                                                                                                             |
| E6  | Token needs refresh                               | Import anyway; the credential is **Refresh due**; "Ferretry renews it the first time you launch."                                                                                                                                                                                          |
| E7  | Secret-looking values                             | Settings carries "2 secret values · go to the secret store, never shown"; after import the Settings component lists `env.NAME` as "In Ferretry's secret store · never shown".                                                                                                              |
| E8  | MCP command missing                               | The `notes` server is imported with the warning "Command not found: uvx" and a note to install uv on the machine; it starts working once installed.                                                                                                                                        |
| E9  | `CLAUDE.md` and `AGENTS.md` identical / different | Identical: one generic Instructions component, "one shared copy". Different: "Claude instructions" and "Codex instructions", each harness-only.                                                                                                                                            |
| E10 | Skipped everything                                | Done lists Claude Code and Codex as skipped, each with **Set up later** → Runtimes. Runtimes tab: "No runtimes on _machine_ yet" with **Add your first runtime**.                                                                                                                          |
| E11 | Machine goes offline mid-stepper                  | "_machine_ is asleep or offline. Setup is paused. Your progress is kept." **Retry**.                                                                                                                                                                                                       |
| E12 | Add runtime with no credentials                   | The Login part says there are none yet; **+ Add a new login** opens in place (Sign in to Claude Code / Codex, disabled when not installed, or a provider key) and returns it picked.                                                                                                       |
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

## 13. Build plan (as built)

The model was built as 22 file-disjoint units, U0–U21, each one PR (#433–#456, then the U21
retirement PR), in this order. No file belonged to two units, and a route always landed with the
client file that dials it (the route-agreement gate).

| Unit                               | Delivered                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| U0 Seams                           | one barrel line, route registration and composition-root line per later unit                                      |
| U1 Schema                          | the §5.3 schema and validation, reserved environment names, manifest runtime rows                                 |
| U2 Layering                        | flatten, loops, conflicts, applicability, model-set resolution, the fixed layer (pure)                            |
| U3 Credential stores               | store resolution (`host` is `""` for Claude), keychain naming, the Codex canonical file and link                  |
| U4 CI guard                        | §8.5, pinned and latest                                                                                           |
| U5 Component adaptation            | §8.3: per-harness files, link-or-generate, plumbing keys, partial-support table                                   |
| U6 Materialise and wrappers        | one config dir and one wrapper per runtime, the fixed layer as launch arguments, `ids.json`                       |
| U7 Credential status and usage     | the four words, passive and active usage, Check now, `fy statusline`                                              |
| U8 History pool and lease          | the always-on pool and the lease (§9.3)                                                                           |
| U9 Migration                       | the conversion in §10's earlier draft — **deleted again in U21**                                                  |
| U10 Import scan                    | the first-run import of a host's Claude and Codex setup (E4–E9)                                                   |
| U11 Tool install                   | §8.6                                                                                                              |
| U12 Launch policy                  | `fy start --agent <runtime>`; `agent: true` replaces the `-auto-` name match                                      |
| U13 Credential routes and dial     | `/v1/fleet/credentials`, Check now, sign-in by credential id                                                      |
| U14 Catalogue routes and proposals | `/machine`, `/components`, `/profiles`, `/runtimes`, every proposal kind                                          |
| U15 Setup and clone routes         | `/setup/scan`, `/machine/tools/install`, `/export`, the `setup.import` and `clone.import` executors               |
| U16–U19 PWA                        | the Machines shell, Runtimes and Credentials, Profiles and Components, Settings, first run and Clone              |
| U20 CLI                            | §6                                                                                                                |
| U21 Retire and document            | everything the old system served is deleted with its dial; this document and `docs/account-model.md` are the docs |

U21 deleted, rather than deprecated: the old Accounts UI and its client, `mounts/fleet.ts` and the
routes in §7's last paragraph, the version-1 reader, converter and migration code, the boot scaffold
and credential seed, `FleetFirstRunSeeder`, the `accountModel` switch, and the docs
`fleet-defaults`, `fleet-health`, `fleet-sharing`, `fleet-env-profiles`, `harness-discovery` and
`design/credential-seeding`. What those documents said about launching, credentials and layering is
now in this one.

---

## 14. Declared gaps and resolved questions

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
  missing a referenced secret; the build flags it like a missing command (K6).
- **G8 — Several INFERRED harness keys** (Claude trust/onboarding keys, Codex trust override, Codex
  skills directory) are pinned only by the CI guard, not by a read of the source.

### Questions the owner left open, built with the lead's defaults

Each is easy to change later.

- **O1 — Where the surface mounts.** One **Machines** entry in the PWA Settings list (depth 2, linkable
  `#machines/<name>/<tab>`). The old "Daemons → Fleet → Accounts" path is gone.
- **O2 — First run makes agent runtimes.** The first-run runtimes (`claude-default`, `codex-default`)
  are created **with the agent flag on**: running agents is Ferretry's purpose, and the person's own
  `claude` stays their own CLI.
- **O3 — `--disallowed-tools=AskUserQuestion`** belongs to the Claude fixed layer (agent runtimes
  only), but is **per ferret**: an unattended (`auto`) ferret has nobody to answer, so the wrapper
  withholds the tool; an **interactive** ferret has the owner and keeps it, and the PWA shows its
  question as an answerable card. The daemon writes `FY_SESSION_MODE` (`interactive`|`auto`) into the
  ferret's launch environment at creation and the generated wrapper prepends the flag at exec time
  unless it is `interactive` (a launch with no mode is unattended). Codex gates `request_user_input`
  behind `default_mode_request_user_input`, so the same line passes `--enable` for an interactive
  ferret only. **Codex 0.164 exits on that flag unless `--no-daemon` is also passed** ("Cannot use the shared
  background server: This session requires default_mode_request_user_input"); 0.145 rejects `--no-daemon`, so
  the wrapper has to add it only where it is accepted.
- **O4 — Claude "Auto mode"** needs `--permission-mode auto`. If the pinned Claude does not accept it,
  the agent runtime **refuses to launch** with a message naming the fix (switch Agent permissions or
  update Claude). Auto is never silently mapped to a weaker or stronger mode.
- **O5 — Offline edits.** Steppers keep their progress (E11), but no change is queued: a write needs
  the machine awake.
- **O6 — Import again** adds what is new and **offers** (never applies on its own) to update a
  component whose source file changed since the last import.
