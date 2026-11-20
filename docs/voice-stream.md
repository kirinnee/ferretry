# The voice stream wire format

Status: **the contract for slice B3a of &F1269. The codec is built; the route is not.** This document
owns the bytes of `/v1/voice/stream` — the start record, both fixed-size units, the control slot, the
fragment rules, the bounds and every refusal. [Voice modes and the daemon speech engine](design/voice-modes.md)
§1.5 and §3.1 own _why_ the stream looks like this; [the rendezvous protocol](relay-protocol.md) §14 ›
Stream sessions owns the session it rides in. Implement against this page, not against the code: the
code is `packages/protocol/src/lib/voice-stream*.ts`, and a test pins the constants table below to it.

Nothing here opens a route, loads a speech model or draws a pixel. The daemon route (B3), the worker
(B2) and the PWA wiring come in later slices and must read this page first. Opus (B6) later replaces the
uplink unit's PCM block with its own fixed unit and is **not** described here.

---

## 1. The shape, in one screen

```
browser                                                  daemon
 │  text record  : the start record (once, first)  ───────▶
 │  bytes records: uplink units, 1,344 B every 40 ms ─────▶
 │  ◀──────────── bytes records: downlink units, 1,024 B every 200 ms
```

- The stream is a §14 **stream session**: after `stream-opened`, both sides speak `data` records.
- The **first record the browser sends is one `text` record**, the start record (§2). It is the only
  `text` record either side ever sends. A second `text` record, or a `bytes` record before the start
  record, is a protocol error (§9).
- Everything after it is `bytes`. A `bytes` record is **a run of an ordered byte stream whose
  boundaries are not preserved** (§14 › Data): a carrier or a relay may deliver the units split in the
  middle or glued together. **Each side therefore re-assembles units from bytes and never relies on a
  record being a unit** (§7). The browser writes one whole unit per record, because it can; no reader may
  assume so.
- Both directions are **constant shape**: a unit of the same size at the same cadence for as long as the
  stream is open, whatever is said, muted or pressed. That is the whole reason the units are `bytes` and
  not `text`: a `bytes` record's base64url length depends only on its byte count, while a `text` record
  is JSON-escaped again inside the tunnel envelope and so varies in sealed length with its content (the
  round-2 review measured two 1,024-byte snapshots sealing to 1,056 and 1,136 bytes).

---

## 2. The start record

One `text` record, UTF-8 JSON, **at most 1,024 bytes**, exactly these three members and no others:

```json
{ "purpose": "dictation", "sessionId": "fy_…", "style": "after-stop" }
```

| Member      | Type                            | Meaning                                                                                                  |
| ----------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `purpose`   | `"dictation"` \| `"voice-chat"` | What the stream is for. The route decides what each purpose may do; the codec only carries it.           |
| `sessionId` | string, 1–128 characters        | The ferret session the words are for. Not interpreted by the codec.                                      |
| `style`     | `"after-stop"` \| `"real-time"` | When words may appear: once, after the person stops, or as they pause. Voice chat's route may ignore it. |

The schema is **strict**: an unknown member, a missing member, a value outside the enumerations or an
over-long `sessionId` is refused `start_invalid`. A record over 1,024 bytes is refused before it is
parsed. The codec validates the record; it does not decide whether this device may open this purpose —
that is the route's capability guard, upstream of the start record.

---

## 3. The uplink unit — browser to daemon

**Exactly 1,344 bytes**, one every 40 ms (25 a second), for as long as the stream is open.

```
offset   size   field
0        1280   PCM block: 640 samples, 16 kHz, mono, signed 16-bit, little-endian
1280        1   slot length L, 0..63
1281        L   control slot JSON, UTF-8
1281+L  63 − L  zero padding
                                                               total 1,344
```

- The PCM block is 640 samples = **40 ms**. Silence and muted time are **zero samples** — the unit is
  never shorter, never skipped.
- The **control slot** is bytes 1280..1343: one length byte, then up to 63 bytes of JSON, then zeros to
  the end. `L = 0` is the empty slot (no echo, no control) and is all zeros.

### 3.1 The control slot

The slot's JSON is one object with these members, compact (no spaces), in this order when encoded:

| Key | Type                      | Meaning                                                          |
| --- | ------------------------- | ---------------------------------------------------------------- |
| `n` | nonce (§5), 12 characters | **Echo** of the newest downlink nonce this browser has received. |
| `k` | control kind (below)      | **At most one** control in a unit.                               |
| `t` | unsigned 32-bit integer   | The turn the control is about (`shown`, `hold`, `send-now`).     |
| `r` | unsigned 32-bit integer   | The transcript revision (`shown` only).                          |

