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
  it reads the body, and the service refuses again unless the actor is `admin-cli`, `admin-ui` or a
  paired device. A remote device follows the owner's "ask again for each change" setting; there is no
  separate passkey act.
- **Retries never type twice.** Each Send carries a `deliveryId`; the daemon remembers its outcome (no
  value) for the request's life. A second id after delivery is 409 `already_delivered`.
- **Re-observe before inject.** Deliver compares the target with the facts the owner was shown
  (`observedDigest`). Any difference is 409 `target_changed` and nothing is written. Three failed
  checks end the request.
- **One write.** A terminal delivery is one hex `send-keys -H` write of the value, plus `\r` when the
  owner wants Enter pressed (on by default for a terminal secret, off for a browser).
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
