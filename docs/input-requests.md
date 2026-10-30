# Input requests: typing a secret without handing it over

An agent stuck at a password, `sudo`, OTP or 2FA prompt raises an **input request** naming its own
terminal (a browser field comes later). The **daemon**, not the agent, records what is actually
there. The owner sees an agenda card, types the value or picks a saved secret, and presses Send. The
daemon re-checks the target and types the value **straight into it**, optionally pressing Enter.

The wire contract is `packages/protocol/src/lib/input-request.ts`. This page says what it means and
what it does not promise. It is a **contract**: the daemon, the CLI and the app implement against it.
Which parts are live is the phase table at the end.

## The one rule

**The value never passes through the agent, a tool call, the transcript, the journal, `agenda.json`,
the audit log, a push payload or disk.** This extends [secrets](secrets.md) ("use, never read"): no
route, command or API returns a value or a digest of one, and nothing logs a body.

| Place                                            | Holds the value?                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Agent context, tool calls, harness transcript    | **Never.** No agent tool takes or returns it.                                                     |
| `agenda.json`, journal, audit log, push, ledgers | **Never.** The schemas have no field for it, and a test walks every schema to keep it that way.   |
| Disk                                             | **Never**, unless the owner ticks "save as secret NAME": then only the encrypted vault.           |
| The app                                          | Only the controlled field until Send. Cleared on send, on unmount and when the page is hidden.    |
| The wire                                         | Only inside the end-to-end sealed carrier, **padded** to a 256-byte bucket (see below).           |
| Daemon RAM while handling                        | From body parse to inject. No reference is kept after the handler returns.                        |
| Daemon RAM, the **redaction window**             | The one retained copy: a per-session map, 10 minutes by default and 60 at most. Never serialized. |
| The target                                       | It now lives in the target program. That is the point.                                            |

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

| Value     | Meaning                                                       | Checks                                                            |
| --------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `secret`  | A password, passphrase or token. Redacted, never shown back.  | Echo must be **off** (unknown counts as on), or a password field. |
| `private` | An OTP, 2FA code, username or email. Redacted for the window. | The field must be a real input.                                   |
| `plain`   | A hostname, `y`. Not sensitive.                               | Target binding only.                                              |

`secret` and `private` values containing a control character or a line break are refused ("this would
press keys"). `plain` allows Tab. `inputValueProblem` is that rule.

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
  same step as the write: the pane (by id), the pane's shell pid, the foreground command name, the
  cursor row and "the pane is not dead". Any mismatch types nothing and answers 409 `target_changed`;
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

## Phishing is made visible

A rogue program can print `[sudo] password for kirin:` itself. The card therefore draws what the
**daemon** observed (`sudo` is reading it, typing is hidden) large and what the **agent** wrote
small. A `secret` request read by the bare shell, an interpreter, `cat`, `tee` or any unrecognised
program shows an amber warning and keeps Send off until the owner ticks "I trust this program". It is
a warning, not a refusal.

## The relay can see sizes

The relay sees message sizes. The value is length-prefixed and padded to the next 256-byte boundary
(`padInputValue`, read back by `unpadInputValue`), so a short and a long password look the same.

## Redaction

The daemon holds each delivered value in RAM, for the window above, and masks it as
`[redacted:input !A7]` wherever it scrubs text: the operator's screen, transcript and journal reads,
and the agent's `terminal.read` and `terminal.wait`. Redaction fails closed.

- **The same text is scrubbed everywhere.** The ephemeral window and the vault's `SecretRedactor` are
  composed into one redactor (`EphemeralAwareRedactor`), and the operator's list and read routes go
  through it, so an owner read never shows what an agent read hides.
- **`terminal.wait` tests scrubbed text.** Its predicate runs on the redacted screen, so waiting for a
  prefix of the value never reveals whether the screen holds it.
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
  masked in each row it sat in. A redactor that fails closes the stream.
- **Captures keep their trailing spaces until masked.** The viewer capture and the prompt-line read use
  `capture-pane -N`, so tmux does not trim a value typed with trailing spaces before it is matched;
  the trailing spaces are dropped only after masking. Values of one or two characters count half of
  themselves as a piece, so `ab ` cut at the edge of a row is still found.
- **The trust set never holds a program name.** The trusted-program set is keyed by the keyed digest of
  the name, so a foreground program whose name is itself a typed value is not kept after the window or
  the session ends.
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
  with a saved secret. The bridge makes **accidents impossible and phishing visible**. It is the same
  boundary `sudo` has ([secrets](secrets.md)). Answering and cancelling are owner-only by an
  honest-client rule, as everything under the admin token is.
- **A hand-typed value is masked for the window only.** Afterwards a program that echoes it is not
  masked, unless the value was saved to the vault.
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
  a declared limit. The remaining defences are the owner's warning card, the trusted-program gate, the
  short window and the masking above. The `if-shell` syntax itself is exercised against a real tmux
  in CI (`tmux-input-guard.test.ts`); if a tmux build rejects it the write fails closed as _uncertain_,
  never as a silent type.
- **A value cut by the capture window is not matched.** The viewer masks what one capture holds. A value
  that wrapped so that only its tail is left in the first captured row (its head scrolled out of the
  capture) is not found as a whole. The prompt-line projection catches pieces at the edge of its own line,
  the viewer does not.
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

| Phase | What                                                                                    | State       |
| ----- | --------------------------------------------------------------------------------------- | ----------- |
| P0    | This contract and the schemas                                                           | done        |
| P1    | Terminal secret: the daemon service, agent tools, deliver and cancel routes, `fy input` | this change |
| P2    | The app card                                                                            | later       |
| P3    | Saved secrets (one tap) and "save as"                                                   | later       |
| P4    | Browser fields, and the agent-instruction extension for the browser                     | later       |
| P5    | Multi-step chains, consumer configuration, a per-daemon remote cap                      | later       |
