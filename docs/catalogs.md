# Catalogs: sharing skills and MCP setups, signed

A **catalog** is a named list of skills and MCP setups on one machine, the **publisher**. Someone who
is not one of your devices can install an item from it on **their own** machine, the **installer**.
Every catalog is **signed by the publisher's daemon identity**, so the installer checks where it came
from itself, whatever carried it: a file, a browser, an offline copy.

This page is the **contract**: what is built, the bytes both ends agree on, and the checks an installer
runs. The full approved design, with the people, sharing codes, offline library and artifacts still to
come, is [design/catalogs.md](design/catalogs.md). Where they differ, this page wins for what exists.
Which parts are live is the [phase table](#what-is-built) at the end.

The wire contract is `packages/protocol/src/lib/shared-catalog.ts` (items, manifests, files),
`shared-catalog-review.ts` (the review and its warnings), `catalog-install.ts` (the installer's routes)
and `canonical-json.ts`. Signing and checking are `packages/relay/src/lib/catalog-signature.ts`, beside
the identity they use. In code everything is `SharedCatalog*`, because "catalog" already names four
other things (design §1).

## The one rule

**Installing an item is a trust step.** A skill is instructions a ferret follows, scripts included, and
an MCP setup is a program the installer's runtimes start. Nothing makes either safe. So an install is:

- **Visible.** Every file is shown in full, and every command line, never a count.
- **Deliberate.** Every secret the item needs is mapped by the installer, to one of **their own**
  secrets, every time. Nothing is bound for them.
- **Pinned.** The publisher's fingerprint, the item version and its digest are recorded. **Nothing
  updates by itself.** A later version is a new review and a new yes.

## Items

An item is one **version**, frozen when it is published and never rewritten
(`SharedCatalogItemSchema`). Each has an `itemId` that stays the same across versions, a `name` (the
folder a skill installs as, or the MCP server's name: letters, digits, `-` and `_`, starting with a
letter or digit), a one-line `summary` and, optionally, the `harness` it is written for. Every one of
those is in the signed bytes, and its manifest line must say the same.

**A skill** is a folder: `SKILL.md` at its root and up to 200 text files. The bundle rules are Clone's
([cross-daemon.md](cross-daemon.md) §3a′, §3b), plus more, so the review lists exactly what gets
written and no two names can look alike:

- every path is one plain relative path (no leading `/`, `~` or `$`, no `.` or `..`, no `\`), at most
  16 folders deep;
- **every name in it is plain ASCII**: letters, digits, `.`, `_` and `-`, at most 255 characters, not
  ending in `.` and not starting with `-` (a shell glob would hand that to a program as an option). That rules out invisible characters, look-alike letters, Unicode normalisation and case
  folding beyond ASCII, and Windows's own tricks (`name::$DATA`, a trailing dot);
- no Windows device names (`CON`, `NUL`, `COM1`…), because a project install lands in a repository a
  teammate on Windows may check out;
- **no `.git` folder**. A carried repository's config can name programs (`core.fsmonitor`) that any
  `git` command run in that folder starts, and nothing in the review would look like a script. A folder
  laid out as a **bare repository** (`HEAD` beside `objects/` and `refs/`) is refused for the same reason;
- no file is carried twice, **including two names a case-insensitive file system treats as one**
  (`SKILL.md` and `skill.md`);
- no path is both a file and a folder;
- at most 256 KiB per file and 2 MiB in total, counted in UTF-8 bytes.

Files are text. A skill with a binary file cannot be added yet. A file's **content** may hold any
character, because a skill may need to; the review marks each hidden one (below).

**An MCP setup** is a program to start (`command`, `args`, `env`) or a server to reach (`url`, with an
optional `auth: "oauth"`). **No field exists for a secret value**, and `${` reaches nothing but a
placeholder the installer fills:

- A secret is named only as a **whole** environment value, `${secret:NAME}`. That is a placeholder the
  installer fills in.
- **Nothing else may contain `${`**: not a command, not an argument, not the address, and not part of a
  value. Otherwise a setup could ask for `${GITHUB_TOKEN}` and have the installer's own environment
  expand into its program.
- **A heuristic refuses values that look like raw keys**: the rule the MCP forms already use
  (`mcpServerRefusal`), plus a known provider prefix anywhere in an argument, value or address
  (`--token=ghp_…`, `?key=sk-…`), and a long value right after a secret-sounding word or an auth scheme
  (`--api-key …`, `Bearer …`). Those names are read as whole words, so `--author` and `/oauth/authorize`
  are ordinary, and in an address only as a query parameter. It is a heuristic: a key with no known prefix under an innocent name is
  not found by anything.
- A command, an argument, a value, an address and an OAuth client id refuse controls and invisible or
  text-direction characters. An argument or a value may hold a tab or a line break, which the review
  shows quoted, so it cannot draw a review line of its own.
- An address is plain `http://` or `https://`, with no user name or password in it. A signed-in server
  is `https://` only.
- An OAuth **client secret has no field**. The installer signs in on their own machine
  ([mcp-oauth.md](mcp-oauth.md)), and no token is ever copied.

**An artifact** item is listed in the schema now so the contract does not change later, but it carries
only a reference to an encrypted snapshot (design §3.8). Artifacts are opened, never installed, and
nothing publishes one yet.

**Labels** (a catalog's name, the publisher's name, a summary) refuse controls, line breaks and every
invisible or text-direction character: the bidirectional overrides and marks, zero-width spaces and
joiners, the soft hyphen, the line and paragraph separators, the Hangul fillers, variation selectors, tag
characters and the byte-order mark (`HIDDEN_CHARACTER_SOURCE`). A description may also hold line breaks
and tabs. **Look-alike letters are not refused** (a Cyrillic `А` in "Аnthropic"): names in every
language are allowed, so a reader always shows **its own label** for a publisher and the start of its
fingerprint beside the publisher's own name.

## Signed manifests

A **manifest** lists one catalog at one **revision** (`SharedCatalogManifestSchema`): its name,
description, visibility, and one line per item version with its digest and size. The revision only goes
up. Withdrawn items stay listed as withdrawn, so an installer can say so.

```text
digest    = "sha256:" ‖ hex(SHA-256(canonical JSON of the item))
signature = Ed25519(publisher's daemon identity key,
                    "ferretry-catalog-manifest-v1" ‖ 0x00 ‖ SHA-256(canonical JSON of the manifest))
signed    = { manifest, spki, sig }      // spki: the publisher's public key, DER
```

- **Canonical JSON is RFC 8785** (JCS), written by `canonicalJson` and nothing else. The publisher, the
  app and the installer all call that one function. It is tested against the RFC's own vectors, and it
  refuses what has no single spelling (`NaN`, infinity, a lone surrogate).
- **The label is new.** The same identity key signs relay handshakes, rendezvous claims and
  secret-import offers, each under its own label, so a manifest signature can never stand in for one of
  those.
- **No schema transforms.** A signature covers the canonical JSON of the **parsed** document, so a
  schema that trimmed or defaulted a field would make the two ends hash different things. Every schema
  only accepts or refuses. A tested property: parsing returns exactly its input.
- **A daemon signs only for itself.** `signCatalogManifest` refuses a manifest that names another
  publisher.

## The catalog file

`fy catalog export` writes a **catalog file** (`SharedCatalogFileSchema`, format
`ferretry-catalog-file`): the signed manifest plus any of the item versions it lists. It is the whole
trust core with no people involved: send the file, and the other person installs from it.

A reader refuses a file larger than **32 MiB before parsing it**: whoever reads one from disk or the network bounds the bytes there first (its size, or `Content-Length`), and `readSharedCatalogFile` refuses an oversized text by its length before measuring it. The schema then refuses any item the
manifest does not list, at another version or name, from another catalog, or carried twice. Who made
it is decided only by the signature.

## What the installer checks, in order

The installer is the subscriber's **own** daemon. It never talks to the publisher, and it never takes
the caller's word for what the publisher said:

1. **The signature.** The public key hashes to the publisher's daemon id
   (`fy_daemon_` ‖ base64url(SHA-256(spki))), and the signature holds over the manifest.
2. **The item.** It is the version, kind, name, summary and harness its manifest line lists, and its digest and
   size are those of exactly these bytes.
3. **The publisher pin.** If this machine already installed from this catalog, the fingerprint is the
   same. The first install records it, and the review says it is a first install (trust on first use).
4. **No downgrade.** The version is at least the installed one, unless the person chose an older one,
   and then the review says so first.
5. **The bundle rules** above.
6. **The target is one this machine already knows**: a registered project, or an existing runtime and
   profile.

Steps 1 and 2 are `verifySignedCatalogManifest` and `verifyCatalogItem`. The app runs them too,
before it shows anything, but the installer always runs them again.

## The review

The installer answers a preview from one module, `shared-catalog-review.ts`, so what a person reads and
what gets written can never disagree:

- **Every file in full**: `SKILL.md` first, then every other file by path. Each invisible or
  text-direction character, and each control but a tab, a line break or a carriage return that ends a
  line, is **shown marked** as `⟨U+202E⟩` (`revealHidden`), so a file cannot read differently on screen
  from what it says (Trojan Source). The bytes installed are the bytes published; only what a person
  reads is marked.
- **Every command line**, quoted the way a person would type it, and **every variable**, with
  placeholders shown as written. A value holding a tab or a line break is shown quoted.
- **Warnings**, in words:
  - `unpinned-package`: each package the command fetches at launch with no fixed version. It reads npx,
    bunx, `npm exec`, `pnpm dlx`/`pnpx`, `yarn dlx`, `bun x`, uvx, `uv tool run`, `uv run --with`,
    `pipx run`, `docker`/`podman run`, `go run`, `deno run` and `nix run`/`nix shell`, every `-p` and
    `--with` package, and the command lines inside `sh -c` (also `-lc`), `cmd /c` and
    `powershell -Command` (the rest of the arguments), `env` (also `-u`, `-C` and `-S`) and `npx -c`,
    three levels deep. A container image counts as fixed only by its digest, since any tag can be pushed
    again. The text says it runs whatever is newest each time a ferret starts, so it can change without
    an update. **Even an exact version is only the top of the tree**: its own dependencies resolve fresh
    when it installs. This is a warning, not a refusal (owner decision Q15), because refusing would
    block most real servers.
  - `package-registry`: a `--registry`, `--index-url` or `--userconfig` flag (`-i` for Python tools), or
    a variable that sets a registry (`NPM_CONFIG_REGISTRY`, `UV_INDEX_URL`), a proxy (`HTTPS_PROXY`) or
    which certificates are trusted (`NODE_TLS_REJECT_UNAUTHORIZED`, `SSL_CERT_FILE`). Whoever controls
    that can serve different files for the same version, so an exact version means nothing there.
  - `network-url`: a server at an address runs on someone else's computer and can change at any time.
  - `carries-scripts`: a skill carries scripts (by extension, or a `#!` first line), named one by one.
  - `runs-on-its-own`: a skill carries files a tool runs or obeys by itself when it opens the folder
    (`.envrc`, `.env`, `package.json`, `Makefile`, `justfile`, `mise.toml`, `.pre-commit-config.yaml`,
    `.mcp.json`, and anything in `.vscode`, `.idea`, `.husky`, `.mise`, `.claude`, `.codex` or
    `.agents`), in any letter case.
  - `hidden-characters`: which files hold the characters the review marks.
  - Only the installer can know `first-publisher`, `older-version` and `edited-locally`, so it adds those
    itself.

## Installing from a file

Installing is two steps and every route has exactly one capability. A project write is governed by
`filesystem` and a runtime write by `fleet`, so each scope has its own preview and its own apply
(`packages/daemon/src/lib/runtime/mounts/catalog-installs.ts`):

| Route                                            | Capability             | What it does                                                              |
| ------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------- |
| `POST /v1/catalog-installs/project/preview`      | `filesystem.use`       | verifies everything, answers the review and a `previewId`; writes nothing |
| `POST /v1/catalog-installs/project`              | `filesystem.configure` | applies exactly that preview into a project folder                        |
| `POST /v1/catalog-installs/runtime/preview`      | `fleet.use`            | the same, for a runtime and profile                                       |
| `POST /v1/catalog-installs/runtime`              | `fleet.configure`      | applies it as one fleet change                                            |
| `GET /v1/catalog-installs`                       | `fleet.use`            | what is installed, and where                                              |
| `DELETE /v1/catalog-installs/project/:installId` | `filesystem.configure` | removes exactly what that install wrote                                   |
| `DELETE /v1/catalog-installs/runtime/:installId` | `fleet.configure`      | the same, for a runtime install                                           |

- **The preview** runs the checks above in that order. Each refusal has its own code and a plain
  sentence (`CATALOG_INSTALL_REFUSALS`); the first one to fail is the one reported. The body is refused
  past 16 MiB before it is parsed. The answer is the full review, the publisher (with `firstSeen`),
  where it would land in words, and every placeholder. `held` (whether B holds a secret of that name) is
  told only to a caller who may list secret names (`secrets.use`, as `GET /v1/secrets` asks); to any other
  it is left out, so a preview never tells which names exist. `replaces` is set only when B's own record shows the same publisher, catalog and item at the same
  target; another publisher's item of the same name is never replaced.
- **Previews live in memory** only, for 600 seconds, up to 8 per caller. A preview is bound to the item's
  digest, the target **and the caller that reviewed it** (a paired device by its id, the machine's own
  shell as the host, a ferret as an agent): another caller's apply is `catalog_preview_unknown`, and one
  caller can never push another's preview out. An apply consumes it.
- **The apply** takes `{previewId, secretBindings}`. The bindings name **exactly** the preview's
  placeholders. Each maps to one of B's own secrets (it must exist) or to `null` (unbound). Nothing is
  bound silently, so a mismatch is `catalog_bindings_invalid`. **`null` leaves the variable OUT** of what is
  written (the project `.mcp.json` and the runtime component alike), the install records it as unbound,
  and the apply's notes say "NAME is not set. The program runs without it until you bind one of your
  secrets to it." An unbound placeholder is never filled by a secret of the same name. A bound project
  server gets `${OWN}` in `.mcp.json` (the variable must be set in the ferret's environment, and the apply
  says so); a bound runtime server gets `${secret:OWN}`. No secret value crosses any route.
- **It writes only through existing paths**: the project `.mcp.json` compare-and-swap, a project skill
  folder (a new port that never follows a symbolic link and refuses one on the path), and for a runtime
  the fleet catalogue (an INTERNAL change, `catalog.install`: the component, its skill files and the
  profile entry are one change). That kind is not in the wire schema, so `POST /v1/fleet/proposals`
  refuses it; only the installer produces one, after its checks. The fleet executor also resolves every
  file path and refuses any write outside the skill's own folder in the assets directory. Anything already at the destination that B's install record did not write is
  `catalog_install_conflict`. An update replaces an install only when every file it wrote still has the
  hash B recorded (files are compared by exact relative path); a file edited by hand is a conflict that
  says so. A runtime component is compared by a hash of what it holds, recorded at install, so a hand
  edit is found even when its provenance is kept. B records the resolved project folder and root, so a
  removal needs no re-derivation from the spelling the install used. Keeping your edits is phase 3.
- **A passkey for every install.** An apply from a governed caller needs a fresh step-up for the act
  `catalog-install` (`403 grant_step_up_required` otherwise). **The unlock is not that proof**: it
  opens the machine, and only a passkey proved for this act counts. The proof is claimed atomically at
  admission, so one confirmation buys one install even when two applies race, and it is **not** given
  back when the install is then refused: ask again. An update asks too. **Removing never asks.** A loopback caller is ungoverned: the CLI asks y/N instead.
- **A ferret may preview and list, but never install or remove**: it is refused with `403 forbidden`
  , because an install is code that will run.
- **What "pinned" means.** The first install from a catalog records the publisher's fingerprint, and
  later installs of that catalog from any other fingerprint are `catalog_publisher_changed`. B also
  records the highest manifest revision it has installed from, and an older revision is
  `catalog_revision_older`. The pin, the revision and the install are recorded **only when an apply
  succeeds**, never by a preview. Nothing updates itself: a newer version is a new preview and a new yes.
- **Storage.** `<FY_HOME>/state/catalog-installs.json`, mode `0600`, written by temp file and rename,
  with a `schemaVersion` and checked on read. It holds each install with the SHA-256 of every file it
  wrote, the publishers, the pin per catalog and the highest revision seen. A damaged file stops every
  install route with `500 catalog_installs_unreadable` instead of starting afresh.

### The command line

```
fy catalog install <file> [--item <name>]
    ( --project <root> --harness claude|codex | --runtime <r> --profile <p> )
    [--bind PLACEHOLDER=MY_SECRET]... [--unbound PLACEHOLDER]... [--older] [--yes]
fy catalog installs
fy catalog uninstall <installId> [--yes]
```

`install` checks the file's size before reading it, previews, prints the **whole** review (every file,
command and warning), asks for each placeholder you did not name (or fails when it cannot ask), asks
y/N unless `--yes`, then applies. When the daemon wants a passkey it says so and changes nothing.

## Declared gaps

What this does **not** protect against, said plainly (more in design §4.8):

- **Trust on first use (G5).** A valid signature proves the bytes came from the machine with that
  fingerprint. It does not prove that machine is the person you meant. Compare the fingerprint with them
  if it matters.
- **Unpinned package managers (G6)** change what runs without an update. Warned, not refused. Neither
  warning is complete: a launcher this module does not know, or a script that downloads something
  itself, is only visible as its command line.
- **A program you install is a program you run.** Leaving a secret unbound stops that secret from
  being handed over. It does not stop the program reading whatever else its process can reach,
  including variables it inherits (`sh -c 'echo $AWS_SECRET_ACCESS_KEY'`).
- **Raw keys are found by a heuristic.** No field holds a secret value, but a key with no known prefix,
  under a name that does not sound secret, passes.
- **Look-alike names.** A publisher may name itself with letters that look like another's. The reader's
  own label and the fingerprint are what tell two publishers apart.
- **Files left behind.** If B's state file cannot be written after the files were, they stay on disk
  with no record, and the next install there is a `catalog_install_conflict`. Nothing is deleted
  that B has no hash for.
- **A folder swapped for a link mid-install.** The write refuses a link on the path when it checks and
  again for each file, but a folder swapped for a link in the instant between the two is not caught.
- **Refused previews are not in the audit log.** Only applies and removes are.
- **Signed means attributable (G9).** Anyone holding a signed manifest can prove the publisher
  published it. A catalog file's `exportedAt` is not signed: it only says when the file was written.

## What is built

| Phase                                                                                                        | State                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **0. The contract**: items, manifests, files, canonical JSON, signing and checking, the review, the warnings | **Built.** No routes and no screens yet.                                                    |
| **1. Signed catalog files**: make catalogs, export a file, install it on another machine with the review     | The installer side is built (routes, `fy catalog install`, storage). Next: the app screens. |
| 2–7. Members, the offline library, public catalogs, revoke clean-up, hosted artifacts, passkey-locked ones   | Designed ([design/catalogs.md](design/catalogs.md) §6), not started.                        |
