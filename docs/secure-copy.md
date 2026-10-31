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
  reading the terminal as tmux names it (`pane_current_command`, at most 15 characters on Linux). A match
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
  sticky bit. Ownership, not permission bits: an owner can `chmod` its way back in. So a rule auto-pastes only from
  system programs (`/usr/bin/gh`); anything under `$HOME`, a `~/.nix-profile` link included, always asks.
  A rule names a program, not what it runs: `gh` (its aliases and extensions), `env`, `node` or `op run` can run
  anything, and a rule for one matches whatever arguments the ferret gives it.
- **The secret store is never written by a rule** unless that rule names the exact secret NAME: `secret:<NAME>`
  has no pattern and no wildcard, so a rule for `VERCEL_TOKEN` never writes `VERCEL_TOKEN_2`.
- **A plan**: `secure.preapprove` raises ONE card listing the pastes the agent plans, each with its route and
  the agent's reason (shown as its words). The owner allows some or all with `fy copy plan approve <id> 1 3`
  (none declines), or ticks them on the card, a permission card whose own Allow and Decline answer it (the
  generic agenda answer is refused). Each allowed item becomes a rule for that session allowing one paste until
  the plan's expiry, which the card states (two hours by default, a day at most: a longer route is the owner's to add as a
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
| SC2a  | Paste to a terminal prompt, pre-approval rules and the plan card, `fy copy`, Allow on the input card | done        |
| SC2b  | Paste to the secret store, with the exact-NAME rule                                                  | done        |
| SC3a  | Paste to a field on a page; the card names the file a command copy came from                         | done        |
| SC3b  | Copy from a page element; the source page is not pictured; `pageReadBeforeCapture`                   | this change |
| SC3c  | Clipboard capture (headless only); another page showing a held value is not pictured                 | later       |
| SC4   | The app's paste and plan cards, Settings, and the agent instruction                                  | later       |
