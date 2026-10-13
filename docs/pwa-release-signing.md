# Signed PWA releases

The hosted app at Ferretry's Pages address is a website, and a website is whatever its host serves
today. This page explains how an **installed** copy of the app refuses to update to anything Ferretry
did not sign, and where that protection ends.

The design is section D, "Signed PWA releases", of the zero-trust design (`docs/design/zero-trust.md`,
on the `feat/zero-trust` branch until it lands). This page is the runbook: the contract, the key,
and what to do when something goes wrong.

## What it does

- **Every deploy carries a signed list of its files.** The build writes
  `release-manifest.json`: the version, the commit, the commit's time, the worker's file name, and
  the SHA-256 of every file in `dist/`. CI signs the exact bytes of that file with an Ed25519 key and
  writes `release-manifest.sig`.
- **The service worker serves only checked bytes.** `sw.verified.js` fills its cache only with
  files whose hash the signed list names. Once installed, it serves the app from that cache, even if
  the site changes or goes away.
- **An update is checked before it is used.** When the app opens, and each time the tab becomes
  visible, the worker fetches the list and its signature, verifies the signature against the key it
  **pinned** at first install, fetches every listed file, checks every hash, writes them into a new
  cache, and only then moves one pointer to it. The pointer and the pinned key are one IndexedDB
  record written in one transaction, so a check interrupted halfway changes nothing.
- **A failed check changes nothing.** The installed version keeps running, and the app says, in one
  sentence, that an update was blocked and why.
- **A replaced checker is reported.** If the browser starts installing a new worker script, the
  running verified app asks its worker to fetch that script and compare it with the signed list. If it
  is not the signed worker, the app shows a warning it will not let you dismiss.

## The pieces

