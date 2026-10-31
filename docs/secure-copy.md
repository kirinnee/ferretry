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
characters. A vault that cannot be opened withholds stderr. **Stdout is never returned.** No schema here has
a field for the value; a protocol test walks every schema to keep it that way.

## Capturing

| Source      | What the daemon does                                                                                                                                                                                                                                                                                        | State |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `command`   | Runs `argv` with **no shell**, in the session's folder (or `cwd`), through the secret store's child runner: an allowlisted environment (no admin token, none of the daemon's own secrets), stdin closed, a timeout (30 s, 60 s at most) and a byte cap. Stdout, trimmed unless `trim: false`, is the value. | live  |
| `browser`   | Reads one element of a page the agent may act on, by `ref` or `selector`: its text, a field's value or one attribute.                                                                                                                                                                                       | SC3   |
| `clipboard` | Reads the agent browser's clipboard for that page's origin, after the agent pressed the page's own Copy button. Never this computer's system clipboard.                                                                                                                                                     | SC3   |

A capture is refused, and nothing is held, when the command fails, times out, prints nothing, or prints
more than 16 KiB. Capturing needs no approval: the agent could run the command or read the page itself.
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
- "Save to the secret store as NAME" is a paste destination (SC2): the owner approves it like any other.

## Hiding

From the moment it is read, a copy is held in the daemon's one masking registry (`EphemeralValues`, the
one the input bridge uses) as `[sealed:<name>]`, until it expires **plus 10 minutes** (it may still be on a
screen it was pasted to). That masks it in:

- the agent's `terminal.read` and `terminal.wait`, and the live terminal viewer;
- the owner's screen, transcript, journal and process reads;
- a command copy's own stderr.

Page reads, accessibility snapshots, evaluation results and screenshots are covered by the browser phase
(SC3), through the same browser guard the input bridge's browser fields use. A screenshot of a page that
shows a held value is **withheld**, not pixel-masked.

### A value the agent had already seen

Masking cannot take back what the agent already read. So a capture says, honestly:

- **`exposure.transcript`**: the daemon searches the end (32 MiB) of the session's own transcript file for
  the value, as it is and as JSON escapes it. `found` means it is in the agent's context and **is not
  protected**: the agent is told so in plain words and should tell the owner to rotate it. `clean` means
  it was not found in what was read; `unknown` means the transcript could not be read.
- **`exposure.pageReadBeforeCapture`** (SC3): the agent read, screenshotted or evaluated that page since it
  last navigated.

The agent instruction teaches the rule that makes this work: **capture before you read**.

## Pasting

`secure.paste` names a handle and a terminal the agent opened. The daemon raises an **input request** whose
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
- **Audit**: `input.delivered` with `source: sealed` and the copy's name, never the value.

### Approving in advance

- **A rule** allows pastes from a source (`command:<program>`, `browser:<origin>`, `clipboard:<origin>`) to
  a destination (`terminal:<program>`, `browser:<origin>`, `secret:<NAME>`), for one session or any, with an
  optional expiry and count. Only the owner adds or removes one (`fy copy rules add|rm`, `POST|DELETE
/v1/copy-rules`): the route refuses an agent before it reads a body and the service refuses again. Adding
  one demands `terminal.configure`, so a remote device follows "ask again for each change"; each add, removal
  and plan answer is kept in the security log as `security.changed`.
- **Matching** runs on what the DAEMON observed: the program the copy was captured from, and the program
  reading the terminal as tmux names it (`pane_current_command`, at most 15 characters on Linux). A match
  pastes at once, still as one guarded write, with the card raised and closed so it shows in the log, and the
  audit actor is the rule. A rule's use is taken synchronously, so two pastes can never both spend its last
  use. A write that typed nothing gives the use back and leaves the card for the owner; a write that may have
  typed (uncertain) spends it. A use is recorded in memory even when the rules file cannot be written.
- **Only where typing is hidden.** Nobody sees the card of a pre-approved paste, so a rule pastes unasked only
  into a terminal with echo off (or a page's password field). Anywhere the value would show on screen, the card
  waits for the owner even under a matching rule.
- **The secret store is never written by a rule** unless that rule names the exact secret NAME. Pasting into
  the store is the next phase (SC2b); until then a `secret:` rule matches nothing.
- **A plan**: `secure.preapprove` raises ONE card listing the pastes the agent plans, each with its route and
  the agent's reason (shown as its words). The owner allows some or all with `fy copy plan approve <id> 1 3`
  (none declines); each allowed item becomes a rule for that session allowing one paste until the plan's
  expiry, which the card states (two hours by default, a day at most: a longer route is the owner's to add as a
  rule). Two answers arriving together make the rules once. Closing the card approves nothing. Plans live in RAM: a restart forgets them.
- **The rules file** (`<state>/secure-copy/rules.json`) holds routes and counts, never a value. One that cannot
  be read is NO rules: every paste then asks the owner.

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
- **A rule trusts a program's name.** tmux reports the foreground command's name, so a program named `vercel`
  that the agent wrote itself matches a `terminal:vercel` rule. Approve routes into programs you know the
  ferret is running, and prefer a count or an expiry.
- **Command arguments are the agent's own words.** They are not audited (only their count), but they are in
  the agent's transcript, so a secret belongs in a `${secret:NAME}` use, never in `argv`.
- **Not zeroed, not locked.** Strings are immutable in the runtime; "let go of" means unreachable.

## Phases

| Phase | What                                                                                                 | State       |
| ----- | ---------------------------------------------------------------------------------------------------- | ----------- |
| SC1   | This contract, the in-memory store, command capture, masking, exposure check, `secure_*` agent tools | done        |
| SC2a  | Paste to a terminal prompt, pre-approval rules and the plan card, `fy copy`, Allow on the input card | this change |
| SC2b  | Paste to the secret store, with the exact-NAME rule                                                  | later       |
| SC3   | Page and clipboard capture, paste to a browser field, page-read and screenshot hiding                | later       |
| SC4   | The app's paste and plan cards, Settings, and the agent instruction                                  | later       |