The members that go together, and nothing else:

| Slot JSON                                       | Meaning                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `{"n":"…"}`                                     | An echo and no control.                                                       |
| `{"n":"…","k":"shown","t":T,"r":R}`             | The words of turn `T`, revision `R`, are **on screen in full**.               |
| `{"n":"…","k":"hold","t":T}`                    | Hold: cancel turn `T`'s countdown, keep its words.                            |
| `{"n":"…","k":"send-now","t":T}`                | Send turn `T` now.                                                            |
| `{"n":"…","k":"muted"}` / `"unmuted"` / `"end"` | The microphone is muted (zero samples follow) / open again / End was pressed. |

`n` may be omitted — a browser that has received no downlink unit yet has nothing to echo — and then
the slot carries only the control. **The unit carries the newest nonce, every unit**: the echo is a
liveness proof (plan §1.5), so a unit that carried a control but skipped the echo would blind it. The
worst slot is `shown` with both integers at 4,294,967,295: **62 bytes** of JSON, one under the
63-byte limit. `{}` (a non-empty slot with nothing in it) is not a valid slot; the empty slot is
spelled `L = 0`.

### 3.2 Refusals — `decodeUplinkUnit`

A unit is refused (the stream is closed, §9) when:

| Code            | When                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `unit_size`     | It is not exactly 1,344 bytes.                                                                                       |
| `slot_length`   | `L` is above 63.                                                                                                     |
| `slot_padding`  | Any byte after the JSON, to the end of the unit, is not zero.                                                        |
| `slot_encoding` | The `L` bytes are not valid UTF-8, or not valid JSON.                                                                |
| `slot_shape`    | The JSON is not one of the shapes in §3.1: an unknown key, a wrong type, a bad nonce, an integer out of range, `{}`. |

---

## 4. The downlink unit — daemon to browser

**Exactly 1,024 bytes**, one every 200 ms (5 a second), for as long as the stream is open.

```
offset   size   field
0           2   N: the JSON length in bytes, unsigned 16-bit BIG-endian, 1..1022
2           N   UTF-8 JSON
2+N   1022 − N  zero padding
                                                               total 1,024
```

