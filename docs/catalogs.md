# Catalogs: sharing skills and MCP setups, signed

A **catalog** is a named list of skills and MCP setups on one machine, the **publisher**. Someone who
is not one of your devices can install an item from it on **their own** machine, the **installer**.
Every catalog is **signed by the publisher's daemon identity**, so the installer checks where it came
from itself, whatever carried it: a file, a browser, an offline copy.

This page is the **contract**: what is built, the bytes both ends agree on, and the checks an installer
runs. The full approved design, with the people, sharing codes, offline library and artifacts still to
come, is [design/catalogs.md](design/catalogs.md). Where they differ, this page wins for what exists.
Which parts are live is the [phase table](#what-is-built) at the end. The machine that makes a catalog is
[the publisher side](#the-publisher-side).

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
characters and the byte-order mark (`HIDDEN_CHARACTER_SOURCE`). **Any Unicode format character (`\p{Cf}`) is refused** the same way in names, summaries, arguments and values, and marked in file bodies, so a file that parsed under an older build can be refused now. A description may also hold line breaks
and tabs. **Look-alike letters are not refused** (a Cyrillic `А` in "Аnthropic"): names in every
language are allowed, so a reader always shows **its own label** for a publisher and the first 20 characters of its
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
  - `possible-secret`: which skill files hold what the MCP raw-key rule would refuse (a known provider
    prefix, or a long value right after `token`, `key`, `password` and the like). A guess and a warning, not a
    refusal: a skill may show an example key. The publisher's freeze also leaves out credential files by
    name (see [What a freeze does](#what-a-freeze-does)).
  - Only the installer can know `first-publisher`, `older-version` and `edited-locally`, so it adds those
    itself.

## The publisher side

What exists on the machine that makes a catalog. Everything here needs the **`sharing`** capability
(`use`), and every write is the owner's: a ferret may read, never publish.

### Making and exporting a catalog

> **Upgrading.** A device paired before this release holds **Sharing OFF**: its record predates the
> capability, and an old record never reads wider than it was written. At the machine, turn it on for one
> device with `fy device grant <device> sharing --use`. The host's own `fy catalog` commands are not
> governed by a device grant and work at once. See [grants.md](grants.md#changing-a-devices-grants).

```text
fy catalog create "Team skills"                       # an empty catalog, revision 1
fy catalog add "Team skills" --skill review-pr        # shows ALL of it, then asks y/N
fy catalog add "Team skills" --mcp docs --summary "Search our docs"
fy catalog export "Team skills" --out team.catalog.json
```

- `ls`, `create`, `rename`, `describe`, `rm` manage catalogs. `add`, `publish`, `withdraw` manage items.
- `add --skill <path|name>` / `add --mcp <id|name>` freezes a **copy** of the source. A name that matches
  several sources is never guessed: the command lists them and stops.
- `add` and `publish` print the full review and the warnings the installer will see, then ask `y/N`.
  `--yes` skips the question, not the printing. `rm` and `withdraw` ask too.
- `publish <catalog> <item>` freezes the source again as the item's **next version**. If the source
  has not changed it says "nothing to publish".
- `export` writes `<catalog-name>.catalog.json` (or `--out`) and refuses to overwrite without `--force`
  (before asking the daemon to sign anything). Before it signs, it **prints every live item with its
  version and digest and asks `y/N`** (`--yes` skips the ask, not the printing), and after the daemon
  answers it checks that what was signed is exactly what was printed, writing nothing if it is not. The
  file is verified with the installer's own check before it is handed over. The file is **compact JSON on one
  line**, because the 32 MiB cap is measured on those bytes and the file is for machines; the review above is what a
  person reads. `--force` writes a temporary
  file beside the destination and renames it over, and refuses a destination that is a symbolic link.
- `export --item` chooses which items the **file carries**. The signed manifest still lists **every live
  item** of the catalog, so a reader sees the whole catalog and which items it was not given. The ask
  above shows every live item for the same reason.
- `add` and `publish` also print **where the source was read from** (the `SKILL.md` path, or the file
  or fleet component that declares the MCP server), so a name that means two things is never silently one.
- `ls` re-reads every source to say whether it changed; the daemon does that only for
  `GET /v1/catalogs?sourceState=1`, which `fy catalog ls` sends. A plain `GET /v1/catalogs` does not
  touch any source.
- Install is the other machine's side (`fy catalog install`, phase 1b).

### What a freeze does

- **A freeze is a copy.** Editing the skill afterwards changes nothing already published. The list shows a
  `sourceState`: `unchanged`, `changed` (publish to ship it), `unavailable` (the source is gone) or
  `withdrawn`.
- **A skill** is read recursively. Symlinks are **not followed**, and nothing is left out silently:
  every file that does not go (binary, over 256 KiB, `.git`, deeper than 16 folders, a name the
  contract refuses, a case-clash, past 200 files or 2 MiB) is listed with its reason. The walk is bounded
  before any contents are read, and **folders count toward the entry limit** as files do.
- **Hard links are not carried** ("a hard link can be a file from outside the folder"): a file whose link
  count is above one is listed as not carried.
- **Credential files are not carried**, each listed with why: `.env`, `.env.*`, `.netrc`, `.npmrc`,
  `.pypirc`, `.git-credentials`, and any `id_rsa*`, `id_ed25519*`, `*.pem` or `*.key` name. A file that
  does go but looks like it holds a key draws the `possible-secret` warning in [the review](#the-review).
- **An MCP setup from a fleet component** converts directly and keeps `${secret:NAME}` as a
  placeholder. An OAuth `clientSecret` is dropped, and the review says so.
- **An MCP server from `.mcp.json`, `~/.claude.json` or a local config** is **refused** if an
  environment value uses `${VAR}` or looks like a raw key. The answer is the contract's sentence plus the
  fix: put the key in the secret store and add the server as a fleet component with `${secret:NAME}`.
  Headers and a bearer variable are never carried, and are listed as not carried.
- **Ferretry's own tools server** is not shareable: every install already starts it.
- Visibility is always `members`. A request for `public` is refused (400, `public_unavailable`).

### One preview, one add

`POST /items/preview` freezes the source and answers the review and a **digest** of the content.
`POST /items` sends that digest back with the source; if the source hashes differently by then, the
add is refused (409 `changed_since_preview`). So the thing you read is the thing that is published.
The digest is the content digest, with the item's identity (its id and version) set aside; the digest
the signed manifest lists covers identity and is what an installer pins.

The preview also says **where the source was read from** (`location`: the resolved `SKILL.md` path, or the file or fleet component that declares the MCP server). A name that matches more than one source is **refused (409 `source_ambiguous`) with every candidate listed**; the daemon never picks one.

### The revision rule

A catalog's `revision` rises by **exactly 1** on every change the manifest can see (an item added, a
new version, a withdrawal, a rename, a new description, a new publisher name), and **never otherwise**. `issuedAt` is the
instant of that change, and a file's `exportedAt` is that same instant, so **two exports with nothing
between them are byte-identical**. A reader that saw revision 7 refuses a signed 6.

The publisher name the manifest carries is **stored with the catalog** when it is made (the machine's
name then) and signed from the store at every export, so a change of host name does not change the bytes
of a revision. `PATCH` may set it, which is a change like a rename. Restoring `catalogs.json` from a
backup can **reuse revision numbers**: an installer that saw a newer revision of this catalog refuses
the restored older one, and the fix is to publish something new so the revision passes theirs.

### Routes

All are `sharing`/`use`, `noStore`, and the writes answer a ferret 403 `forbidden`.

| Route                                          | Does                                                                  | Ferret  |
| ---------------------------------------------- | --------------------------------------------------------------------- | ------- |
| `GET /v1/catalogs[?sourceState=1]`             | every catalog, its items and versions (`sourceState` only when asked) | may     |
| `POST /v1/catalogs`                            | make one (201)                                                        | refused |
| `PATCH /v1/catalogs/:id`                       | rename, describe or set the publisher name                            | refused |
| `DELETE /v1/catalogs/:id`                      | delete it and its versions                                            | refused |
| `POST /v1/catalogs/:id/items/preview`          | freeze a source for review; writes nothing                            | may     |
| `POST /v1/catalogs/:id/items`                  | add the previewed source as a new item (201)                          | refused |
| `POST /v1/catalogs/:id/items/:itemId/versions` | publish the next version (201)                                        | refused |
| `DELETE /v1/catalogs/:id/items/:itemId`        | withdraw an item                                                      | refused |
| `POST /v1/catalogs/:id/export`                 | sign and return the catalog file                                      | refused |

Refusals keep their code: 404 `catalog_unknown` / `item_unknown` / `source_unknown`; 409 `item_withdrawn`,
`name_taken`, `catalog_full`, `source_ambiguous`, `changed_since_preview`, `nothing_to_publish`; 400
`public_unavailable`; 413 `export_too_big` (the file would be over 32 MiB: export fewer items); 422
`source_refused`; 503 `signing_unavailable`; 500 `store_damaged` / `export_failed`.

### Why a ferret may only list

A ferret holds the admin token, but a catalog hands skills and MCP setups to other machines. A
prompt-injected agent that could publish would be one that could hand a skill, or the address of a
server, to whoever the owner next sends the file to. So the daemon refuses a ferret (an agent caller)
every route above except the two reads. Governed remote callers also need a passkey step-up for
`sharing.use` ([grants.md](grants.md#capability-eight-was-added-sharing)).

### Storage

Under `<FY_HOME>/state/catalogs/`, directory `0700`, files `0600`, written atomically:

- `catalogs.json`: the catalogs, their items and a line per version (digest, size, when, source). It
  carries a `schemaVersion` and is parsed with zod on every read. A damaged file is a clear
  `store_damaged` error; it is never silently reset.
- `blobs/<sha256-hex>.json`: one frozen item version each, **content-addressed and never rewritten**.
  The blob is written before the document that lists it, and a blob is checked against its digest when
  read.

Mutations are serialised, so two requests never interleave a read-modify-write.

### Audit

Ids only, never what an item holds ([audit.md](audit.md)): `catalog.changed` (create, update, delete,
publish, withdraw, with item id, version, digest and revision) and `catalog.exported` (revision and
item ids). Both are **kept** events.

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
  and the apply's notes say "NAME is not set by this install. The program runs without it unless its own
  environment already has a variable of that name." An unbound placeholder is never filled by a secret of the same name. A bound project
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
  opens the machine, and only a passkey proved for this act counts. Each proof is stamped with the act it
  was proved for (the app names the act when it asks), so a leftover proof for another act, such as loosening
  a configuration file, does not count either. The proof is claimed atomically at
  admission, so one confirmation buys one install even when two applies race, and it is **not** given
  back when the install is then refused: if the install is refused after you confirm, you confirm again. An update asks too. **Removing never asks.** A loopback caller is ungoverned: the CLI asks y/N instead.
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
    [--bind PLACEHOLDER=MY_SECRET]... [--unbound PLACEHOLDER]... [--older] [--yes] [--json]
fy catalog installs [--json]
fy catalog uninstall <installId> [--yes] [--json]
```

`install` checks the file's size before reading it, previews, prints the **whole** review (every file,
command and warning), asks for each placeholder you did not name (or fails when it cannot ask), asks
y/N unless `--yes`, then applies. When the daemon wants a passkey it says so and changes nothing.

With `--json` (on the verb, or on `fy catalog` itself), which `install` and `uninstall` accept only
together with `--yes` (a script cannot answer y/N; a person reads the review without `--json`), stdout
carries exactly one protocol payload: the
applied install with its notes, the install list, or what was removed. The preview still goes out in full,
as JSON on stderr, so a script never skips the review a person would have read.

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
- **A folder swapped for a link mid-install** (the installer side). The write refuses a link on the path when it checks and
  again for each file, but a folder swapped for a link in the instant between the two is not caught.
- **Refused previews are not in the audit log.** Only applies and removes are.
- **Signed means attributable (G9).** Anyone holding a signed manifest can prove the publisher
  published it. A catalog file's `exportedAt` is not signed: it only says when the file was written.
- A catalog file is plain JSON that anyone can read. Signed is not secret: do not add what you would not
  hand over.
- Skill content is shown in full but is only checked by the heuristics in [The review](#the-review).
- **The ferret refusal is an honest-client guard, and the export's printout is the check.** "A ferret may
  only list" reads who is asking from the session header `fy` sends from inside a ferret. A ferret holds
  the same admin token and runs as the same user, so it can send raw HTTP without that header, or write
  `state/catalogs/` itself. Either way a program running as the owner on the publisher can change what
  the **next export signs**. `fy catalog export` therefore prints every item it will sign (name, version,
  digest) and asks first, and refuses to write a file that differs from what it printed; read that list.
  A per-session credential would close this and is not built (the same limit as
  [secrets.md](secrets.md)).
- **A folder swapped for a link during the publisher’s read (declared as a gap).** The skill walk resolves the
  folder, checks each parent, and opens each file with `O_NOFOLLOW`; after the open it checks the file is
  a regular file with one link. What is not closed is the instant between the parent check and the open:
  a folder replaced by a link in that instant is followed for that one read. The attacker must already be
  the same user on the publisher, and the content is shown in the preview and bound by its digest.
- `public` and members are not available; a file is the only way a catalog leaves.

## What is built

| Phase                                                                                                        | State                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. The contract**: items, manifests, files, canonical JSON, signing and checking, the review, the warnings | **Built.**                                                                                                                                                                                                                                                                                                                   |
| **1. Signed catalog files**: make catalogs, export a file, install it on another machine with the review     | **Built**: the publisher side (`fy catalog`, the owner routes, the `sharing` capability), the installer side (`fy catalog install`, the install routes, a passkey per install), and the app screens (Add to catalog, Settings › Sharing › Catalogs, Install from a file). The next phase is 2 (members, live), once decided. |
| 2–7. Members, the offline library, public catalogs, revoke clean-up, hosted artifacts, passkey-locked ones   | Designed ([design/catalogs.md](design/catalogs.md) §6), not started.                                                                                                                                                                                                                                                         |
