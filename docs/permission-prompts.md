# Permission prompts

When Claude Code or Codex wants to run a tool it has not been allowed to, it stops and draws a numbered
choice list in its terminal — "Do you want to proceed? 1. Yes 2. Yes, and don't ask again for … 3. No".
Nothing moves until somebody picks one. Ferretry reads that prompt off the agent's pane, shows it as an
approval card in Chat, and types the person's choice back into the pane.

## What is recognised

Measured on real panes, captured from Claude Code 2.1.220 and 2.1.281 and Codex 0.145.0, 0.156.1 and 0.164.0
against a local fake model API (no inference). The captures are the test fixtures in
`packages/daemon/tests/fixtures/permission-prompts/`.

| Harness | Prompt                                            | `tool`     | `action`    | `what`              |
| ------- | ------------------------------------------------- | ---------- | ----------- | ------------------- |
| Claude  | Bash command — "Do you want to proceed?"          | `Bash`     | `run`       | the command         |
| Claude  | Read file (outside the workspace)                 | `Read`     | `read`      | the path            |
| Claude  | Edit file — "Do you want to make this edit to …?" | `Edit`     | `edit`      | the path            |
| Claude  | Create file — "Do you want to create …?"          | `Write`    | `create`    | the path            |
| Claude  | Fetch — "Do you want to allow Claude to fetch …?" | `WebFetch` | `fetch`     | the URL             |
| Claude  | Tool use (an MCP tool)                            | `MCP`      | `use`       | the server and tool |
| Claude  | Exit plan mode?                                   | `Plan`     | `exit-plan` | —                   |
| Codex   | "Would you like to run the following command?"    | `Shell`    | `run`       | the command         |
| Codex   | "Would you like to make the following edits?"     | `Edit`     | `edit`      | the destination     |

Any other dialog with the same shape — a "Do you want to …?" / "Would you like to …?" question directly
above a choice list numbered 1..n, at the bottom of the frame, with no composer below it — is read as a
generic request with the harness's own title as `tool`. The one-time dialogs Ferretry already knows
(auto-mode nudge, trust, API key) keep their own reading (`turnPrompt`) and are never shown as approval
cards. The harness's own dialogs — hook review, MCP-server approval, sign-in, update — have their own card:
see [harness-dialogs.md](harness-dialogs.md).

The request (`PermissionRequest` in `packages/protocol/src/lib/session-permission.ts`) carries every option
in the harness's own words, its kind (`allow`, `allow-always`, `deny`) and the row the harness's cursor is
on. Its `id` is a digest of everything a person decides on, so a prompt that changed on screen is a new id.

## How it travels

- The turn watcher reads it every two seconds with the rest of the turn evidence. While it is on screen
  the session's `turnState` is `needs-input` and `state.permissionRequest` holds it. It rides the session
  journal (`turn.state` for a new boundary, `turn.prompt` for a new request on the same one), so open
  pages see it at once.
- The PWA raises one notification per request ("<agent> wants to read … — Allow?"), marks the session as
  needing approval in the session list, and shows the approval card at the bottom of Chat.

## Answering

`POST /v1/sessions/:sessionId/permission` with `{ kind: 'choice', requestId, number }` or
`{ kind: 'deny', requestId }`:

1. The pane is captured and parsed again. If it no longer shows `requestId`, nothing is typed and the
   answer is `409 permission_prompt_gone` — the card says "this prompt is gone" and re-reads.
2. One key is typed: the option's digit, or Escape for deny. **No Enter follows the digit**: both
   harnesses act on the digit the moment it is pressed (measured on every version above), so an Enter
   would land on whatever the harness drew next — and if that is the next permission prompt, it would
   approve it unseen. Escape is the harness's own `(esc)`: it refuses and leaves the agent at its prompt,
   so a note for the agent is sent afterwards as an ordinary message.
3. The pane is read until the prompt is gone; `cleared: false` means the key landed and the same prompt is
   still up. It is reported, never sent again.

Answers to one session are taken one at a time. Governance is the Console's: `terminal` / `use`, see
[grants.md](grants.md).

## Never answered automatically

Ferretry never answers a permission prompt on its own. The only dialog the daemon answers by itself is
Claude's one-shot "Make auto mode your default permission mode?" nudge, which delivery declines so the
owner's chosen mode stays. A send that finds a permission prompt on screen reports `blocked_by_prompt` and
types nothing — a message typed into a choice list could pick a row.

## Declared gaps

- **Hooks are not used.** Claude's `PermissionRequest` / `Notification` hooks can say that a prompt is up
  and which tool asked, but not the rows the dialog offers ("don't ask again for: curl -s …" is worked out
  inside the dialog), and the answer must be a key into the pane either way. The pane is the one witness
  with everything a person decides on. A hook could shave the up-to-two-second detection delay; that is
  not built.
- **Wrapped commands.** A command longer than the pane is wide is read as the harness wrapped it, one line
  per row.