The length is big-endian (network order, like the browser stream's `FYBC` header); only the PCM
samples are little-endian, because that is the format recognisers take.

**Every unit is complete and parseable on its own**, but the transcript is assembled from every unit in
order: fragments are sent once (§6.1) and a gap is refused, so losing any unit is fatal for the stream —
there is no recovery from a later unit. The JSON object:

| Key | Type                                              | Required | Meaning                                                                                |
| --- | ------------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `n` | nonce (§5)                                        | yes      | A **fresh** nonce, new in every unit. The browser echoes the newest one it has seen.   |
| `s` | state (below)                                     | yes      | What the daemon is doing now.                                                          |
| `c` | countdown `{t, r, at, now}`                       | no       | A send is pending: turn `t`, revision `r`, at `at`.                                    |
| `d` | send id, 1–64 characters of `A–Z a–z 0–9 _ : . -` | no       | The message was sent; this is its stable send id (`<streamId>:<turnId>`).              |
| `e` | error code, `[a-z][a-z0-9_]{0,31}`                | no       | The turn failed out loud (`engine_behind`, `engine_timeout`, …). Not a protocol error. |
| `f` | fragment `{t, r, o, l, x}`                        | no       | A bounded piece of the turn's words (§6).                                              |

**State** is one of `listening` (microphone open, nothing heard), `hearing` (speech in progress; interim
words may follow), `finishing` (a pause was heard and the final decode is running), `counting` (words are
final and a countdown is running), `held` (a send was cancelled; the words are kept), `muted` (the
browser said so; the endpointer is paused). The daemon route may only add a state by amending this page.

**Countdown.** `t` is the turn, `r` the revision and `at` the instant it will send, as **unix
milliseconds on the daemon's clock**. The countdown also carries `now`, the daemon's unix milliseconds
**when it wrote the unit**, so a browser draws the bar from `at − now` against its own monotonic clock
and never from comparing `at` with its own wall clock, which a phone may have set minutes wrong. `at`
and `now` are non-negative safe integers. (The plan lists `{turnId, revision, sendAt}`; `now` is the one
member this page adds, for the reason in the previous sentence.)

**Integers.** `t`, `r` and `o`/`l` are non-negative integers; `t` and `r` are at most 4,294,967,295 (a
turn and a revision are counters the daemon increments, which §6's supersession rules rely on).

### 4.1 Refusals — `decodeDownlinkUnit`, `encodeDownlinkUnit`

| Code                                                       | When                                                                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit_size`                                                | A decoder is handed other than exactly 1,024 bytes.                                                                                                                       |
| `unit_length`                                              | `N` is 0 or above 1,022.                                                                                                                                                  |
| `unit_padding`                                             | Any byte after the JSON, to the end of the unit, is not zero.                                                                                                             |
| `unit_encoding`                                            | The `N` bytes are not valid UTF-8, or not valid JSON.                                                                                                                     |
| `unit_shape`                                               | The JSON is not the object above: an unknown key, a missing `n` or `s`, a wrong type or range, a bad nonce.                                                               |
| `fragment_total`, `fragment_text`, `fragment_inconsistent` | The unit's `f` fails §6.2's rules that need no other fragment (rules 1 and 5, plus the 700-byte text cap): a decoder applies them, so a bad fragment is fatal on arrival. |
| `unit_too_large`                                           | **Encoder only:** the JSON would exceed 1,022 bytes. The encoder answers an error; it never truncates.                                                                    |

---

## 5. Nonces

A nonce is **exactly 12 characters of unpadded base64url** (`A–Z a–z 0–9 - _`): 72 bits, made by a
caller from **9 random bytes** (`encodeVoiceNonce`). The codec holds no source of randomness — a nonce's
unguessability is the caller's job, because the codec is pure — and a nonce is meaningful only as the
daemon's record of what it issued (§8). The daemon issues a fresh nonce in every downlink unit; the
browser echoes the newest in every uplink unit.

---

## 6. The turn's words: fragments

A turn's words can be longer than one unit holds (240 words is ~1.3 KB; a turn may run 120 s). The unit
carries them as a **fragment** `f = {t, r, o, l, x}`:

| Member | Meaning                                                                            |
| ------ | ---------------------------------------------------------------------------------- |
| `t`    | The turn.                                                                          |
| `r`    | The revision of that turn's transcript. Any change to the words is a new revision. |
| `o`    | The fragment's **offset, in UTF-8 bytes**, into the revision's text.               |
| `l`    | The revision's **total length, in UTF-8 bytes**.                                   |
| `x`    | This fragment's text.                                                              |

### 6.1 Making fragments — `fragmentTurnWords`

- The text is cut on **code-point boundaries**: a surrogate pair, an emoji or a CJK character is never
  split, so every fragment is valid text and the offsets are real byte offsets.
- A fragment's `x` holds at most **700 bytes as the JSON string spells them** — the escaped form, so a
  quote counts two and a control character six. That cap, with the worst case of every other member
  (all integers at their maximum, a 64-character send id, a 32-character error code, a countdown and a
  fragment together), keeps the unit inside 1,022 bytes **by construction**; a test builds that worst
  case and asserts it.
- Fragments are contiguous: the first has `o = 0`, each next `o` is the previous `o` plus the previous
  `x`'s UTF-8 length, and the last ends at `l`. `l` is the same in all of them.
- A revision whose text is empty is one fragment, `o = 0, l = 0, x = ""`. Any other fragment has a
  non-empty `x`.
- **A text of more than 16,384 bytes (16 KB) is refused** (`fragment_total`) — far above 120 s of speech.
  The text must also be well-formed Unicode (no lone surrogate), else `fragment_text`.
- The daemon sends **one fragment per unit, in order**, a revision's pieces on consecutive ticks. A long
  turn therefore needs `⌈l / 700⌉` ticks (at the 16 KB ceiling, 24 ticks = 4.8 s, more when the text needs escaping). Once the last piece
  is sent the daemon sends no further fragment for that revision; a unit with no `f` says nothing about
  the words.

### 6.2 Reassembling — `applyVoiceFragment`, `TurnWords`

The browser keeps one assembly: the newest `(turnId, revision)` seen, the bytes so far, and whether it is
whole. A fragment is applied by these rules, in order; the first that matches decides:

1. `l` above 16,384, or `x` not well-formed text, or `x` over its 700-byte cap, or `o + length(x)` above
   `l` → refused (`fragment_total`, `fragment_text`, and `fragment_inconsistent` for the last two). Rules 1
   and 5 need no other fragment, so a decoder applies them already (§4.1).
2. **A lower turn than the assembly's**, or a lower revision of the same turn → refused
   (`fragment_inconsistent`): the stream is ordered, a stale fragment is the daemon's bug.
3. **A higher turn, or a higher revision of the same turn, starts a new assembly and drops the old
   one.** It must begin at `o = 0`; any other offset is refused. Its `l` is fixed from now on.
4. The **same** `(t, r)` continues the assembly: `l` must equal the assembly's, and `o` must equal the
   bytes received so far — a gap, a repeat or an overlap is refused (`fragment_inconsistent`). A
   fragment for a revision that is already whole is refused.
5. A fragment with `l > 0` and an empty `x` is refused (`fragment_inconsistent`): it would never finish.

A revision is **whole only when the bytes received equal `l`**; `l = 0` is whole on its first fragment.
Until then the assembly exposes its text so far for display but says `complete: false`. **A browser
sends `shown {turnId, revision}` only for a whole revision** — that is what makes the countdown wait for
a long turn's last fragment (plan §3.1).

---

## 7. Re-assembling units from bytes — `feedUplink`, `feedDownlink`

Each side runs a reassembler on the byte stream it receives (1,344-byte units on the daemon, 1,024 on
the browser).

- It is **fed arbitrary runs** — a unit cut anywhere, several units glued, a one-byte run — and yields
  every whole unit completed, **decoded** (§3, §4), in order. It holds at most one partial unit.
- **A run is at most 65,536 bytes** (`run_too_large`); the rendezvous protocol's §7 record cap is 65,492 and a real run is
  under 48 KiB, so this bounds the work of one feed. The internal buffer therefore never exceeds one
  unit's bytes less one, plus the run in hand.
- A unit that does not decode **fails the whole stream** — there is no resynchronisation, because
  units have no marker to resynchronise on. The caller closes the stream (§9).
- **A stream that ends mid-unit is an error** (`stream_ended_mid_unit`): the caller asks
  `finishVoiceReassembly`, and any buffered byte makes that fail. A stream that ends on a unit boundary
  ends cleanly.
- It is a value: every step takes the old state and answers the new one; nothing is mutated and no step
  throws.

---

## 8. The two rules the daemon must apply

Both are pure functions of values and a time the caller passes in; the codec reads no clock. **Every time
the caller passes — `now`, the shown receipt times, the nonce issue times and the rate arrivals — must come
from ONE monotonic clock domain**, separate from the wire's unix timestamps (the countdown's `at` and
`now`, which are the daemon's wall clock). An age is a difference inside that domain.

### 8.1 May a countdown send? — `mayAutoSend`

Plan §1.5. The daemon may send an automatic message only if **all** of:

1. **Not cancelled.** Hold, a close, a stream error, speech resuming, or the device's `voice.use` being
   narrowed has not cancelled it (the caller passes `cancelled`).
2. **Shown, for these exact words.** A `shown` control was received with this turn **and this revision**,
   and **at least 500 ms before now** (inclusive: exactly 500 ms is enough). A `shown` for an earlier
   revision of the turn does not count; if the words changed, a new `shown` is needed.
3. **Alive.** The newest nonce the daemon has seen echoed was **issued** by it **no more than 1,000 ms
   before now** (inclusive). An echo proves the phone was running after that nonce left the daemon.

`VoiceNonceLedger` keeps what rule 3 needs: the nonces issued in the last second (bounded, 16 at most) and the
issue time of the newest echoed one. An echo of a nonce the ledger does not hold — unknown, or forgotten — changes
nothing; one it still holds but that is old is recorded and simply can never allow a send. `mayAutoSend` answers `{allowed: true}` or `{allowed: false, reason}`
with the first failing rule: `cancelled`, `not_shown`, `shown_too_recent`, `no_echo`, `echo_stale`. **It fails
closed on a bad age**: a shown time or a nonce issue time in the future (a negative age), or any age that is not a
finite number, is `shown_too_recent` / `echo_stale` respectively — never "fresh enough".

### 8.2 Is the browser sending too fast? — `recordUplinkUnits`

A stream that sends more than **1.25× the nominal 25 units a second over any 5 seconds** is closed: more
than 156.25 units, so **157 units in any 5,000 ms window** exceeds it and 156 does not. `recordUplinkUnits` (over a `VoiceRateGuard`) is fed
the arrival time and count of each batch of units and answers whether the limit was exceeded; it holds at
most 157 timestamps. The window is 5,000 ms _exclusive at its old end_: a unit exactly 5,000 ms old no
longer counts. Burst slack is deliberate — a stalled relay may deliver ~1.3 s of units at once (§3.1 of
the plan) and stay inside the limit.

---

## 9. When it goes wrong

**Malformed is fatal.** Any refusal in §2, §3.2, §4.1, §6.2 or §7 on a byte the _peer_ sent closes the
stream; there is no skipping a bad unit. The codec returns the refusal as a value
(`{ok: false, error: {code, message}}`); the route turns it into a sealed `stream-close` (§14 › Ending a
stream) and then ends the session:

| What                                                                                                            | Close code                |
| --------------------------------------------------------------------------------------------------------------- | ------------------------- |
| A start record that is missing, a second `text` record, `bytes` before the start, any §3.2/§4.1/§6.2/§7 refusal | `1003` (unsupported data) |
| More than 1.25× the nominal rate over 5 s (§8.2)                                                                | `1008` (policy violation) |

The reason carried with the code is the refusal's `code`, never the content that was refused.

A **recoverable** failure is not a refusal: `e` in a downlink unit (`engine_behind`, `engine_timeout`,
…) fails one _turn_ and the stream goes on. The codes the plan names are exported as
`VOICE_STREAM_ERROR_CODES`; the field accepts any `[a-z][a-z0-9_]{0,31}` token so a route can name a new
one without a wire change.

**What is not specified here:** the credit and queue bounds (plan §3.1 — 32 frames, 2 s of audio, 5 s
for a final decode), admission (1 stream per device, 2 per machine), the 120 s turn and 2 h stream caps,
and what a relay can see (plan §3.4, to be added to `relay-protocol.md` §10 by B3). They belong to the
route, the worker and the relay document.

---

## 10. Constants

Named once, in `packages/protocol/src/lib/voice-stream.ts`; a test reads this table and fails if a value
here and the exported constant disagree.

| Constant                           | Value      | Meaning                                                       |
| ---------------------------------- | ---------- | ------------------------------------------------------------- |
| `VOICE_UPLINK_PCM_SAMPLES`         | 640        | Samples in one uplink unit.                                   |
| `VOICE_UPLINK_PCM_BYTES`           | 1280       | Bytes of PCM in one uplink unit.                              |
| `VOICE_UPLINK_SLOT_BYTES`          | 64         | The control slot, length byte included.                       |
| `VOICE_UPLINK_SLOT_JSON_MAX_BYTES` | 63         | The most JSON a slot holds.                                   |
| `VOICE_UPLINK_UNIT_BYTES`          | 1344       | One uplink unit.                                              |
| `VOICE_UPLINK_UNIT_INTERVAL_MS`    | 40         | Nominal cadence of the uplink.                                |
| `VOICE_UPLINK_UNITS_PER_SECOND`    | 25         | The nominal rate.                                             |
| `VOICE_DOWNLINK_UNIT_BYTES`        | 1024       | One downlink unit.                                            |
| `VOICE_DOWNLINK_LENGTH_BYTES`      | 2          | The downlink length prefix.                                   |
| `VOICE_DOWNLINK_JSON_MAX_BYTES`    | 1022       | The most JSON a downlink unit holds.                          |
| `VOICE_DOWNLINK_UNIT_INTERVAL_MS`  | 200        | Nominal cadence of the downlink.                              |
| `VOICE_FRAGMENT_TEXT_MAX_BYTES`    | 700        | The most escaped text bytes in one fragment.                  |
| `VOICE_TURN_WORDS_MAX_BYTES`       | 16384      | The most UTF-8 bytes one revision may have.                   |
| `VOICE_NONCE_CHARS`                | 12         | A nonce's length.                                             |
| `VOICE_NONCE_RANDOM_BYTES`         | 9          | The random bytes a nonce is made from.                        |
| `VOICE_START_RECORD_MAX_BYTES`     | 1024       | The longest start record.                                     |
| `VOICE_REASSEMBLER_MAX_RUN_BYTES`  | 65536      | The longest run one feed may carry.                           |
| `VOICE_SHOWN_MIN_AGE_MS`           | 500        | How long `shown` must have been received before an auto-send. |
| `VOICE_ECHO_MAX_AGE_MS`            | 1000       | How old the newest echoed nonce's issue time may be.          |
| `VOICE_RATE_WINDOW_MS`             | 5000       | The window the rate guard counts over.                        |
| `VOICE_RATE_MAX_UNITS`             | 156        | The most units allowed in one window (157 closes the stream). |
| `VOICE_COUNTER_MAX`                | 4294967295 | The largest turn or revision counter (unsigned 32-bit).       |

---

## 11. Declared gaps

- **No route, worker or PWA uses this yet.** The codec is proved by its own tests, not on a wire.
- **The sealed sizes are not measured here.** B3 tests the sealed frame sizes and gaps on the wire; this
  slice proves only that a unit's byte count is fixed and that base64url length is a function of it.
- **`now` is added to the countdown** beyond the plan's three members (§4); the route slice may keep or
  drop it, but must then say how the browser draws a countdown without comparing two clocks.
- **The state list is a first proposal** (§4); B4 and B5 may amend it here.
- **A browser that echoes a nonce late looks dead.** That is the rule working (plan §1.5), not a bug.
