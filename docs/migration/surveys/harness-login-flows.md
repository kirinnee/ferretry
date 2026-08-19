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

  > **RETIRED FOR THE UI-DRIVEN FLOW, and kept for a person at the host.** This is correct advice for
  > somebody at a terminal and wrong for a browser: a route that accepted an access token would make the
  > daemon a credential conduit and the browser a credential form, which is exactly what
  > `docs/design/harness-login.md` §0 refuses. `--with-access-token` and `--with-api-key` appear nowhere
  > in the daemon flow, its wire contract, or either panel — and `codex-flow.test.ts` asserts the argv
  > carries neither, so the exclusion is checkable rather than remembered.

## What the CLIs actually printed, observed 2026-08-19 with PIPED stdio

Both were run against throwaway harness homes and both were killed by a timeout while still waiting. No
login was completed. This section exists because the design was built against these bytes rather than
against the help text, and three of them are not guessable.

### `codex login --device-auth`, codex-cli 0.145.0

    Follow these steps to sign in with ChatGPT using device code authorization:

    1. Open this link in your browser and sign in to your account
       <ESC>[94mhttps://auth.openai.com/codex/device<ESC>[0m

    2. Enter this one-time code <ESC>[90m(expires in 15 minutes)<ESC>[0m
       <ESC>[94m0IER-FFQW6<ESC>[0m

- **`--device-auth` is UNDOCUMENTED at this version.** `codex login --help` lists it with an EMPTY
  description, so a reader scanning the help text concludes it is not there. An undocumented flag can
  vanish without a deprecation, which is why the daemon flow fails as itself and names `fy fleet login`
  when it recognises nothing.
- **Colour is emitted even when stdout is a pipe**, so an unstripped line never equals the code it shows.
- The user code is two uppercase alphanumeric groups joined by one hyphen, alone on its own indented line.
- There is no return trip: the child polls and exits on its own.

### `claude auth login --claudeai`, claude-code 2.1.220

    Opening browser to sign in…
    If the browser didn't open, visit: <OSC8>https://claude.com/cai/oauth/authorize?…<BEL>https://…<OSC8-end>
    Paste code here if prompted >

- **The paste prompt IS reached with piped stdio.** That is the whole remote leg.
- **The URL is wrapped in an OSC 8 hyperlink**, so the address appears TWICE — once as the link target
  inside the escape and once as visible text. Stripping OSC sequences whole is what leaves exactly one.
- **The prompt carries no trailing newline**, so a line splitter that only emits complete lines never
  delivers it.
- **`code_challenge_method=S256` is in the printed URL**, so the code is PKCE-bound and the verifier is
  inside the child. `docs/design/harness-login.md` §4.2 recorded this as an assumption it could not cite;
  this is the citation.
- **`redirect_uri` is `https://platform.claude.com/oauth/code/callback`** — a hosted page that SHOWS the
  reader a code. There is no localhost callback in this path, so what comes back is a CODE off a web page
  and not a redirected address. A UI asking for "the complete redirected URL" asks for something a person
  never sees.
- **The subcommand is `auth login`, not `/login`.** `process-login.ts` launches `<wrapper> /login`,
  which hands a slash command to the interactive TUI; `auth login` is what was observed to work with a
  pipe. The daemon flow uses `auth login` and the CLI path is unchanged.

## State

The identity model, donor policy, credential store and per-identity login are implemented — see
section E of [kfleet-map.md](kfleet-map.md). **The daemon-side login session and the PWA surface that
drives it are implemented too**, against the observations above: see
[harness-login.md](../../design/harness-login.md), whose §6 records what is still open.