| piece                                             | role                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/pwa/src/lib/release-manifest.ts`        | the list's format, the signature file's format, request → listed file |
| `packages/pwa/src/lib/release-verification.ts`    | the verifier: signature, pinned key, version order, file hashes       |
| `packages/pwa/src/lib/release-keeper.ts`          | fetch, check, cache, swap; the page ↔ worker messages                 |
| `packages/pwa/src/lib/release-storage.ts`         | IndexedDB, Cache Storage and same-origin fetch, behind small ports    |
| `packages/pwa/src/worker/service-worker.ts`       | the worker's composition root (wiring only)                           |
| `packages/pwa/src/hooks/use-release-integrity.ts` | the page side: asks for checks, audits a new worker                   |
| `packages/pwa/src/shell/release-notice.tsx`       | the notice the reader sees                                            |
| `packages/pwa/scripts/build-release.ts`           | builds the worker, writes the list and the UNSIGNED marker            |
| `packages/pwa/scripts/sign-release.ts`            | signs the list and re-verifies it with the worker's own verifier      |
| `scripts/ci/sign-pwa-release.sh`                  | puts the secret in a `0600` temp file, signs, removes the file        |
| `packages/pwa/release-signing-key.pub`            | the public key, compiled into every worker                            |

### Wire formats

`release-manifest.json` (written by `serializeReleaseManifest`; the signature covers the bytes as
served, so a verifier never re-serialises):

```json
{
  "version": "3.38.0",
  "commit": "5a2e9c7…",
  "createdAt": "2026-10-13T18:18:15.000Z",
  "worker": "sw.verified.js",
  "files": { "app/index.html": "<sha256 b64url>", "…": "…" },
  "nextKey": "<optional: SPKI b64url of the next signing key>"
}
```

`files` lists every file in `dist/` except `_headers` and `_redirects` (Pages configuration, never
served as bytes) and the list and its signature themselves. `scripts/ci/build-pwa.sh` fails the
build if the list and `dist/` disagree.

`release-manifest.sig` is one line: `<SHA-256 of the signing key's SPKI, b64url>.<64-byte Ed25519
signature, b64url>`. The fingerprint lets the verifier say "signed by a key this app does not trust"
honestly instead of "bad signature". A build with no key writes the single word `unsigned`.

Releases are ordered by version, then by `createdAt` (the commit's time). Pages deploys every push to
`main`, so many deploys share a version; the commit time is what makes an older deploy of the same
version refusable.

## What the worker refuses

| refusal         | meaning                                                      | words the reader sees                               |
| --------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| `unsigned`      | the `unsigned` marker, on any origin but a developer machine | "it was not signed"                                 |
| `malformed`     | the signature file or the list is not well-formed            | "its signature or file list was damaged"            |
| `unknown-key`   | signed by a key that is not pinned                           | "it was signed with a key this app does not trust"  |
| `bad-signature` | claims a pinned key, does not verify                         | "its signature did not match"                       |
| `older`         | older than the installed release                             | "it is older than the version you have"             |
| `hash-mismatch` | a listed file's bytes are not the signed bytes               | "one of its files was not the file that was signed" |

The signature is checked over the raw bytes **before** they are parsed, so nothing an unsigned list
says can influence the decision.

### Unsigned builds

Local builds and pull-request builds have no key. They write the `unsigned` marker so "unsigned" is a
decision the build made out loud, never a missing upload.

- On a loopback hostname (`localhost`, `*.localhost`, any `127.x.x.x`, `[::1]` — the shared
  `isLoopbackHost` rule in `@ferretry/protocol`), the worker answers "unverified": it
  caches nothing and lets every request reach the network, so a developer sees their own build.
  This is decided from the page's hostname, which a deploy cannot change — a production origin can
  never accept an unsigned release, whatever the build said.
- Anywhere else, `unsigned` is a refusal like any other.
- **Production cannot deploy one.** `pwa-pages.yaml` runs `scripts/ci/sign-pwa-release.sh` before
  the deploy step, and that script fails when `PWA_RELEASE_SIGNING_KEY` is missing.

## The key

### Where it lives

- **Private key:** the GitHub Actions secret `PWA_RELEASE_SIGNING_KEY` (PKCS#8 PEM), defined on the
  `pwa-release` **environment**, not as a repository secret. Protect that environment:
  **Settings → Environments → pwa-release → Deployment branches and tags → Selected branches →
  `main`**, and add required reviewers if you want a human to approve each deploy. Only the `deploy`
  job of `pwa-pages.yaml` names the environment, and that job only runs on `main`.
- In CI the key is written only to a `0600` file inside a fresh `mktemp -d` directory, passed to the
  signer as a path, and removed by an `EXIT` trap. It is never echoed, never an argument, and never
  in the workspace.
- **Public key:** `packages/pwa/release-signing-key.pub`, committed. The build compiles it into the
  worker. `sign-release.ts` refuses to sign with any key whose public half is not this file, because
  every new install pins this file and would refuse anything else.

### Generating a key

```bash
openssl genpkey -algorithm ed25519 -out pwa-release-signing-key.pem   # keep this OFF the repo
openssl pkey -in pwa-release-signing-key.pem -pubout -out packages/pwa/release-signing-key.pub
chmod 600 pwa-release-signing-key.pem
```

Paste the whole `.pem` (including the `BEGIN`/`END` lines) into the `PWA_RELEASE_SIGNING_KEY`
secret of the `pwa-release` environment, commit the `.pub`, then delete the local `.pem` or move it to
offline storage you trust.

### Rotating a key (planned)

A key is added to an installed app only one way: **announced by a release signed with a key it
already trusts.**

1. Generate the new key pair (above). Do not change the secret yet.
2. Commit the new public key as `packages/pwa/release-signing-key.next.pub`. The build puts it in
   the list as `nextKey`.
3. Deploy. Every installed copy that accepts this release (signed by the **old** key) now trusts both
   keys.
4. Give installed copies time to see that release — they check when the app is opened.
5. Swap: move the new public key to `release-signing-key.pub`, delete `release-signing-key.next.pub`,
   and replace the secret with the new private key. Deploy.
6. The first time an installed copy accepts a release signed by the new key, it forgets the old one.

A copy that was **not opened** between steps 3 and 5 never learned the new key. It refuses the new
releases as "signed with a key this app does not trust" and keeps running its installed version. It
recovers with a reinstall (below).

### If the key is compromised

Someone holding the private key can sign a release every installed copy will accept, if they can
also get it served from the Pages address. Act in this order:

1. **Remove the secret** from the `pwa-release` environment and revoke the Cloudflare token used by
   `pwa-pages.yaml` if the same machine or account was involved.
2. **Generate a new key pair** and commit the new public key as `release-signing-key.pub` (do not
   announce it through `nextKey` — that would be signed by the compromised key).
3. **Deploy** a release signed with the new key. Installed copies refuse it ("a key this app does not
   trust"); new installs pin the new key.
4. **Tell users to reinstall:** open the app's address, then use the browser's site settings to
   **clear the site's data** (this removes the pinned key), and reload. On a phone with the app on the
   home screen, remove it and add it again after clearing the data.

There is no remote way to make an installed copy forget a key, by design: anything that could would
also be a way for an attacker to make it forget the real one.

## What this does and does not protect against

**It protects an installed copy** against a deploy that changes the app's files — a compromised
Pages project, a hijacked Cloudflare token, or a CI run on the wrong ref — **as long as that deploy
keeps the signed worker.** Such a release is refused; the reader keeps the version they had and is
told.

**It does not protect:**

- **The first install (trust on first use).** A browser that has never installed the app trusts
  whatever the site served at that moment, key included.
- **Against a deploy that ships a new service worker.** A browser installs a changed `sw.verified.js`
  on its own schedule, and the worker is the checker. An attacker who controls the deploy and ships
  their own worker replaces the check itself. The running, verified app watches for a new worker and
  compares it with the signed list; an unsigned one raises a warning the reader cannot dismiss. That
  is **detected, not prevented**. Preventing it needs a client the deploy cannot rewrite (a native app
  or a browser extension), which is out of scope. The daemon's audit log is meant to record this too;
  the page leaves a typed hook for it (`onUnsignedWorker` in `use-release-integrity.ts`) that nothing
  is wired to yet — the audit log is zero-trust PR C.
- **A browser with no service worker** (an insecure origin, some private windows): nothing is
  checked and nothing is shown.
- **The daemon.** Daemon requests never go through this cache: the worker answers only same-origin
  `GET`s that a verified release lists, and passes everything else through untouched.
- **A compromised signing key** — see above. The key is the root of this whole check.
- **A copy that is never opened.** Checks happen when the app is opened or brought back into view;
  there is no timer.
