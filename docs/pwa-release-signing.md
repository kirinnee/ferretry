# Signed PWA releases

The hosted app at Ferretry's Pages address is a website, and a website is whatever its host serves
today. This page explains how an **installed** copy of the app refuses to update to anything Ferretry
did not sign, and where that protection ends.

The design is section D, "Signed PWA releases", of the zero-trust design (`docs/design/zero-trust.md`,
on the `feat/zero-trust` branch until it lands). This page is the runbook: the contract, the key,
and what to do when something goes wrong.

## What it does

- **Every deploy carries a signed list of its files.** The build writes
  `release-manifest.json`: the version, the commit, a release **sequence** that CI owns, the worker's
  file name, and the SHA-256 of every file in `dist/`. CI signs the exact bytes of that file with an
  Ed25519 key and writes `release-manifest.sig`.
- **The service worker serves only checked bytes.** `sw.verified.js` fills its cache only with
  files whose hash the signed list names. Once installed, it serves the app from that cache, even if
  the site changes or goes away.
- **Every page load is answered from the installed release.** Once a verified release exists, no
  navigation reaches the network: a listed page, an app route (through the `_redirects` rewrites), or
  the release's own `index.html` for any other path — the signed list and its signature included. A
  deploy that serves its own HTML at some address cannot put that document in front of anyone who has
  the app installed.
- **The headers are the signed worker's, not the host's.** The build compiles the rules in
  `public/_headers` into the worker, and every answer from a release carries exactly those headers —
  the security policy included — with a content type taken from the file's extension. Whatever the
  host sent when the file was fetched is never replayed.
- **Nothing the worker stores is trusted.** IndexedDB and Cache Storage belong to the site, so any
  script that runs on it can rewrite them. The worker stores the signed list and its signature as
  bytes, never a conclusion like "this key is trusted". It checks them again, from the key compiled
  into itself, every time it reads them. It re-hashes every cached file before serving it, and fetches
  a fresh copy of any file that no longer matches.
- **An update is checked before it is used.** On every page load, when the app opens, and each time
  the tab becomes visible, the worker fetches the list and its signature, verifies the signature, fetches every listed
  file, checks every hash, writes them into a new cache, and only then moves one pointer to it. The
  pointer is one IndexedDB record written in one transaction, so a check interrupted halfway changes
  nothing.
