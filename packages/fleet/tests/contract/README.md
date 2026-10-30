# Harness contract guard

The account model ([design §8](../../../../docs/design/account-model.md)) shares one login across many
runtimes through mechanisms Claude Code and Codex never documented. This suite measures each one
against a real `claude` and `codex`, so a harness release that breaks one fails a build instead of
forking somebody's login.

```sh
packages/fleet/tests/contract/run.sh pinned   # the versions this build pins (the flake's own nixpkgs)
packages/fleet/tests/contract/run.sh latest   # the newest npm releases
```

CI runs `pinned` on Linux and `macos-15` in every build (`harness-contract` in `realworld.yaml`, the realworld tier's workflow, so it never blocks a merge or a release). The
scheduled `harness-contract-latest.yaml` runs `latest` daily and gates nothing.

## What is pinned

| File                              | Claim                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-credential-store.test.ts` | `CLAUDE_SECURESTORAGE_CONFIG_DIR` is still read; two config dirs share one store; without it a dir is signed out; a refresh lands in the store; the refresh lock is `<store>.lock` and a second runtime never spends the token; a symlinked credential is replaced by a regular file on refresh                                                                                                                                                                                                                                                                        |
| `claude-keychain.test.ts`         | macOS only: the store is the keychain item `Claude Code-credentials-<sha256(dir)[0:8]>`, `""` selects the bare item, a refresh writes the same item (gap G1), and Ferretry reads the item Claude reads (by `acct` and `svce`) past a stale item of the same name                                                                                                                                                                                                                                                                                                       |
| `claude-launch.test.ts`           | `hasCompletedOnboarding` + `projects[cwd].hasTrustDialogAccepted` skip onboarding and trust; `--permission-mode auto` / `bypassPermissions` are accepted; `--settings` overlays rather than replaces; the auto-mode default dialog parks a bypass runtime, and `hasSeenAutoDefaultNudge` or an overlay naming the mode each suppresses it                                                                                                                                                                                                                              |
| `codex-credential-link.test.ts`   | a refresh rewrites `auth.json` through the link; a second home reads the rotated token; `cli_auth_credentials_store = "file"` never touches the keyring (Linux); `codex logout` removes only its link                                                                                                                                                                                                                                                                                                                                                                  |
| `codex-launch.test.ts`            | a Git project is asked about on every version, a folder with no project marker only before 0.160; `-c 'projects={"<cwd>"={trust_level="trusted"}}'` skips the prompt (a Git subdirectory's included) and merges with `config.toml`; the fixed layer's `approval_policy`/`sandbox_mode` survive 0.160's projectless defaults (read off `/status`); the `--add-dir` correlation root is declared and never created; on macOS Seatbelt lets a command create a missing writable root but not one whose parent is missing; `skills/<item>` (including a symlink) is listed |

One suite lives in the daemon, because it measures daemon code against the CLIs, and `run.sh` runs it
with these: `packages/daemon/tests/contract/conversion-acceptance.test.ts` — a cross-harness
conversion (`docs/migration-cross-harness.md`) of every recorded transcript of the other harness is
resumed by the real CLI against a loopback model and read back in order; a damaged one is refused. And
`packages/daemon/tests/contract/question-hook.test.ts`: with the fixed overlay, a real Claude asking one
`AskUserQuestion` (scripted by a loopback model) fires the overlay's `PreToolUse` hook before the form is
drawn, the daemon projects that question as pending from the hook's file, and once the form is answered
the transcript takes over ([launch-settings.md](../../../../docs/launch-settings.md)). A
version outside the converter's gate fails it on purpose.

Every positive claim sits beside the control that shows what it suppresses. A claim that changed at a
release is gated on the version the harness reports (`harnessVersion`), so `pinned` and `latest` each
assert the behaviour of the version they measure.

`terminal-transcript.test.ts` is not a claim about a harness: it pins the support code that reads a
screen. A PTY delivers output in arbitrary chunks, so the transcript decodes as one stream; decoding each
chunk alone turned a box-drawing character split across two chunks into `��` and failed a `/status`
assertion intermittently on `macos-15`.

## Rules

- **Fake credentials only.** Tokens are made up here (`FAKE`, `ROTATED<n>`). Nothing reads the
  caller's environment: each child gets a throwaway `HOME` and a minimal `PATH`.
- **No network.** Every proxy variable points at a loopback proxy that records each `CONNECT` and
  forwards nothing. The one exception is Claude's token host, spliced to a loopback TLS server
  trusted through `NODE_EXTRA_CA_CERTS`; Codex's token endpoint comes from
  `CODEX_REFRESH_TOKEN_URL_OVERRIDE`.
- **No inference.** A refresh is triggered by `claude mcp list` or Codex `app-server`
  `getAuthStatus`, neither of which calls a model; anything aimed at an inference host dies at the
  proxy's `CONNECT` line with no request sent.
- **The keychain is written only on the CI runner** (`FY_CONTRACT_KEYCHAIN=1` and `CI=true`), because
  the bare item is where a person's own Claude login lives.
- Outside `run.sh` (`FY_HARNESS_CONTRACT` unset) every file skips, which is what the unit and
  integration tiers see. Opting in without a binary fails instead of skipping.

## Declared limits

- The keyring check is Linux-only: there a keyring call is a D-Bus connection a fake bus can count.
  On macOS Codex's keyring is the Security framework, which has no socket to watch.
- The lock test proves a second runtime waits and adopts the rotated token while the first holds
  the lock. It does not race two refreshes at the same instant.
- `latest` comes from npm, not nixpkgs, so it measures what a person who installs from npm runs.
- On macOS the keychain suite runs with the runner's REAL `HOME`: `security` finds the login keychain
  through the search list under `~/Library`, so under a throwaway `HOME` no keychain is searched at all
  (measured on the first `macos-15` run). The launch suite keeps a throwaway `HOME`, so there Claude
  reports signed out; none of the screens it measures depends on being signed in.
