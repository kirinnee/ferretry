# Configuration files

A machine's settings are **human-editable YAML files** under `<FY_HOME>/config/`, one per building
block. The files are the source of truth: the app, `fy` and agents are all editors of them, and the daemon
watches the directory, checks every file, and keeps the last good version of a file in effect while a newer
one is broken. This page is the design note; the code is `@ferretry/fleet`'s `config-files/` (pure),
`packages/daemon/src/lib/config-files/` and `packages/protocol/src/lib/config-files.ts` (the layout and the
wire).

## Layout

| File                            | Holds                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `machine.yaml`                  | Agent permissions, the default runtime, what agents may control, Browser mode ([browser-mode.md](browser-mode.md)), Auto-resume after restart (`autoResume`, on by default: ferrets that were running when the host went down are resumed when the daemon boots), conversations (Keep in sync), the advanced block |
| `logins/<id>.yaml`              | one login (a credential): `harness`, `store`, `label`, `env`                                                                                                                                                                                                                                                       |
| `components/<kind>/<name>.yaml` | one component; `<kind>` is `instructions`, `mcp`, `skills`, `settings`, `hooks` or `modelSets`                                                                                                                                                                                                                     |
| `profiles/<name>.yaml`          | `contents:` — components and other profiles, in order; a later entry overrides an earlier one                                                                                                                                                                                                                      |
| `runtimes/<name>.yaml`          | one runtime: `credential`, `profile`, `agent`                                                                                                                                                                                                                                                                      |
| `warden.yaml`                   | the Warden: on, its layers (rules always; Jev and LLM opt-in) and their caps — see [The Warden](#the-warden)                                                                                                                                                                                                       |
| `learning.yaml`                 | lessons: `passiveDefault` for new ferrets, and the scan miner ([learning.md](learning.md))                                                                                                                                                                                                                         |
| `pack.yaml`                     | Pack mode: on/off, who picks a sub-ferret's model (`agent` or `jev`), the sub-ferret `limits`, the start `probe`, Jev's cap ([pack-mode.md](pack-mode.md))                                                                                                                                                         |
| `models-guide.yaml`             | the models guide: use cases and the models that suit each, best first, and its routing guidance; absent means the guide built from the catalogs ([pack-mode.md](pack-mode.md))                                                                                                                                     |
| `voice.yaml`                    | who cleans up dictated text (provider, style, your own prompts, conversation context), and `defaultEngine` — the speech engine (`parakeet` or `browser`) a device uses until it picks its own ([voice.md](voice.md)); transcription always runs on the device                                                      |
| `presets/<id>.yaml`             | a provider preset of this machine's own, or one replacing a built-in ([provider-presets.md](provider-presets.md))                                                                                                                                                                                                  |

Every file Ferretry writes starts with `# yaml-language-server: $schema=…`, pointing at
`config/.schema/<kind>.json`, which the daemon writes from the same zod schemas it checks with
(`fy config schema <kind>` prints one). `config/daemon.json` and `config/routing.json` live in the same
directory and are not configuration files in this sense: they are the daemon's own documents.

`fy config path`, `check`, `schema` and `guide` need no daemon. `status`, `show`, `write` and `confirm` ask it:
`fy config write <file> [--if-match <etag>]` reads the text from stdin and is refused whole unless it checks.

## How a file is read

Each file is checked on its own — YAML syntax, then the raw-secret detector, then its schema — and the
fleet's files are then assembled into one account model and checked together (a profile naming a component
that is not there). Three rules, in order:

