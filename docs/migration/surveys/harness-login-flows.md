# Survey — can a provider login be driven from a phone?

**Question.** `fy fleet login` assumes a person is sitting at the daemon's host with a terminal. A
provider OAuth flow normally opens a browser on that machine and redirects to a **localhost** callback
there, and a phone cannot reach that callback. So: do `claude` and `codex` expose a path where the
daemon starts the flow, the reader opens a URL **wherever they are**, and hands something back?

**Answer: yes — both, by different mechanisms, and neither needs a browser on the daemon's host.**

Everything below was read out of the installed CLIs. Nothing here is inferred from documentation, and
no login was performed.

| harness  | remote-capable | mechanism                                                              |
| -------- | -------------- | ---------------------------------------------------------------------- |
| `codex`  | yes            | a real device-code grant: `codex login --device-auth`                  |
| `claude` | yes            | out-of-band: the CLI prints a URL and reads a pasted code from `stdin` |

---

## Codex — a first-class device-code flow

`codex login --help` (read from the installed binary) lists:

```
--device-auth
--with-api-key         Read the API key from stdin (e.g. `printenv OPENAI_API_KEY | codex login --with-api-key`)
--with-access-token    Read the access token from stdin (e.g. `printenv CODEX_ACCESS_TOKEN | codex login --with-access-token`)
```

and a `codex login status` subcommand.

`--device-auth` is exactly the shape the ask needs. Two of the other flags matter as well: both read
their secret from **stdin**, which means a daemon can complete a login without ever putting a
credential on a command line where the process table would expose it.

## Claude — no device grant, but an out-of-band paste flow that is already built in

`claude auth login --help` offers only `--claudeai`, `--console`, `--email <email>` and `--sso`. There
is **no** headless or device flag, so the flag surface alone would say "not possible". The binary says
otherwise.

Read out of `claude-code` 2.1.220, the account login's own state machine carries a
`waiting_for_login` state with a `showPastePrompt` flag and an `onSubmitCode(code, url)` handler,
alongside these literal strings:

```
Opening browser to sign in with your Claude account…
Browser didn't open? Use the url below to sign in
Paste code here if prompted >
```

and two different redirect paths:

```
/oauth/code/callback              ← the localhost callback (with a `callbackPort` setting)
/oauth/code/success?app=claude-code   ← the out-of-band page that shows the reader a code
```

So `claude auth login` **already degrades** to: print a URL, let the human open it anywhere, and read
a pasted code back from stdin. That is remotable without a single change to the harness — the daemon
pipes the child's stdio instead of inheriting it, surfaces the URL, and writes the code back.

### Two things that look like answers and are not

- **The device-code strings in the `claude` binary are not the account login.**
  `oauth/device_authorization`, `verification_uri`, `user_code`, `device_code` and
  `urn:ietf:params:oauth:grant-type:device_code` are all present, which is easy to mistake for a
  device grant on the Anthropic account. They sit beside `/.well-known/oauth-authorization-server`,
  `trust_prompt`, and generic `openid profile email` scopes — that cluster is the OAuth **client**
  Claude Code uses to authenticate itself _to third-party MCP servers_, discovered per server. It is
  not reachable from `claude auth login`. Do not build against it.
- **`claude setup-token` is not a login.** It produces a long-lived token, and the binary states the
  limit itself: _"Long-lived tokens (from `claude setup-token` or `CLAUDE_CODE_OAUTH_TOKEN`) are
  limited to inference-only for security reasons."_ It cannot stand in for a full-scope account login.

---

## What this means for the design

The identity model does most of the work before any of this matters. With `pickDonor` and the
credential store, only **one home per identity** ever needs a human, so a fleet of thirty wrappers on
six provider accounts is six approvals — and the remote flow is a handful of interactions, not thirty.

The remaining piece is a daemon-side login session:

1. Spawn the account's wrapper with **piped** stdio rather than inherited, `--device-auth` for Codex.
2. Recognise the URL in the child's output and publish it; publish the user code for Codex.
3. Accept a code from the reader and write it to the child's stdin.
4. Wait for exit, then re-survey the identity and clone the fresh credential to the siblings — which
   is the step that already exists.

**The browser end never sees a credential.** A verification URL and a device or authorization code are
fine in transit; the token is written by the harness into the account's own home, and the daemon reads
it only through the credential store, which returns a classification and never material.

Two constraints that fall out of the reading above and should not be rediscovered:

- Sanitize the environment for the spawn exactly as `fy fleet login` already does. A login started
  from inside an agent session must not inherit that session's `ANTHROPIC_API_KEY`.
- Prefer `codex login --with-access-token` (stdin) over any flag that would take a secret as an
  argument, for the same reason the credential store notes about `security add-generic-password`.

## State

The identity model, donor policy, credential store and per-identity login are implemented — see
section E of [kfleet-map.md](kfleet-map.md). The daemon-side login session and the PWA surface that
drives it are **not** implemented; this document is the contract for building them.
