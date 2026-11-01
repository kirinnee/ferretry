# Secure copy: moving a value the agent never sees

An agent often has to move a value from one place to another: click "Create token" on one site and put the
token into another site's settings, or run `gh auth token` and paste the result into a prompt. Doing that
through the agent puts the value in its context, its transcript and every log of the turn. **Secure copy**
lets the agent move the value **by name**:

1. The agent asks the **daemon** to capture a value: a page element, the page's clipboard after the page's
   own Copy button, or what a command prints.
2. The daemon reads it into memory under a handle, `sealed:<name>`, and tells the agent only facts about it.
3. From that moment the value is **masked** wherever the daemon scrubs text.
4. To use it, the agent pastes the handle into a destination. A paste always needs the owner's approval,
   unless the owner approved that route in advance.

The wire contract is `packages/protocol/src/lib/secure-copy.ts`. This page says what it means and what it
does not promise. It extends [input requests](input-requests.md) (a paste **is** an input request whose
value comes from a handle) and [secrets](secrets.md) ("use, never read").

## What the agent is told

Everything an agent ever learns about a copy is `CopyMeta`:

| Field                     | Meaning                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `handle`, `name`          | `sealed:vercel_token`, the name the agent chose                                         |
| `from`                    | Where the daemon read it: the program's base name, or the page's origin (`https://…`)   |
| `length`, `lines`         | How many characters, and how many lines. A count only: never a prefix, digest or class. |
| `capturedAt`, `expiresAt` | When it was read, and when the daemon lets go of it                                     |
| `state`                   | `live`, `discarded` or `expired`                                                        |
| `exposure`                | Whether the agent may already have seen it (below)                                      |
| `uses`                    | How many times it has been pasted                                                       |

A command copy also reports how the command ended (`exited` with its code, `timeout`, `spawn_failed`) and its
**stderr**, with the would-be value masked, then put through the vault redactor, and cut to 2,048
characters. A vault that cannot be opened withholds stderr. Stderr that holds any piece of the value (six characters or more
in a row, or all of a shorter one) is withheld whole, because masking only recognises the whole value. **Stdout is never returned.** No schema here has
a field for the value; a protocol test walks every schema to keep it that way.

## Capturing

| Source      | What the daemon does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | State |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `command`   | Runs `argv` with **no shell**, in the session's folder (or `cwd`), through the secret store's child runner: an allowlisted environment (no admin token, none of the daemon's own secrets), stdin closed, a timeout (30 s, 60 s at most) and a byte cap. Stdout, trimmed unless `trim: false`, is the value.                                                                                                                                                                                                                                                                                                                                          | live  |
| `browser`   | Reads one element of a page the agent opened or was handed (not one taken over), by `ref` or `selector`, in the page's own queue: its text, a field's value or one attribute. White space around it is dropped. Its origin is the FRAME's the element is in, and the browser names the document it was read from (a page that navigated mid-read copies nothing). Inside the queue it is checked like a page read first (a takeover, a pending value, the owner's hold refuse it), and masked and held before the queue moves on. A field's value, or the text of an element anyone may edit (`contenteditable`), is `editable`: no rule matches it. | live  |
| `clipboard` | Reads the agent browser's clipboard for that page's origin, after the agent pressed the page's own Copy button. Never this computer's system clipboard, so only in a headless browser.                                                                                                                                                                                                                                                                                                                                                                                                                                                               | SC3c  |

