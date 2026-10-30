# Input requests: typing a secret without handing it over

An agent stuck at a password, `sudo`, OTP or 2FA prompt raises an **input request** naming its own
terminal (a browser field comes later). The **daemon**, not the agent, records what is actually
there. The owner sees an agenda card, types the value or picks a saved secret, and presses Send. The
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
| Disk (the bridge's own files)                    | **Never**, unless the owner ticks "save as secret NAME": then only the encrypted vault.               |
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

- **`InputRaiseSchema`**: what the agent says: the target (`%terminal:<key>`), a prompt of at most
  280 characters, a `sensitivity` and a `submit` mode. Nothing the daemon observes is accepted from
  the agent.
- **`InputTargetFactsSchema`**: what the daemon saw: for a terminal, the pane proof, the foreground
  program (pid, pgid, `comm`, argv), `echo` (`off`, `on` or `unknown`), the cursor row, the prompt
  line with its digest, and `recognisedConsumer`. For a browser (a later phase): the page, origin,
  frame origin, navigation, node, field attributes, box and visibility.
- **`InputRequestSchema`**: the aggregate: ids, target, prompt, sensitivity, expiry, the facts and
  their digest while observed, the state and the outcome.
- **`InputDeliverBodySchema`**: `deliveryId` (a UUID), `observedDigest`, **exactly one of** `padded`
  or `secretName`, `submit`, and `saveAs` (a typed value only).
- **`InputAgentViewSchema`**: what the agent learns: state, whether Enter was pressed, `source`
  (`typed` or `saved`) and a redacted screen. **Never** the value, its length or a saved secret's
  name.
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
shows it as the terminal shows it. The card says it is visible to the ferret; nothing about it is
hidden. Handing the value back in the agent's result arrives with the multi-field card (P2).

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
  safely is refused. Three failed checks end the request. **What tmux cannot bind** is in the honest
  limits below.
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

## The risk is flagged, never a reason to refuse

The owner can always be asked. A rogue program can print `[sudo] password for kirin:` itself, so the
card draws what the **daemon** observed (`sudo` is reading it, typing is hidden) large and what the
**agent** wrote small, and carries a **risk flag** with one fixed sentence that says what the risk is
(`request.risk`: a level and a reason; the sentence never contains terminal text):

| Level | When                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------- |
| green | A `secret`, echo off, and a recognised program (`sudo`, `ssh`, `gpg` and so on).                                          |
| amber | A `secret` with echo on (the value will show on screen), echo unknown, an unrecognised program or the bare shell.         |
| amber | A `private` code (it echoes): "This code will show on screen while the terminal is hidden from the ferret for 2 minutes." |
| red   | A `plain` value: "Not secret: the ferret can see this value."                                                             |

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

When a `secret` is delivered the terminal is **quarantined** for `INPUT_QUARANTINE_SECONDS` (120) from
the write:

- **Nobody reads it through an ordinary tool.** `terminal.read` and `terminal.wait` are refused with a
  `conflict` error that says when the quarantine ends, for the agent **and for the owner's ordinary
  terminal-tools endpoint** (`POST /v1/sessions/:sessionId/surfaces/terminals/tools`); the owner's way to
  look is the viewer's "Show anyway", which is audited. The agent can still send keys.
- **ONE publication gate, asked where a result is published.** Whatever is derived from a pane is checked
  again, synchronously, at the point it leaves the daemon: after every awaited capture, redaction, batch,
  audit record and wait tail, and before it is returned, matched against a predicate, sent as a stream
  frame (full, delta, re-attach and the second capture of a redraw) or remembered as the last frame sent.
  A screen read before the quarantine began is discarded if the quarantine began before it was published.
- **Every projection of what the daemon saw is covered.** While a pane is quarantined the prompt line, the
  program name and the argv in the card, the owner's list, the agent's view, the audit record and a
  restored request are replaced with a notice, not just masked.
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
- **The value is briefly visible to `ps`.** Delivery is one `tmux send-keys -H` call, so the value's hex
  is in that process's arguments for the instant it runs. It is the same limit the terminal's own
  keystroke write has today.
- **Saved secrets are refused for now.** A deliver body that names a vault secret instead of typing a
  value answers 400 until P3.
- **The relay carrier is not known where the owner is identified.** A paired device is recorded as
  `direct` in the audit record even when it came over the relay. GAP: `INPUT_MAX_REMOTE_DELIVERIES_PER_HOUR`
  is declared but not enforced yet, which waits on the carrier being known.
- **Today's transcript.** If an agent `terminal_send`s a password itself, the harness transcript keeps
  it. This bridge is how an agent avoids doing that; it does not scrub what an agent already did.

## Phases

| Phase | What                                                                                        | State       |
| ----- | ------------------------------------------------------------------------------------------- | ----------- |
| P0    | This contract and the schemas                                                               | done        |
| P1    | Terminal secret and plain: service, agent tools, deliver and cancel, quarantine, `fy input` | this change |
| P2    | The app card                                                                                | later       |
| P3    | Saved secrets (one tap) and "save as"                                                       | later       |
| P4    | Browser fields, and the agent-instruction extension for the browser                         | later       |
| P5    | Multi-step chains, consumer configuration, a per-daemon remote cap                          | later       |
