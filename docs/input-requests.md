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
  line with its digest, and `recognisedConsumer`. For a page: the page, its origin and whether it is
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
| `private` | A code that echoes (a 2FA code typed into a terminal).                                                                                                                           | Never refused: the card flags it amber ("This code will show on screen while the terminal is hidden from the ferret for 2 minutes."). Quarantine and masking apply exactly as for `secret`. Same hard refusals as `secret`.                      |

`secret` and `private` values containing a control character or a line break are refused
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
  (`plain` → the username, `secret` → the password, `private` → the 2FA code). Only a saved login that
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

| Level | When                                                                                                                                                                        |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| green | A `secret`, echo off, and a recognised program (`sudo`, `ssh`, `gpg` and so on).                                                                                            |
| amber | A `secret` with echo on (the value will show on screen), echo unknown, an unrecognised program or the bare shell.                                                           |
| amber | A `private` code (it echoes): "This code will show on screen while the terminal is hidden from the ferret for 2 minutes."                                                   |
| amber | A page field: the page is not https, the field is in a frame from another site, a `secret` is going into a field that is not a password field, or the field cannot be seen. |
| green | A page's `secret` going into a password field on a secure page.                                                                                                             |
| red   | A `plain` value: "Not secret: the ferret can see this value."                                                                                                               |

The flag is computed from what the daemon observed, when the request is raised and again when it is
restored. Send is available at every level. The only refusals are a control character or line break in
a `secret` or `private` value ("this would press keys"), a target that changed since the card was drawn (`target_changed`),
and a caller who is not the owner. A `private` code is always flagged amber.

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
  the facts are checked again at delivery (the compare-and-enqueue check below). A `private` code is allowed and flagged amber, with the same quarantine.

### How long the lock lasts

