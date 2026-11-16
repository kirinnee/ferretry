# The Claude channel

How a ferret's message, or the daemon's own, reaches a **Claude Code** ferret without being typed into its composer,
and what happens when it cannot. Owner ruling (2026-11-15): _no hooks, they are too buggy; if channels do not exist, go
back to pasting and sending — but the sender checks every second and never types into a pane that is compacting, behind a
dialog or consent prompt, or holding text._

## What a channel is

Claude Code 2.1.317 lets an MCP server declare `capabilities.experimental["claude/channel"]` and push
`notifications/claude/channel` `{ content, meta }` into the running session. Ferretry's per-session MCP server
(`fy mcp serve`, registered as `ferretry`) does exactly that.

Measured live (personal `claude_max` login):

| Case             | Result                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Idle             | delivered in 13–20 ms and starts a turn                                                                           |
| Busy             | delivered at the next tool boundary (3.8–6.2 s behind 7 s tools), in order, none lost                             |
| Transcript, send | a `queue-operation` `enqueue` line carrying `<channel source="ferretry" …>\nTEXT\n</channel>` at once (even busy) |
| Transcript, idle | `{"type":"user","origin":{"kind":"channel","server":"ferretry"},"isMeta":true,…}`                                 |
| Transcript, busy | an `attachment` `queued_command` with the same origin                                                             |

It needs the launch flag `--dangerously-load-development-channels server:ferretry` (plain `--channels` refuses an
unlisted server), and Claude then shows a **startup dialog on every launch** ("I am using this for local development /
Exit"). The daemon answers it with option 1 and never with Exit (`docs/harness-dialogs.md`). The launch setting that
turns the flag on, and its default per login kind, are in `docs/launch-settings.md`.

A busy model may treat a channel message as "not from the user" and ignore it, so the server's `instructions` say
plainly that messages inside `<channel source="ferretry">` come from Ferretry and other ferrets and are to be acted on as
work messages from those senders (each carries its sender banner); the owner's own words arrive as normal prompts.
A meta key named `source` would collide with the tag's own attribute, so none is ever sent (`send_id`, `from` only).

## The two halves

**The MCP server polls — only when the launch gave Claude the flag.** The same launch that passes
`--dangerously-load-development-channels` sets `FERRETRY_CHANNEL=1` in the tools server's own `--mcp-config` environment, and
**in no other case**. Without it `fy mcp serve` is a plain tools server: it declares no channel capability and **never
polls**, so a launch that dropped the flag (`channels: false` in `harness-claude-code.yaml`, or an Enterprise login) can never look like a listening
channel. With it, after `initialized` the server holds `channel_poll` open (an agent tool served by Conversation, called as
the session; it names the server's **generation**, a fresh id per process) and gets **candidates**. For each one it calls
`channel_claim` **right before writing** the notification — `content` is the exact text that would have been typed, banner
line included — and writes it only if the daemon grants the claim. Neither tool is in the list a model reads.

A claim is **never proof of arrival**. Only Claude's own transcript is.

**Conversation decides who may use it.** A message goes through the channel only when **all** hold:

- it is an **agent's** send (a ferret speaking) or a **daemon notice / Agenda** message — never the owner's words, never
  the Warden's composer acts, never a send-now;
- the recipient is a **Claude** ferret;
- its MCP server is **connected** (a poll is open, or one ended within 5 s) and its channel has **not been marked broken**.

Otherwise it is typed, exactly as before.

## Two-phase hand-out: no late push

A poll answer can be delayed in transit. If the fallback typed a message meanwhile and the late answer then made the server
push it, the ferret would read it twice. So a poll only **offers**; the server must **claim** each candidate, and the daemon
grants a claim **only if** the message was not withdrawn **and** the caller is still the current subscriber (its
generation — a restarted server, or a daemon restart, invalidates the older claims). A claimed message is **never
withdrawn**; it is resolved only by the transcript's receipt, or by the receipt window running out (below).

## Proof, and the one fallback

A channel send is ledgered with path `channel` and nothing is typed. The tracker proves it from the transcript only:

1. **Receipt** — the `enqueue` line for its text. The send is then `queued`, **never typed again**, and the ferret's channel
   is **proven** (Claude measurably takes channel messages; it enqueues one immediately even when busy, and drops a
   refused one for good).
2. **Delivered** — the `user` entry (idle) or the `queued_command` (busy).
3. **No receipt within `channelReceiptMs` (10 s)** — counted from the server's claim (from the send, when it never claimed):
   nothing is known to have reached Claude. The tracker reads the transcript **once more**, and only if the receipt or
   delivery is still absent does the fallback run. A transcript that cannot be read is never a reason to type; it waits
   `channelUnreadableMs` (30 s), then says the send is unconfirmed.
4. **The fallback moves the SAME ledger row.** Under the ferret's send lane the row goes from `channel` to the typing path
   (`direct`, accepted, **untyped**) in **one** settle — never withdraw-then-new — and only then is it typed. A crash, a
   failed bind or a question refusal after that settle leaves a row the tracker still retries every second, typed once;
   before it, the row is still a channel row and the next look tries again. A failure is logged with ids, never swallowed.
5. **A claimed message that went unreceived marks the channel broken.** Claude is not taking channel messages (a dropped
   flag, an organisation policy). Nothing more is routed through that ferret's channel until its server is relaunched (a new
   generation polls), and what was waiting is typed. An unclaimed message is simply withdrawn and typed.

## The typing path and its three checks

Typing is the fallback and still the way the owner's own messages travel. Before every try the pane must be **not
compacting** (`routeSend` reads it as busy; a first send is kept `untyped` instead of queued), have **no dialog or consent
prompt** (`waitReady` / `blockedByDialog`), and have an **empty composer** (`ComposerOccupied`; for a ferret's message a
non-empty composer also keeps it `untyped`; the owner's own draft is refused with the app's Clear / Send choice). A send
that fails a check is kept `untyped` and the tracker looks again **every second** (`untypedLookMs`, `deferredNudgeMs`),
typing it on the first look after the pane is safe. The stuck alarm (2 min) and its screen snapshot are unchanged.

## Gate

Personal `claude_max` logins pass it. A Team/Enterprise organisation's `channelsEnabled` policy (default off) would
block it, which is why the setting defaults **off** for every login that is not `claude_max` (read per login from its own
account file; `docs/launch-settings.md#the-claude-channel`).

## Era

Claude Code 2.1.317 drops channels on a "modern" connection era (a discover-handshake kind) and keeps them for "legacy"
servers that open with the classic `initialize` request over stdio. `fy mcp serve` speaks the classic `initialize`
(`tools/list`, `tools/call`, `ping`; no discover handshake), so it is the legacy era and keeps the channel.

## Reading it in the app

The transcript reader unwraps `<channel source="ferretry" …>TEXT</channel>` (both forms above) **only for our server
name**; the sender banner inside TEXT then attributes the message to its ferret, and a daemon notice shows as
"Ferretry · Delivery". Another server's channel keeps its wrapper.