- **Speech runtimes are listed but fetched later.** The speech runtimes (`assets/ort-wasm-simd-threaded-*.wasm`,
  12 MB, and Vosk's `assets/vosk-*.wasm`, 3 MB) are used only by people who install an on-device
  engine ([voice.md](voice.md)), so the update skips downloading them (`isDeferredReleaseFile`). It is still in the signed list: a request for it is
  answered only with bytes that hash to that list, fetched at that moment and not kept in the release
  cache.
- **A failed check changes nothing.** The installed version keeps running, and the app says, in one
  sentence, that an update was blocked and why.
- **Every machine's push worker is the same signed file.** Each paired machine gets its own
  registration of `sw.verified.js` at `/push/<daemonId>/` for its own push subscription
  ([cross-daemon.md](cross-daemon.md) §4b). Those copies run the same release check over the same
  storage, so a page under a push scope is still answered from the verified release, and the page
  audits each copy's script the way it audits the app-wide one. The audit fetches the file without the
  copy's `?machine=` query, so it proves the signed file, not what a host might serve for that query.
- **A replaced checker is sometimes reported.** If the browser starts installing a new worker script
  while a verified tab is open, that tab asks the running worker to compare the script with the signed
  list, and warns the reader if it is not the signed worker. This only **sometimes** works. See
  [what this does not protect](#what-this-does-and-does-not-protect-against).

## The model catalog rides on it

The hosted app also serves `catalog/models.json` and `catalog/version.json` (docs/model-catalog.md §
Live updates). They are ordinary listed files, so the same signature covers them, and a daemon checks
that signature itself — with the release key compiled into it — before it takes a newer model catalog.
No second key exists for it.

## The pieces

| piece                                             | role                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/pwa/src/lib/release-manifest.ts`        | the list's format, the signature file's format, request → listed file |
| `packages/pwa/src/lib/release-headers.ts`         | the `_headers` rules, and the headers a verified file is served with  |
| `packages/pwa/src/lib/release-verification.ts`    | the verifier: signature, key chain, release order, file hashes        |
| `packages/pwa/src/lib/release-keeper.ts`          | fetch, check, cache, swap, serve; the page ↔ worker messages          |
| `packages/pwa/src/lib/release-storage.ts`         | IndexedDB, Cache Storage and same-origin fetch, behind small ports    |
| `packages/pwa/src/worker/service-worker.ts`       | the worker's composition root (wiring only)                           |
| `packages/pwa/src/hooks/use-release-integrity.ts` | the page side: asks for checks, audits a new worker                   |
| `packages/pwa/src/shell/release-notice.tsx`       | the notice the reader sees                                            |
| `packages/pwa/scripts/build-release.ts`           | builds the worker, writes the list and the UNSIGNED marker            |
| `scripts/ci/sign-pwa-release.sh`                  | signs the list with openssl; the key arrives on stdin                 |
| `scripts/ci/check-pwa-release.sh`                 | proves the list says only what the run decided, before signing/deploy |
| `scripts/ci/verify-pwa-release.sh`                | proves the signature before a deploy                                  |
| `packages/pwa/release-signing-key.pub`            | the public key, compiled into every worker                            |
| `.github/workflows/pwa-pages.yaml`                | three jobs — build, sign, deploy — so the key never meets the build   |

### Wire formats

`release-manifest.json` (written by `serializeReleaseManifest`; the signature covers the bytes as
served, so a verifier never re-serialises):

```json
{
  "version": "3.38.0",
  "commit": "5a2e9c7…",
  "sequence": 1234,
  "createdAt": "2026-10-13T18:18:15.000Z",
  "worker": "sw.verified.js",
  "files": { "app/index.html": "<sha256 b64url>", "…": "…" },
  "nextKey": "<optional: SPKI b64url of the next signing key>"
}
```

`files` lists every file in `dist/` except `_headers` and `_redirects` (Pages configuration, never
served as bytes) and the list and its signature themselves. `scripts/ci/build-pwa.sh` fails the
build if the list and `dist/` disagree, and the deploy job checks every hash again before it uploads.

`release-manifest.sig` is one line: `<SHA-256 of the signing key's SPKI, b64url>.<64-byte Ed25519
signature, b64url>`. The fingerprint lets the verifier say "signed by a key this app does not trust"
honestly instead of "bad signature". A build with no key writes the single word `unsigned`.

### Which release is newer

Releases are ordered by `sequence` and nothing else. The deploy workflow passes its own run number
(`PWA_RELEASE_SEQUENCE`): a counter GitHub owns and only ever raises, so neither a commit's
self-reported time nor a version number decides anything. A release whose sequence is lower than the
installed one is refused as `older`. So is a release with the **same** sequence but a different
commit — one of the two is a replay. A local build is sequence 0, which every deployed release
outranks.

Two consequences to know:

- **Re-running an old workflow run republishes an old release** (a re-run keeps its run number), and
  installed copies refuse it. Deploy a fix by pushing to `main` or starting a new `workflow_dispatch`.
- **Renaming `pwa-pages.yaml` restarts the counter at 1**, and every installed copy would refuse every
  later release as `older`. Do not rename it. If it must be renamed, add the old workflow's last run
  number to `PWA_RELEASE_SEQUENCE` in the build job.

## What the worker refuses

| refusal         | meaning                                                                     | words the reader sees                               |
| --------------- | --------------------------------------------------------------------------- | --------------------------------------------------- |
| `unsigned`      | the `unsigned` marker, on any origin but a developer machine                | "it was not signed"                                 |
| `malformed`     | the signature file or the list is not well-formed                           | "its signature or file list was damaged"            |
| `unknown-key`   | signed by a key the worker does not trust, or one a later release retired   | "it was signed with a key this app does not trust"  |
| `bad-signature` | claims a trusted key, does not verify                                       | "its signature did not match"                       |
| `older`         | a lower sequence than the installed release, or the same one from elsewhere | "it is not newer than the version you have"         |
| `hash-mismatch` | a listed file's bytes are not the signed bytes                              | "one of its files was not the file that was signed" |

The signature is checked over the raw bytes **before** they are parsed, so nothing an unsigned list
says can influence the decision.

### Which keys a worker trusts

The **one anchor is the key compiled into the running worker** (`release-signing-key.pub` at build
time). A worker also trusts a key announced as `nextKey` by a release that verifies under a key it
already trusts. It keeps those announcing releases as signed bytes and re-verifies them every time it
reads them, so a key list written into IndexedDB by a page is never read at all. Keys are ranked in
the order they were announced. Once a release signed by a later key is installed, a release signed by
an earlier one is refused as `unknown-key`, which is how a planned rotation retires the old key.

### Unsigned builds

Local builds and pull-request builds have no key. They write the `unsigned` marker so "unsigned" is a
decision the build made out loud, never a missing upload.

- On a loopback hostname (`localhost`, `*.localhost`, any `127.x.x.x`, `[::1]` — the shared
  `isLoopbackHost` rule in `@ferretry/protocol`), the worker answers "unverified": it
  caches nothing and lets every request reach the network, so a developer sees their own build.
  This is decided from the page's hostname, which a deploy cannot change — a production origin can
  never accept an unsigned release, whatever the build said.
- Anywhere else, `unsigned` is a refusal like any other.
- **Production cannot deploy one.** The `sign` job fails when `PWA_RELEASE_SIGNING_KEY` is missing, and
  the `deploy` job runs `scripts/ci/verify-pwa-release.sh`, which fails on the marker.

## The key

### Where it lives

- **Private key:** the GitHub Actions secret `PWA_RELEASE_SIGNING_KEY` (PKCS#8 PEM), defined on the
  `pwa-release` **environment**, not as a repository secret. Protect that environment **before the
  workflow first runs**: **Settings → Environments → pwa-release → Deployment branches and tags →
  Selected branches → `main`**. Add required reviewers if you want a human to approve each deploy.
  GitHub creates a referenced environment that does not exist yet with **no** branch policy, so
  until this is set, a workflow on any branch could name the environment and read the secret.
- **Only the `sign` job holds it.** `pwa-pages.yaml` runs three jobs:
  - **`build`** installs dependencies and builds the release, and holds no secret. Any dependency's
    install script or build plugin runs here, so nothing it produces is trusted downstream.
  - **`sign`** holds the key. It installs nothing and runs no build: it checks out the repository for
    the scripts and the public keys, downloads the built release, and signs with openssl. **It never
    signs what it has not read.** A signature makes the list's trust fields permanent for every
    installed copy, so `scripts/ci/check-pwa-release.sh` first proves the list says only what this
    run decided, from facts the sign job knows on its own. Any refusal stops before the key is read:
    - only the fields of the format, and an `x.y.z` version;
    - `sequence` is this run's number and `commit` is this run's commit;
    - `worker` is `sw.verified.js`;
    - `nextKey` is the checkout's `release-signing-key.next.pub`, or absent when that file is;
    - every path is plain and none is Pages server code or configuration (`_worker.js`,
      `_routes.json`, anything starting with `_`, `functions/`);
    - the list names exactly the files built, each with its real hash, and nothing in the release is
      a symlink;
    - `_headers` and `_redirects` are byte-for-byte the checkout's.

    So a compromised build cannot get a real signature on an attacker's next key (as good as the
    stolen key) or on a huge sequence (every later release refused as older, forever). At worst it
    spoils one release's app code, which the list still names exactly.

  - **`deploy`** holds only the Cloudflare token. It runs the same check and proves the signature
    before it uploads.
    Every action in the workflow is pinned to an exact SHA.

- **In the `sign` job** the key reaches the signer on **stdin** (`printf`, a shell builtin, so no
  process's arguments carry it), and the signer runs without it in its environment. The signer writes
  it only to a `0600` file inside a fresh `mktemp -d` directory, which an `EXIT` trap removes. It is
  never echoed, never an argument, and never in the workspace. The signer refuses a key whose public
  half is not the committed `.pub`, and proves the signature before it returns.
- **Public key:** `packages/pwa/release-signing-key.pub`, committed. The build compiles it into the
  worker.

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
   and replace the secret with the new private key. Deploy. This release also carries a new
   `sw.verified.js`, because its compiled-in key changed; the running worker accepts it as the signed
   worker of a release it trusts.
6. Once an installed copy accepts a release signed by the new key, it refuses any later release
   signed by the old one. Its next worker carries only the new key.

A copy that was **not opened** between steps 3 and 5 never learned the new key. It refuses the new
releases as "signed with a key this app does not trust". When the browser then installs the new
worker on its own, that copy reports it as a replaced worker. Then it moves to the new worker, which
trusts the new key. Clearing the site's data (below) gets there at once.

### If the key is compromised

Someone holding the private key can sign a release every installed copy will accept, if they can
also get it served from the Pages address. Act in this order:

1. **Remove the secret** from the `pwa-release` environment and revoke the Cloudflare token used by
   `pwa-pages.yaml` if the same machine or account was involved.
2. **Generate a new key pair** and commit the new public key as `release-signing-key.pub` (do not
   announce it through `nextKey` — that would be signed by the compromised key).
3. **Deploy** a release signed with the new key. Installed copies refuse it ("a key this app does not
   trust"). The release also carries a new worker, compiled with the new key. The browser installs it
   on its own schedule, and while a tab is open the old worker reports it as a replaced worker, which
   in this one case is expected.
4. **Tell users to reinstall:** open the app's address, then use the browser's site settings to
   **clear the site's data**, and reload. On a phone with the app on the home screen, remove it and
   add it again after clearing the data. That installs the new worker and its release in one step.

There is no remote way to make an installed worker distrust a key it compiled in, by design: anything
that could would also be a way for an attacker to make it distrust the real one.

## What this does and does not protect against

**It protects an installed copy** against a deploy that changes the app's files, pages or headers —
a compromised Pages project, a hijacked Cloudflare token, or a CI run on the wrong ref — **as long as
that deploy keeps the signed worker.** Such a release is refused; the reader keeps the version they
had and is told. A page the deploy adds, or HTML it serves at any other address, is never loaded for
an installed copy, because every navigation is answered from the installed release. A weakened
`_headers` changes nothing either, because the worker serves the headers it was built with.

**It also protects an installed copy against a script that once ran in it** (an XSS) trying to
outlive the tab through the worker. The script cannot make the worker serve bytes it wrote into the
cache (they are re-hashed against the signed list). It cannot make the worker trust a key or a release
it wrote into IndexedDB (both are re-verified from the compiled-in key). And it cannot make a good
update look like a bad deploy (a tampered cached copy is fetched again, not refused).

**It does not protect:**

- **The first install (trust on first use).** A browser that has never installed the app trusts
  whatever the site served at that moment, the worker and its key included.
- **Against a deploy that ships a new service worker.** A browser installs a changed `sw.verified.js`
  on its own schedule, and the worker is the checker, so a deploy that ships its own worker replaces
  the check itself. The audit described above is the only defence, and it is weak:
  - It runs **only if a verified tab is open** while the browser installs the new worker. The browser
    also checks for a new worker on its own (on navigations, on push events, and at least every 24
    hours), so the new worker can be live before the app is next opened, with no audit at all.
  - A hostile worker can always win the race. One that calls `skipWaiting()`, claims the open tabs,
    and reloads them is in control before the old worker has fetched the script to compare it. The
    tab that would have shown the warning is gone.
  - The warning is page state. It does **not** survive a reload, so even when it is shown, the next
    load under the new worker shows nothing.
  - **Nothing reaches the daemon.** The page has a typed hook for it (`onUnsignedWorker` in
    `use-release-integrity.ts`) that nothing is wired to yet; the audit log is zero-trust PR C.

  So this is **not prevented, and only occasionally detected**. Preventing it needs a client the
  deploy cannot rewrite (a native app or a browser extension), which is out of scope.

- **A server that lies only to the browser's worker install.** The audit compares the bytes the
  running worker fetches for the new script with the signed list. A host that answers the browser's
  own worker-install request (`Sec-Fetch-Dest: serviceworker`) differently from an ordinary fetch can
  pass the audit even when it does run. A static deploy cannot make that split, but as above, it does
  not need to.
- **Code running in the open app.** An XSS acts with the app's full authority while the tab is open,
  as everywhere else in the zero-trust design. What it can still do to the worker's storage:
  - **wipe it**, after which the worker has no release, lets requests reach the network, and
    installs whatever signed release the site serves at the next check;
  - **put back an older release it kept a copy of** — genuine signed bytes. Once this worker has
    installed or confirmed a newer release from the site, it remembers that release's sequence and
    never serves a stored one below it. But that memory is the worker's own, and the browser stops an
    idle worker within minutes. **The first page load after the worker restarts serves the restored
    release.** That load also re-checks the site and moves forward again, but the restored release has
    already run once. So an XSS in release N, fixed in N+1, can keep coming back: it runs again on the
    first load after each worker restart, for as long as it keeps writing N back. Clearing the site's
    data ends it. Ending it for good needs storage a page cannot write, which a website does not have;
  - **break the database** (for example by upgrading its version), after which the worker cannot read
    its record and lets requests reach the network.

  None of these lets it serve its own code, but combined with a compromised deploy, wiping the
  storage turns the next load back into a first install.

- **A browser with no service worker** (an insecure origin, some private windows): nothing is
  checked and nothing is shown.
- **The daemon.** Daemon requests never go through this cache: the worker answers only same-origin
  `GET`s, and passes everything else through untouched. A same-origin fetch of a file the release does
  not list also goes to the network; only a navigation never does.
- **A compromised signing key** — see above. The key is the root of this whole check.
- **A copy that is never opened.** Checks happen when the app is opened or brought back into view;
  there is no timer.