1. **Last good wins.** A file that fails a check is reported with its path, line, column and a plain fix
   (`GET /v1/config/status`, `fy config check`, the daemon log, the app's Files panel), and the version the
   daemon accepted before stays in effect. Nothing half-applies. When the fleet does not assemble, every
   fleet change of that round is held back and the machine keeps the fleet it had.
2. **Loosening waits for the owner.** An edit that loosens what the machine may spend or what agents may do
   is HELD and the tighter version stays in effect: a Warden layer that spends switched on (Jev, LLM),
   a cap raised, something it may now do alone, its concurrency raised or its cadence shortened; lesson mining turned on or its caps raised; Pack mode switched on, Jev choosing sub-ferret models, a sub-ferret limit or depth raised; an agent control turned on (Ferretry
   settings included); Agent permissions set to `skip`; dictated text sent to a provider. Tightening always
   applies at once. Deleting a file is an edit to its defaults and is judged the same way. The owner confirms
   a held edit by its etag — at the machine with `fy config confirm <file>`, or in the app with a passkey
   proved for that act (`loosen-config`) — so a confirmation can never put into effect an edit nobody saw.
3. **The daemon's own writes are acknowledged.** A reviewed fleet change, a first-run import, a clone and
   the Warden settings form record the text they write as accepted before writing it, so the owner's own
   act is never held as if somebody else made it.

What is in effect is recorded in the state home (`state/config-accepted.json`), file by file with its text,
so a last good version survives a restart and a confirmed loosening is not asked about again. A missing or
unreadable record reads as empty — every file judged against the defaults — which holds back any loosening
until it is confirmed again.

The watcher reads a fingerprint of the tree (size, modification time and inode per file) when one of the
tree's directories reports a file event, and every 30 seconds anyway for an event the platform lost — once
a second where there are no file events — and loads after a 300 ms quiet period. Every directory is
watched on its own, because a platform watcher that follows a tree misses a file created in a new
directory, and a missed save is a broken file nobody is told about.

Readers that run on a timer — the fleet and credential catalogues, presets, model catalogs, the usage
feed, the Warden — answer from the last load and never scan the directory themselves. A load happens on
their first read, after a file event in the tree (which marks the last load stale at once, before the
watcher's debounce), when the watcher settles on a change, and after this daemon's own writes and
confirmations (a reviewed fleet change loads as soon as it is applied). Decisions about authority still
load first: an agent-control switch, Pack mode's limits, a launch, and judging a reviewed change stale —
so a tightening is in effect the moment it is saved and an edit made just before an apply is never missed.

A link is never followed — not by the daemon, not by `fy config check`. `GET /v1/config/file` returns a
file's text to a caller off the machine, so a link planted in the directory would otherwise read any file
the user can. A link, or a file over 256 KiB, is reported as unreadable and keeps its last good version.

## Secrets never go in a file

A secret lives in the secret store (`fy secret set NAME`) and a file names it as `${secret:NAME}`
([secrets.md](secrets.md)). A file holding anything that looks like a raw key — a known provider prefix
(`sk-`, `sk-ant-`, `sk-or-`, `AKIA…`, `ghp_`, `github_pat_`, `xox…-`, `gsk_`, `csk-`, `AIza…`, `glpat-`)
anywhere, or a high-entropy value under a key ending `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIALS`
— is refused like a file that does not parse, and the issue never repeats the value.

## Editing

Every program that writes a file computes the value it wants and edits the existing text with the `yaml`
package's Document API: only the keys whose value changes are rewritten, a removed key is deleted, a list is
edited item by item, and the owner's comments and key order survive. A default the file leaves out stays
left out.

| Editor                           | How                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| Any text editor                  | edit, then `fy config check`                                                          |
| A script                         | `fy config show <file>` for the etag, then `fy config write <file> --if-match <etag>` |
| The app                          | Settings › a machine › **Files**: status, issues, Open file path, **Edit as YAML**    |
| `fy component\|profile\|login …` | reviewed fleet changes, written into the files                                        |
| An agent                         | the `config_read`, `config_validate` and `config_write` Ferretry tools                |

## Routes

| Route                       | Grant                                                      | Does                                                   |
| --------------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| `GET /v1/config/status`     | `fleet.use`                                                | every file, its state, every issue, every held edit    |
| `GET /v1/config/file?path=` | the file's capability, `use`                               | one file (or the starter a new one begins with) + etag |
| `PUT /v1/config/file`       | the file's capability, `configure`; `If-Match: <etag>`     | write a file that checks; a loosening may be held      |
| `POST /v1/config/confirm`   | the file's capability, `configure`; fresh passkey remotely | confirm one held edit by its etag                      |
| `POST /v1/agent/config`     | the agent's session credential; Ferretry settings on       | the `config.*` tools                                   |

The file's capability is `warden` for `warden.yaml` and `fleet` for everything else. A loosening `PUT` is in
effect at once only for somebody at the machine or a device that proved a passkey for the act; anyone
else's is written and held. An agent never confirms.

## The Warden

`warden.yaml` decides how the supervisor watches every ferret and what it may spend. A flag passes through
**layers**, cheapest first:

| Layer             | Key          | What it does to a flag                                                                   | Spends         |
| ----------------- | ------------ | ---------------------------------------------------------------------------------------- | -------------- |
| Rules             | — (always)   | deterministic checks raise it; shown to you in Insights › Warden › Needs you             | nothing        |
| Jev               | `layers.jev` | Jev looks first: a confident `skip` clears it; anything else is passed on                | Jev            |
| LLM investigation | `layers.llm` | a read-only investigation (an assigned warden), rotated across `accounts`, as kteam does | investigations |

The rules always run while `enabled` is on. Jev and the LLM investigation are switched on independently, and
both are off on a new machine. A flag Jev did not clear — or every flag, with Jev off — goes to an
investigation while `layers.llm` is on, and **to you** while it is off: never to a spend you did not switch on.
Jev is asked once about a flag and remembered for as long as that flag stands in the same status, so a flag
waiting for you is not paid for every sweep.

**Older files.** A `warden.yaml` from before the layers says `triage:`. It is still read: `rules` is both
layers off, `llm` is `layers.llm` alone, and `jev` is both on (Jev in front of an investigation). An explicit
`layers:` wins over it field by field, and the next write leaves `triage` out.

**Jev is only a guard.** Its whole answer is `skip` or `investigate`. A skip below `guard.threshold`
(0.70–0.95, default 0.85) counts as investigate, and so does every failure — no key, a timeout, a refusal, an
answer it cannot read — so an unsure or broken guard costs money or your attention and never hides a stuck
ferret. Jev never acts on a ferret. Without a Jev key every flag is passed on.

**What leaves the machine.** With Jev on, a short summary of the flagged ferret — the anomaly, the sweep's
one sentence, its recent transcript lines and the tail of its screen — is sent to TypeSafe AI (Jev). Every
string in it passes the vault redactor first, the same one every operator read uses, and a snapshot that
cannot be redacted is never sent (that flag is passed on instead). The Jev key itself is spent only
through the outbound holder ([docs/secrets.md](secrets.md)); `guard.endpoint` cannot move it to another host.
Investigations run on your own login and read the transcript, pane, diffs and CI. The rules send nothing.

**Only an investigation acts.** Its explicit `Verdict:` line is what acts — never prose — and only as far as
`mayActAlone` allows: `nudge`, `resume`, `restart` and `failover` default on, **`stop` defaults off**.
`restart` relaunches a dead or frozen process with its conversation intact — the resume path, replacing a
pane that still looks alive — when the report recommends `RESTART`; a file that names `resume` but not
`restart` gives `restart` the same answer. An act it may not
do alone is held and listed under Needs you for you to decide. Every act and every Jev skip is listed under
Recent actions with who decided it.

**Which login investigates.** `accounts` is the order of logins, head first, and `failover.policy` says how
they share the work: `fallback` uses the first and moves on only when it is unhealthy, `round_robin` takes
turns — across logins on different providers too. A login that fails to start an investigation hands it to
the next one within the same sweep (at most three tries), and each failure still counts against its login.
Ferretry compiles no login in: a file that leaves `accounts` out (or sets it to `[]`) runs investigations on
this machine's **default runtime** — whatever `machine.yaml` names when the investigation starts — and never
writes that name back, so changing the default moves the Warden with it. A machine with neither has **no
investigation login**: the LLM layer is off, the status says `no_login`, and Settings › Warden asks you to
choose one (Jev needs no login). A login named here that this machine does not have — a `warden.yaml` copied
from another machine — is shown as **unknown login '‹name›' — choose one** and is skipped; the file is never
rewritten to hide it.

**Caps, per UTC day, per layer.** `caps.jevUsdPerDay` (default $0.50) is Jev's and
`caps.investigationUsdPerDay` (default $2) the investigations'; `caps.maxInvestigationsPerHour` (default 6)
spaces investigations. A cap that is reached turns off **only its own layer** until midnight UTC — with the
Jev cap hit, flags go straight to an investigation; with the investigation cap hit, Jev still clears what it
can and the rest wait for you — and the Warden page says so. Jev is priced at
`guard.usdPerMillionInputTokens` (published prices disagree, so it is a setting). An investigation is
priced from its own transcript once analytics has read it; until then it counts at the average priced
investigation, for the cap only. The status's savings line — skips × that average, minus Jev's own cost —
appears only once an investigation has been priced.

**A cleared flag stays quiet, longer each time.** When Jev or an investigation clears a flag, that kind of
anomaly on that ferret is left alone for `blessMinutes` (default 15). Each consecutive re-clear of the same
kind on the same ferret doubles it — 15, 30, 60, 120 — up to **4 hours**. The run starts again when the
ferret changes status (which also ends the quiet at once), or when the flag stops being raised. A different
kind of trouble on the same ferret is never covered.

**Leave it longer.** On a flagged or cleared ferret, Insights › Warden offers _Leave it longer_: an hour,
four, or until its status changes (at most a week). It covers the kinds flagged or cleared there now, never
shortens a quiet stretch already in force, takes the ferret out of the investigation queue, and counts into
no streak. It is `POST /v1/warden/leave {sessionId, duration}` — `warden.configure`, because it switches the
Warden's supervision of that ferret off for a while ([grants.md](grants.md)).

**The liveness check.** Every 30 s the Warden looks at each working ferret — a digest of its screen and
of its transcript tail, the work counters its harness paints, and whether its pane has a live subprocess —
and keeps a per-ferret ledger of when each last moved. That ledger is what the long-think and
long-command rules (`susThinkingSeconds`, `susSubprocessSeconds`) read, and a working ferret it has not been
able to see for three ticks is flagged `dead_monitor`. A ferret with no sign of life of any kind for its
`nudgeAfterSeconds` (default 300) is nudged once — only while `mayActAlone.nudge` is on — and one with no
transcript, counter or subprocess sign for its `killAfterSeconds` (default 900; read as "frozen", since the
Warden never kills) after that is flagged **frozen**: a restart candidate that goes through the layers like
any other flag. A ferret parked with `signal waiting`, an interactive ferret, or a tick that ran late on a
starved host is never nudged or flagged. The ledger is kept in memory: a restarted daemon starts every
clock again rather than judging silence it did not see.

**When it sweeps.** Every `intervalMinutes` (1, 2, 5, 10 or 15; default 2), and also soon after a turn ends,
a question is waiting or a pane dies (`events.turnEnd`, `events.question`, `events.paneDied`), at most one
extra sweep a minute.

```yaml
# yaml-language-server: $schema=.schema/warden.json
enabled: true
layers: { jev: true, llm: true }
guard: { threshold: 0.85 }
caps: { jevUsdPerDay: 0.5, investigationUsdPerDay: 2 }
mayActAlone: { stop: false }
investigation: { effort: low }
failover: { policy: round_robin }
blessMinutes: 15
accounts:
  - agent: claude-default
    model: claude-haiku-5-5
  - agent: codex-default
```

`POST /v1/warden/investigate {sessionId, note?}` is the owner asking for an investigation: it skips Jev
and the blessing, joins the queue ahead of the sweep's own flags, and still waits for a slot and counts
against today's cap — even with the LLM layer off, because the owner asked. `GET /v1/warden/attention` is
the Needs-you feed: the session attention boards, the verdicts that ask for you, the flags nothing has
cleared and the acts held for you.

## Copy and Export

Because the files are the settings, moving settings between machines is moving files — minus secrets, which
no file holds and no route returns.

- **Copy settings from another machine** (Settings › a machine › Machine › Setup, and New machine setup's
  _Start from_ step) runs in the browser, which holds both pairings. It reads `warden.yaml`, `learning.yaml`
  and `voice.yaml` from the source with `GET /v1/config/file` and writes each here with `PUT /v1/config/file`
  against this machine's current etag, so the loosening rule applies exactly as to any other editor: a copied
  file that loosens (a Warden that turns on the Jev guard) is written and **held** until the owner confirms
  it. Profiles, components, runtimes and logins travel as the reviewed `clone.import` change, and agent
  controls and the default runtime as one `machine.settings` change — `machine.yaml` is not copied whole,
  because its `advanced` block names this machine's own paths. Before anything is written the preview lists
  every secret and sign-in the copied settings need (`${secret:NAME}` references, the Jev, Groq or Cerebras key
  a copied Warden or voice setting spends, a login that arrives empty), each marked when this machine already
  holds it, with a field to store it through `POST /v1/secrets`. The keys of the copied API-key logins and
  settings are not left to that field: they travel sealed, for one passkey on the source, in the same Copy
  ([secrets.md](secrets.md#sign-ins-are-not-copied-api-keys-are)); a sign-in never does.
- **Export settings** zips every file `GET /v1/config/status` lists, read one by one, under `config/`. A file
  the daemon refused is **left out and named**: a pasted key is exactly what makes a file invalid, and an
  invalid file is still on disk as typed.

## Agents

"What agents may control › **Ferretry settings**" decides whether an agent may use the `config.*` tools. It
is **off by default**, and turning it on from another device needs a passkey like the other controls. It is a
kill switch, not a boundary: an agent with plain file access can edit the files too. The real guard is rule
2 — an agent's loosening waits for the owner either way.

The built-in **Set up Ferretry** skill teaches any agent the layout, the schemas, the commands and the rules.
Every agent runtime's system prompt carries its short form (where the files are, no secret values,
`fy config check` after every edit, a loosening waits for the owner) and points at `fy config guide`, which
prints the whole skill as a `SKILL.md` to drop into any skills directory.

## Live changes

An open app never needs a reload to see a change made somewhere else. The daemon counts every change to
what a screen shows as configuration, from **any** source, and tells every open app which kinds moved:

| Source                                                                      | How the daemon notices                                                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A hand edit, `fy`, an agent, the app, another device                        | the next load finds a file different (the watcher loads within about a second of a save) |
| A reviewed fleet change applied                                             | its apply route, at once                                                                 |
| Check now, a speed-up key or test, a secret, a tool install, an MCP sign-in | the route that made it (`ANNOUNCED_ROUTES`)                                              |
| A harness sign-in finishing in the background                               | the sign-in flow completing                                                              |

`GET /v1/events?topic=config` (a WebSocket, like the session feed) sends where the revision stands first, then
one frame per change: `{ kind: "config", epoch, revision, kinds }`, `kinds` drawn from `files`, `machine`,
`credentials`, `components`, `profiles`, `runtimes`, `speedups`, `warden`, `learning`, `voice`, `presets`.
Announcements within 100 ms are merged into one revision. A quiet stream sends an `idle` proof every thirty
seconds. The frame carries kinds and a counter, never a value from a file.

The app keeps one stream for the machine on screen and re-reads only the screens whose kinds moved, keeping
what is shown until the new answer lands; an unsaved edit in a form or the file editor is kept. Nothing is read
on a timer. The revision is per boot (`epoch`), and it is how the app learns what it missed: the stream reopens
whenever the app returns to the foreground or the network comes back, and if the first frame's revision moved —
or names another boot — every screen reads again.

## Declared gaps

- The fleet's own files apply as written; a component or profile change is not judged for loosening,
  because it changes what an agent runs with, which every editor may already change.
- A reviewed change in the app is made against the configuration IN EFFECT. If `machine.yaml` holds a
  loosening that is waiting, a change saved from the app rewrites that file from the version in effect,
  which drops the waiting edit — confirm or revert it first.
- There is no back-compat: a `fleet/config.yaml` is refused by sentence ([account-model.md](account-model.md)).
- Live changes ([above](#live-changes)) cover the screens that show configuration. The session page's
  "This folder" rail reads its MCP sign-ins when it opens, not when one changes elsewhere.
- A login's status that moves on its own — a token refreshed or expired by the harness, with no route
  or sign-in in between — is not announced; it shows at the next read or Check now.
