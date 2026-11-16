# Provenance: vendored `AtomiCloud/actions.setup-nix`

This directory is a copy of a third-party composite action, vendored so every action it runs is pinned to a full
commit SHA (`docs/standards/ci-cd/index.md#installing-nix`). The copy is mechanical: read the diff against the
upstream commit, not the files, to review it. Nothing here is edited by hand except the nine `uses:` lines below, and one file is ADDED (`package.json`).

- **Source:** https://github.com/AtomiCloud/actions.setup-nix
- **Tag and commit:** `v4.0.0` = `6d7c1e0710ce2fbda572edd6c3a473ea8210b4c0`
- **Vendored:** 2026-11-16 (kirinnee/ferretry PR #1685)
- **Used by:** `.github/actions/install-nix` only (`uses: ./.github/actions/setup-nix`)
- **Files copied** (the ones `action.yml` reads through `$GITHUB_ACTION_PATH` or `uses:`): `action.yml`,
  `bin/durian-shell`, `scripts/cache-shell.sh`, `scripts/linux-warm-nix.sh`, `scripts/store-guard.sh`,
  `post-cache-push/{action.yml,file-cache-push.sh,noop.js,push.js}`, `store-guard/{action.yml,noop.js,post.js}`.
  Not copied: the upstream repo's own flake (`flake.nix`, `nix/`), release files, tests, README.

## The one added file: `package.json`

`{"private": true, "type": "commonjs"}`. Upstream's JS hooks (`store-guard/post.js`, `post-cache-push/push.js`) are
CommonJS, but this repository's root `package.json` says `"type": "module"`, which Node applies to every `.js` below it
(measured on the first full CI run: `ReferenceError: require is not defined in ES module scope` in the store-guard post
step, which failed every job that installs Nix). A `package.json` here scopes these files back to CommonJS without
editing them. Keep it when re-vendoring.

## The edited lines (all in `action.yml`)

Upstream names five floating or external refs. Each was replaced, and nothing else in any file was changed:

| Upstream line                                                                       | Here                                                                           | Lines |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----- |
| `actions/create-github-app-token@v3`                                                | `…@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0`                          | 1     |
| `actions/checkout@v6`                                                               | `…@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0`                          | 4     |
| `namespacelabs/nscloud-cache-action@v1`                                             | `…@1124a6f3ce44e5cf84cc22111530961f4d2a15f9 # v1.7.0`                          | 2     |
| `DeterminateSystems/nix-installer-action@main`                                      | `…@3138316df39ed29be04236d7ffc686fa525866aa # v23`                             | 1     |
| `AtomiCloud/actions.setup-nix/store-guard@11719dd7422357488272a5e2c5ac80eba82de832` | `./.github/actions/setup-nix/store-guard` (the vendored copy of the same hook) | 1     |

`DeterminateSystems/nix-installer-action` was pinned to its latest release `v23` (`main` was 10 commits ahead of it
on 2026-11-16 and is not a release). The runs that exercise it are the ones the PR's full CI performs.

## Re-vendoring

1. Pick the new upstream tag and its commit `NEW` (`gh api repos/AtomiCloud/actions.setup-nix/git/ref/tags/<tag>`).
2. Copy each file listed above from `NEW` over this directory
   (`gh api "repos/AtomiCloud/actions.setup-nix/contents/<file>?ref=NEW" --jq .content | base64 -d > <file>`),
   keeping `bin/durian-shell` and the `scripts/*.sh` executable.
3. Re-apply the nine edits in the table: find every `uses:` line in `action.yml`
   (`rg -n 'uses:' .github/actions/setup-nix/action.yml`) and pin each to a full 40-character SHA with its tag as
   a trailing comment; point the store-guard `uses:` at `./.github/actions/setup-nix/store-guard`. Look for NEW
   `uses:` lines upstream added and pin those too.
4. Keep `config/action-trust.json` equal to the actions now used (`scripts/validate/action-pins.sh trusted` and
   `non-trusted` must pass) and update this file's tag, commit, date and table.
5. Run a full CI on a Namespace and a GitHub-hosted runner before merging.