A capture is refused, and nothing is held, when the command fails, times out, prints nothing, prints fewer
than 4 characters (too short to mask without masking it everywhere by chance), or prints more than 16 KiB on
stdout (stderr's size does not count); or when the element is not on the page, holds nothing, or holds fewer
than 4 characters or more than 16 KiB. Capturing needs no approval: the agent could run the command or read the page itself. The
tools are an AGENT's: a person's terminal and browser tool routes refuse every `secure.*` call, so a device granted only
the browser can never reach a command through them.
Capturing **instead** keeps the value out of its context. It does need the "What agents may control"
switch for what it reads: `terminal` for a command, `browser` for a page.

Limits per session: 10 live copies, 20 capture attempts an hour (failed ones count), one live copy per
name. A copy lives one hour by default and four at most.

## Lifetime

- **RAM only.** A copy is never written to disk, the journal, the audit log or a push payload.
- It ends when it **expires**, when the agent **discards** it (`secure.discard`), or when its **session
  ends**. A **daemon restart forgets every copy**; the agent is told there is no such copy.
- An ended copy stays listed, without its value, for 10 minutes, so the agent can tell "discarded" from
  "never existed".
- "Save to the secret store as NAME" is a paste destination (see [Into the secret store](#into-the-secret-store)):
  the copy outlives its hour there, encrypted, used by name and never read back.

## Hiding

From the moment it is read, before anything else is awaited, a copy is held in the daemon's one masking
registry (`EphemeralValues`, the one the input bridge uses) as `[sealed:<name>]`, in every spelling a reader may
meet it in (as read, and without its surrounding white space), until it expires **plus 10 minutes** (it may
still be on a screen it was pasted to). A session that ends lets go of its copies at once, and their masks
run the 10 minutes from then. That masks it in:

- the agent's `terminal.read` and `terminal.wait`, and the live terminal viewer;
- the owner's screen, transcript, journal and process reads;
- a command copy's own stderr;
- a page read, as the page snapshot lays it out: the value's white space collapsed, each of its lines long enough
  to mask on its own (a list of recovery codes, a key's lines), and each escaped as a JSON or YAML string would. A
  page result passes the mask once more as it leaves, so a read that ran while a copy sealed is masked too.

- **The page a copy was read from is not pictured** while it still shows that document: `browser.screenshot`,
  `browser.pdf` and `browser.highlight` are refused there (no mask can be drawn on pixels), through the same page
  gate as the input bridge's holds, checked before the act, inside the page's queue and after it. Its text stays
  readable, masked as `[sealed:<name>]`, so the agent can still find "Done" by its ref. Navigating away (or the
  copy's mask ending) lifts it. A page whose document cannot be told is treated as still showing it.
- A screenshot of ANOTHER page that shows a held value is the next phase (SC3c): it will be **withheld**, not
  pixel-masked. **GAP until then:** a page can draw the value where masking cannot see it (a canvas, an image),
  another page that shows it can be pictured, and reloading the source page (a new document) lifts its hold while
  it may show the value again.
- **GAP: page scripts.** With scripts on, the agent can write any text into a page with `browser.eval`, so a rule
  for a page's origin trusts what that page shows, which the agent may have put there. A field's value is never
  matched by a rule for that reason, nor editable text; other text is, so keep page scripts off where a rule names a
  page. Text a page REFLECTS (a preview echoing what was typed elsewhere) is not detected either.

### A value the agent had already seen

Masking cannot take back what the agent already read. So a capture says, honestly:

- **`exposure.transcript`**: the daemon searches the end (32 MiB) of the session's own transcript file for
  the value, as it is and as JSON escapes it. `found` means it is in the agent's context and **is not
  protected**: the agent is told so in plain words and should tell the owner to rotate it. `clean` means
  it was not found in what was read; `unknown` means the transcript could not be read.
- **`exposure.pageReadBeforeCapture`**: the agent read, screenshotted or evaluated that very document of the
  page before the copy, so the value may be in its context already. The daemon records the document INSIDE the
  page's queue, before each such act (whether it then succeeds or not), and the copy asks after its own read, so
  a read queued ahead of the copy counts.

The agent instruction teaches the rule that makes this work: **capture before you read**.

## Pasting

`secure.paste` names a handle and where it goes: a terminal the agent opened, one field on a page the agent
opened (`{ kind: "browser", name, ref | selector }`), or the secret store. The daemon raises an **input request** whose
value comes from the copy (`InputRaise.source`), so the card, the daemon-observed destination facts,
`observedDigest`, the single guarded write, the quarantine and the audit are all the input bridge's own
([input requests](input-requests.md)):

- **A paste is always a `secret`**, whatever the agent said, and its card says what is pasted and where it
  came from: "Allow pasting sealed:vercel (40 characters from gh) into the terminal. You type nothing."
- **The owner allows it; there is nothing to type.** The deliver body is `{ sealed: true }`: it names no copy
  and no value, and the daemon pastes the copy the REQUEST names. A typed value or a saved login on a paste
  card is refused, and so is `sealed` on an ordinary card. `fy input answer !A7` allows it at the machine
  (no prompt, so it also works from a pipe); the app's card shows **Allow paste** and no field.
- **The copy is opened once, at the write**, after every check that can refuse without typing. A copy that
  was discarded or expired since the card was raised ends the request as `copy_gone`, with nothing typed;
  so does a paste still waiting when the daemon restarts, because a restart forgets every copy. A copy with
  a line break or a control character is refused for a terminal ("this would press keys").
- **Risk flag**: as for any terminal secret, and never green when the ferret had already seen the value
  ("The ferret saw this value before it was sealed, so it is not protected; consider rotating it.").
- **Into a page field** it is one field of the input bridge's page request: the card says "into a field on
  <host>", the daemon observes the field and the page's origin, the write is the bridge's own guarded one, and
  the page is held afterwards like any typed secret (pictures refused while held). It needs the `browser`
  switch, as any page tool does, and allowing it from a device needs `browser.use` too. A rule for
  `browser:<origin>` names the TOP page, so it pastes unasked only where the card would be green for every field:
  a visible, uncovered password field of that page itself (not a frame from another site), on https, with no
  challenge showing. Anything the card would flag waits for the owner.
  **GAP:** once the page's hold ends, a page script (`browser.eval`, with scripts on) can read the field's value,
  so a page paste shares the value with whatever the page runs; a rule for a page is that trust, given ahead.
- **Audit**: `input.delivered` with `source: sealed` and the copy's name, never the value.

### Into the secret store

`secure.paste` with `to: { kind: "secret", name: "VERCEL_TOKEN" }` saves the copy as that secret
([secrets](secrets.md)), so a minted token outlives the copy and the ferret uses it as `${secret:VERCEL_TOKEN}`
without ever reading it. It is the same input request, with the store as the destination:

- **Only a paste writes the store.** An ordinary input request naming the store is refused: the owner adds
  other secrets in Settings or with `fy secret set`.
- **The daemon observes the store, never a value**: the name and whether it exists. A new name is green; an
  existing one is amber ("This replaces the value the secret holds now; the old value is gone for good.").
  If the name appeared or went between the card and the write, the write is refused as `target_changed`
  and nothing is stored. The check and the write are one turn of the store's own, which every writer shares
  (the secrets routes, an import, an MCP sign-in refresh), so nothing lands between them and no write is lost.
  A full or unreadable store refuses before writing, so nothing is uncertain and a rule's use is given back.
- **It needs the secrets grant too.** Allowing a store paste, adding a `secret:` rule and approving a plan
  item into the store are `terminal` routes, but they change the store, so a governed device also needs
  `secrets.configure` (or its passkey confirmation), exactly as `POST /v1/secrets` does
  ([grants](grants.md)). A device paired without it cannot overwrite a secret by allowing a paste instead.
- **Nothing is shown**, so there is no quarantine, and a rule naming the exact NAME pastes unasked, but only
  to ADD that secret: replacing a value the store holds now always waits for the owner.
- **Audit**: `input.delivered` as for any paste, and `secrets.changed` with the name, `paste` or
  `paste-replace`, the request and the rule if one allowed it; never the value. A write that was cut off is
  kept as `paste-uncertain` (outcome `failed`), because the store may hold the copy now.
- **GAP: a replaced value stops being masked.** The live redactor masks what the store holds, so after a paste
  replaces a secret the OLD value (often still valid after minting a new token) is no longer masked in old
  scrollback. Revoke the old credential when you replace it.
- **A paste is the only way a ferret writes the store.** The secrets routes (`POST /v1/secrets`,
  `DELETE /v1/secrets/:name`, saved logins, copy-in and copy-out) refuse a ferret outright, so `fy secret set`
  from inside a ferret is answered with a sentence pointing here, and the owner's card is the only way in.
  The owner's own `fy` at a shell and the app's secret form are not refused. The refusal reads the caller
  the daemon derived, so it holds against an honest or confused agent; one that forges its identity is the
  per-session token work, separately ([secrets](secrets.md) threat model).

### Approving in advance

On screen: Settings › this machine › **Secure copy** › Pastes approved in advance.

- **A rule** allows pastes from a source (`command:<program>`, `browser:<origin>`, `clipboard:<origin>`) to
  a destination (`terminal:<program>`, `browser:<origin>`, `secret:<NAME>`), for one session or any, with an
  optional expiry and count. Only the owner adds or removes one (`fy copy rules add|rm`, `POST|DELETE
/v1/copy-rules`): the route refuses an agent before it reads a body and the service refuses again. Adding
  one demands `terminal.configure`, so a remote device follows "ask again for each change"; each add, removal
  and plan answer is kept in the security log as `security.changed`.
- **Matching** runs on what the DAEMON observed: the program the copy was captured from, and the program
  reading the terminal as the KERNEL proves it (`program` in the card's facts: the one program every process of the
  terminal's foreground group runs, in line mode: [who reads the terminal](input-requests.md#who-reads-the-terminal)). The name
  `ps` or tmux shows is never enough: a ferret's shell can call itself `vercel` (`printf vercel > /proc/$/comm`),
  so a terminal whose program is not proved matches no rule and the owner is asked. A match
  pastes at once, still as one guarded write, with the card raised and closed so it shows in the log, and the
  audit actor is the rule. A rule's use is taken synchronously, so two pastes can never both spend its last
  use. A write that typed nothing gives the use back and leaves the card for the owner; a write that may have
  typed (uncertain) spends it. A use is recorded in memory even when the rules file cannot be written.
- **Only where typing is hidden.** Nobody sees the card of a pre-approved paste, so a rule pastes unasked only
  into a terminal with echo off (or a page's password field). Anywhere the value would show on screen, the card
  waits for the owner even under a matching rule.
- **Never a copy the ferret saw.** A copy whose value was already in the ferret's transcript is not protected,
  so its paste always waits for the owner, whose card says so.
- **A program run by its path never matches.** A rule names a bare program (`gh`), the one the daemon's PATH
  finds. A copy captured from `./gh` or `/tmp/x/gh` keeps that path as its source, because it may be a file the
  ferret made to print a value of its choosing, so no rule matches it and the owner is asked.
- **The card names the file that printed it.** The child runner finds the program once, on the command's own
  PATH, runs that very file, and the copy records its path (`from.path`), so the card, `fy input answer` and
  `fy copy ls` show WHICH `gh` printed the value: `/usr/bin/gh`, or one in `~/.local/bin` the ferret could
  have written. A program given by a path is walked on the disk itself, every `..` and symlink as the kernel takes
  them, so neither a symlinked folder nor a link inside the path can point it at another file. A rule matches the
  bare name only for a program the daemon found AND that this account cannot change. It is `replaceable` (and every
  paste of it asks the owner, whose card shows the path) when any part of its path, or of the real file behind it,
  up to `/`, is OWNED by the account the daemon and every ferret run as, or is a folder anyone may write without the
  sticky bit. Ownership, not permission bits: an owner can `chmod` its way back in. EVERY hop is checked: the path is
  walked one part at a time as the kernel walks it, so a root-owned link that points through a link the account
  owns (`/usr/bin/gh` → `~/link` → anywhere) is replaceable too. A file in the **Nix store** is root-owned whoever
  put it there (any user can `nix-store --add` a shell copy named `<hash>-gh/bin/gh`), so a store file counts only
  when a root-controlled bin folder leads to it: `<folder>/gh` walks to that very file, for a folder of
  `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, `/usr/local/bin`, `/run/current-system/sw/bin`,
  `/nix/var/nix/profiles/default/bin` or `/etc/profiles/per-user/<account>/bin` (the per-user profile a nix-darwin or
  NixOS activation builds as root), each itself passing the same walk. So a rule auto-pastes only from system
  programs (`/usr/bin/gh`, a system profile's `gh`); anything under `$HOME`, a `~/.nix-profile` link included, or a
  store path named directly, always asks.
  A rule names a program, not what it runs: `gh` (its aliases and extensions), `env`, `node` or `op run` can run
  anything, and a rule for one matches whatever arguments the ferret gives it.
- **The secret store is never written by a rule** unless that rule names the exact secret NAME: `secret:<NAME>`
  has no pattern and no wildcard, so a rule for `VERCEL_TOKEN` never writes `VERCEL_TOKEN_2`.
- **A plan**: `secure.preapprove` raises ONE card listing the pastes the agent plans, each with its route and
  the agent's reason (shown as its words). The owner allows some or all with `fy plan approve <id> 1 3`
  (`fy copy plan approve` is the same command; none declines), or ticks them on the card, a permission card whose own Allow and Decline answer it (the
  generic agenda answer is refused). Each allowed item becomes a rule for that session allowing one paste until
  the plan's expiry, which the card states (two hours by default, a day at most: a longer route is the owner's to add as a
  rule). Two answers arriving together make the rules once. Closing the card approves nothing. A paste plan is now a
  [task plan](#task-plans) of paste lines only, answered the same way.
- **A plan's rules live in memory only.** They are kept apart from the owner's own rules, never written to the rules
  file, and end with their plan: at its expiry, when it is revoked, and when its session ends. A restart forgets them,
  so those pastes ask again. Plan rules a store from before this change still holds are dropped when the daemon reads it.
  The owner's rules and the plans' pastes share one cap of 50, so the rules listing always fits.
- **The rules file** (`<state>/secure-copy/rules.json`) holds the owner's own rules (made in Settings or with
  `fy copy rules`) and the profile-targets setting: routes, counts and one switch, never a value. These stay on disk
  across a restart. One that cannot be read is NO rules: every paste then asks the owner.

### Task plans

> **Not filling yet.** The daemon raises, resolves, stages, approves and revokes plans
> (`packages/daemon/src/lib/task-plans/`), and an approved paste line pastes as a rule did. An approved sign-in line
> is pinned and kept, and the shared matcher that fills under it is built
> ([input requests › Task plan fills](input-requests.md#task-plan-fills-a-sign-in-the-owner-approved-in-advance)), but
> it fills only while the daemon reports `task-plan.1`, and no daemon reports it until the app draws the plan card
> (R3a-5). The agent tool `task_plan` is listed in MCP and the owner answers with `fy plan` (R3a-3);
> `secure.preapprove` still raises paste-only task plans.

A task plan widens the paste plan. One card holds up to 10 lines, each with 1–5 uses (1 by default), for 2 hours
by default (5 minutes to 1 day). A line is one of three kinds:

- a **sign-in** (`kind: sign-in`): Ferretry types an account's username and password on a page, and a code only
  with its own tick;
- a **terminal sign-in** (`kind: terminal-sign-in`): the account's password typed into `sudo`, `su` or `doas`.
  Other programs read their environment and config files, which the ferret controls, so Ferretry can't prove where
  they send the password. A line for one is `unavailable` (`tool-not-covered`);
- a **paste** (`kind: paste`): today's planned paste.

The rules the contract fixes:

- **A line names only what the owner saved.** That is a sign-in id (`si_…`), or a host or `tool@host` the owner
  already saved, as a lookup key. A line never carries an origin, a URL, a program path or a value. Two lines for
  one sign-in are refused. The daemon resolves each line against Accounts and draws the card from what it found.
- **The owner only narrows.** They tick lines and pick one of the daemon's candidate accounts (needed when there
  are two or more). They tick codes only where the ferret asked for them and the account can make them. They can't
  raise uses, lengthen the plan or add a field (`taskPlanSelection`). One account can be ticked on only one line, even when one
  line named it and another reached it through a site picker; otherwise their uses would add up.
- **Any ticked sign-in line needs a passkey, at the machine too.** The act is `approve-task-plan`, asked of every
  caller. Its proof is bound to `taskPlanApprovalSubject(stage, canonical)`:
  `sha256("ferretry.task-plan.v1\0" + stage + "\0" + sha256(canonical))`. `canonical` is the RFC 8785 JSON of the
  plan id, its session, its expiry and every ticked line with its pins: the account's immutable key, the login
  domains (or `tool@host`), the recipe version and the field identities with history. A change to any one of them
  changes the subject. A plan record with an approved sign-in line and no passkey answer, or a passkey answer from
  the machine itself, doesn't parse. Whatever the daemon resolved, the bytes bind a page line only to web hosts and a
  terminal line only to `sudo`, `su` or `doas`. A selection of paste lines only keeps the paste plan's rule.
- **The ferret learns nothing about secret fields.** Its view (`taskPlanAgentView`) has each line's state, the
  picked account's name and uses left. It has no `can`, `history`, flags, reasons or code tick. When a plan doesn't
  fill a card, the ferret gets one sentence for every reason. The owner's card gets the reason as a fixed sentence
  (`grantMissLine`).
- **The old tool keeps working.** `secure.preapprove { items }` reads as a task plan of one-use paste lines
  (`taskPlanCallOf`). Its answer is projected back to the old plan shape (`copyPlanOf`). An old item number is
  never a line number: `taskPlanLineOfCopyItem` maps it back, so "approve item 0" can't land on a sign-in line.
- **The app ships first.** An input card a plan fills carries a `plan` actor and a `preapproval` note, and an
  older app's strict parse refuses them. So `task-plan.1` stays unreported until the app draws the plan card.

#### How a plan is raised and answered

- **Raised by the ferret, drawn by the daemon.** `TaskPlanService.propose` takes the call's lines and expiry and
  nothing else: no page, no terminal, no facts. Each line is resolved against Accounts: a named sign-in is that one
  account ("Ferret chose this"); a site or `tool@host` lists every password sign-in saved for it (at most 8), with
  the owner's own default for the project, folder or site preselected (never the ferret's hint) or nothing. A line is
  `unavailable` when it is not in Accounts, signs in through a provider ("ClickUp via Google"), or is a terminal tool
  other than `sudo`, `su` or `doas`. Two lines that resolve to one sign-in, or a sign-in of the other kind, are
  refused with no card. The ferret's reason is masked by the vault redactor before it is kept, shown or audited.
  At most 3 plans wait and 3 are in force per session, and a session raises at most 6 an hour. A proposal takes its
  place against these caps before it awaits anything, so proposals sent together can't all pass; a refused one gives
  its place back.
- **One card, raised only by the daemon.** The card carries the `taskPlan` ref (and the paste-plan ref when the plan
  has paste lines, so an older app answers those as it always did). A ferret's agenda add has no field for either,
  and the agenda refuses a plain answer to the card (`use_input_form`): only the plan routes answer it. Every card
  says: "Ferrets here can read Ferretry's own files, so this stops misuse through their tools and page text, not a
  ferret that goes around Ferretry."
- **Stage, passkey, commit.** `POST /v1/sessions/:sid/task-plans/:pid/approval` with the ticks and picks. Nothing
  ticked declines the plan; paste lines only are approved at once, with no passkey. Any ticked sign-in line is
  STAGED (`201`, `{ stage: "tps_…", summary, expiresAt }`): the daemon snapshots its pins from Accounts now (a
  sign-in removed, moved to another account or with other login domains than the card showed is refused) and holds
  the canonical bytes for 2 minutes. One stage per plan: a new one drops the old. The app runs the passkey for
  `approve-task-plan` with the stage as its subject (`POST /v1/step-up/options` binds the challenge to that
  stage's subject; an unknown or finished stage is `404 stage_not_found`), then sends
  `POST …/approval/:stage/commit`. The commit takes only a fresh proof for that act bound to THAT stage's subject,
  once; without one it answers the ordinary step-up demand. It never reads the grants, an unlock or
  `stepUpOnActions`, so the machine's token can never commit a sign-in line. All or nothing: the plan's paste rules
  and its sign-in grants are made together, or the plan stays pending. No device with a passkey: `409
passkey_required` ("Add a passkey in Settings › Security first"); paste lines can still be approved alone.
- **At the machine.** `fy` stages the same way, then `POST …/approval/:stage/confirm-in-app` shows the selection on
  the plan's OWN card (`machineStage`) for the passkey in the app; no second card is raised. Only a stage the machine
  made can be shown this way, so "Asked at the machine" is always true; a paired device commits its own stage directly. `GET …/approval/:stage`
  answers `waiting`, `approved`, `denied` or `expired`. The machine reads and drops only the stages it made; a
  paired device, where the passkey lives, answers any. `DELETE …/approval/:stage` drops one, approving nothing.
- **Revoke, one tap, no passkey.** `POST …/task-plans/:pid/revoke` with `{ lines }` ends those lines, or every line
  with none; a plan still waiting is declined whole. Its pastes and grants go at once. A plan also ends at its
  expiry and when its session ends, its card closed. Plans live in RAM: a restart forgets them, their pastes and
  their grants. No route edits a plan; more lines are a new plan.
- **Owner only, twice.** Every plan route is `caller: 'person'`, so a ferret's session credential is refused
  `owner_only` before a body is read; the service refuses an agent caller again. `GET /v1/task-plans` and
  `GET …/task-plans/:pid` are the owner's reads. A plan names your accounts (labels, usernames, places), so every
  route that answers a plan or a stage's summary also needs `secrets.use`, as `GET /v1/accounts` does.
- **The kept paste-plan routes** answer from task plans: `GET /v1/copy-plans` lists the waiting plans with paste
  lines, as paste plans of those lines only, and `POST …/copy-plans/:pid/approve { items }` reads each item through
  `taskPlanLineOfCopyItem`. An item a plan doesn't have is `400`; a sign-in line can never be ticked this way.
- **Audit, never a value.** The service writes `security.changed` itself: `task-plan-raised` (one record per line:
  its kind, uses, sign-in or route and the masked reason), `task-plan-answered` (who, the proof, the expiry, the lines
  allowed and declined), `task-plan-line-approved` (one per allowed line: the sign-in, account, fields and uses) and
  `task-plan-ended` (`revoked`, `expired` or `session-ended`). A restart writes nothing.

## Programs in your own profile

Settings › Secure copy › "Copy rules may target programs in my own profile" (`allowProfileTargets`, owner decision
!A182). **Off** unless you turn it on.

- **The risk, plainly:** every process running as you, so every ferret, can change your profile. `~/.nix-profile`
  and the generations behind it are links your account owns, and anyone may add a path to the Nix store. A ferret can
  therefore put a program of its own in your profile under ANY name a rule of yours could name, and a rule for that
  name would then paste into it without asking you. That covers every rule marked "your profile" below, including
  one whose program is not in your profile yet.
- **Which rules it can reach, and which never:** only a `terminal:<program>` rule whose program **no
  root-controlled folder holds** (`/usr/bin`, `/bin`, a system profile, …; an entry your account could replace does
  not count), and never one for a password or code program (sudo, sudoedit, su, doas, passwd, ssh, scp, sftp, mosh,
  and the aws, gcloud, az and vault CLIs). So a rule for `/usr/bin/gh`, `sudo` or `ssh` is still met only by the
  root-placed program, setting on or off: a fake `sudo` in your profile is never proved. This is checked when the
  terminal is looked at, with the same check the badge uses.
- **How the program is proved:** the entry `~/.nix-profile/bin/<program>` is walked one part at a time, every link on
  the way must stay inside the profile chain (`~/.nix-profile`, `~/.local/state/nix/profiles`,
  `/nix/var/nix/profiles/per-user/<you>`, the store), and the walk must end at the very store file every process
  reading the terminal runs. Everything else still holds: every process of the foreground group proved, line mode,
  no process of another session holding the terminal. A program in `~/bin`, any other path, or a store path your
  profile does not name is never matched. The write itself checks again that the same profile program, by name and
  by store file, still holds the terminal, or nothing is typed. Names are judged in any case: a rule for `Sudo` is
  a rule for sudo.
- **What it never allows:** a program proved through your profile earns no green card, no short lock and no one-tap
  saved login; it only lets a rule you wrote match. The proof is the daemon's own and is never sent to the app.
- **Who may turn it on:** the owner only. A ferret is refused before its request is read
  (`PUT /v1/copy-rules/settings`). At the machine it takes effect at once; from a paired device it needs
  `terminal.configure` and a passkey proved for this one act (`allow-profile-targets`), claimed in one step, so a
  passkey proved for something else never turns it on. Turning it off never asks. It is kept beside the rules in
  `<state>/secure-copy/rules.json`; a file that cannot be read holds it off. "The owner only" is the honest-client
  boundary in [honest limits](#honest-limits): a ferret that reads the admin token is taken for the owner here too.
- **What you see:** while the setting is on or off, every terminal rule a program from your profile could satisfy
  is marked "your profile — a ferret could swap this program" (Settings, and `fy copy rules ls`), with "asks you"
  while the setting is off. The settings and these marks come from `GET /v1/copy-rules/settings`, a route of its own;
  an app or CLI talking to an older daemon (a 404) shows neither, and the rules list itself is unchanged. Any other
  failure to read it is said ("could not check which rules a program in your own profile could satisfy"), never a
  silently missing setting.
- **What is logged:** a paste under a rule into such a program is audited as every rule paste is (`by: rule`, the
  rule), with the store file it pasted into (`profileProgram`); never the value. Turning the setting on or off is
  kept as `security.changed` (`copy-rule-settings`).
- **A rule into a shell or an interpreter** (bash, sh, zsh, fish, csh, tcsh, busybox, nu, pwsh, python, pypy, node,
  bun, perl, ruby, php, lua, …) is warned about when you add it (Settings, `fy copy rules add`), on the rule's row,
  in `fy copy rules ls`, and on a ferret's paste plan card: such a program runs whatever it reads.
- **GAP: Linux only.** No reading of a macOS process's executable is wired, so nothing is proved through a profile
  there.

## Honest limits

- **Not a sandbox.** An agent running as the owner's user can run the same command again and print it, or
  read the page. Secure copy keeps an honest agent's context clean and makes the route visible; it does
  not stop one that is trying to read the value. That is the boundary [secrets](secrets.md) states.
- **Masking is best effort.** A value printed differently (cut, wrapped, encoded) is not recognised. A
  fragment of the value in a failed command's stderr is not masked.
- **`clean` is not a proof.** The transcript check reads the file's end and matches the value whole.
- **Owner-only is an honest-client rule.** Allowing a paste, adding a rule and answering a plan refuse a caller
  that says it is a ferret, as every route under the admin token does ([input requests](input-requests.md)). A
  ferret that clears its own session variables and reads the admin token is taken for the owner, and since
  allowing a paste needs no value and no terminal, that is one command. It gains no more than the
  [secrets](secrets.md) boundary already gives it; it is said here so nobody reads "owner only" as stronger.
- **A rule's program must be a system program, unless you allow your own profile.** A `terminal:<program>` rule
  matches only when EVERY process reading the terminal is proved to be that program, in line mode: on Linux, a file a
  root-controlled bin folder leads to under that name (`/usr/bin/gh`, a system profile's `gh`), or a setuid getpass
  program (sudo, su, …). So a program from `~/bin` or `~/.local/bin`, a script (a Node CLI such as `vercel` runs as
  `node`), or a program behind a relay (`ssh -t`, `docker exec -it`) is never proved, and every paste into it asks the
  owner. One from your own Nix profile (`~/.nix-profile`) asks too, unless you turned on
  [programs in your own profile](#programs-in-your-own-profile). On macOS only a setuid getpass program is ever proved, so a
  `terminal:` rule there matches only sudo, su and the like (GAP). A proved program started by the ferret is still the
  ferret's own process, with arguments of its choosing: approve routes into programs you know the ferret is running,
  and prefer a count or an expiry.
- **Command arguments are the agent's own words.** They are not audited (only their count), but they are in
  the agent's transcript, so a secret belongs in a `${secret:NAME}` use, never in `argv`.
- **Not zeroed, not locked.** Strings are immutable in the runtime; "let go of" means unreachable.

## Phases

| Phase | What                                                                                                 | State       |
| ----- | ---------------------------------------------------------------------------------------------------- | ----------- |
| SC1   | This contract, the in-memory store, command capture, masking, exposure check, `secure_*` agent tools | done        |
| SC2a  | Paste to a terminal prompt, pre-approval rules and the plan card, `fy copy`, Allow on the input card | done        |
| SC2b  | Paste to the secret store, with the exact-NAME rule                                                  | done        |
| SC3a  | Paste to a field on a page; the card names the file a command copy came from                         | done        |
| SC3b  | Copy from a page element; the source page is not pictured; `pageReadBeforeCapture`                   | this change |
| SC3c  | Clipboard capture (headless only); another page showing a held value is not pictured                 | later       |
| SC4   | The app's paste and plan cards, Settings, and the agent instruction                                  | later       |
