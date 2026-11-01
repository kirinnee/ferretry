# Input requests: typing a secret without handing it over

An agent stuck at a password, `sudo`, OTP or 2FA prompt raises an **input request** naming its own
terminal (a browser field comes later). The **daemon**, not the agent, records what is actually
there. The owner sees an agenda card, types the value or taps a [saved login](#saved-logins), and presses Send. The
daemon re-checks the target and types the value **straight into it**, optionally pressing Enter.

The wire contract is `packages/protocol/src/lib/input-request.ts`. This page says what it means and
what it does not promise. It is a **contract**: the daemon, the CLI and the app implement against it.
Which parts are live is the phase table at the end.

## The one rule

**This applies to a `secret` value (a password or passphrase). A `plain` value (a username, an email, a
hostname, `y`) is not secret: the card says so and the ferret may see it.**

**The bridge itself never carries a `secret` value through the agent, a tool call, the journal, `agenda.json`,
the audit log, a push payload or disk.** This extends [secrets](secrets.md) ("use, never read"): no route,
command or API returns a value or a digest of one, and nothing logs a body.

That is a promise about how the **bridge** handles the value, and one more: for a limited window
(the quarantine below) the daemon keeps the **terminal** the value was typed into from the agent and from
the viewer. It is **not** a promise that the value can never be read off the target afterwards. After the
window ends, or when the owner ends it or chooses "Show anyway", what the target program printed is read
back through best-effort masking, and masking cannot recognise every form of a value. See the honest
limits.

| Place                                            | Holds the value?                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Agent context, tool calls, harness transcript    | Not through the bridge: no agent tool takes or returns it. The terminal's own output: see below.      |
| `agenda.json`, journal, audit log, push, ledgers | **Never.** The schemas have no field for it, and a test walks every schema to keep it that way.       |
| Disk (the bridge's own files)                    | **Never**, unless the owner ticks "Save as": then only the sealed saved-login document.               |
| The app                                          | Only the controlled field until Send. Cleared on send, on unmount and when the page is hidden.        |
| The wire                                         | Only inside the end-to-end sealed carrier, **padded** to a 256-byte bucket (see below).               |
| Daemon RAM while handling                        | From body parse to inject. No reference is kept after the handler returns.                            |
| Daemon RAM, the **redaction window**             | The one retained copy: a per-session map, 10 minutes by default and 60 at most. Never serialized.     |
| A **plain** value                                | Not held. It is not secret: the card says the ferret can see it, and the agent may get it back.       |
| The target                                       | It now lives in the target program, and in whatever that program prints or stores. That is the point. |

`InputDeliverBodySchema` is the only schema with a value, and only as `padded`. It is a request body:
nothing stores or returns it.

## The agenda card

The input form **is** an agenda item of `kind: 'input'`, referenced like any item (`!A7`; no new
sigil, see [the reference standard](reference-standard.md)). Its `input.requestId` points at the
request. The card lives until it is answered, cancelled or expired, and **survives a daemon restart**:
the facts are RAM-only, so after a restart the card reads "re-observing" and the daemon observes the
target again before Send is allowed.

The generic agenda answer **refuses** `kind: 'input'` (400 `use_input_form`), so a value can never be
typed into the agent's pane as `[answer to !A7] hunter2`. The agent adds `kind: 'input'` items only
through the input tool; the generic add refuses it.

## The shapes

- **`InputRaiseSchema`**: what the agent says: the target (`%terminal:<key>` or `%browser:<key>`), a
  prompt of at most 280 characters, a `submit` mode, and EITHER one `sensitivity` (one value) OR up to
  four `fields` (see [cards of several fields](#cards-of-several-fields)). Nothing the daemon observes
  is accepted from the agent.
- **`InputTargetFactsSchema`**: what the daemon saw: for a terminal, the pane proof, the foreground
  program (pid, pgid, `comm`, argv), `echo` (`off`, `on` or `unknown`), the cursor row, the prompt
  line with its digest, `program` (the reader the kernel PROVED, absent when unverified:
  [who reads the terminal](#who-reads-the-terminal)), `recognisedConsumer` and `trustedProgram`. For a page: the page, its origin and whether it is
  secure, the document (`navigationId`), and per field the frame and its origin, the node, the field's
  attributes, its box and whether it is visible; and `challenge` when the page shows a captcha.
- **`InputRequestSchema`**: the aggregate: ids, target, prompt, `fields` (each with its own sensitivity
  and risk), the strongest sensitivity, expiry, `chain` and `step`, the facts and their digest while
  observed, the state and the outcome.
- **`InputDeliverBodySchema`**: `deliveryId` (a UUID), `observedDigest`, the value(s), `submit`, and
  `save` (`{ entry, label }`, typed values only). A one-field card sends **exactly one of** `padded`
  or `entry` (a saved login's handle). A card of several sends `fields` (`[{ field, padded }]`, each
  value padded on its own) and may add `entry` for the fields it did not type.
  A paste of a [secure copy](secure-copy.md) sends `sealed: true` and no value: the daemon pastes the copy the
  request names.
- **`InputAgentViewSchema`**: what the agent learns: state, whether Enter was pressed, `source`
  (`typed` or `saved`) and a redacted screen. **Never** the value, its length or a saved login's
  name.
- **`InputRequestSchema.saved`** (the owner's view only): the target's key, the saved logins the card may
  offer and what "Save as" suggests. See [saved logins](#saved-logins).
- **`InputEventSchema`** and **`InputAuditDetailSchema`**: names and flags only. The audit detail
  does not carry the prompt text.

### Sensitivity

| Value     | Meaning                                                                                                                                                                          | Checks                                                                                                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `secret`  | A password or passphrase. The bridge never carries it to the agent, a log or disk; what the target prints afterwards is held back (quarantine) and then only masked best effort. | Never refused for its target: the card flags the risk (green, amber or red) and Send stays available. Hard refusals: a control character or line break in the value, a changed target (409 `target_changed`), and a caller who is not the owner. |
| `plain`   | A username, email, hostname or `y`. **Not secret.**                                                                                                                              | Target binding only. The card says "Not secret: the ferret can see this value." and flags it.                                                                                                                                                    |
| `private` | A value that is not one-time but shows on screen as it is typed (rare).                                                                                                          | Never refused: the card flags it amber ("This value will show on screen while the terminal is hidden from the ferret for 2 minutes."). Quarantine and masking apply exactly as for `secret`. Same hard refusals as `secret`.                     |
| `code`    | A one-time code: 2FA, an e-mail or SMS verification code, a device code. **Not secret.**                                                                                         | Never refused: the card says "One-time code: the ferret can see it." and flags it **neutral**. No lock, no quarantine, no page hold, not masked (but see [one-time codes](#one-time-codes-code)). Same hard refusals as `secret`.                |

`secret`, `private` and `code` values containing a control character or a line break are refused
("this would press keys"). `plain` allows Tab. `inputValueProblem` is that rule.

A `plain` value is typed the same way and is not held in the redaction window, so the agent's next read
shows it as the target shows it. The card says it is visible to the ferret; nothing about it is
hidden. It is not handed back in the agent's result: the agent reads it off the screen like anything else.

### Cards of several fields

One card can ask for several values for **one surface**: a Google login is "Email" (`plain`, flagged red
beside the field) and "Password" (`secret`) on one card, and the daemon types each into its own element.

- **A page's fields each name their element** (`element`: a snapshot `ref` or a selector, the agent's
  pointer). The daemon resolves every one and observes it: the frame, the node, the attributes, the box.
  Each field gets its own risk flag; the card's header carries the worst.
- **A terminal takes exactly one field.** A terminal shows one prompt at a time, so a value it asks for
  next is a new card with `chain`. A terminal field may carry a `label` ("Passphrase").
- **Every field is covered before anything is typed**: typed, or filled from ONE saved login by its role
  (`plain` → the username, `secret` → the password, `code` or `private` → the 2FA code). Only a saved login that
  holds every field's value is offered.
- **"Save as" keeps a login card as ONE saved login**, in one change under the store-wide lock: the `plain`
  field as the username and the `secret` one as the password (`savedRolesOf`). A one-time code is never
  kept. A card with two usernames or two passwords cannot be kept as one login and does not offer it, and
  every field it keeps must be typed (not filled from a saved login). The kept record is written once per
  field kept.
- **One write**: the target adapter gets the values in field order and types them under one binding
  check, with Enter (submit) after the last. Each value that is not `plain` is masked before it is typed.
- **A login on two pages is two cards**: the second names the first in `chain` and reads "Step 2 · after
  !A7" (`request.step`). Submit is per card, so each step chooses its own. `chain` must name one of the
  SAME session's input requests that this daemon holds; another session's card or an unknown one is refused.
- **Only a password input is green.** `autocomplete="current-password"` or `"new-password"` says what a field
  is for, not that it hides what is typed: a text input carrying it stays amber.
- **With a saved login on offer, the card still lists every field** with its flag (the red "not secret" of a
  `plain` field, the daemon's risk of the rest) above the one-tap button, so nothing is sent unseen.
- A page's card does not survive a daemon restart: its elements are the agent's words and are not
  journalled, so the card ends as interrupted and the agent raises it again.

### One-time codes (`code`)

The owner decided that one-time codes are not secrets: a ferret may read an e-mail or SMS code from an inbox it has,
and may see a TOTP code. `code` is the sensitivity for them; `private` stays for a value that echoes but is not
one-time.

- **The card** says "One-time code: the ferret can see it.", flags it neutral (not the red of `plain`, not the amber
  of `private`), and shows the value as it is typed (no Show toggle, no numeric pad: a device code may hold letters).
- **Nothing is held**: no lock, no quarantine, no page hold, no redaction window. The ferret's next read shows the
  screen as it is.
- **The ferret may type a code itself** with `terminal_send` or `browser_type`. A pending card whose every field is a
  `code` does not keep those two off the surface; a script, a key press or a form fill still waits, and a card with any
  other field still blocks them all. The card stays open (the owner
  can dismiss it), and an owner's Send after the ferret typed is checked against the target like any other.
- **A code the DAEMON made** from a saved 2FA seed: no tool, result or route **returns** it, and it is typed only into
  the observed field of that sign-in. Its text is also masked from text reads for the redaction window, as defence in
  depth; that covers text only, so the ferret may still see it on screen (a screenshot, a scripted read). The owner
  allowed that: TOTP codes are fine to see (design §11.1).
- **A `code` aimed at a password is a secret.** The daemon handles a code field as `secret` when any of these
  holds (the ferret's words may only ever raise a code, never lower one):
  - the page field is `type=password`, or its name, id or autocomplete says pass, pwd or PIN (any type);
  - the terminal runs sudo, sudoedit, su, doas or passwd, or its prompt line asks for a password (password,
    passphrase, passwd, Passwort, Kennwort, contraseña, mot de passe, credential, secret, "pw:", PIN), whatever else
    the line says;
  - the terminal reads with typing hidden, unless its program asks for 2FA codes (ssh, scp, sftp, mosh, the aws,
    gcloud, az and vault CLIs), proved for EVERY process of the terminal's foreground group (an ssh `LocalCommand` or a pipeline led by ssh is
    not one) from the file it RUNS (`/proc/<pid>/exe`, Linux only: on macOS nothing proves the program, so an
    echo-off code prompt there is always a secret), and only when that file is what a system folder resolves the
    name to (`/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, `/usr/local/bin`, `/run/current-system/sw/bin`,
    `/nix/var/nix/profiles/default/bin`, `/etc/profiles/per-user/<account>/bin`) and no hop of that entry is owned by
    this account or open to anyone (the secure-copy rule), and no process of another session holds the terminal open.
    A name in `ps` can be rewritten, a shell copied to `~/bin/ssh`, and anyone may add a shell to
    the Nix store, so none of those is proof, and the prompt line the daemon read from the pane asks for a code (verification code,
    one-time, OTP, 2FA, authenticator, "code:") and says none of password, passphrase, PIN, token or secret; a
    shell's `read -s` is never a code;
  - the ferret's own prompt, or the field's label or id, says password, passphrase or PIN.

  Every line and word is matched after NFKC normalisation with combining marks and invisible characters removed
  ("pàss​word" reads "password"); a word mixing ASCII letters with any other letter ("Pаssword", "Pɑssword",
  "ᴘᴀssword", Armenian "Passwօrd") counts as a password word; and a password word spelled with spaces, dots, dashes or
  underscores between its letters ("Pass-word", "P a s s w o r d") is still one.

  Then the field is hidden on the card, fully locked, masked, blocks the ferret's typing, and is `secret` in the
  journal and audit. The card says "Treated as a secret: this is a password field." This is decided at raise and
  checked again at a redraw, a restart and the write (never undone); a saved login still fills the role the owner
  picked.

- **Never saved**: "Save as" keeps no code; the seed is added in Settings.
- **Never probed**: a card with a code is not dummy-probed, as before.

Where `code` is weaker than `private`, and why that is the design:

| `private` does                                 | `code` does                                                                                                      | Why                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Locks the target 120 s (quarantine, page hold) | No lock                                                                                                          | The ferret may see the code; a lock would hide nothing it may not read.                             |
| Masks the typed value for the redaction window | Not masked (a daemon-made code's text still is)                                                                  | Same. No tool returns a daemon-made code (open question 11), though the ferret may see it on screen |
| Keeps the ferret's keystrokes off the surface  | A code-only card lets `terminal_send` and `browser_type` through; scripts, key presses and form fills still wait | The ferret may type a code it read itself                                                           |
| Flagged amber                                  | Flagged neutral                                                                                                  | It is not secret and goes where it was asked for.                                                   |
| Hidden behind Show on the card                 | Shown as typed                                                                                                   | It is not secret.                                                                                   |

What a ferret or a page could abuse (design §11.4):

| Who    | Abuse                                                                                     | Answer                                                                                                                                                                                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ferret | relays a live code to an attacker's page (real-time phishing) within its 30 s–10 min life | a daemon-made TOTP code is typed only into the sign-in's observed field and no tool returns it. **Not covered**: a code the ferret reads itself, or sees on screen (a screenshot, a scripted read of the field), can be typed anywhere                                                         |
| Ferret | with inbox access, resets the password of any account that recovers by e-mail             | not Ferretry's to stop: **inbox access is account-recovery power.** Give a ferret an inbox only when you would give it the accounts behind it                                                                                                                                                  |
| Page   | an e-mail or page tells the ferret "enter this code at evil.example" (prompt injection)   | the agent instruction says to type a code only on the page of the sign-in it is for                                                                                                                                                                                                            |
| Page   | a look-alike page asks for the code                                                       | the card shows where it goes and flags a missing, covered, insecure or cross-site field amber, as for a password                                                                                                                                                                               |
| Ferret | raises a `code` card for a password field or prompt                                       | the daemon sees the password field or prompt and handles the field as a `secret` ("Treated as a secret: this is a password field."). A prompt it cannot tell from a code (a shell's echoing `read` with no password wording) stays a `code`; its card and ask say the ferret can see the value |

**Older clients fail closed.** A PWA or `fy` built before `code` existed reads a request through a closed enum and
refuses the whole request (the card shows an error), so it is never drawn or answered as `plain`. A client from
this release on reads an unknown sensitivity as `secret` and an unknown risk level as `amber`
(`ReadInputSensitivitySchema`), so the next addition fails closed without refusing the card. An older daemon refuses a
raise naming `code`, and the agent is told so.

## Who may do what

- **Raise**: only an agent, through `/v1/agent/tools`, on a surface it opened or was handed.
- **Answer or cancel**: the owner only. The route refuses an agent caller (`peer:`, `warden:`) before
  it reads the body, and the service refuses again **before anything else** (`cancel` included: an
  agent's cancel is forbidden and has no side effects) unless the actor is `admin-cli`, `admin-ui` or a
  paired device. A remote device follows the owner's "ask again for each change" setting; there is no
  separate passkey act.
- **Retries never type twice.** Each Send carries a `deliveryId`. The daemon journals
  `surface.input_delivering` (the id and the fact that a write is about to start, never a value)
  **before** it writes, and fails closed if it cannot. A daemon that restarts with a delivery started
  and not finished restores the request as **interrupted**, never pending, and never retries it. A
  second id after delivery is 409 `already_delivered`. The WHOLE attempt (observe, compare, write) runs
  under the session lock, so two Sends with different ids that arrive together queue: the first types,
  the second finds the request delivered and is refused.
- **The write is guarded by tmux itself.** Deliver looks at the target, compares it with the facts the
  owner was shown (`observedDigest`, a keyed HMAC whose key lives only in this daemon process), and
  then sends **one** `tmux if-shell -F` command whose condition tmux evaluates in its own server in the
  immediately before it queues the write (see the honest limits for what that does not prove): the
  pane (by id), the pane's shell pid, tmux's `pane_current_command`, the cursor row and "the pane is
  not dead". The foreground facts shown on the card come from `ps` and are digested; tmux can only be
  asked about its own command name, so that name is what the guard compares. Any mismatch types nothing and answers 409 `target_changed`;
  a refused or failed command is _uncertain_. A foreground program whose name tmux cannot compare
  safely is refused. Three failed checks end the request; a change that is still the same target redraws
  the card instead of counting ([When the target changes](#when-the-target-changes)). **What tmux cannot
  bind** is in the honest limits below.
- **One write, never repeated.** A terminal delivery is **one** hex `send-keys -H` carrying the
  value and, when the owner wants Enter pressed, the `\r` in the same command (on by default for a
  terminal secret, off for a browser). If that command fails or throws, the outcome is _uncertain_: the
  value may or may not have been typed. That is a terminal `interrupted` outcome. It is never
  retried, whatever `deliveryId` the next Send carries.
- **Serialised per session.** Raising a request, an agent's own `terminal.send`/`close` and a delivery
  take one lock per session, so an agent send cannot complete after a request is raised on its pane,
  and two raises on one target cannot both be admitted. Admission reserves the surface and the
  pending-request capacity under that lock. An **owner cancel and a card being dismissed do not take
  that lock**: they check the request's state and make their final-state change synchronously, so a
  delivery already past its last look finishes as delivered and one that has not started finds the
  request closed. A close the daemon itself caused is ignored by the card-closed observer.
- **Limits**: 3 pending requests and 20 raises an hour per session; 30 remote deliveries an hour per
  daemon.

## When the target changes

The card binds to everything the daemon saw, so ANY change refuses the write: a page's field node, its box,
whether something covers it, the document; a terminal's cursor row. Most changes are not a different target.
A 2FA page re-renders its code input as a new node (React replaces it, and the agent's ref goes stale), a
countdown moves the box, a toast covers it for a moment, a reload makes a new document; a terminal redraws the
same password prompt a row lower. Before this rule the request kept the digest it was raised with, so after
one such change every Send failed the same way and the third ended the request as `check_failures`.

Now a Send whose look does not match **looks again** (`InputTargetPort.refind`). A page looks for the same
field: the node the owner approved when it is still there, else the agent's pointer when it names exactly one
element that is still that field (it decides between several look-alikes), else the **one** visible element of the
page's main frame (or an open shadow root) with the same tag and attributes. Every candidate is looked at exactly as
the first look (the node Playwright holds, described by the session that holds it); one that cannot be proved, more
than eight, or a page that changes while it is searched makes the search ambiguous, and then not even the pointer
decides. A field inside a frame is found again only through the pointer. A terminal is looked at again.
What it finds is then compared on its **binding**, the part of the facts that names the target itself
(`lib/input-requests/rebind.ts`):

| Target     | Must be the same                                                                                                   | May change                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| a page     | the page, its origin and https, every field's frame origin, tag, `type`, `name`, `id`, `autocomplete`, `inputmode` | the node, frame id, box, cover, document, challenge |
| a terminal | the pane, the program (pid, group, name, argv), echo, the prompt line, whether it asks for secrets                 | the cursor row                                      |
| a secret   | its name                                                                                                           | whether it already holds a value                    |

- **The same target, exactly as shown**: it is typed into (a stale ref that finds the same node, say).
- **The same target, something else changed**: the card is **redrawn** — a new picture taken before anything
  is typed, a new digest, the risk worked out again — the request stays pending, nothing is typed and **nothing
  is counted**. Send answers 409 `target_rebound` and the card says "The page changed. Check the picture and
  send again." (a terminal: "The terminal redrew its prompt."). The owner always approves the target the value
  goes into: a re-bind never types. It is audited as `input.rebound`. A page card redrawn onto ANOTHER document
  than the one it was raised on (a reload, or a navigation within the same origin) is flagged amber: "The page
  loaded a new document since you were asked: check the picture, and open the page if you are not sure it is the
  one you meant." The card shows the origin, not the address. A field whose own flag is red (a plain value) keeps
  red; the other fields of the card carry the amber.
- **Anything else** is a failed check, counted as before: another origin or page, an http page, a field in
  another site's frame, a password field that became a text field, a hidden field, no such field, **several
  look-alikes** (none is chosen), another program or prompt, echo turned on.

A card older than the request (the owner's client still holds the digest from before a redraw) is answered
`target_rebound` and not counted: nothing is wrong with the target. Both endings are `check_failures`, told apart
in plain words:

- redrawn more than `INPUT_MAX_REBINDS` (5) times: Send answers 410 `target_unsettled`, and the card closes with
  "The page kept changing, so nothing was typed. Ask the ferret to request again."
- three failed checks (another target): Send answers 409 `target_changed` as each one did, and the card closes
  with "The page is no longer what you approved, so nothing was typed. Look at it before the ferret asks again."
  It never invites a fresh request on a target that turned into another one.

The guarded write is unchanged: `inputType` still writes only to the exact nodes the (redrawn) card showed and
refuses anything different, and a write refused at the last moment redraws the card but is never retried within
that Send.

## The risk is flagged, never a reason to refuse

The owner can always be asked. A rogue program can print `[sudo] password for kirin:` itself, so the
card draws what the **daemon** observed (`sudo` is reading it, typing is hidden) large and what the
**agent** wrote small, and carries a **risk flag** with one fixed sentence that says what the risk is
(`request.risk`: a level and a reason; the sentence never contains terminal text):

| Level   | When                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| green   | A `secret`, echo off in line mode, and EVERY process of the foreground group PROVED to run one recognised program (`sudo`, `ssh`, `gpg` and so on), with no stranger holding the terminal. |
| amber   | A proved program in raw or readline mode: it may be relaying keys (`ssh -t`, `docker exec -it`), not asking for a password itself.                                                         |
| amber   | **Unverified**: the program reading the terminal is not proved ([who reads the terminal](#who-reads-the-terminal)), whatever name `ps` shows. The card says "unverified".                  |
| amber   | A `secret` with echo on (the value will show on screen), echo unknown, an unrecognised program or the bare shell.                                                                          |
| amber   | A `private` value (it echoes): "This value will show on screen while the terminal is hidden from the ferret for 2 minutes."                                                                |
| neutral | A one-time `code`: "One-time code: the ferret can see it." A page field's amber checks (missing, covered, not https, another site's frame) still come first.                               |
| amber   | A page field: the page is not https, the field is in a frame from another site, a `secret` is going into a field that is not a password field, or the field cannot be seen.                |
| green   | A page's `secret` going into a password field on a secure page.                                                                                                                            |
| red     | A `plain` value: "Not secret: the ferret can see this value."                                                                                                                              |

The flag is computed from what the daemon observed, when the request is raised and again when it is
restored. Send is available at every level. The only refusals are a control character or line break in
a `secret`, `private` or `code` value ("this would press keys"), a target that changed since the card was drawn (`target_changed`),
and a caller who is not the owner. A `private` value is always flagged amber, a `code` neutral.

**`sudo` always goes through the app.** The agent instruction makes `terminal_request_input` the only way
to answer a `sudo` password prompt: the agent never types it and never asks for it in chat.

## The relay can see sizes

The relay sees message sizes. The value is length-prefixed and padded to the next 256-byte boundary
(`padInputValue`, read back by `unpadInputValue`), so a short and a long password look the same.

## Redaction

Masking can only hide a value it can recognise: a prefix cut at a row edge, a value wrapped over
rows, an escape payload or a program that echoes it differently all defeat a matcher. So masking is
**defence in depth**; the confidentiality boundary is the quarantine below.

### The pane quarantine

When a `secret` is delivered the terminal is **quarantined** from the write for its **lock**: `INPUT_QUARANTINE_SECONDS`
(120), or `INPUT_SHORT_LOCK_SECONDS` (10) when the daemon proved the target hides what is typed (see
[how long the lock lasts](#how-long-the-lock-lasts)):

- **Nobody reads it through an ordinary tool.** `terminal.read` and `terminal.wait` are refused with a
  `conflict` error that says when the quarantine ends, for the agent **and for the owner's ordinary
  terminal-tools endpoint** (`POST /v1/sessions/:sessionId/surfaces/terminals/tools`); the owner's way to
  look is the viewer's "Show anyway", which is audited. The agent can still send keys.
- **ONE publication gate, asked where a result is published.** Whatever is derived from a pane is checked
  again, synchronously, at the point it leaves the daemon: after every awaited capture, redaction, batch,
  audit record and wait tail, and before it is returned, matched against a predicate, sent as a stream
  frame (full, delta, re-attach and the second capture of a redraw) or remembered as the last frame sent.
  A screen read before the quarantine began is discarded if the quarantine began before it was published.
  The routes that carry such a body also hand back a way to spell it again (`ApiResponse.late`). The dispatcher
  keeps it on the response, and every carrier calls it (`finalised`) as the last synchronous step before the bytes
  leave: the direct HTTP server and the relay tunnel (which the relay link and the direct carrier both use), so no
  await sits between the final check and the wire. The relay link also asks once more after the record is
  queued and sealed, because those are awaits: an answer, or a terminal stream frame (the bridge hands the
  downstream a permit with every frame, true while its capture may still be shown), whose last word changed in the
  meantime is dropped unsent, and its session ends so no sequence number is reused. The viewer reconnects and is
  shown the quarantine notice. Only the write to the socket itself remains, which is the
  declared compare-and-enqueue gap.
- **Every projection of what the daemon saw is covered.** While a pane is quarantined the prompt line, the
  program name and the argv in the owner's list, the agent's view and a restored request are replaced with a
  notice, not just masked. The agenda card and the audit trail never carry what the pane showed at all: the card
  says "Type it into the terminal", and an audit record holds ids, kinds, flags and outcomes, not the program name,
  so no later fold, flush or projection of either can republish it.
- **A viewer gets a notice instead of the pane**, unless that viewer chose "Show anyway". That choice
  is per connection (`?reveal=1` on the viewer socket), owner-gated, and audited as
  `input.quarantine_revealed`.
- **The owner can end it early** (`POST /v1/sessions/:sessionId/input-quarantines/:key/end`, audited as
  `input.quarantine_ended`); `GET .../input-quarantines` lists the live ones. Ending it lets go of exactly the
  settled holds it released, each journalled by its own id, never every hold that shares a name. A hold whose
  write may still be in flight or unresolved is never ended this way.
- **It is durable before the write, or nothing is written.** The hold is journalled before the first byte
  is typed. If the journal cannot record it, the delivery is aborted with nothing typed. While the write is
  in flight the hold reads as "now plus the window" and so cannot expire before the write; once the write
  returns, the window runs in full from that moment.
- **Each delivery attempt has its own hold.** An attempt that fails, is refused or is uncertain releases
  only its own hold, never one an earlier delivery left on the same terminal, live or after a restart.
- **A hold stays unresolved until its settlement is recorded.** The first journal entry for a delivery is
  marked `unresolved` and has no end time. The end time is only journalled after the write, so a daemon that
  stops, or a journal that cannot record the settlement, leaves the unresolved entry: a delivery that landed,
  and one that was uncertain, are both still held after a restart. A request reaching a final state does not
  remove that evidence.
- **It survives a restart, and a restart reads closed.** The daemon journals every name of the terminal (its
  key, name and id), the hold and its end time or unresolved state (`surface.input_quarantined`,
  `surface.input_quarantine_ended`; no value, digest or length) and replays them on start. Every hold,
  with all its names, is restored in a first pass over every session before anything is unlocked; recovery
  does not wait on the agenda or the request history. Until then every terminal reads as quarantined, and a
  session whose replay fails stays quarantined for a window. A hold still unresolved after a restart gets a
  fresh window from the restart. A quarantine whose window has passed is not restored.
- **"Show anyway" is audited, and is refused if it cannot be.** If the daemon cannot record that the owner
  chose to see the terminal, it does not show it. The audit log itself may report a persistence failure
  rather than propagate it, so a lost audit record is a limit, below.
- **A terminal is known by every name** (its key, name and id), so a read by any of them is refused.
- **Raise-time rules**: nothing is refused for its target. A `secret` on a terminal that echoes, or whose
  echo is unknown, is allowed and flagged amber; the quarantine hides the pane, including what echoed, and
  the facts are checked again at delivery (the compare-and-enqueue check below). A `private` value is allowed and flagged amber, with the same quarantine. A one-time `code` gets no quarantine at all.

### How long the lock lasts

The owner chose an **adaptive** lock (!A149). The card shows its length and why ("Hidden from the ferret for 10 s
after typing. …"), from `request.lock` (`InputLockSchema`: `seconds` and a fixed `reason`); the agent learns the
seconds (`lockSeconds`). It is decided only from what the daemon observed (`packages/daemon/src/lib/input-requests/lock.ts`):

| Reason            | Lock  | When                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hidden-terminal` | 10 s  | A LOCAL password prompt: echo off AND line (canonical) mode, the PROVED program is sudo, sudoedit, su, doas or passwd, and EVERY process of the foreground group runs setuid root (effective uid 0, real uid not), which a script or binary the ferret wrote cannot. ssh, docker, psql, every readline or raw-mode program and every unverified card are never short. |
| `proven-field`    | 10 s  | A submitted value into exactly the page fields below, AND the facts of the sign-ins matched to this page (every account's, read together) for that very field identity say masked, no echo after submit and moved on, with no record saying otherwise.                                                                                                                |
| `probed-field`    | 10 s  | One password field as below, and the daemon's **dummy probe** at raise came back clean.                                                                                                                                                                                                                                                                               |
| `code`            | 120 s | A `private` value: it shows as it is typed. (A one-time `code` field gets no lock at all; the reason's name is older than the sensitivity.)                                                                                                                                                                                                                           |
| `not-proven`      | 120 s | Anything else, every probe that did not run cleanly, an unreadable login store, a ferret that could have steered the page.                                                                                                                                                                                                                                            |

A page field qualifies when every secret field is a visible, uncovered `input type=password` on a secure page, in the
page's own origin, with no human check showing.

A card of `plain` values and one-time `code`s has **no lock** (`heldFromView`): the ferret may see both. A card with a
`code` beside a `secret` is locked for the secret alone, by the rules above.

- **Masking does not shorten.** The redaction window stays 10 minutes whatever the lock; the owner can still end a
  lock early or reveal.
- **A card never shortens at the write.** The lock is decided again from the facts seen at Send and the longer of
  that and the card's is used. A card redrawn onto a re-rendered field drops its probe result.
- **The ferret's own steering voids a page's proof**: a session that ever ran a page script never gets a short page
  lock and is never probed, and at Send any act of the ferret on a page since the card was raised voids it.
- **A terminal's OBSERVED facts never shorten it** (a program the ferret placed can carry the right name). Only the
  card's own facts do, and only when every process of the foreground group is a setuid-root password program.
- **The dummy probe** runs on a page card only, for exactly ONE secret field, after the field picture and before the
  owner is asked, inside the page's own queue. It is skipped for a session that ran a page script, for any card with a
  `private` value or a one-time `code`, and for a field whose `autocomplete`, `name` or `id` says code, PIN, OTP, 2FA, verification, CVV or
  token, or whose `inputmode` is numeric, tel or decimal. It runs only on an EMPTY field in the page's main frame, and
  only when the page holds no WebSocket open. A throwaway value of three characters (a tilde and two random letters or
  digits, shorter than any code or PIN field and than the minimum length of nearly every password field) is typed the way the owner's will be; the page's text is
  searched for it at once and again 750 ms later (visible text, accessibility snapshot, markup, title and address);
  the field is emptied with Backspace, or the native value setter if Backspace did not, and proven empty. It never
  presses Enter and never moves to another field. If the page fires any request it can see or shows another document while it
  runs, opens a WebSocket (even one it closes again), a field does not empty or the page cannot be read whole, the probe is `aborted` and the lock
  stays 120 s.
- **Limits.**
  - The probe reads the page's text, not its pixels: an echo drawn only on a canvas, or only after the second look,
    or only on submit, is not seen. `proven-field` covers what happened after a real submit on that field identity.
  - The probe sees the page's own requests and sockets: a service worker's or a shared worker's traffic, and WebRTC,
    are not seen.
  - The short lock will often not happen, in the safe direction: a busy page aborts the probe, and a `sudo` with
    `pwfeedback` reads in raw mode.
  - A field's identity has no path: two forms on one host with the same field attributes share their facts.
  - The probe moves the focus into the field and may make the page show a "required" message.
  - GAP: once a page's hold ends while the page still shows the document the value was typed into, a page script
    (`browser_eval`, when the owner allows scripts) can read the field and transform the value past masking. The
    short lock makes that sooner; the full lock never closed it.

The daemon holds each delivered `secret` in RAM, for the window above, and masks it as
`[redacted:input !A7]` wherever it scrubs text: the operator's screen, transcript and journal reads,
and (after the quarantine) the agent's `terminal.read` and `terminal.wait`. Redaction fails closed.

- **The same text is scrubbed everywhere.** The ephemeral window and the vault's `SecretRedactor` are
  composed into one redactor (`EphemeralAwareRedactor`), and the operator's list and read routes go
  through it, so an owner read never shows what an agent read hides. The two stores are masked as a
  **union**: both are asked where they match in the original text, overlapping matches are merged and
  each run is replaced once, so a vault secret overlapping a typed value cannot leave a tail behind.
- **`terminal.wait` tests scrubbed text.** Its predicate runs on the redacted screen, so once the
  quarantine is over, waiting for a prefix of a value masking recognises does not reveal whether the
  screen holds it. Masking is best effort: a value it cannot recognise is not covered by this.
- **What the daemon saw is a projection, made once.** The prompt line, the program name (`comm`) and
  the argv are masked WHOLE first and only then cut to their limits (200, 64 and 200 characters), so a
  clipped echo cannot leave the front of a value. A prompt line that ends with the start of a value, or
  starts with its end (three characters or more), is a value that wrapped over a row: no exact match
  finds half a value, so the line is replaced outright. The card, the agent's view, the journal, the
  audit record and the owner's list all use the projection. The raw facts are digested and handed to
  the write, then dropped: a request that ends keeps no observed facts and no digest.
- **The viewer's stream is scrubbed too.** The live terminal the app draws goes through
  `RedactingTerminalStreamService`: each capture is masked before the stream diffs it, so a delta, a
  full redraw and a re-attach all carry the masked screen. The mask is **structural**: each row is split
  into terminal cells, the redactor says WHERE a known value sits (positions, never the value), and
  exactly those cells are overwritten in place with `*` of the same width (two for a wide character, none
  for a combining mark). Nothing is rewritten, so rows, columns and the cursor keep their shape, colours
  survive, and no marker exists that another value could collide with. A value that wrapped over rows is
  masked in each row it sat in. A redactor that fails closes the stream. Only colour codes (SGR) are
  kept on a row; every other escape (a hyperlink's URL, a title) is dropped, because its payload is
  metadata that can carry a value. Background and reverse video are tracked apart, so a blank that is
  still painted is never trimmed. Cell widths follow the East Asian wide ranges tmux and xterm use.
- **Captures keep their trailing spaces until masked.** The viewer capture and the prompt-line read use
  `capture-pane -N`, so tmux does not trim a value typed with trailing spaces before it is matched;
  the trailing spaces are dropped only after masking. Values of one or two characters count half of
  themselves as a piece, so `ab ` cut at the edge of a row is still found.
- **Digests are keyed.** `observedDigest` and the prompt-line digest are HMACs under a per-process key,
  so a leaked digest cannot be used to test guesses against a low-entropy prompt line.
- **Values are really dropped.** Each purge replaces the stored array with only the unexpired entries.
  A clock-driven sweep purges every session, not only the one that was just read, and a session that
  ends drops its values at once. Neither depends on someone reading the window.
- **An input card takes no free text.** Resolving or dismissing an `input` card from a human actor
  ignores any note, and the app empties the composer when such an action is taken (and the next card
  starts with no note), because a note is the one place a value could be pasted into the ledger by
  mistake.

## Pages

A request on a page (`browser_request_input`) goes through the same service, card and deliver as a terminal's.
What is different is how the daemon looks and types, and what it holds back afterwards.

### Looking: the browser decides, the agent only points

- The agent names each field's element (a snapshot `ref` or a selector). The **browser** resolves it and
  reports what is there: the page's origin and whether it is secure (https, or http on this machine), the
  document (the main frame's `loaderId`), and per field the frame it is in and that frame's origin, the node
  (`backendNodeId`, found by a marker the worker sets and removes, never by page script), its tag and
  `type`/`autocomplete`/`name`/`id`/`inputmode`, its box and whether it is visible.
- A field the page lacks refuses the raise. Every look and write runs in the page's own queue
  (`BrowserSubsystem.inputOnPage`), so no act of the agent lands between the check and the write.
- The card's flags come from those facts: http, a field in a frame from another site, a `secret` into a field
  that is not `type=password`, a field that cannot be seen: amber. Only a password input on a secure page
  is green.
- **A picture of the fields** is taken at raise, before anything is typed, and kept in RAM for the card
  (`GET /v1/sessions/:sid/input-requests/:id/shot`, owner only; `request.pictured` says there is one). The
  card draws each field's box on it from the browser's facts. It is let go when the request ends.

- **The field's identity is the node Playwright holds.** Playwright resolves the agent's ref or selector in its
  own isolated world and holds the element; the node is the one Playwright's own DevTools session names for that
  handle (`DOM.describeNode` on its remote object), together with that session's TARGET: a backend node id is only
  unique inside one renderer. The session the write uses must be a session of that same target (the frame's own,
  or its nearest ancestor's, or the page's; never the page's for a frame in another target) and must describe the
  same node, or the field is refused.
  Every fact on the card (node, attributes, box) comes from that node; no page script is asked which element it
  is. This reaches past Playwright's public API (pinned with the version the worker ships, and a unit test fails
  when the installed Playwright is another release): a missing part refuses the field, it never guesses.
- **Covered or off screen is a flag, not a refusal.** The node on top at the field's centre (hit-tested by
  DevTools) that is not the field, or a field off screen, marks it `covered`; the card says "covered or off screen"
  and flags it amber, and the owner decides.

### Typing: one write into exactly the nodes the card showed

`inputType` re-checks the page against the card's facts first: the same document, the same origin, and every
node still there with the same attributes. Anything different types nothing (`target_changed`). Then, per
value in order: focus the node, confirm the focus landed on it, select what the field holds, and insert the
text (`Input.insertText`, which a page's script sees as ordinary input). Enter goes to the last field when
the owner ticked it. A failure before the first insert typed nothing; one after it is `uncertain` and the
request ends, never retried. The select, the focus proof and the insert run through an isolated world of the field's frame, where the page's
own overrides do not exist, and the insert is the very next call after the proof. What remains is the same
compare-then-write gap the terminal has: the page's own events (the `select` it is sent, a timer) can run in
the moment between the proof and the insert. The value crosses the worker pipe in that one request and is in no answer,
error or log.

### The hold on a page

A `secret` or `private` value typed into a page (never a one-time `code`) holds that page for the same window as a terminal
(`INPUT_QUARANTINE_SECONDS`):

- The agent's **pictures** of it (`browser_screenshot`, `browser_pdf`, `browser_highlight`) are refused for
  the whole window: no mask can be drawn on pixels.
- Its **text** (`browser_read` in every mode, `browser_console`, `browser_network`, `browser_wait_for`, `browser_eval` and
  its results) is refused while the page still shows the document the value went into. Once the
  page has moved on (a new `loaderId`), text reads come back, and they are **masked** for the redaction
  window like every other read: a next page that prints the password back shows a mask.
- While a request is pending on a page, the agent's `browser_type`, `browser_fill_form`, `browser_press` and `browser_eval`
  on it are refused: those values are the owner's to type.
- **The decision is made inside the page's own queue**, immediately before the act runs, for every caller:
  a request raised or a value typed while an act waited in the queue stops it there. The check before the queue
  only fails fast, and a check after the act still withholds a result a hold began under.
- **Errors are reads too.** A failed page call under a hold answers with the hold; every other error message
  passes the same redactor as a read (a page that throws the password back shows a mask), and fails closed to a
  fixed sentence when the redactor cannot run.
- Page holds share the terminal's registry under their own names (a hold on page `app` never seals terminal
  `app`) and are not journalled: a page does not outlive the daemon that drove it, and a page's card ends as
  interrupted on restart. GAP: the owner cannot end a page's hold early from the app; it runs its two minutes.

### Password saving is off in the agent profile

On every lease of the agent profile, before Chrome starts on it, the daemon forces Chrome's own preferences
`credentials_enable_service`, `credentials_enable_autosignin` and `profile.password_manager_enabled` to false
in `Default/Preferences`, keeping every other preference (a profile made before this rule gets it on its next
lease). A profile whose preferences cannot be written is not handed out, so the browser does not start.

### Passkeys are off in the agent browser

Every page of the agent browser (popups included) gets a CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator`,
USB, no resident keys) that claims to verify users but never does, and answers with the user-presence bit unset
(`setResponseOverrideBits({ isBadUP: true })`). Measured against a throwaway headless Chrome 154:

- `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` is false, so sites do not offer a passkey.
- Every `navigator.credentials.get` and `create` with `publicKey` (resident key required, preferred or
  discouraged; user verification required, preferred or discouraged; cross-platform; direct attestation;
  conditional mediation) fails with `NotAllowedError` in a few milliseconds, so nothing is registered and the
  site falls back to its password form.
- The one exception: a `create` that insists on a `platform` authenticator waits for one and registers nothing.
  A site asks for that only after `isUserVerifyingPlatformAuthenticatorAvailable()` said yes, which it does not.

The user agent and every fingerprint stay honest; nothing is spoofed. A login that needs the owner's real
passkey or security key is handed over (`browser_ask_owner`), and the agent instruction forbids accepting a
site's "create a passkey" or "add a security key" offer. GAPs: a WebAuthn call from a frame in another process
than the page was not separately proved, and a popup that navigates before its authenticator is added is not
covered.

### Captchas are the owner's

The daemon recognises the common human checks (reCAPTCHA, hCaptcha, Cloudflare Turnstile and interstitials,
and others; `recogniseBrowserChallenge`) from what the browser knows about the page, and puts `challenge` in
the facts. The card says so and the agent's answer tells it to hand the page over with `browser_ask_owner`
("complete the captcha") and wait. Ferretry never solves, skips or disguises itself past one.

## Saved logins

The bridge is also a small **password manager**. A saved login is a **labelled entry**: a label the owner
reads ("GitHub (kirinnee)"), what it is for (`match`), and its fields. The wire is
`packages/protocol/src/lib/login-entries.ts`; the store is the account store
(`packages/daemon/src/lib/secrets/accounts.ts`, [secrets](secrets.md#accounts-and-sign-ins-the-store)), and
`logins.ts` projects it as saved logins for one release.

| Field      | Kind               | Where it rests                                        | Who sees it                                              |
| ---------- | ------------------ | ----------------------------------------------------- | -------------------------------------------------------- |
| `label`    | plain              | the index, `login-entries.json` (`0600`)              | the owner's list and card                                |
| `match`    | plain              | the index                                             | the owner's list and card                                |
| `method`   | plain              | the index                                             | the owner, and the ferret's `account_hint`               |
| `domains`  | plain              | the index                                             | the owner, and the ferret's `account_hint`               |
| `username` | **plain**          | the index                                             | the owner, and the ferret once it is typed (it is plain) |
| `password` | **secret**         | sealed in `login-secrets.json`, under the vault's key | **nobody**: it is typed into a target and masked         |
| `totp`     | **secret**, opt-in | sealed in `login-secrets.json`                        | **nobody**: the daemon makes the code and types it       |

**Use, never read**, exactly as for every other secret ([secrets](secrets.md)). No route, command or API
answers a password, a seed or a code. A listing shows the label, the match, the username and **which** secret
fields exist. The sealed document is not the main vault: `fy secret use` cannot spend a saved login and
`${secret:…}` cannot name one. Saved values are masked wherever the daemon scrubs text, as
`[redacted:login:<ID>:password]`.

### How it signs in, and where

Each entry says **how** it signs in (`method`) and **where** the sign-in happens (`domains`), apart from what it
is for (`match`, the site the work is on):

- **`method`**: `password` (the default), or an identity provider — `google`, `github`, `microsoft`, `apple`,
  or `sso` with the provider's name as its button says it ("Okta"). A provider method may name the provider's own
  saved login (`via`): Vercel signs in with Google **via** "Google (kirin@…)". The ferret then clicks "Continue
  with Google", and the provider's page is filled from that entry. `via` must name another entry that exists;
  renaming the provider entry moves the link, deleting it drops the link.
- **No passkey method.** The list has none, and an `sso` name that says passkey, WebAuthn, FIDO, U2F or a
  security key is refused (`namesPasskey`): the agent browser has [passkeys off](#passkeys-are-off-in-the-agent-browser),
  so a login that needs one is the owner's hands (`browser_ask_owner`), never a saved login.
- **`domains`**: web hosts, exact (`app.vercel.com`, `accounts.google.com`). A pasted URL is read as its host. A
  **page** card's one-tap choice is an entry whose login domain is the page's host **exactly** — no wildcard, no
  parent domain. A **terminal** card still matches by `match` (`sudo@kirin-box`).
- **Older entries** (saved before methods) read as `password`, with their web `match` hosts as their login
  domains, and are not rewritten until edited.
- When a sign-in a page is for goes through a provider, the owner's card says so ("Sign in with Google via
  'Google (kirin@…)'", `InputSaved.signIn`), and **no** saved password is offered there but one the daemon matched
  on that page: not the provider's (it is typed only on the provider's own domain), and nothing by hand either. That
  holds when a migration dropped the `via` link and left only the method, so the provider is never one tap away on
  the site that signs in through it. A provider (an account some sign-in goes `via`) is never offered by hand
  anywhere it is not matched.

### The ferret's hint: `account_hint`

`account_hint` and `account_propose` were `login_hint` and `login_propose`; the daemon still accepts the old tool names, read as the new ones through the same checks.

Before a sign-in, a ferret calls **`account_hint`** (a page by name, so the daemon reads the host from where the page
**is**, or a site) and gets **one line per sign-in** for that site, then the provider sign-ins they lead to
(`accountHintsFor`): the **sign-in id** (`si_…`, what `account_propose` names), the account's **handle, label and
plain username**, the place, the method and the provider it goes via, the account's 2FA keys by kind and label, its
[recipe and observed facts](#login-recipes-how-it-signs-in-and-what-the-daemon-saw), and why it would be first on
this session's card ("Only account here", a default) — decided by the same `chosenSignIn` as the card, over every
matched sign-in, so it never says which accounts lack a password. Never a password, a seed, a code, which secret
fields exist, the 2FA parameters, seal names, auto-apply or proposals (`AccountHintSchema` has no field for one).
Every answer ends "passkeys are off". The tool answers the lines as its summary; the structured hint is
`GET /v1/accounts/hint?site=` (`secrets` use), and an `fy` from before sign-ins, which reads a result strictly, is
given no field it does not know. The owner sees saved-login words with `fy account hint <site>`
(`GET /v1/secrets/logins/hint`, one release). It is not more than a ferret could list before (`GET /v1/secrets/logins`
was already readable with the admin token); it is a narrower view, offered at the moment it helps.

### Login recipes: how it signs in, and what the daemon saw

A saved login can carry a **recipe**: steps for signing in, as Markdown, and the facts the **daemon** recorded while
it typed that login. Both are plain (not secret) and ride with the entry in the index. The wire is
`packages/protocol/src/lib/login-recipes.ts`; the policy is `packages/daemon/src/lib/secrets/login-recipes.ts`; the
facts are `packages/daemon/src/lib/input-requests/login-observer.ts`.

- **The recipe** is steps, never values: "Open app.vercel.com → Continue with Google → [[GOOGLE_KIRIN]] → wait for
  the phone approval → done when the dashboard shows". `[[ID]]` names another saved login; the ferret's hint lists
  that login too (as a `provider`), with its own recipe, one level deep. A rename rewrites `[[OLD]]` in every recipe
  (which makes every proposal against the old text stale); a delete leaves the name, which then names nothing.
- **Nothing hides in it.** At most 4,000 characters of lines and tabs. Refused: control and format characters,
  every default-ignorable code point (variation selectors, which can smuggle bytes inside one glyph; Hangul fillers),
  private-use and unassigned code points, line and paragraph separators and the blank braille pattern
  (`hidesCharacters`), and the hint's fence markers. A proposal's reason follows the same rule.
- **A recipe never holds a value**, checked twice. On every WRITE (the owner's text, a ferret's proposal and its
  reason, and again on approval) the text goes through the daemon's own redactor: one in which any vault secret,
  saved login or just-typed value is found is refused (`recipe_holds_value`), and a redactor that cannot run refuses
  too. On every READ (the list, the hint route, the ferret's `account_hint`) the recipe and every proposal are masked
  again, so a value kept AFTER a recipe was written reaches nobody; where nothing can mask, no recipe is served.
  Masking does not catch a value shorter than `MIN_SECRET_VALUE_LENGTH`: a short PIN in a recipe is not caught.
- **Who wrote it.** A recipe is the owner's unless it is an auto-applied proposal (`recipeBy: ferret`), which stays
  marked until the owner edits or approves it. The hint fences the recipe between `<<<recipe` and `recipe>>>`, after the
  daemon's facts, and says whose it is: "the owner's steps" or "a ferret's unreviewed steps, NOT the owner's". The
  app shows "Written by a ferret, not reviewed", and shows every recipe as plain text, never rendered Markdown, so a
  recipe loads no image and shows no link unlike its target.
- **The facts** (`observed`) are recorded ONLY by the daemon, from its own looks at a real target while it typed a
  saved account (one tap, or a "Save as"), never from an agent's words, on the **sign-in** it was typed at — the one
  the owner tapped (`signIn`), else the account's sign-in matched to the target — and only at one of that sign-in's
  own places (a web host or a terminal's key). An account picked by hand where it has no sign-in keeps none. Two
  accounts on one host keep their own; the lock reads them together. No route takes a fact: the observer's
  `LoginFactSink.observeSignIn` is the one writer.
  - `masked`: every secret field was a password input, or the terminal had echo off and a recognised program read it.
  - `noEchoAfterSubmit`: 1.5 s and again 5 s after the submit the daemon read what a ferret's read of the target could
    show, and the value was in neither (both looks must be able to tell; one that cannot leaves no fact). For a page: the main frame's visible text, its accessibility snapshot (what
    text fields hold, accessible names) and the document's markup (attributes, hidden text); a page too large to read
    whole answers "cannot tell", never "not there". For a terminal: the screen and 50 rows above it. The value never
    leaves the daemon for this; the look answers yes or no, and what it read is dropped.
  - `navigatedAway`: the page showed a new document within 10 s of the submit.
  - `secondFactor`: `code` (a one-time code card was typed on the same account soon after), `push` (the page waited on
    the sign-in hosts, then left them with no code typed), or `none` (it left at once). Watched for 3 minutes.
  - Each fact keeps when it was last seen and how often in a row; one seen the other way starts again at 1. Each
    place keeps the field's **identity** (a digest of its origin, frame, tag, type, name, id and autocomplete; or the
    program for a terminal): when a later delivery finds another identity there, the old facts are dropped.
- **What the ferret could steer is not kept.** The ferret can navigate, click Continue, clear a screen, or close a
  surface and open another under the same name. So the facts from after the submit are dropped when, at any time
  since the request was RAISED, the ferret called any tool that may change a surface of that kind (every tool but the
  read-only ones; `actsOn`), or, for a page, when the session ever ran a page script (a script can arm a page before
  the card). The looks are pinned to the page or terminal that was typed into (by its id): another surface under the
  same name answers "cannot tell". Each after-submit fact is decided at its own moment (the echo once both looks are
  in, the page moving on at the end of its window, the second factor when the page leaves the sign-in hosts), and an
  act after that moment does not undo it. A raise time that cannot be read keeps no after-submit fact. The proposal
  card and the owner's change and approval answers are masked like any read. The facts of the write itself come from
  the card's own observation.
- **The ferret reads both** in `account_hint`, and the agent instruction says to read it before a sign-in.
- **The ferret proposes, the owner decides.** After a sign-in a ferret may call `account_propose` (`signIn`, the
  whole new `recipe`, `why`). It is keyed by the **sign-in**: the older `{ login }` (and `login.propose`) is
  accepted by the same one schema and resolved to that account's **only** sign-in before any check runs; an account
  that signs in at several places is refused ("name the sign-in: … signs in at 2 places (si*…, si*…)"), and one that
  signs in nowhere too. The audit names the sign-in it resolved to. The proposal waits on that sign-in (three at most;
  a fourth pushes out the oldest and closes its card) and on an agenda card, "Recipe change for 'GitHub (kirinnee)'
  on github.com", that shows the changed lines and "The ferret says: …". **The card approves nothing**: the owner
  approves or declines in Settings › Accounts › the account › the place › Recipe, or with
  `fy account recipe approve|decline <id> <proposal>`, through the owner-only
  `POST /v1/accounts/sign-ins/:si/recipe/proposals/:proposalId` (or `/v1/secrets/logins/:id/…`, which finds the
  proposal on whichever of the account's sign-ins holds it; `secrets` configure, a kept `secrets.changed` record).
  An approval is refused (`stale_proposal`) when the recipe changed after the proposal was made, because the owner
  was shown a diff from the older text. Only an owner who turns **auto-apply** on for that ONE sign-in lets a
  proposal apply at once; that is audited (`login-recipe-auto`, with the sign-in) and marked as the ferret's.
  **Every applied change** (an owner edit, an approval, an auto-apply, a clear) bumps that sign-in's
  `recipeVersion`; the same text written again, or clearing no recipe, does not. The counter is kept while there is
  no recipe (nothing shows it then), so a recipe set after a clear never reuses a version: (sign-in, version) names
  one text, ever.
- **Page text never writes a recipe.** The daemon never reads a recipe off a page, and nothing a page says becomes a
  fact. A recipe changes only by the owner's edit, the owner's approval, or the owner's per-login auto-apply.
- **GAPs and limits.**
  - With auto-apply on, a prompt-injected ferret's proposal applies unseen and reaches every later ferret that signs
    in there (or names the login with `[[ID]]`). It is marked and fenced as unreviewed ferret text, audited, and holds
    no value, which is why auto-apply is off by default and per login.
  - The facts are never stronger than the shared admin token: a ferret that calls the person routes without naming
    itself, or drives tmux or the browser from its own shell, is not seen acting. Terminal facts are weaker still: a
    program the ferret placed (a fake `sudo` on its PATH) has the same name, so a terminal's OBSERVED facts are
    information for the ferret and the owner, and never shorten the post-typing lock (only the card's own
    echo-off and recognised-program facts do).
  - The echo look reads the main frame; a value echoed only inside another frame, or transformed on its way to the
    screen, is not recognised. `push` is inferred from timing and hosts, and an owner who types the code by hand on a
    taken-over page is not seen, so it reads as `push`.
  - Any recipe or fact written makes the index unreadable to an older daemon (strict schema): it reads as damaged
    and fails closed.

### The first time: "Save as"

The owner types the value on the card and ticks **Save as**. The daemon suggests a handle and a label from
the target's key (`sudo@kirin-box` → `SUDO_KIRIN_BOX`, "sudo on kirin-box"; a web host `github.com` →
`GITHUB_COM`); both are editable, and an existing entry can be chosen instead ("Save to … new or existing"). When an
account already signs in here, the suggestion is that account, chosen as the card's primary is (`chosenSignIn`,
without the ferret's hint); when two or more do and nothing chooses one, nothing is suggested, so a typed password is
never saved over "the first" of them.

- **The save is checked before anything is typed.** A one-time code is never saved (add the 2FA seed in
  Settings instead), and a password shorter than `LOGIN_PASSWORD_MIN_LENGTH` (8, a masking limit, not a
  strength rule) cannot be kept. Either refuses the Send with nothing typed and says to send it unsaved.
- **The value is kept only once it is typed.** A `secret` is saved as the password, a `plain` value as the
  username. Saving to an existing entry keeps its label and adds this target to what it matches (and, for a page, to the login domains it keeps).
- **A failure to keep it never undoes the delivery.** The answer says so in a fixed sentence
  (`saved: { ok: false }`); the owner can save it from Settings.
- **It is recorded as a change to the secret store**: a KEPT `secrets.changed` record (`login-save`) with
  the handle and the field, exactly as `fy secret set` is audited. Never the value.
- **One change at a time, for the whole store.** Every saved login shares the same two files, and a change
  reads both, seals and writes both back whole. Every change — a card's "Save as", a Settings edit, a rename,
  a delete, `fy account` (alias `fy secret entry`) — runs its read, merge and write in one store-wide queue (`LoginStoreLock`), so
  two that overlap both land and every acknowledged secret stays masked. A per-entry or per-session lock would
  not be enough: the files are shared.
- **All or nothing, across a crash.** A change never overwrites a sealed value the index points at. New
  secret values are sealed under **fresh, versioned names** and added beside the old ones; then the index —
  written to a temporary file, synced and renamed into place — is published pointing at them. That rename is
  the one commit point: before it, the entry is entirely the old one (old username, old password, the old
  ciphertext still sealed and still masked); after it, entirely the new one. Ciphertext nothing points at any
  more is swept after the commit and again at boot (`LoginDirectory.sweepUnreferenced`), and stays masked until
  then. The sweep runs only once the booting daemon holds the state home's lock (never while the daemon is
  being assembled, nor for `--check` or `--print-config`), so a second invocation can never sweep a live
  daemon's staged ciphertext. A boot with no committed index sweeps nothing, and neither does one whose index
  names a value the sealed document does not hold: the store is reported as damaged and every value is kept,
  and masked.
- **A username and a password from one card are kept together** (`LoginDirectory.saveFields`, one change), so a
  login card never leaves an entry with half of what was typed. The one-field card saves the one field it has.

### The next time: one tap

When a ferret raises a request, the daemon works out the target's **key** from what **it** observed:
`program@host` for a terminal (the foreground program and this machine's short name, or the destination
for `ssh`, `scp` and `sftp`), or the web host for a page. A **sign-in** whose place has that key **exactly**
(`signInMatches`: a site's login domains, a terminal's `tool@host`) is **matched**, and its account is offered with
the sign-in's id (`offer.signIn`). The card's primary action, **"Use saved <label>"**, is the one sign-in
`chosenSignIn` picks among the matched ones (`offer.primary`, with `offer.why`: `ferret`, `project`, `folder`,
`site` or `only`); see [Accounts and sign-ins](#accounts-and-sign-ins-data-model). Two or more matched and nothing
chose one: no offer is the primary. Offers come primary first, then the other matched ones by label, then the
accounts that may be picked by hand.

- **The tap is the permission.** Nothing is typed until the owner taps. Every rule of a delivery applies
  unchanged: owner only (twice), the `deliveryId`, the target re-observed and compared, the tmux guard, one
  hex write, the quarantine, the risk flag. The value is opened **inside the daemon**, after every check that
  can refuse without typing, and goes only into that write.
- **A saved value never passes through the app.** The card sends the entry's handle (and the offer's `signIn`);
  the daemon resolves it. **The card's rules are the daemon's, not only the app's list**: at Send it draws the offers
  again (`savedForFields`, over the fields the owner did not type) and refuses (`bad_request`), before anything is
  opened or typed, an account that is not offered there now (a provider on a page that signs in through it, a 2FA
  code from an account that does not sign in here), and a `signIn` that is not that offer's matched sign-in: one of
  another account (the same answer whether it is another account's or none), one of this account at another place,
  or any with an account picked by hand. The value always comes from the account; the sign-in says where the facts
  of the write go.
- **Which field it fills** follows the request: the password for a `secret`, the 2FA code for a `code`
  (or `private`) request, the username for a `plain` one. An entry that does not hold that field is not offered.
- **A mismatch is never the primary.** A look-alike program, another host or another site is not matched. An
  account that holds the field stays **selectable by hand** ("Use another account…"), because the owner may know
  better — except a one-time code (a code belongs to the sign-in it is for), any account on a page whose sign-in
  goes through a provider, and a provider account anywhere it is not matched ([above](#how-it-signs-in-and-where)).
  A hand pick keeps no facts.
- **The ferret may hint** (`secretHint` / `secret_hint`, a handle or a `si_…`): a hint naming a matched sign-in
  makes it the primary ("Ferret chose this", `why: ferret`); one naming anything else is only tagged "the ferret
  suggested this", never promoted, and the agent's answer is the same whether the account exists. Nothing a hint or
  a default does types anything: the owner's tap is the permission.
- **The agent learns `source: saved`** from the delivery and nothing else: not the handle, not the label, not the
  value. What it may know beforehand is the [hint](#the-ferrets-hint-account_hint): metadata, never a value.

### 2FA seeds (opt-in, per entry)

An entry may keep a TOTP seed (RFC 6238; SHA-1, 6 digits and 30 seconds unless the setup page says otherwise).
The daemon makes the current code when the owner taps Use on a `code` (or `private`) request and types it into the
observed field; the seed never leaves the use boundary, and **no tool, result or route returns** the code it made. Its
text is masked from text reads for the redaction window (a code the owner typed is not); the ferret may still see it
on screen. It is **off by default**, and adding one requires an
explicit confirmation of this sentence (`LOGIN_TOTP_WARNING`), shown in the app and the CLI:

> Keeping the password and the 2FA seed in the same place means one compromise of this machine's vault
> defeats both factors.

### Managing them

Settings › Accounts (the former "Saved logins") and `fy account ls|add|edit|rename|rm|recipe` (`fy secret entry …` is a hidden alias for one release) list entries (never values),
add and edit the label, match, sign-in method (`--method`, `--via`, `--sso-name`), login domains (`--domain`)
and username, replace a password, add or remove a 2FA seed, rename the handle and
delete. Values are typed into a masked field or read from the TTY with echo off; never a flag.
Routes: `GET /v1/secrets/logins`, `GET /v1/secrets/logins/hint?site=`, `PUT /v1/secrets/logins/:id` (create or change; an omitted field is kept,
`null` removes it), `POST /v1/secrets/logins/:id/rename`, `DELETE /v1/secrets/logins/:id`, `POST /v1/secrets/logins/:id/recipe/proposals/:proposalId`, all `secrets`
capability (`use` to list, `configure` to change) and each change a kept `secrets.changed` record.

### Accounts and sign-ins (data model)

> **The store and the daemon's side of the card have landed; the app's has not.** The shapes are in
> `packages/protocol/src/lib/accounts.ts`; the store, the migration at boot and the `/v1/accounts*` routes are in
> [secrets](secrets.md#accounts-and-sign-ins-the-store). The card's offers, a deliver's `signIn`, the facts, the
> lock, `account_hint` and `account_propose` read sign-ins ([one tap](#the-next-time-one-tap)). The app reads
> `primary`/`why` and sends `signIn` only once a daemon reports `accounts.signins.1`, which waits for the Accounts
> screen (the app ships first). Project and folder defaults are not read yet (`config/account-defaults.yaml`).

A saved login is being split in two:

- An **account** is one identity: label, **plain** username, its **secret** password, and its 2FA keys (an
  opt-in 2FA seed among them), sealed exactly as today. Its handle is the saved login's handle
  (`GITHUB_KIRINNEE`, still `[[GITHUB_KIRINNEE]]` in a recipe) and its immutable key is the saved login's `L…`
  key, so **no sealed name changes**.
- A **sign-in** is how that account signs in at **one place**: a website (its login domains, plus the hosts it
  is for) or a terminal tool (`sudo@kirin-box`, `ssh@build.example.com`). It holds the method, the provider it
  goes `via`, the recipe (with a `recipeVersion`), what the daemon observed there and the ferrets' proposals. Its
  id is `si_` and 16 hex digits and never changes.

Same site, two accounts: two sign-ins. Same account, two places: two sign-ins.

**Matching does not change.** A sign-in's keys (`placeKeys`) are byte-identical to the target key the daemon
derives today: a page's host against a site's login domains, `program@host` (`ssh@<destination>`) for a
terminal. What a site is _for_ never matches a page. Matching is exact: no look-alike, parent domain, other
program or other ssh destination.

**The index changes from `v: 1` to `v: 2`; the sealed document does not.** `migrateLoginIndex` is pure and
deterministic (a migrated sign-in's id is derived from the account key and its place, so a re-run gives the
same ids):

| Saved login (`v: 1`)                   | Becomes (`v: 2`)                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| handle, key, label, username, password | the account, verbatim                                                           |
| 2FA seed and its parameters            | the account's first 2FA key, under the same sealed name ([2FA keys](#2fa-keys)) |
| login domains and web `match` hosts    | one **site** sign-in                                                            |
| each `tool@host` in `match`            | one **terminal** sign-in (ssh, scp, sftp keep the destination)                  |
| method, via, recipe                    | every sign-in from that entry (via by the provider's key)                       |
| auto-apply, proposals                  | the **primary** sign-in only (the site, else the first terminal)                |
| each observed fact                     | the sign-in at its place; a fact from no place of the entry is dropped, counted |
| nothing matched                        | an account with no sign-ins                                                     |

Dropping a fact is safe: facts only ever shorten the [lock](#how-long-the-lock-lasts). A via link the new rules
refuse (gone, itself, a provider with no site, a circle) is dropped and counted rather than written. An older
daemon reads a `v: 2` index as **damaged**, never as empty.

The index keeps its rules on every read: each sign-in's account exists, one account never has two sign-ins at
the same place, `via` names another account that signs in on a site and never goes round in a circle.

**Which account a card offers first** (`chosenSignIn`) is decided **only among the sign-ins the daemon matched**:
the ferret's `secretHint` (a handle or a `si_…`), then the session's project default, then (an Unfiled session)
its folder default, then the site default (`config/account-defaults.yaml`, R1-4), then the only matched one.
Two or more matched and nothing chose one: **no one-tap primary**, the owner picks ("Pick one: 2 accounts sign
in here"). A hint or a default naming an account with no matched sign-in is ignored. None of them types
anything: **the tap is still the permission.** A line that would choose two matched sign-ins at once chooses
neither, so the answer never depends on list order.

`account_hint` answers one line per sign-in, with the sign-in id to propose against. It never says which
secret fields an account holds, nor its 2FA parameters, seal names, auto-apply or proposals. It lists an account's
2FA keys by kind and label only.

#### 2FA keys

> **Protocol only**, like the rest of this section: the shapes are in `accounts.ts` and `two-factor.ts`; the
> store, the routes and the cards land later. No daemon reports `accounts.2fa-keys.1` yet. Until it does, a
> deliver that names a key (`factor`) is refused, and so is a step-up for `add-2fa-key`.

**An account is a username, a password and a list of 2FA keys** (`factors`, at most 8). Each key has an id
(`tf_` and 12 hex digits, never shown to people), a kind, a label **the owner wrote** ("Okta Verify on Pixel",
"Phone ••42") and a few plain facts:

| Kind           | Holds a value?                                                    | Plain facts                                              |
| -------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| `totp`         | **only when the owner saved its seed** (sealed, as a password is) | code parameters, issuer and account name, checked by use |
| `sms`          | never                                                             | the last 2 to 4 digits (`••42`), never a whole number    |
| `email`        | never                                                             | where the code arrives                                   |
| `push`         | never                                                             | the app (Okta Verify, Microsoft Authenticator, Duo…)     |
| `security-key` | never                                                             | none                                                     |

A `totp` key with a seed is **automatic**: Ferretry makes its codes. Without one, it is an authenticator only
the owner holds, and they type its codes. At most 4 keys per account hold a seed.

The index keeps these rules on every read, so a hand-edited file is damaged, never half-trusted:

- a key's id is unique in the **whole** index, and its label within its account (case-folded);
- a seed's seal is a `…_TOTP_…` name under **this account's own key**, so it can never point at another
  account's secret or at a password;
- no sealed name appears twice in the index, whether a password's or a key's;
- a `totp` key keeps its code parameters exactly when it keeps a seed, and only a key with a seed is checked
  by use.

`sealedNamesOf(account)` lists every sealed name an account points at: its password's and each key's seed. A
sweep of the sealed document must keep everything it lists. **A sweep that skipped the keys would delete every
saved seed.**

**The migration moves today's seed; it does not rewrite it.** A saved login's `seals.totp` and its parameters
become the account's first key, `{ kind: 'totp', label: 'Authenticator app', seal: <the same name>, params,
addedBy: 'migration' }`. The key is not yet checked. Its id is derived from the account key and the sealed
name (`migratedTwoFactorId`), so a re-run gives the same id. The sealed document is byte-identical before and
after. A seed without its parameters, or parameters without a seed, is refused as damaged rather than turned
into a guessed key. This is folded into the `v: 2` index directly; there is no `v: 3`.

**What each reader sees:**

- **The owner** (`AccountSummary.factors`): each key without its seal, plus `automatic`. `fields.totp` and
  `totp` stay for one release, for an app from before 2FA keys.
- **A ferret** (`account_hint`): each key's id, kind and label, **nothing else**. A `totp` key reads the same
  whether Ferretry holds its seed or the owner does, so two accounts that differ only by a seed give
  byte-identical hints. The hint line reads `2FA: 'Okta Verify on Pixel' (push) [tf_…], 'Phone ••42' (sms) [tf_…]`.
  A ferret can still tell which accounts have a `totp` key, and right after the migration every such key holds a
  seed. The design allows that (a ferret may know which 2FA kinds an account has); it never learns more.

**A code card's title** comes from the keys (`factorAskWords`), in the owner's words: "Code sent to ••42 (SMS)",
"Code from Authenticator app", "One-time code: SMS ••42 or Authenticator app", or, with no key known, "One-time
code for GitHub · kirinnee". A raise may name the key with `factor`. Like `secretHint`, it is a hint: it is used
only if it is a key of the matched account, and otherwise ignored.

**Saving a seed** takes one field: a base32 key (spaces fine) or an `otpauth://totp/…` link. `parseTotpInput` is
the one parser, run by the app for instant feedback and again by the daemon, which has the final say. It refuses
each of these with its own fixed sentence, and **never repeats any part of the input**:

- an `otpauth://hotp` link (counter-based codes);
- any other `otpauth` type, or an `otpauth-migration://` export;
- an algorithm other than SHA1, SHA256 or SHA512;
- digits other than 6 to 8, or a period outside 15 to 120 seconds;
- a missing or malformed secret, or a setting named twice;
- a label whose issuer contradicts the `issuer` setting;
- hidden characters or a broken %-escape;
- anything over 2,048 bytes.

`factorMismatch` warns when the key says it is for another account. The issuer must match the account label,
or a label of a host its sign-ins name. The account name must match the username, or be an email whose local
part is the username. If either differs, the owner sees: "This key says it is for Okta · bob@x.com, but you're
saving it to GitHub · kirinnee." The daemon refuses the save unless the owner ticked "save it here anyway".

**The passkey is asked every time, even at the machine.** `add-2fa-key` is the one step-up act that
**every** caller must prove, the admin token on loopback included. Its proof is bound to the one staged save:
`StepUpOptionsRequest.subject` is the stage (`st_…`), and the challenge carries
`addTwoFactorKeySubject(accountKey, stage)`. A proof for one save can never commit another.

#### Approve on your phone

> **Protocol only.** The shapes are in `phone-approval.ts`. No daemon reports `input.phone-approval.1` yet, so
> no daemon raises one.

A sign-in that waits for a push the owner approves on their phone has its own card, a `PhoneApproval`. It is
not an input request, because nothing is typed.

**Nothing of the ferret's is shown.** The raise (`PhoneApprovalRaise`) names only:

- where: a page or a terminal;
- optionally, the element it thinks shows the number. This is only **where to look**: the browser reads the
  element, never the ferret;
- optionally, the account and the push key, as hints;
- how long to wait: 30 to 300 seconds, 2 minutes by default.

It has no prompt, message, label or number field, and it is strict, so an extra field is refused.

The account, site, time and number on the card all come from the daemon. `phoneApprovalWords` builds the card,
the agenda subject and the push from the approval's own fields, and from nothing else:

- **Card:** "Approve on your phone" · "ClickUp · a@gmail.com" · "ClickUp via Okta on company.okta.com" · "Tap 42
  on your phone" (Duo: "Enter 123456 in Duo Mobile").
- **Push** (owner decision !A171): the daemon-read number comes first, as in "Tap 42 on your phone: ClickUp ·
  a@gmail.com". With no number, it ends "— open for the number".
- **Agenda subject:** never the number. It is a plain `info` item with a `phoneApproval` ref, so an older app
  shows it as an info card.
- **No number:** the card says why ("A ferret scripted this page, so Ferretry won't read a number from it.").
- **A sign-in Ferretry does not know:** the card says so, and where ("a sign-in Ferretry doesn't know, on
  login.microsoftonline.com"), so an unexpected push is easy to refuse.
- **Every card** ends with: "Never use a number a ferret tells you."

**A terminal never shows a number.** A ferret can print any text into its own pane, so a terminal card always
reads `numberMissing: 'terminal'` and sends the owner to the terminal.

**Success is observed, never claimed.** `moved-on` is set only by the daemon, when it sees the sign-in move on.
There is no "I approved" button and no route that sets it.

While it waits, the ferret is told only the state and, once the sign-in moved on, `secondFactor: 'push'`
(`PhoneApprovalAgentView`). It is **never told the number**.

### Later, and off by default: standing permission

Placing a saved login **without a tap** is not built. A later phase may add it as an explicit owner opt-in,
per entry and per target ("standing permission for `SUDO_KIRIN_BOX` on `sudo@kirin-box`"), **off by
default**, revocable, and audited on every use. Until then every placement is a tap.

## Who reads the terminal

A secret card's green flag, its short lock, the code exception, a secure-copy rule's destination and a saved login's
one-tap match all rest on ONE question: which program will read what the owner types? The daemon answers it from
the kernel (`TmuxInputTarget` with `KernelProgramProof`, `packages/daemon/src/adapters/system/kernel-program-proof.ts`),
never from the name `ps` shows. Before this (#1218's review, &B112) every one of them trusted that name, for the
foreground group's LEADER only, and both halves were wrong:

- **The name is the process's own.** Any process can rewrite it: `printf sudo > /proc/$/comm; read -s X` makes `ps`
  print `sudo` for a shell, and on macOS `ps -o comm=` is argv[0] (`exec -a sudo bash`). The card then said green
  "sudo is asking", locked for 10 s, and the owner's password landed in a variable the ferret could read.
- **The leader is not the only reader.** Every process of the TTY's foreground process group can read it: an ssh
  `LocalCommand` or `ProxyCommand` child, or `sudo … | sh -c 'read -s X'`, a pipeline a real setuid sudo leads.
  Which one wins a read is a race, so naming the one that is blocked in `read` (`/proc/<pid>/wchan`) would not say
  who gets the next byte, and a setuid process's wchan cannot be read by this account anyway.
- **A process of another session can read too.** The pty belongs to this account, so a ferret can `cat /dev/pts/N`
  from any other terminal: it has no controlling terminal there, so job control does not stop it.

So the daemon proves the GROUP or nothing:

1. Every process of the foreground group (`ps -t <tty>`, every row whose group is the terminal's foreground group) is
   proved, one by one. A process is proved when it runs **setuid root** right now (effective uid 0, real uid not: only
   a root-owned setuid file gives that) under a getpass name (sudo, sudoedit, su, doas, passwd); or, on Linux, when its
   **executable** (`/proc/<pid>/exe`) is what a root-controlled bin folder resolves its name to (the folders and walk
   of the [secure-copy rule](secure-copy.md#pasting)). The exe proof says WHICH system program runs, bash included;
   what the name is worth is each decision's own. A process root runs outright (`sudo -n bash -c 'read -s X'` leaves
   one) is never proved: its executable cannot be read, and it is whatever a ferret with a cached sudo started.
2. No process whose controlling terminal is another (or none) holds the TTY open: on Linux every `/proc/<pid>/fd`,
   each descriptor matched by the DEVICE it reaches, not by how its path is spelled; on macOS `lsof` and `ps`. A
   process of this account whose descriptors cannot be read (one can make itself not dumpable) makes the answer
   unknown, with one exception every systemd login has: systemd's own PAM helper `(sd-pam)`, told apart by the
   kernel and not by its name (its parent runs a root-owned `systemd` this account cannot replace, and it started
   within a second of that parent). tmux itself holds only the pty's master side.
3. Then `program` is the ONE program every member is proved to run (two different programs, such as sudo leading a
   proved `sh`, are unverified), `recognisedConsumer` says it is a program that asks for a secret, and `trustedProgram`
   says every member runs setuid root. Anything unread, unproved or thrown leaves `program` out: the card is
   **unverified** (amber, never green), the lock stays full, the code exception is refused, no secure-copy rule matches
   and no saved login is the one-tap choice. A member that joins the group after the card changes the facts, so the
   write refuses with nothing typed.
4. **Line mode too.** A proved program that RELAYS keys (`ssh -t` to a remote shell, `docker exec -it`) hands them to a
   reader outside this machine's foreground group. A real password prompt (getpass, readpassphrase, Go's
   `ReadPassword`) reads a line; a relay puts the terminal in raw mode. So green, a secure-copy rule's match and the
   one-tap saved login also need the terminal in line (canonical) mode, as the short lock always did. Otherwise the
   card is amber: "The terminal is not reading a line…".

Raising a card to a password from the NAME (`sudo` in `ps`, or the prompt line) still happens: a fake name there only
makes the card stricter.

- **GAP: a macOS daemon proves only setuid programs.** No reading of a macOS process's executable is wired, so ssh,
  gpg, psql and every other program there is unverified (amber, full lock); sudo and su stay green.
- **GAP: another account's processes are not looked at.** They cannot open this account's pty for reading unless
  they are root, and root is outside this model. A setuid-root process whose descriptors cannot be read is passed over
  too: it is a program root placed, the same trust its proof gives.
- **GAP: the name of a setuid program is the caller's choice.** Whoever starts it picks the name: a link's name on
  Linux, any argv[0] on macOS (`exec -a sudo /usr/bin/<another setuid program>`). So the proved `program` of a setuid
  process says only that root placed it and that it runs under a getpass name; the card may say sudo while another
  setuid program reads. What reads the value is still a program root put there, and no common setuid program is known
  to hand what it reads to its caller.
- **The stranger scan is a look at one moment, and best effort against this same account.** A TTY opened after the
  final look, or held outside any descriptor table, is not seen.
- **A ferret that can already run sudo without a password is root.** Nothing here holds against it.
- **The proof is as old as the last look.** The write still only ENQUEUES ([honest limits](#honest-limits)); a process
  that joins the group, or execs, between the final look and the program's read is not seen.

## Honest limits

- **Not a sandbox.** An agent running as the owner's user that builds a capture program and talks the
  owner past the warning can get the value. So can one that reads the admin token and calls deliver
  with a saved secret. The bridge **reduces accidents and makes phishing visible**. It is the same
  boundary `sudo` has ([secrets](secrets.md)). Answering and cancelling are owner-only by an
  honest-client rule, as everything under the admin token is.
- **A hand-typed value is masked for the window only, and masking is best effort.** Afterwards a program
  that echoes it is not masked, unless the value was saved to the vault, and a value it cannot recognise
  (cut at a row edge, wrapped, inside an escape, printed differently) is shown. The quarantine is the
  stronger boundary but is a finite window: it ends after 120 seconds, or when the owner ends it or
  chooses "Show anyway". After that, target output can expose the value.
- **The audit trail is best effort.** The reveal and end acts are recorded through the common audit log,
  which reports a persistence failure instead of propagating it. A reveal is refused if the call to record
  it is rejected, but a record the log silently loses is lost.
- **The quarantine hides the pane from the agent's reads, not from the pane's program.** An agent that
  can send keys can still make the program print what it received; the agent's `terminal.read` of it is
  refused, but a process the agent started in another pane or a file it redirected to is not covered.
- **A `plain` value is visible by design.** It is marked on the card.
- **A browser `private` value can appear in an after-screenshot** (a later phase).
- **A one-time `code` is weaker than `private` on purpose** (the owner's decision, see [one-time codes](#one-time-codes-code)).
- **Not zeroed, not locked.** Strings are immutable in the runtime. "Dropped" means unreachable. Swap
  and core dumps are out of scope.
- **The guard is compare-and-ENQUEUE, not compare-and-deliver.** `if-shell -F` evaluates its condition
  inside the tmux server's command queue, and the branch's `send-keys -H` then only **enqueues** the
  bytes into the pane's pty buffer. tmux does not wait for the program to read them. So what is proven is:
  at the instant of the queue, the pane (by id), its shell pid, the foreground _command name_, the cursor
  row and liveness were what the owner was shown. What is NOT proven, and cannot be with tmux's formats:
  the foreground **process group** and the terminal's **echo flag** (tmux has no format for either), and
  anything that changes between the queue and the program reading the bytes. In that gap the foreground
  can become **any** command (a different name as well as a same-named replacement), echo can flip, and
  the prompt can change; the bytes then go to whatever reads the pty next. Unit tests pin each of these as
  a declared limit. One unit test pins the gap (`DECLARED LIMIT` in `terminal-target.test.ts`). The remaining defences are the owner's warning card, the risk flag, the
  short window and the masking above. The `if-shell` syntax itself is exercised against a real tmux
  in CI (`tmux-input-guard.test.ts`); if a tmux build rejects it the write fails closed as _uncertain_,
  never as a silent type.
- **A value cut by the capture window is not matched, which is why the quarantine exists.** The viewer
  masks what one capture holds; a value whose head scrolled out of the capture, or a fragment at a row
  edge, is not found as a whole. The quarantine hides the whole pane for the window, so this is only
  reachable after it ends, when the value has by then normally left the screen.
- **An uncertain write is not a retry.** If the single write fails or throws the owner is told the
  value may have been typed, and must raise a new request. Typing it again could put the password in
  the wrong place twice.
- **The value never appears in a process's arguments.** The guarded write (`tmux if-shell -F … send-keys -H`) is delivered on stdin to tmux, never in argv (#1115), so it is not readable from `/proc` or `ps`.
- **A saved login is as safe as the vault's key.** The sealed document sits beside the vault under the same
  key file: it fails safe when one file is copied somewhere, and protects nothing against someone with this
  user account ([secrets](secrets.md)). An agent that reads the admin token can deliver a saved login into a
  capture program it built; the card, the risk flag and the exact match make that visible, not impossible.
- **A 2FA seed beside its password is one factor.** That is why it is opt-in with the warning above.
- **Matching is exact and by the PROVED program.** `sudo@kirin-box` is the proved program's name and this machine's
  name; a terminal whose program is unverified has no key, so a shell that renames itself `sudo` never makes the sudo
  login the one-tap choice (the owner can still pick any entry by hand, under the amber "unverified" flag). A `ssh` destination is read from the command line and can be wrong; it then
  matches nothing.
- **No migration from the first saved-login format.** An index written before versioned keys (an entry with
  `password: true` and no `seals`) does not parse, so the store reads as damaged — it fails closed: nothing is
  typed from it, nothing is swept, and every sealed value stays masked. No saved logins exist in a release yet,
  so the premise is a fresh store; a daemon that has one must remove `login-entries.json` and
  `login-secrets.json` and save the logins again.
- **GAP: no QR import yet.** A 2FA seed is entered as text; reading it from an uploaded QR image is a
  follow-up.
- **GAP: the ferret's hint and the target's key are not journalled**, so after a restart a request is offered
  saved logins again from what is re-observed, without the hint.
- **The relay carrier is not known where the owner is identified.** A paired device is recorded as
  `direct` in the audit record even when it came over the relay. GAP: `INPUT_MAX_REMOTE_DELIVERIES_PER_HOUR`
  is declared but not enforced yet, which waits on the carrier being known.
- **Today's transcript.** If an agent `terminal_send`s a password itself, the harness transcript keeps
  it. This bridge is how an agent avoids doing that; it does not scrub what an agent already did.

## Phases

| Phase | What                                                                                                                                    | State       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| P0    | This contract and the schemas                                                                                                           | done        |
| P1    | Terminal secret and plain: service, agent tools, deliver and cancel, quarantine, `fy input`                                             | done        |
| P2    | The app card, cards of several fields, `chain` steps                                                                                    | done        |
| P3    | Saved logins (one tap), "Save as", 2FA codes, `fy account` (alias `fy secret entry`), Settings › Saved logins (now Settings › Accounts) | done        |
| P4    | Pages: browser fields, field shot, page holds, passkeys off, captcha handover                                                           | done        |
| P4b   | Login recipes: steps, daemon-observed facts, ferret proposals the owner approves                                                        | this change |
| P5    | Multi-step chains, consumer configuration, a per-daemon remote cap                                                                      | later       |
