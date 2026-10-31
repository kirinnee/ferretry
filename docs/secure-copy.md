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

| Source      | What the daemon does                                                                                                                                                                                                                                                                                        | State |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `command`   | Runs `argv` with **no shell**, in the session's folder (or `cwd`), through the secret store's child runner: an allowlisted environment (no admin token, none of the daemon's own secrets), stdin closed, a timeout (30 s, 60 s at most) and a byte cap. Stdout, trimmed unless `trim: false`, is the value. | live  |
| `browser`   | Reads one element of a page the agent may act on, by `ref` or `selector`: its text, a field's value or one attribute.                                                                                                                                                                                       | SC3   |
| `clipboard` | Reads the agent browser's clipboard for that page's origin, after the agent pressed the page's own Copy button. Never this computer's system clipboard.                                                                                                                                                     | SC3   |

A capture is refused, and nothing is held, when the command fails, times out, prints nothing, or prints
more than 16 KiB. Capturing needs no approval: the agent could run the command or read the page itself. The
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

## Pasting (SC2, SC3)

A paste names a handle and a destination: a browser field or a terminal prompt (an input-bridge target), or
the secret store under a name. The daemon raises an **input request** whose source is the handle, so the
card, the daemon-observed destination facts, `observedDigest`, the single guarded write, the quarantine and
the audit are all the input bridge's own. The card names source and destination ("token from **gh** →
**vercel.com** env value field") and carries a risk flag. The owner taps **Allow**; there is no value field.

- **Always approved by the owner by default.**
- **Pre-approval**: the owner can approve a route in advance (source origin or program → destination
  origin or program, with an optional expiry and count), from a card or from Settings. The agent can ask for
  this up front with one card listing its planned copies. Routes are matched on what the **daemon**
  observed, never on the agent's words. A pre-approved paste is still raised, audited and shown in the log.
- **The secret store is never written by a rule** unless that rule names the exact secret NAME; otherwise
  the owner approves the write, so no rule can overwrite an existing secret.

## Honest limits

- **Not a sandbox.** An agent running as the owner's user can run the same command again and print it, or
  read the page. Secure copy keeps an honest agent's context clean and makes the route visible; it does
  not stop one that is trying to read the value. That is the boundary [secrets](secrets.md) states.
- **Masking is best effort.** A value printed differently (cut, wrapped, encoded) is not recognised. A
  fragment of the value in a failed command's stderr is not masked.
- **`clean` is not a proof.** The transcript check reads the file's end and matches the value whole.
- **Command arguments are the agent's own words.** They are not audited (only their count), but they are in
  the agent's transcript, so a secret belongs in a `${secret:NAME}` use, never in `argv`.
- **Not zeroed, not locked.** Strings are immutable in the runtime; "let go of" means unreachable.

## Phases

| Phase | What                                                                                                 | State       |
| ----- | ---------------------------------------------------------------------------------------------------- | ----------- |
| SC1   | This contract, the in-memory store, command capture, masking, exposure check, `secure_*` agent tools | this change |
| SC2   | Paste to a terminal prompt and to the secret store, pre-approval rules and the plan card, `fy copy`  | later       |
| SC3   | Page and clipboard capture, paste to a browser field, page-read and screenshot hiding                | later       |
| SC4   | The app's paste and plan cards, Settings, and the agent instruction                                  | later       |
