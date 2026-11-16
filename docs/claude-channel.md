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

**The MCP server polls.** After `initialized` it holds `channel_poll` open (an agent tool served by Conversation, called as
the session) and forwards each message it gets as one notification — `content` is the exact text that would have been
typed, banner line included — then calls `channel_ack`. Neither tool is in the list a model reads.

**Conversation decides who may use it.** A message goes through the channel only when **all** hold:

- it is an **agent's** send (a ferret speaking) or a **daemon notice / Agenda** message — never the owner's words, never
  the Warden's composer acts, never a send-now;
- the recipient is a **Claude** ferret;
- its MCP server is **connected** (a poll is open, or one ended within 5 s).

Otherwise it is typed, exactly as before.

## Proof, and the one fallback

A channel send is ledgered with path `channel` and nothing is typed. The tracker proves it from the transcript only:

1. **Receipt** — the `enqueue` line for its text (within `channelReceiptMs`, 5 s). The send is then `queued` and **never
   typed again**.
2. **Delivered** — the `user` entry (idle) or the `queued_command` (busy).
3. **No receipt and no ack from the MCP server** by the deadline — nothing reached Claude. The tracker reads the
   transcript **once more**, and only if the receipt or delivery is still absent does it take the message back from the
   outbox and type it **once** (ledger path `direct`, never channelled again). A receipt that is merely slow therefore
   never double-delivers. A transcript that cannot be read at that moment is never a reason to type.
4. **Acked but no receipt** — the server forwarded it, so a typed copy would be the duplicate. It is said unconfirmed after
   `channelAckedGraceMs` (30 s) and stays watched, so a late record still proves it delivered.

## The typing path and its three checks

Typing is the fallback and still the way the owner's own messages travel. Before every try the pane must be **not
compacting** (`routeSend` reads it as busy; a first send is kept `untyped` instead of queued), have **no dialog or consent
prompt** (`waitReady` / `blockedByDialog`), and have an **empty composer** (`ComposerOccupied`; for a ferret's message a
non-empty composer also keeps it `untyped`; the owner's own draft is refused with the app's Clear / Send choice). A send
that fails a check is kept `untyped` and the tracker looks again **every second** (`untypedLookMs`, `deferredNudgeMs`),
typing it on the first look after the pane is safe. The stuck alarm (2 min) and its screen snapshot are unchanged.

## Gate

Personal `claude_max` logins pass it. A Team/Enterprise organisation's `channelsEnabled` policy (default off) would
block it, which is why the setting defaults off for `claude_enterprise`.

## Reading it in the app

The transcript reader unwraps `<channel source="ferretry" …>TEXT</channel>` (both forms above) **only for our server
name**; the sender banner inside TEXT then attributes the message to its ferret, and a daemon notice shows as
"Ferretry · Delivery". Another server's channel keeps its wrapper.