The owner chose an **adaptive** lock (!A149). The card shows its length and why ("Hidden from the ferret for 10 s
after typing. …"), from `request.lock` (`InputLockSchema`: `seconds` and a fixed `reason`); the agent learns the
seconds (`lockSeconds`). It is decided only from what the daemon observed (`packages/daemon/src/lib/input-requests/lock.ts`):

| Reason            | Lock  | When                                                                                                                                                                                                                                                                                                 |
| ----------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hidden-terminal` | 10 s  | A LOCAL password prompt: echo off AND line (canonical) mode, the program is sudo, sudoedit, su, doas or passwd, and it runs setuid root (effective uid 0, real uid not), which a script or binary the ferret wrote cannot. ssh, docker, psql and every readline or raw-mode program are never short. |
| `proven-field`    | 10 s  | A submitted value into exactly the page fields below, AND a saved login's facts for that very field identity say masked, no echo after submit and moved on, with no record saying otherwise.                                                                                                         |
| `probed-field`    | 10 s  | One password field as below, and the daemon's **dummy probe** at raise came back clean.                                                                                                                                                                                                              |
| `code`            | 120 s | A one-time code (`private`): it shows as it is typed.                                                                                                                                                                                                                                                |
| `not-proven`      | 120 s | Anything else, every probe that did not run cleanly, an unreadable login store, a ferret that could have steered the page.                                                                                                                                                                           |

A page field qualifies when every secret field is a visible, uncovered `input type=password` on a secure page, in the
page's own origin, with no human check showing.

- **Masking does not shorten.** The redaction window stays 10 minutes whatever the lock; the owner can still end a
  lock early or reveal.
- **A card never shortens at the write.** The lock is decided again from the facts seen at Send and the longer of
  that and the card's is used. A card redrawn onto a re-rendered field drops its probe result.
- **The ferret's own steering voids a page's proof**: a session that ever ran a page script never gets a short page
  lock and is never probed, and at Send any act of the ferret on a page since the card was raised voids it.
- **A terminal's OBSERVED facts never shorten it** (a program the ferret placed can carry the right name). Only the
  card's own facts do, and only for a setuid-root password program.
- **The dummy probe** runs on a page card only, for exactly ONE secret field, after the field picture and before the
  owner is asked, inside the page's own queue. It is skipped for a session that ran a page script, for any card with a
  one-time code, and for a field whose `autocomplete`, `name` or `id` says code, PIN, OTP, 2FA, verification, CVV or
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

A `secret` or `private` value typed into a page holds that page for the same window as a terminal
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
`packages/protocol/src/lib/login-entries.ts`; the store is `packages/daemon/src/lib/secrets/logins.ts`.

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
- When the entry a page is for signs in through a provider, the owner's card says so ("Sign in with Google via
  'Google (kirin@…)'", `InputSaved.signIn`), and the provider's login is **not** offered as the one tap there:
  it is typed only on the provider's own domain.

### The ferret's hint: `account_hint`

`account_hint` and `account_propose` were `login_hint` and `login_propose`; the daemon still accepts the old tool names, read as the new ones through the same checks.

Before a sign-in, a ferret calls **`account_hint`** (a page by name, so the daemon reads the host from where the page
**is**, or a site) and gets each entry for that site and the provider entries they go via: **handle, label,
method, login domains and the plain username**, and its [recipe and observed facts](#login-recipes-how-it-signs-in-and-what-the-daemon-saw). Never a password, a seed, a code, nor even which secret fields
exist (`LoginHintSchema` has no field for one). Every hint ends "passkeys are off". The owner sees the same words
with `fy account hint <site>`; the route is `GET /v1/secrets/logins/hint?site=` (`secrets` use). It is
not more than a ferret could list before (`GET /v1/secrets/logins` was already readable with the admin token);
it is a narrower view, offered at the moment it helps.

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
  saved login (one tap, or a "Save as"), never from an agent's words, per place (a web host or a terminal's key):
  - `masked`: every secret field was a password input, or the terminal had echo off and a recognised program read it.
  - `noEchoAfterSubmit`: 1.5 s and again 5 s after the submit the daemon read what a ferret's read of the target could
    show, and the value was in neither (both looks must be able to tell; one that cannot leaves no fact). For a page: the main frame's visible text, its accessibility snapshot (what
    text fields hold, accessible names) and the document's markup (attributes, hidden text); a page too large to read
    whole answers "cannot tell", never "not there". For a terminal: the screen and 50 rows above it. The value never
    leaves the daemon for this; the look answers yes or no, and what it read is dropped.
  - `navigatedAway`: the page showed a new document within 10 s of the submit.
  - `secondFactor`: `code` (a one-time code card was typed on the same login soon after), `push` (the page waited on
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
- **The ferret proposes, the owner decides.** After a sign-in a ferret may call `account_propose` (`login`, the whole
  new `recipe`, `why`). The proposal waits on the entry (three at most; a fourth pushes out the oldest and closes its
  card) and on an agenda card that shows the changed lines and "The ferret says: …". **The card approves nothing**:
  the owner approves or declines in Settings › Accounts › the login › Recipe, or with
  `fy account recipe approve|decline <id> <proposal>`, through the owner-only
  `POST /v1/secrets/logins/:id/recipe/proposals/:proposalId` (`secrets` configure, a kept `secrets.changed` record).
  An approval is refused (`stale_proposal`) when the recipe changed after the proposal was made, because the owner
  was shown a diff from the older text. Only an owner who turns **auto-apply** on for that ONE login lets a proposal
  apply at once; that is audited (`login-recipe-auto`) and marked as the ferret's.
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
`GITHUB_COM`); both are editable, and an existing entry can be chosen instead ("Save to … new or existing").

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
  a delete, `fy account` (alias `fy account`) — runs its read, merge and write in one store-wide queue (`LoginStoreLock`), so
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
for `ssh`, `scp` and `sftp`), or the web host for a page. A saved login whose `match` contains that key
**exactly** is **matched**, and the card offers it as the primary action, **"Use saved <label>"**, next to
"Type a different one".

- **The tap is the permission.** Nothing is typed until the owner taps. Every rule of a delivery applies
  unchanged: owner only (twice), the `deliveryId`, the target re-observed and compared, the tmux guard, one
  hex write, the quarantine, the risk flag. The value is opened **inside the daemon**, after every check that
  can refuse without typing, and goes only into that write.
- **A saved value never passes through the app.** The card sends the entry's handle; the daemon resolves it.
- **Which field it fills** follows the request: the password for a `secret`, the 2FA code for a `private`
  request, the username for a `plain` one. An entry that does not hold that field is not offered.
- **A mismatch is never the primary.** A look-alike program, another host or another site is not matched;
  every entry that holds the field stays **selectable by hand**, because the owner may know better.
- **The ferret may hint** (`secretHint` / `secret_hint`): the card marks that entry as "the ferret suggested
  this", but a hint never makes an entry matched, and the agent's answer is the same whether the entry exists.
- **The agent learns `source: saved`** from the delivery and nothing else: not the handle, not the label, not the
  value. What it may know beforehand is the [hint](#the-ferrets-hint-account_hint): metadata, never a value.

### 2FA seeds (opt-in, per entry)

An entry may keep a TOTP seed (RFC 6238; SHA-1, 6 digits and 30 seconds unless the setup page says otherwise).
The daemon makes the current code when the owner taps Use on a `private` request and types it like any
`private` value; the seed never leaves the use boundary. It is **off by default**, and adding one requires an
explicit confirmation of this sentence (`LOGIN_TOTP_WARNING`), shown in the app and the CLI:

> Keeping the password and the 2FA seed in the same place means one compromise of this machine's vault
> defeats both factors.

### Managing them

Settings › Secrets › Saved logins and `fy account ls|add|edit|rename|rm|recipe` (`fy account …` is a hidden alias for one release) list entries (never values),
add and edit the label, match, sign-in method (`--method`, `--via`, `--sso-name`), login domains (`--domain`)
and username, replace a password, add or remove a 2FA seed, rename the handle and
delete. Values are typed into a masked field or read from the TTY with echo off; never a flag.
Routes: `GET /v1/secrets/logins`, `GET /v1/secrets/logins/hint?site=`, `PUT /v1/secrets/logins/:id` (create or change; an omitted field is kept,
`null` removes it), `POST /v1/secrets/logins/:id/rename`, `DELETE /v1/secrets/logins/:id`, `POST /v1/secrets/logins/:id/recipe/proposals/:proposalId`, all `secrets`
capability (`use` to list, `configure` to change) and each change a kept `secrets.changed` record.

### Later, and off by default: standing permission

Placing a saved login **without a tap** is not built. A later phase may add it as an explicit owner opt-in,
per entry and per target ("standing permission for `SUDO_KIRIN_BOX` on `sudo@kirin-box`"), **off by
default**, revocable, and audited on every use. Until then every placement is a tap.

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
- **A browser `private` code can appear in an after-screenshot** (a later phase).
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
- **Matching is exact and by name.** `sudo@kirin-box` is the program's name and this machine's name; a
  program that renames itself `sudo` matches. The risk flag and the daemon-observed facts on the card are the
  defence, as for a typed value. A `ssh` destination is read from the command line and can be wrong; it then
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

| Phase | What                                                                                                     | State       |
| ----- | -------------------------------------------------------------------------------------------------------- | ----------- |
| P0    | This contract and the schemas                                                                            | done        |
| P1    | Terminal secret and plain: service, agent tools, deliver and cancel, quarantine, `fy input`              | done        |
| P2    | The app card, cards of several fields, `chain` steps                                                     | done        |
| P3    | Saved logins (one tap), "Save as", 2FA codes, `fy account` (alias `fy account`), Settings › Saved logins | done        |
| P4    | Pages: browser fields, field shot, page holds, passkeys off, captcha handover                            | done        |
| P4b   | Login recipes: steps, daemon-observed facts, ferret proposals the owner approves                         | this change |
| P5    | Multi-step chains, consumer configuration, a per-daemon remote cap                                       | later       |
