# Move the repository to another GitHub account

**What this is:** the steps to transfer `github.com/<old-owner>/ferretry` to a new GitHub owner
(`<new-owner>`) and keep everything that ships (installs, updates, the app's links) pointing at the
right place.

**The short version:** you do the GitHub steps (1–5), one command rewrites the code (6), then you
release (9–10) and migrate each machine (11–12). Nothing here needs a secret value in chat or in a file.

**This page never names a real owner.** `<old-owner>` and `<new-owner>` are placeholders on purpose:
`scripts/local/move-repo.sh` rewrites every shipped address, and a runbook that spelled the owner out
would be rewritten into nonsense ("untap the new owner"). The script prints the migration commands with
both owners filled in at the end of its run (step 6); paste those.

## Why one command is enough

The GitHub owner is **one fact**, kept in the root `package.json`:

```json
"repository": "github:<owner>/ferretry"
```

The repository name equals the product name (`name` in the same file), as the
[two-name model](../standards/architecture/index.md#two-name-model) already requires. Everything a user
or the product follows is derived from that line:

| Shipped file                                                                                        | What it carries                           |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `Casks/ferretry.rb`                                                                                 | release URLs, homepage                    |
| `.goreleaser.yaml`                                                                                  | release owner, cask owner, homepage       |
| `scripts/release/install.sh`, `scripts/release/backfill-changelog.ts`                               | the repo the installer and changelog read |
| `INSTALLATION.md`, `packages/pwa/get-started/index.html`                                            | `brew tap`, `nix`, `curl … install.sh`    |
| `packages/protocol/src/lib/daemon-update.ts` (`RELEASE_OWNER`)                                      | where daemons look for a newer release    |
| `packages/pwa/src/features/onboarding/onboarding-model.ts`                                          | the install commands the app shows        |
| `packages/pwa/src/features/carrier/active-carrier-card.tsx`                                         | a docs link                               |
| `scripts/host/*.service`, `*.timer`                                                                 | `Documentation=`                          |
| `docs/updating.md`, `docs/cloudflare-*.md`, `docs/multi-user-host.md`, `docs/standards/{nix,ci-cd}` | commands users copy                       |
| the tests that assert those addresses (`follow` entries in the allowlist)                           | what ships                                |

`scripts/validate/repo-slug.sh` (pre-commit hook `a-repo-slug`) fails when any shipped file names a
different owner. `scripts/validate/repo-slug-allowlist.txt` lists what is **deliberately** left alone:
changelogs, migration notes, design records, links to one issue or PR (GitHub keeps redirecting
those), and test data that uses the slug as an arbitrary example.

Not owner-bound, so never touched: the Gemfury account (`kirinnee97`) and the Cloudflare `workers.dev`
host. They are separate accounts.

## Steps

### On GitHub (you)

1. **Create or choose the new account** (a user or an organisation). Note its exact login: that is
   `<new-owner>` below.
2. **Install the Namespace GitHub App on it** and grant it access to the repository (CI runs on
   Namespace runners). If Namespace is down, set the repository variable `CI_RUNNER_POOL` to `github`
   to fall back to GitHub-hosted runners.
3. **Create a new `RELEASE_TOKEN`** under the new account: a personal access token (or GitHub App
   token) that can push tags and write contents to this repository. Semantic release uses it, because
   tags pushed with the default `GITHUB_TOKEN` do not start the CD workflow. Keep the value to
   yourself; you will paste it into the secret in step 5.
4. **Transfer the repository** (Settings → General → Danger Zone → _Transfer_). It must be a
   **transfer, not a copy or a new repo**: a transfer keeps issues, PRs, releases, stars, the Pages
   settings and the redirect from the old address (see "Why installed daemons keep updating").
   **Add `kirinnee` as an Admin** of the repository so you keep full access.
5. **Check every secret, environment and variable** exists on the new repository. Names only; GitHub
   never shows values. Re-add anything missing (`gh secret set NAME --repo <new-owner>/ferretry`,
   which prompts for the value; set `RELEASE_TOKEN` to the new token from step 3).

   | Kind                | Name                                                                                        | Used by                                |
   | ------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------- |
   | repository secret   | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`                                             | PWA Pages deploy, hosted relay deploy  |
   | repository secret   | `FURY_PUSH_TOKEN`                                                                           | Gemfury push of `.deb` / `.rpm`        |
   | repository secret   | `RELEASE_TOKEN`                                                                             | `release.yaml` (semantic release tags) |
   | repository secret   | `HOSTED_TUNNEL_ACCOUNTS`                                                                    | hosted relay tunnel pool               |
   | environment         | `pwa-release` — secret `PWA_RELEASE_SIGNING_KEY`                                            | signs the hosted PWA                   |
   | environment         | `pwa-release-v5` — secret `PWA_RELEASE_SIGNING_KEY`                                         | the same, for the v5 workflows         |
   | environment         | `pwa-deploy-v5` — secrets `CLOUDFLARE_PAGES_V5_ACCOUNT_ID`, `CLOUDFLARE_PAGES_V5_API_TOKEN` | v5 Pages deploy                        |
   | environment         | `daemon-release` — empty (it may hold the optional `DAEMON_RELEASE_SIGNING_KEY`)            | `cd.yaml` standalone-release signing   |
   | repository variable | `HOSTED_RELAY_ORIGIN`, `LINK_STORE_ORIGIN`                                                  | relay and link-store addresses         |
   | repository variable | `MACOS_SMOKE`, `CI_RUNNER_POOL`                                                             | CI switches                            |

   Environments also carry a **deployment-branch policy** (Settings → Environments → _Deployment
   branches and tags_). They are **not all the same, and the rule is: keep each exactly what it is now.**
   Do not "tidy" them to `main`. Read the current policy of each one on the old address **before the
   transfer** (read-only), then compare after:

   ```bash
   # 1. Read every environment: `deployment_branch_policy` says whether it has a custom policy.
   gh api repos/<old-owner>/ferretry/environments --jq '.environments[] | {name, deployment_branch_policy}'
   # 2. Only for an environment whose `deployment_branch_policy` is NOT null, list its branches/tags:
   gh api repos/<old-owner>/ferretry/environments/<name>/deployment-branch-policies
   ```

   **Skip step 2 when the policy is `null`.** That subresource answers `404 Not Found` for an
   environment with no policy (today: `daemon-release`). It is not an error: `null` is the expected
   unrestricted state, and what to keep is exactly that, no policy.

   | Environment      | Policy on 2026-11-11 (check it, do not trust this table) | Why it must stay                                                                                                       |
   | ---------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
   | `pwa-release`    | custom policy: branch `main`                             | the v4 `pwa-pages.yaml` signing job runs on `main` only                                                                |
   | `pwa-release-v5` | custom policy: branch `rebuild/5.0`                      | read by the v5 branch's workflows, not by `main`                                                                       |
   | `pwa-deploy-v5`  | custom policy: branch `rebuild/5.0`                      | the same                                                                                                               |
   | `daemon-release` | no policy at all (any ref may deploy)                    | `cd.yaml`'s signing job runs on the **release tag** `v*.*.*`, so a `main`-only rule would stop every release signature |

   Never apply a blanket "only `main`" rule: it would lock the v5 environments out of their own branch
   and `daemon-release` out of its tag. `cd.yaml` recommends restricting `daemon-release` to the tags
   `v*.*.*`; that is a separate hardening to make deliberately (tag pattern, not a branch), not part of
   the move. The v4 `main` workflows reference only `pwa-release` and `daemon-release`; the v5 branch's
   workflows read the other two. After the transfer, run the same two commands on `<new-owner>` and check
   each environment shows the policy it had.

   **Do not create a new `PWA_RELEASE_SIGNING_KEY`** unless you mean to rotate it
   (see "Why a new PWA signing key breaks installed apps").

   **A new `CLOUDFLARE_API_TOKEN` needs a manual relay run.** The hosted relay's operator bearer is
   _derived from_ `CLOUDFLARE_API_TOKEN` (`relay-hosted.yaml`: a domain-separated SHA-256 of it, stored as
   a Worker secret at deploy time). If the transfer keeps the secret, nothing changes. If you set a
   different token, the stored bearer no longer matches and every relay operation (kill switch, metrics,
   ceilings, tunnel pool) answers 401 until you run **Actions → Deploy Hosted Relay → Run workflow**
   from `main` with `operation: deploy`: a manual run always deploys (a push deploy is skipped when the
   served bundle is unchanged) and so reinstalls the derived secret. A deploy drops every live relay
   session, so do it once, deliberately, at a quiet moment.

### In the code (one command)

6. From a **fresh worktree of `main`**:

   ```bash
   scripts/local/move-repo.sh --owner <new-owner>
   ```

   It rewrites `package.json`'s `repository`, every shipped file in the table above, and the tests that
   assert them; prints each file it changed; then runs `scripts/validate/repo-slug.sh`. It is
   **idempotent**: running it twice changes nothing. A different repo name is not a flag here: run
   `scripts/local/rename.sh --product <name>` (it moves the `repository` field too), then this script.

   **At the end it prints the migration lines with both owners filled in** (the git remote, the Homebrew
   sequence, the Nix input). Copy those for steps 8, 11 and 12 rather than editing this page's
   placeholders by hand. The script never edits this runbook: it names no real owner.

7. **Review `git diff`**, commit with a title that **triggers a release**, open a PR, and let CI run.
   Use exactly this shape:

   ```text
   fix(release): move the repository to <new-owner>
   ```

   **Not `chore:`.** `.releaserc.yaml` releases only `feat`, `fix`, `perf` and breaking commits; a
   `chore:` commit ships nothing, so no build would carry the new `RELEASE_OWNER` and installed daemons
   would keep leaning on the redirect forever. If the PR is squash-merged, the **squash commit title**
   is what semantic release reads, so make that title the `fix(release): …` line too.
   The first CI run on the new owner is also the proof the secrets and runners work.

8. **Point every clone at the new address:**

   ```bash
   git remote set-url origin git@github.com:<new-owner>/ferretry.git
   ```

   The old address keeps working through the redirect, but SSH host aliases such as
   `github-personal:` need the new path spelled out. The board's GitHub watcher reads the remote of
   each project's working copy, so update those clones before expecting cards to move on PR events.

### Release and the machines

9. **Merge, then let the release run.** Semantic release tags with `RELEASE_TOKEN`; `cd.yaml` builds,
   publishes the GitHub release (GoReleaser) and commits the new `Casks/ferretry.rb` into the repo.
10. **Verify the release landed on the new owner before going on.** Both must succeed; if either does
    not, stop and fix it (usually `RELEASE_TOKEN` or the Actions run) before touching any machine:

    ```bash
    git ls-remote --tags --refs --sort=version:refname git@github.com:<new-owner>/ferretry.git 'v*' | tail -3   # newest tag last
    gh release view --repo <new-owner>/ferretry                                                                # latest release: its assets are attached
    ```

    The latest tag must be newer than the one that existed before the move, and the release must list
    the platform archives (`fy_darwin_arm64.tar.gz`, `fy_linux_amd64.tar.gz`, `fy_linux_arm64.tar.gz`)
    and `checksums.txt`. Also check that `Casks/ferretry.rb` on `main` now points at
    `github.com/<new-owner>/ferretry/releases/download/…`.

11. **Update each daemon:** `fy daemon update --yes` (or the Update button in the app). It installs the
    release that now carries the new `RELEASE_OWNER`, so from then on it asks the new owner directly.
12. **On each machine installed through Homebrew, migrate the tap.** `brew untap` refuses while a
    cask from that tap is installed (it needs `--force`, which is not what we want), so uninstall
    first, then untap, tap the new address and install from it:

    ```bash
    brew uninstall --cask ferretry
    brew untap <old-owner>/ferretry
    brew tap <new-owner>/ferretry https://github.com/<new-owner>/ferretry
    brew install --cask <new-owner>/ferretry/ferretry
    fy daemon restart
    ```

    The cask has no `zap` stanza and only installs the `fy`, `fyd` and `fyd-browser-worker`
    binaries, so **the daemon keeps its state home** (config, sessions, secrets store under
    `~/.ferretry`); uninstalling the cask removes the binaries, not your data. The command syntax
    is in [Homebrew's `untap` reference](https://docs.brew.sh/rubydoc/Homebrew/Cmd/Untap.html). Until
    you migrate, brew follows the old address through the redirect, which works but is not guaranteed
    forever.

Nix users change `github:<old-owner>/ferretry` to `github:<new-owner>/ferretry` in their flake inputs and run
`nix flake update ferretry`.

## Why installed daemons keep updating

An installed daemon looks up its latest release at `api.github.com/repos/<old-owner>/ferretry/…`. After a
transfer **GitHub redirects the old owner's address** (web, git and API) to the new one, and the
daemon's HTTP client follows the redirect, so the first release made after the move is found and
installed. That release carries the new `RELEASE_OWNER`, and the daemon stops depending on the
redirect. This is why step 7 insists on a release-triggering `fix:` title: without a release there
is no daemon that knows the new owner.

The redirect lives only while **nobody creates a repository at the old address**. Do not create
`<old-owner>/ferretry` again, or rename the transferred repository, until every daemon you care about has
updated.

## Why a new PWA signing key breaks installed apps

The hosted app is a signed release. The **public** key is compiled into the service worker of each
installed copy, and the worker refuses any update that is not signed by a key it already trusts
([pwa-release-signing.md](../pwa-release-signing.md)). A key is added to an installed copy only one
way: announced as `nextKey` by a release signed with the **old** key. So:

- **Keep the existing `PWA_RELEASE_SIGNING_KEY`** in `pwa-release` (and `pwa-release-v5`). The transfer
  moves it with the repository; step 5 only checks it is there.
- **If you generate a new key instead**, every installed copy rejects the next release as unsigned
  ("update blocked") and stays on its old version until someone clears the site data and reinstalls.
  Rotate only with the planned procedure in `pwa-release-signing.md`.

The hosted app's address is a Cloudflare Pages project, not a GitHub address, so the transfer does not
change it.

## When the gate fails

`scripts/validate/repo-slug.sh` prints the file, the line and the owner it found. Either run
`scripts/local/move-repo.sh --owner <the-source-owner>` (a file drifted), or, if the mention is a
record of the past or an arbitrary example, add its path to `scripts/validate/repo-slug-allowlist.txt`
with the right mode and a reason.
