# Catalogs: sharing skills and MCP setups, signed

A **catalog** is a named list of skills and MCP setups on one machine, the **publisher**. Someone who
is not one of your devices can install an item from it on **their own** machine, the **installer**.
Every catalog is **signed by the publisher's daemon identity**, so the installer checks where it came
from itself, whatever carried it: a file, a browser, an offline copy.

This page is the **contract**: what is built, the bytes both ends agree on, and the checks an installer
runs. The full approved design, with the people, sharing codes, offline library and artifacts still to
come, is [design/catalogs.md](design/catalogs.md); the Sharing page, skill rows, versions and links that build on it are
[design/catalogs-sharing.md](design/catalogs-sharing.md). Where they differ, this page wins for what exists.

**Where it is in the app.** The **Sharing** page, `/d/<machine>/sharing/<tab>`, works like a marketplace (&B131) with
three tabs: **Subscriptions** (`shared`, the first and default tab: what you subscribe to and can install), **My
catalogs** (`catalogs`: what this machine publishes) and **People** (`people`). The old **Skills** tab is gone; an
address naming it opens Subscriptions. Phone: **More › Sharing**. Desktop: the top bar, the sidebar footer and the
narrow rail. The palette also finds **Sharing**, **Subscriptions** and **Publish skills…** (which opens My catalogs).
Settings › Machine › Catalogs is only a link to Sharing › My catalogs. `/shared` stays for a browser
with no machine.
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

> **Upgrading.** A device that held **every** capability before Sharing existed — the owner's phone — gets
> Sharing on once, at the first boot of this release, with nothing to run: what it would hold if it were paired
> today (owner decision; [grants.md](grants.md#capability-eight-was-added-sharing) says exactly when). Any other
> device can have it turned on in the app (Settings › Devices) by a device that has Sharing on and may manage
> devices, or at the machine with `fy device grant <device> sharing --use`. The host's own `fy catalog` commands are not
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
  has not changed it says "nothing to publish". It prints [what changed](#what-changed-catalogs-3d-1) from the
  version installers get now, then the full review, and only then asks `y/N`.
- `versions <catalog> <item>` lists every version the item has, oldest first, with the current one marked. It only reads.
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

Exactly one catalog's revision rises for a rename, a description, an add (new or existing), a withdrawal or a relist. A new version raises the revision of **every catalog that lists the item live** (one write carries all of them, whichever route published it), and leaves a catalog that withdrew the item alone. Making a catalog the default changes no manifest, so no revision rises.

A catalog serves the versions from the one it joined at (or was relisted at) onward: the entry's optional `sinceVersion` (absent means 1, so catalogs made before 3c-2 serve every version) is set to the item's current version when an existing item is added or relisted, and `frozenItem` refuses any older version as `item_unknown`, so **a catalog never serves a version below its `sinceVersion`**. Publishing a new version leaves `sinceVersion` alone. `sinceVersion` is a floor, not a ceiling: when an item is added or relisted while newer versions already exist (the current version was rolled back), the entry also stores `joinedAtMax`, the newest version that existed then, because the person who added it reviewed `sinceVersion` and was never shown the ones between. **A catalog may serve its `sinceVersion`, its current version, and any version after `joinedAtMax`; never one in between.** `joinedAtMax` is absent (no gap) unless a newer version existed, so entries from before 3d-2 carry none; see the declared gap below. A live entry's `sinceVersion` can never be newer than the item's current version: the document is refused as damaged if it is. Only the current version is exported. The first call on a 3d-2 daemon raises the file to **`schemaVersion: 3`** (same shape, nothing else changes) and keeps the old file as `catalogs.v2.json`, so a 3c-1 or 3d-1 daemon, which only reads versions it knows, refuses it (`store_damaged`) and never writes. A downgrade needs the file restored: stop the daemon, `mv catalogs.v2.json catalogs.json` ([Going back from version 3](#upgrading-from-version-2)). Without that, a 3d-1 build would have read the file, ignored `joinedAtMax` and retirement, and written entries back without them.

The publisher name the manifest carries is **stored with the catalog** when it is made (the machine's
name then) and signed from the store at every export, so a change of host name does not change the bytes
of a revision. `PATCH` may set it, which is a change like a rename. Restoring `catalogs.json` from a
backup can **reuse revision numbers**: an installer that saw a newer revision of this catalog refuses
the restored older one, and the fix is to publish something new so the revision passes theirs.

### Routes

All are `sharing`/`use`, `noStore`, and the writes answer a ferret 403 `owner_only` (the `person` caller check at the route boundary). The handlers keep a second line, 403 `forbidden`, that is only reached if the boundary ever lets a ferret through, and a unit test calls them directly to pin it.

| Route                                               | Does                                                                                                                                          | Ferret       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `GET /v1/catalogs[?sourceState=1]`                  | every catalog, its items and versions (`sourceState` only when asked), and which is the default                                               | may          |
| `GET /v1/catalog-items[?sourceState=1]`             | every shared item once, with the catalogs that list it and where each version is used                                                         | may          |
| `GET /v1/catalog-items/:itemId[?sourceState=1]`     | one shared item, as the list shows it (404 `item_unknown`)                                                                                    | may          |
| `GET /v1/catalog-items/:itemId/versions/:version`   | one frozen version in full: what an installer of exactly that version is shown (404 `version_unknown`)                                        | current only |
| `GET /v1/catalog-items/:itemId/changes?from=&to=`   | what a person would read differently in `to` than in `from` (404 `version_unknown`)                                                           | current only |
| `POST /v1/catalog-items/:itemId/versions/preview`   | the next version from the source the item remembers, with what changed from the current one; body `{}`; works while no catalog lists the item | may          |
| `POST /v1/catalog-items/:itemId/versions`           | publish the previewed next version to every catalog that lists the item live (201)                                                            | refused      |
| `PUT /v1/catalog-items/:itemId/current`             | make a kept version current in every live catalog; body `{version, from}` (409 `version_before_join`, `version_retired`)                      | refused      |
| `PATCH /v1/catalog-items/:itemId/versions/:version` | retire a version or bring it back; body `{retired}` (409 `version_current`)                                                                   | refused      |
| `POST /v1/catalogs`                                 | make one (201)                                                                                                                                | refused      |
| `PATCH /v1/catalogs/:id`                            | rename, describe, set the publisher name, or `role: "default"` (no revision)                                                                  | refused      |
| `DELETE /v1/catalogs/:id`                           | delete it (its items and versions are kept in the store)                                                                                      | refused      |
| `POST /v1/catalogs/:id/items/preview`               | freeze a source for review; writes nothing                                                                                                    | may          |
| `POST /v1/catalogs/:id/items`                       | add the previewed source as a new item, or `{itemId, version}` to list an item already kept (201)                                             | refused      |
| `POST /v1/catalogs/:id/items/:itemId/versions`      | publish the next version (201)                                                                                                                | refused      |
| `DELETE /v1/catalogs/:id/items/:itemId`             | withdraw an item                                                                                                                              | refused      |
| `POST /v1/catalog-items/quick-add`                  | one-tap Add into the default catalog: 201 `added`, 200 `already` or `review`                                                                  | refused      |
| `POST /v1/catalog-items/quick-add/undo`             | take that add back with its token (single use, 60 s)                                                                                          | refused      |
| `POST /v1/catalogs/:id/export`                      | sign and return the catalog file                                                                                                              | refused      |

Refusals keep their code: 404 `catalog_unknown` / `item_unknown` / `source_unknown`; 409 `item_withdrawn`,
`name_taken`, `catalog_full`, `catalogs_full` (256 catalogs), `items_full` (4,096 items, or 1,000 versions of one item), `version_current`, `version_retired`, `version_before_join`, `item_listed`, `current_changed`, `source_ambiguous`, `changed_since_preview`, `nothing_to_publish`, `same_as_version`; 404 `version_unknown`; 400
`public_unavailable`; 410 `undo_expired`; 413 `export_too_big` (the file would be over 32 MiB: export fewer items); 422
`source_refused`; 503 `signing_unavailable`; 500 `store_damaged` / `export_failed`.

### What changed (catalogs 3d-1)

Before a person publishes, they are shown what would be different. `POST …/items/preview` and
`POST /v1/catalog-items/:itemId/versions/preview` carry an optional `changes` when the item already exists. It is
worked out **against the current version**, the one every catalog serves, from the same review text a person reads, so
text that hides a character is already marked when it is compared.

- **One entry per thing in the review**, keyed by its label (`Skill file <path>`, `Starts`, `Reaches`, `Environment X`, …):
  `added`, `removed` or `changed`. A one-line entry carries its text `before` and `after`. A file carries **hunks**
  (unified-diff shaped, three lines of context), or its whole text when added or removed. `unchanged` counts the rest.
- **Flagged first.** A change to what a setup starts, reaches or has in its environment is flagged `command`; a
  changed script is `script`; a file a harness runs by itself is `runs-on-its-own`. Flagged entries are listed
  before the others.
- **Warnings** are compared too: `newWarnings` are ones the next version would draw that the current one does not,
  `goneWarnings` the reverse.
- **Bounded.** A file needing more than 4,000 edits is `tooLarge` (read it whole in the full review), and the answer
  stops at 20,000 lines in all: the entries that did not fit say `tooLarge` and the answer says `truncated`.
  Nothing is dropped without saying so. The work is bounded too: two texts whose lengths differ by more than 4,000
  lines are `tooLarge` at once, and **one answer spends one budget of 8,000,000 diff steps across all its files**.
  Once it is spent, every later document entry is `tooLarge`, is not diffed, and the answer says `truncated`.
  A folder a ferret can write therefore cannot hold the daemon busy for more than that budget.
- **A carriage return at the end of a line is marked** (`⟨U+000D⟩`) on hunk lines, so a CRLF to LF change is
  visible instead of looking like lines that changed to themselves.
- **`sameAsVersion`** says the source hashes to a version already kept. The current one is checked first, then older
  ones. Publishing it is refused: 409 `nothing_to_publish` when it is the current version, 409 `same_as_version`
  when it is an older one (making an older version current is 3d-2, below). Only a version that could be made current
  again counts: one that is retired, or that a live catalog may not serve, is published as a new number instead, so
  publishing and making current never refuse each other.
- **`sameAsRetiredVersion`** (optional) says the source hashes to a RETIRED version, the newest such one, when
  `sameAsVersion` is absent. Publishing is still allowed and makes a new version number; the field is a warning for the
  app to show before it does.
- Publishing keeps the preview binding: the source is read again and refused (409 `changed_since_preview`) unless
  it still hashes to the previewed digest. One item holds at most 1,000 versions (409 `items_full`).
- `POST /v1/catalogs/:id/items/:itemId/versions` stays, as the same publish for an item that catalog lists. Both
  routes bump every catalog that lists the item live in **one write** and leave each `sinceVersion` alone.

The reads of the **current** version are open to a ferret (they show only what the owner already keeps); the publish
is the owner's. A ferret keeps only today's view: reading **any other version**, or `changes` where either side is not
the current version, is the owner's and answers a ferret 403 `forbidden` (older versions are history the owner keeps,
not something an agent needs). The `changes` and the version reads are the same bytes whoever asks. A version read reads the kept copy, and
refuses a copy that no longer matches its digest.

The feature flag is `catalogs.versions.1`: a daemon reports it when it answers the item routes above (making a version current and retiring one are `catalogs.versions.2`, see 3d-2 below), so the app
dials them only where the machine says it can.

### Making a version current, retiring one, and the signed version list (catalogs 3d-2)

Publishing always makes the new version current. This slice adds the other two things an owner does with versions
already kept, and a signed list of what a catalog offers. The owner's screens for it are [catalogs 3d-4](#the-owners-versions-in-the-app-catalogs-3d-4); there is no installer for the list yet.

- **`PUT /v1/catalog-items/:itemId/current` `{version, from}`** makes a kept version the one every live catalog
  serves. `from` must still be the current version (409 `current_changed` otherwise). It bumps **every live
  catalog that lists the item in one write** and leaves each `sinceVersion` alone. Making the version that is
  already current is 409 `nothing_to_publish`.
- **`PATCH /v1/catalog-items/:itemId/versions/:version` `{retired}`** retires a version (it stops being offered)
  or brings it back. The answer is `{itemId, version, retiredAt?, catalogs:[{catalogId, revision}]}`; `retiredAt`
  is absent once it is back in use. Retiring or unretiring bumps every live catalog in one write. Asking for the
  state it already has writes nothing.
- **Version numbers are never reused.** Retiring does not free a number: the next publish is still the next number.

**The audience rule.** A catalog never serves a version below its entry's `sinceVersion`, and making a version
current cannot widen who sees what:

- Making a version current is refused, 409 `version_before_join`, when **any** live catalog may not serve it: it is
  below that catalog's `sinceVersion`, or it is one of the versions between `sinceVersion` and `joinedAtMax` (rolled
  back from v5 to v3, then listed in catalog D at v3: D is never offered v4 or v5, and gets v6 when it is published).
  The sentence names those catalogs. `sinceVersion` and `joinedAtMax` are never changed implicitly.
- Retiring the current version is refused, 409 `version_current`. A retired version cannot be made current,
  409 `version_retired` (bring it back first).
- Every write is checked again at the commit, and a document that breaks any of these rules is refused as
  `store_damaged` with nothing written: a live entry's `sinceVersion` newer than its item's current version; the current
  version inside the entry's `joinedAtMax` gap (above `sinceVersion`, up to and including `joinedAtMax`); a
  `joinedAtMax` that is not above `sinceVersion` or is past the item's last version (it must lie in
  (`sinceVersion`, number of versions]).
- Publishing the content of an older version again is refused (409 `same_as_version`) only when **making that version
  current would be accepted**: it is not retired and every live catalog may serve it. Otherwise it is published as a new
  version number, so a publish and a make-current never refuse each other.

**The signed version list** says which versions of one item one catalog offers, so an app that already holds the
signed manifest can ask "what else is there" without trusting the transport.

- It is `{versions, spki, sig}`. `versions` is `format: "ferretry-catalog-versions"`, `version: 1`, then the
  `publisher`, `catalogId`, `itemId`, `revision`, `issuedAt`, `current` and `offered[]`
  (`version`, `digest`, `size`, `publishedAt`, `summary`), oldest first.
- It **offers only versions the catalog may serve (see the audience rule) that are not retired, and the current
  version is always offered.** A catalog that joined at version 3 is never offered 1 or 2.
- The signature covers the label `ferretry-catalog-versions-v1`, one `0x00` byte and the SHA-256 of the list's
  canonical JSON. The manifest's label is different, so **a manifest signature never verifies as a list and the
  reverse**.
- A reader proves the list belongs to a manifest it holds: `publisher`, `catalogId`, `itemId`, `revision` and
  `issuedAt` equal the manifest's, `spki` is the same key, and `current` and the digest of the current entry equal the
  manifest line, including its size and summary (`verifyCatalogItemAgainstVersions` in `packages/relay`); an item
  read from the list must also match the entry's digest, size and summary. Any difference is refused.
- It is built from **the same document snapshot as the manifest**, so the two cannot disagree.

**The member route** is `GET /v1/shared/catalogs/:catalogId/items/:itemId/versions` ([relay-protocol.md](relay-protocol.md)
§14). An unlocked member only; their grants are re-read on every request. The `ETag` is the catalog's revision and a
match answers 304. The daemon first does a plain read (no write queue, nothing signed): an item the catalog does not
offer, because it is withdrawn or not listed, is 404 `item_unknown` whatever tag was sent; then the tag is checked, and
only then is the list signed. A 304 never signs anything. The sibling route `…/items/:itemId/:version` refuses a
**retired** version, one the catalog may not serve, and a withdrawn item the same way. **Both member routes say one fixed
sentence for every `item_unknown`** ("this catalog does not offer that"): no item name, no version number, no reason, so
retired, below-join, never-existed and withdrawn are indistinguishable to a member. A damaged store is
500 `store_damaged`, not an export failure.

**What an app does with the answer (the `/versions` contract).** The app learns that an item is withdrawn from the
**signed manifest** (its `withdrawn[]` ids), never from `/versions`. A member app cannot see the feature flag
(`SharedMeSchema` is strict and has no flags), so it tries the route and reads the answer:

- Manifest lists the item live and `/versions` answers **404**: treat it as "this machine offers no version list" (an old
  daemon, or a race with a withdrawal that the next manifest will show) and show **only the manifest line**.
- Manifest lists the item in `withdrawn[]`: it is withdrawn, whatever `/versions` says.
- 200: verify the list against the manifest it holds (above), then show it.

The decision is a pure function of the manifest and the status; the member app that needs it is catalogs 3d-5, which
owns its unit test. Nothing in this slice builds that app model.

**Who may.** Both writes are the owner's (`sharing.use`, a person, not a ferret: 403 `owner_only`) and ask for no new
passkey. The audit records ids only: a `catalog.changed` entry with action `make-current`, `retire` or `unretire`,
the item id, the version and the catalogs and revisions it raised. A retire or unretire is recorded only when it changed
something: the answer carries `changed`, and asking for the state a version is already in (`changed: false`, nothing
written, no revision raised) is not an audit entry. The action comes from the request's `retired` flag, so a refused
unretire is recorded as an `unretire` that did not succeed, never as a retire; a body that cannot be read is recorded
as `retirement`.

The feature flag is `catalogs.versions.2`: a daemon reports it when it answers these three routes, so an owner app
dials the two owner routes only where the machine says it can. A member app has no flag to read and uses the 404 rule
above.

**For 3d-3 (recorded, not built).** An install chosen from the version list must keep the existing
`catalog_revision_older` pin: an install chosen from a version list is checked against the manifest the list was
verified with, and a manifest older than the revision of that catalog the app has already seen is refused, so a stale or
replayed list cannot install an older version.

**Declared gap.** An entry written before 3d-2 has a `sinceVersion` but no `joinedAtMax`, and the 2→3 upgrade does not
invent one. That is safe because the window needs a rollback, no released build could roll an item back, and so such an
entry never sat below a newer version. The one way to open it is to run a 3d-1 build on a file that a 3d-2 build had
already rolled back (3d-1 would add entries without `joinedAtMax`). The version 3 file stops that: a 3d-1 build refuses
it (`store_damaged`) and never writes. It happens only if the owner restores `catalogs.v2.json` over a file that holds a
rollback, which the downgrade note above warns against.

### One item in many catalogs, and the default (catalogs 3c-2)

An item is kept once and can be listed in any number of catalogs. `POST /items` with `{itemId, version}` lists an item
the machine already keeps in another catalog. `version` must equal the item's current version, else 409
`current_changed`; an item the catalog already lists live is 409 `item_listed`; a withdrawn entry is **listed again in
place**. Only the catalog it joins gains a revision. A preview with `{itemId}` for an item the catalog does not list shows
the frozen current version and reads no source. That preview is open to a ferret like the others, for withdrawn and orphaned items too: it only shows what the owner already keeps, and writes nothing. Publishing a new version through one catalog raises the revision of every
catalog that lists the item live.

`PATCH` with `role: "default"` makes a catalog the default **without a revision** (it is not in any manifest). There is
no demoting to none: another catalog replaces it, and deleting the default clears it. `role` and `defaultCatalogId` are
optional response fields. The CLI: `fy catalog ls` marks the default, `fy catalog default <catalog>` sets it, and
`fy catalog add <catalog> --item <itemId>` prints the frozen review and asks y/N. The feature flag is
`catalogs.items.1`. The app's use of these is [The app (catalogs 3c-4)](#the-app-catalogs-3c-4).

### One-tap Add, and Undo (catalogs 3c-3)

`POST /v1/catalog-items/quick-add` takes `{source}` (a skill or an MCP server, named as in a preview) or `{itemId}` (an
item already kept) and lists it in the **default catalog**, the only target. There is no field to say "this is clean":
the daemon decides.

- **Clean means the one frozen object that is stored.** The source is read once, frozen once, and the warnings are read
  from that same object, which is then written. Any warning (a script, hidden characters, a possible secret, an MCP
  command), any file left out (`problems`), a missing summary, or a kept item whose current version has warnings answers
  **200 `review`** with the reasons (`warnings`, `problems`, `needs-summary`) and, except for a missing summary, the
  preview a person reads. **Nothing is written**, including the default catalog.
- **`added` (201)** answers the catalog (and whether this tap made it), the item, version and digest, whether the item is
  new, whether its source has since changed (a kept item is never re-published by a tap), and an Undo token with its expiry.
  **`already` (200)** is a double tap: the item is live in the default catalog and nothing is written.
- **The default catalog is made lazily**, in the same single write as the item: "<this machine's label>'s skills", the label
  cut so the name is at most 80 characters, then "… 2" to "… 9" when the name is taken (`name_taken` after nine). A refusal
  (`catalogs_full`, `catalog_full`, `items_full`) leaves nothing written. A source is matched to a kept item by that
  item's **current** version; when two or more kept items are the same source (the sheet made one per catalog) the tap is
  409 `source_ambiguous`, naming the item ids, and the caller names one by `itemId`. Whether the item is already live,
  or needs review, is decided before the default catalog is made or checked. A kept item joins through the same step as
  `POST /items`, so its audience starts at its **current** version (`sinceVersion`); older versions are not served.
- **Undo** (`POST …/quick-add/undo` with `{token}`) is bound to the credential that tapped (a paired device, or the host),
  good once, for 60 seconds. A token is used up only when its write has landed, so a failed write leaves it good. It **retracts** (the entry is removed with no withdrawal record, and the item with it when this
  tap made it and no catalog lists it) only while the catalog is still on the revision the add made **and** no signed
  manifest of that revision was ever produced (a member reading it, or an export). Otherwise it **withdraws**, the ordinary
  withdrawal that members see. An item relisted over an earlier withdrawal is always withdrawn again. The default catalog
  the tap made stays. An unknown, lapsed, used or other caller's token is 410 `undo_expired` with nothing changed; withdraw the item the ordinary way.
- Every write, and every manifest or export that signs, runs in the one write queue, so a manifest read and an Undo cannot
  interleave. **Member manifest reads and exports now wait in that queue** behind a write in flight, instead of reading
  alongside it.
- Declared gap: **the undo record is in memory.** A restart forgets every token, so Undo then answers 410 and the person
  must withdraw the item the ordinary way (nothing does it for them); it also forgets which revisions were signed, which is why no add survives a restart as
  retractable. The feature flag is `catalogs.quick-add.1`. Audit: `catalog.changed`, `publish` or `undo`, ids only
  ([audit.md](audit.md)); a `review` or `already` answer changed nothing and is not recorded.

### The app (catalogs 3c-4)

The skill and MCP rows (`features/catalogs/catalog-item-row.tsx`) use the two routes above. The app ships before the
daemon, so it asks `GET /v1/health` once per read and uses a route only when the matching flag is there:
`catalogs.quick-add.1` for one-tap Add, `catalogs.items.1` for the default catalog, **Make default** and **Add to another
catalog…**. A machine that cannot be asked (the read fails) offers neither, and every row keeps the sheet it had before.

- **Publish is one tap** when the machine says it can: the row's ⋯ item says where it goes, "Publish in ‹default
  catalog›", or "Publish in a new catalog, ‹machine›’s skills" while no default exists yet. The app never claims a
  catalog the machine has not made. The tap sends `{source}` to `quick-add`; picking it again while one is in flight
  is ignored.
- **`added`** shows a toast, "Published in ‹catalog›", with **Undo** (44px tall) and a seconds counter. It stays **10
  seconds**, shorter than the daemon's 60-second token, so a slow link still lands. Undo calls `quick-add/undo`
  with the token and shows what it did: **retracted** says "Taken back. It was never in ‹catalog› for anyone.";
  **withdrawn** says "Withdrawn from ‹catalog›. Someone may have seen it, so it shows as withdrawn." A refusal (an
  `undo_expired` token, a lost link) is said in the same toast as a plain sentence. The toast floats over the page
  (`fy-attn-undo`) and is drawn into `document.body`, so no list or sheet clips it; on a phone it sits above the
  bottom tab bar. After an Add or an Undo the rows read the catalogs again, so the version chip and the "Add to another
  catalog…" entry are right.
- **`already`** is a plain 4-second toast, "Already in ‹catalog›", with no Undo.
- **`review`** writes nothing and opens the Add sheet on the preview the daemon sent (the frozen copy a person reads,
  with its warnings and what was left out) and one sentence saying why the tap stopped. The default catalog is
  preselected; with no default yet, the sheet offers the machine’s default name as the new catalog and makes it the
  default once the add lands (the **Make default** step is best effort: the add has already succeeded). A
  `needs-summary` answer carries no preview, so the sheet starts from Preview.
- **A refused tap** (`catalogs_full`, `items_full`, `source_ambiguous`, `source_refused` and the rest) opens the same
  sheet with the refusal in one sentence, so the person can pick a catalog by hand.
- **Sharing › My catalogs** marks the default catalog with a **default** badge, in the list and on the detail. On the
  detail of any other catalog, **⋯ › Make default** (`PATCH role: "default"`) makes it the default and says so; it is
  shown only when the machine has `catalogs.items.1`.
- **Add to another catalog…** (the row's ⋯, for an item already in a catalog) reads `GET /v1/catalog-items`, finds the
  item by source, and opens the sheet in **add-existing** mode: the catalogs that already list the item live are
  left out of the picker; the sheet opens already showing the **frozen current version** (a preview by `{itemId}`, no source read; Preview re-reads it); Add sends
  `{itemId, version}` with the version that was reviewed. If the item moved on (409 `current_changed`, or
  `changed_since_preview`) the sheet reads the frozen version again, shows it, and says so, and the person adds
  again. Without `catalogs.items.1` the entry opens the ordinary sheet.

Versions are in the next section.

### The owner's versions in the app (catalogs 3d-4)

The owner sees, compares, rolls back and retires versions from the app. It is built only where the machine
advertises the flag: `catalogs.versions.1` for reading (the sheet, the changes, the changes in Publish update) and
`catalogs.versions.2` for the three buttons that write. Without them today's screens stay as they were. Everything is
the owner's: it appears only on the surfaces that already show owner actions (the row's ⋯ on the skill and MCP rows,
and Sharing › My catalogs), never to a member.

- **Versions…** opens a sheet from the row's ⋯ (when the item is shared) and from the item in Sharing › My catalogs
  (not for a withdrawn one). It reads `GET /v1/catalog-items/:itemId`. Each line reads
  `v3 · current · 2 days ago · 4 files · 12 KB`, newest first; a retired one says `retired`. Over the list: the
  catalogs that serve the current version ("Used by Team skills and Friends.") and **"N people can see it."** That is
  **reach, not installs**: the members who may read at least one catalog that lists the item live, counted in the app
  from the members list. Nobody here says who installed what. If the members cannot be read, the line is left out
  rather than guessed.
- **What changed since vN** (on every line but the first) reads `GET .../changes?from=<neighbour>&to=<version>` and
  draws it in the Apply-diff style (`ChangesView`). Entries that deserve a second look (a command or address, a script,
  a file a tool runs on its own) and `newWarnings` come first. `tooLarge` and `truncated` are said in words; hidden
  characters stay marked (`⟨U+200B⟩`) and a carriage return at a line end is shown as `⟨U+000D⟩`. Every string goes
  through the same marked-text renderer as the full review, so raw hidden text is never drawn.
  Lines **wrap** (pre-wrap, break anywhere, the `-`/`+` gutter stays): a review never hides the end of a line, so
  nothing is cut off, ellipsised or scrolled away, on a phone included.
- **Publish update** (Add to catalog's "Publish update" and the row's "Source changed — Publish update") shows
  `changes` against the CURRENT version under the preview, before the button. When the daemon answers
  `sameAsVersion`, the sheet says "That is version N. Make version N current instead." with a button that does it
  (only when N is not already current: the daemon checks the current version first, so it can name it). When it
  answers `sameAsRetiredVersion`, the sheet warns "This is the content of retired version N. Publishing makes a new
  version number anyway." and still lets the owner publish.
- **Make current** sends `{version, from}` with the current version the sheet read, after a one-line confirm ("Every
  catalog that lists it will offer version N from now on. Copies people already have stay as they are."). Refusals
  are one sentence each, shown **beside the version that was refused** (the confirm closes): `version_before_join`
  says it in plain words and names every catalog that joined later ("Friends was added after version 2, so it can't
  offer version 2. Keep the current version, or make a newer one current."; the names are read out of the daemon's
  message, since the wire carries them nowhere else); `current_changed` reads the item again and says it moved on; `version_current` says "Make another
  version current first." (also what a retire of the current one says).
- **Retire…** and **Bring back…** (`PATCH .../versions/:version {retired}`) each confirm in one sentence. Only the
  buttons the daemon would accept are drawn: the current version offers neither, a retired one only Bring back, an
  ordinary one Make current and Retire.

The frames are `harness/catalogs-versions-screenshot.tsx` (`harness/out/catalogs-versions-*.png`).

### Why a ferret may only list

A ferret holds the admin token, but a catalog hands skills and MCP setups to other machines. A
prompt-injected agent that could publish would be one that could hand a skill, or the address of a
server, to whoever the owner next sends the file to. So the daemon refuses a ferret (an agent caller)
every route above except the two reads. Governed remote callers also need a passkey step-up for
`sharing.use` ([grants.md](grants.md#capability-eight-was-added-sharing)).

### Storage

Under `<FY_HOME>/state/catalogs/`, directory `0700`, files `0600`, written atomically:

- `catalogs.json` (**schema version 3**): one shared **item table** and the catalogs that list its items.
  An item holds its kind, name, source and a line per version. A catalog holds its own settings, its
  `revision` and an ordered list of `entries` (`itemId`, `addedAt`, `withdrawnAt` once withdrawn). A
  version carries two digests:
  - `contentDigest`: the digest of the version with the three fields that name a catalog
    (`catalogId`, `itemId`, `itemVersion`) replaced by fixed placeholders, so the same content has the
    **same** `contentDigest` in every catalog. This is the **shared copy**.
  - `bindings[catalogId] = { digest, size }`: the digest and size of the item **as that catalog signs
    it**. A signed item names its catalog, so the digest differs per catalog and the signed format
    cannot change.

  The file carries a `schemaVersion` and is parsed with zod on every read. A damaged file is a clear
  `store_damaged` error; it is never silently reset.

- `blobs/<hex>.json`: one frozen item version each, **content-addressed**: the name is the SHA-256 of the
  file's text, so a file that holds other text is replaced with the right text on the next write (see the gap
  below). Version 2 stores the **shared copy**, named by the hex of its `contentDigest` (no `sha256:` prefix
  in the file name), once per version. Reading it for a
  catalog sets the three placeholder fields back (a pure step), and **every read checks both**: the
  shared copy against its `contentDigest`, and the re-identified item against that catalog's
  `bindings[catalogId].digest`. A blob is written before the document that lists it.
- `catalogs.v1.json`: the version 1 file as it was, kept by the upgrade (see below). Nothing reads it.
- `catalogs.v2.json`: the version 2 file as it was, kept by the 2→3 upgrade (see below). Nothing reads it.

Mutations are serialised, so two requests never interleave a read-modify-write. A new version of an item
raises the `revision` of **every** catalog that lists it live, in one document write; a catalog where it
is withdrawn is not raised, but still gets a binding so it can be listed again later.

Deleting a catalog removes it and its bindings and **keeps the items and versions** it listed (and their
shared copies); the route still answers as before. Nothing yet removes an item no catalog lists.

#### Upgrading from version 1

A version 1 `catalogs.json` listed items inside each catalog, with one blob per catalog version. The
first call that finds one upgrades it, **inside the write queue**, so two first calls upgrade once. The
steps run in this order and each is safe to run again:

1. Read every version 1 blob and **verify it against the digest the file lists**. Any blob that is
   missing, not JSON, not an item, not the item the file says it is, or that no longer hashes to its
   digest stops the upgrade with `store_damaged` naming `blobs/<hex>.json`. **Nothing is written.** The
   next call tries again; restore the file, or install the previous Ferretry version.
2. Write the shared copies (`blobs/<hex of contentDigest>.json`, no `sha256:` prefix).
3. Write `catalogs.v1.json` with the exact text of the old file.
4. Write the version 2 `catalogs.json`.

A crash between any two steps leaves the version 1 file in place, and the next call repeats the upgrade
to the same bytes. The upgrade is pure and deterministic: a version 2 file is left alone. It changes
**nothing a member or an installer can see**: the signed manifests, the per-catalog items, their digests
and the revisions are byte-identical before and after, and the next export equals the one before.
The version 1 per-catalog blobs stay on disk.

**One thing does change: a preview held across the upgrade is stale.** A version 1 `contentDigest` kept the
catalog's real id; a version 2 one is catalog-independent (the shared copy carries placeholder ids). A
preview taken before the upgrade and sent back after it is therefore answered `409 changed_since_preview`;
take a new preview and send that. Nothing is published by the refusal.

**Going back.** A previous daemon only reads `schemaVersion: 1`; it refuses the version 2 file and never
writes to it (`store_damaged`). To go back: stop the daemon, move `catalogs.v1.json` over `catalogs.json`
(`mv catalogs.v1.json catalogs.json`), then start the previous version. **Caveat:** everything changed
since the upgrade is lost, and revision numbers may be **reused**, which an installer that saw the newer
revision refuses ([the revision rule](#the-revision-rule)). The refusal's advice to "move the file
aside" is the wrong way back: the previous daemon then starts with no catalogs, and the next upgrade
would write a new `catalogs.v1.json` over the backup.

**If the version 2 file was already moved aside** and the previous daemon has run since, stop the daemon
first. Copy `catalogs.v1.json` somewhere safe if it is the backup you want to keep. Then either put the
moved-aside file back as `catalogs.json` (it is a whole, valid version 2 file, so the newer daemon reads
it as it was, with every shared copy still in `blobs/`), or, to go back to version 1, move your saved
`catalogs.v1.json` over `catalogs.json` as above. Anything the previous daemon published in between is in
the file it wrote and is lost either way; keep that file too if you need it.

#### Upgrading from version 2

Version 3 has the same shape as version 2. It exists so that a build that does not know `joinedAtMax` or retirement
cannot read the file and write it back without them. The first call that finds a version 2 file, inside the write
queue, writes `catalogs.v2.json` with the exact text of the old file, then writes the version 3 `catalogs.json`. A
crash between the two leaves the version 2 file in place and the next call repeats both to the same bytes. A version 3
file is left alone.

**Going back from version 3.** A 3c-1 or 3d-1 daemon refuses the version 3 file and never writes to it
(`store_damaged`). To go back: stop the daemon, `mv catalogs.v2.json catalogs.json`, then start the previous version.
Everything changed since the upgrade is lost and revision numbers may be reused, as for version 1. Copy
`catalogs.v2.json` somewhere safe first if you want to keep it: a later upgrade writes a new one over it.

### Audit

Ids only, never what an item holds ([audit.md](audit.md)): `catalog.changed` (`create`, `update` (a rename, or a role change, which records `role`), `delete`, `publish` (a new item, a new version or an existing item listed in another catalog) and `withdraw`,
with item id, version, digest and revision; `make-current`, `retire` and `unretire` with item id, version and the catalogs and revisions raised) and `catalog.exported` (revision and
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
| `PATCH /v1/catalog-installs/project/:installId`  | `filesystem.use`       | stay on this version / skip one (no file is touched)                      |
| `PATCH /v1/catalog-installs/runtime/:installId`  | `fleet.use`            | the same, for a runtime install                                           |

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
  hash B recorded (files are compared by exact relative path); a file edited by hand is refused as
  `catalog_install_edited` (see [Updating an install](#updating-an-install-catalogs-3d-3)). A runtime component is compared by a hash of what it holds, recorded at install, so a hand
  edit is found even when its provenance is kept. B records the resolved project folder and root, so a
  removal needs no re-derivation from the spelling the install used.
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

### Updating an install (catalogs 3d-3)

Installing again over an install of the same item at the same target is an **update**. Everything
below is on the installing machine and the daemon decides it from that machine's own bytes. Nothing here
is automatic: an update is always a new preview and a new yes (and, from a governed device, a fresh
`catalog-install` passkey).

- **Move to any offered version.** The preview request may carry `signedVersions`, the publisher's signed
  version list ([above](#making-a-version-current-retiring-one-and-the-signed-version-list-catalogs-3d-2)).
  When `item.itemVersion` is **not** the version the manifest lists as current it is **required**, and the
  installer checks it with `verifyCatalogItemAgainstVersions`: the list must be signed by the pinned
  publisher, be for this catalog, this item and this manifest revision, and offer that version with the
  digest of the bytes sent. A list lifted from another catalog, item or revision is refused
  (`catalog_signature_invalid` / `catalog_item_mismatch`). A version the publisher retired is not on the
  list and so is refused. The provenance records the version moved to and its digest. A move below the
  installed version still needs `allowOlder` and shows the older-version warning. The
  `catalog_revision_older` pin applies to an install chosen from the list exactly as to the current one.
  Installs already on a retired version are untouched.
- **See what changes.** When the preview `replaces` an install it also answers `changes`: the diff from
  **the copy on this machine, as installed now, local edits included** to the offered version
  (`catalogItemChanges`, the same 8M-step budget as the publisher's diff). Skill files are read through the
  same no-link rules as every other skill read, bounded to what a catalog skill may be; a file too large or
  not text is shown as too large. An MCP server is read from the project `.mcp.json` entry or the stored
  component, with the values the install filled in mapped back to their placeholders. If the installed copy
  cannot be rebuilt, `changes` is left out and the preview still stands.
  **See changes is conservative: a part that MAY hold a secret is not drawn.** The preview is open to a ferret and
  the installed copy is read from this machine's own bytes, which can hold a password pasted into a skill or a server's
  environment. So nothing is cut out and nothing is guessed: the installed side and the offered side of each changed
  entry are first checked by a broad detector (`mayHoldSecret`, `lib/catalog-installs/conservative-changes.ts`). If
  EITHER side trips it, the entry is `{ change: 'changed', hidden: true }` with **no hunks, no before and no after**,
  and the screen says "changed — hidden: this file may hold a secret. Open it yourself to compare." An entry that is
  the same on both sides stays "unchanged", decided by comparing the two, never by showing either. **The detector
  trips on** any text holding a name that announces a secret, in any case, with any separator or none (`pass`,
  `pwd`, `secret`, `token`, `key`, `auth`, `cred`, `bearer`, `jwt`, `cookie`, `private`, `signature`, `dsn`,
  `webhook`: `api_key`, `apikey`, `X-Auth`, `passphrase`); a well-known token prefix (`ghp_` `gho_` `ghu_` `ghs_`
  `ghr_`, `github_pat_`, `sk-`, `xox`, `AKIA`, `ASIA`, `glpat-`, `npm_`, `hf_`, `AIza`, `eyJ`, `-----BEGIN`); a
  `${…}` expansion (`${X:-default}` included); any run of 24 or more base64, base64url or hex-like characters; and
  credentials in an address (`scheme://user:pw@host`, `user:pw@host`); and a short flag that takes a credential (`-u`,
  `-p`, `-a` followed by a word, or `-p` with its value attached: `curl -u bob:pw`, `mysql -phunter2`,
  `redis-cli -a hunter2`). The long-word rule is tried again with invisible format characters and the
  `⟨U+00AD⟩` marks the review writes for them taken out, and the names, prefixes and `${` with line breaks (a lone
  carriage return too) taken out as well, so a name or token split by one is still seen, in the text a person reads as
  well as in raw text. A server's arguments are also read one by one as they were written, because the `Starts` line
  quotes an argument with a line break in it. **A server's environment
  values are never shown**: a changed one is only "changed" (hidden), whatever it holds. A new or old warning that
  carries a value (an address, a registry, a package) and trips the detector reads "Hidden: this may hold a secret".
  **Over-hiding is the accepted cost**: a file that merely says "token" or "key" is hidden whole, and a plain file
  with none of these still gets a normal line-by-line diff. **The detector is linear and bounded**: plain scans, no
  backtracking pattern, and a text over 2 MiB is hidden without being read. It never runs the fleet's `redactText`
  (or any pattern that can backtrack) on a publisher's bytes. The same function (`conservativeChanges(onDisk,
offered, budget?)`, with `mayHoldSecret`) is what any other install path that shows an on-disk comparison uses.
  The rest of the answer (`edited`, warnings, the refusal text) names paths and servers only, never text from disk;
  the full `review` is the offered item, the publisher's own text.
- **Keep my edits, or replace them.** If the place is held by this install and the only differences are
  files it wrote whose hash changed (a stored component, or the server's `.mcp.json` entry), the preview is
  refused with **`catalog_install_edited`** (409), naming the paths. Nothing is changed. **Keep** is
  doing nothing. **Replace** is the same preview with `replaceEdited: true`: it lists `edited` with an
  `edited-locally` warning and **saves the hashes it saw**. The apply re-reads the place and compares it with those
  hashes (`sameEdits`), so a file edited again after the review is refused `catalog_install_edited` again; an
  edit **undone** after the review is no edit, and the write is guarded by what is on disk at the apply, not by the
  hash once reviewed. A project server's `.mcp.json` entry is checked again at the write, against the entry the
  check saw, so a file that moves between the two is `catalog_install_conflict`. A file the
  install has no hash for, or anything another install holds, is never overwritten or deleted: that stays
  `catalog_install_conflict`, and it wins over `edited`.
- **Stay or skip.** `PATCH …/:installId` with `{hold?: boolean, skippedVersion?: int | null}` records the
  person's choice about future versions and answers the install (with `hold` / `skippedVersion` when set).
  `hold: false` and `skippedVersion: null` clear. It touches no file and asks for no passkey, but it is the
  person's act, so a ferret is refused. The choice lives in `<FY_HOME>/state/catalog-install-prefs.json`
  (`schemaVersion` 1, `0600`, written by temp file and rename; a damaged file refuses every NEW choice, never
  "no choices", but it does not hide the installs: the list shows all of them without any choice and a `note` that
  says the file is damaged), apart from `catalog-installs.json`, which stays at version 1. A choice is dropped when its
  install is removed or replaced. Neither choice ever updates, or stops, anything on its own.
- **Declared gap: the revision a machine has seen rises only on an apply.** A machine that never installed from
  revision r+1 accepts a cached (manifest r, version list r) pair, exactly as the current-version path does:
  `catalog_revision_older` is judged against what this machine has installed from, not against what it has
  merely been shown.
- **Feature flag.** `GET /v1/health` lists `catalog-installs.updates.1` once the daemon does all of this, so
  an app can tell a daemon that answers `changes` from one that does not.

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

## Members (phase 2)

**Status: the contract (2a) is written; 2b-1 and 2b-2 serve the publisher's half of it.** The relay's `join`
and `member` records, the member route table, member passkeys and closing a revoked member's live sessions
are built in 2b-2; the app is built in 2c ([Built in 2c](#built-in-2c-the-app-for-members)) and the end-to-end test is built in 2d (`tests/e2e/catalogs-members.e2e.test.ts`). The wire is `packages/protocol/src/lib/catalog-member.ts` and
`packages/relay/src/lib/member-session.ts`; the session records are
[relay-protocol.md](relay-protocol.md) §14 "Member sessions", which also fixes the exact order of a join's
checks.

**A member is a person, not a device.** The owner names a member ("Alice", "Workshop Oct 31"). A
member can read the catalogs they were given, and nothing else on the machine: no capability, no unlock
of the machine, no place in the device list. One member can have many browsers; each is a **member
key** that browser made and can never export, plus that browser's own **member passkey**, named
"‹member› · ‹catalog› · ‹publisher›" (for example "Alice · Kirin's skills · kirin-box", at most 64 bytes)
so a person can tell their passkeys apart. That name is the publisher's own text and proves nothing. Each
passkey is filed under its browser's key id, so a synced password manager never replaces one browser's
passkey with another's.

**Sharing.** The owner mints a **share**: the catalogs it grants, who it is for (a new person, or a
member who already exists), how long the code works (15 minutes, 1, 3 or 8 hours, or 1 day), and single
use (the code burns when used) or many (one member named by the share, until it expires or reaches its
cap, at most 200). Minting needs the `sharing` capability and, from a device, a passkey proved for this
act alone (`share-catalog`), as minting a pairing code does.

- **The code is shown once.** `fy_share_` and 16 random bytes (128 bits). The answer to the mint is the
  only place it ever appears; the publisher keeps only its SHA-256, and no list, view or audit event has a
  field for it (a test walks every schema).
- **A code for an existing member is a credential for everything that member can read**, not only the
  catalogs the share adds: whoever opens it becomes another browser of that member. The share sheet says
  so before a code is minted for an existing member, and suggests a new member instead when in doubt. Opening it
  also takes one of that person's passkeys ([Joining as someone who is already here](#joining-as-someone-who-is-already-here)),
  so a forwarded code alone does not add a stranger's browser.
- **The link carries it in the fragment only**: `https://<app>/join#v1;url=…;fp=…;share=…`. The pairing
  link's grammar and the same reader, but the code is under its own field name: a share reader refuses a
  link carrying `code=`, a pairing reader one carrying `share=`, so no link is read by both. The app routes
  by path (`/join` is a share). The publisher's address must be http(s). A link-preview fetcher never sees
  a fragment.
- **A link works on the carriers pairing uses, and names no rendezvous.** `url` is an address another device
  can dial, or — on a machine that answers only on loopback but dials a rendezvous another browser discovers
  for itself (the hosted relay) — that loopback address, exactly as a pairing link from the same machine
  carries it ([pairing.md](pairing.md) "The link names no rendezvous; the device finds one itself"). The
  reader's browser goes to the rendezvous its build discovered and proves the publisher there against `fp`
  before the code leaves it. Because a loopback address names the reader's own computer, a browser that has a
  rendezvous to try **never dials that address** — for the join and for every later member session — unless the
  app itself was opened on loopback (a local build), where it is tried last; with no rendezvous it is the only
  candidate. Any other address is still tried first. A `publicUrl` that is itself loopback is judged as a
  loopback bind, so a loopback link is always a relayed one. The share sheet and `fy catalog share` say so
  beside such a link (`shareLinkNotice` in `@ferretry/protocol`): the relay sees this machine's fingerprint,
  the person's IP address, when they connect and how much is sent, and can tell whether they joined; never
  the code, their keys, their name or the catalogs. The relay is checked once, at boot, as pairing checks it:
  a relay that drops this machine later still lets a link be minted (a declared GAP, at pairing's parity). There is no anonymous route for any of this: the
  join is the sealed `join` record and nothing else.

**Joining.** The browser opens the link, makes its member key and box key, proves the publisher against
the fingerprint, and sends one sealed `join` record, on the direct address or the hosted relay. Every
failure is one generic refusal, and the answer is padded so its size alone does not tell a relay whether it
worked (its timing and the session that follows still can). Checks that need nothing stored come first, so a broken client never loses a code; then, in one
step, the code is found, room is checked (a refusal for room leaves the code live), and the code is burned.

- The new key then has **ten minutes to register ONE passkey**, and can do nothing else. A key that
  registered none when its window closes is removed. More passkeys for a browser are added only from a
  session already unlocked with an earlier one.
- After that every member session needs a **member unlock** with that passkey, which lasts 30 days by
  default (1 to 90), because a member only reads. A key without its passkey can read nothing beyond its
  own join answer (the member's name and how many catalogs) and the passkey's name while it registers one;
  after the window, without the passkey, it can read nothing at all.
- If a session is refused (`4403`), the browser keeps its key and says so: a relay could forge that close,
  so a key is only ever forgotten by the person's choice or a sealed revocation (phase 5).

**Already a member?** The browser signs in first, then spends the new code inside its session. A
single-use code is burned whatever happens next; one made for a different member, or for a new member, is
refused and the owner is told (owner decision Q5). A multi-use code counts a use only when it adds a
catalog, so reopening a workshop link costs nothing. Q5 is enforced for a browser that signs in first; a
browser that joins instead becomes whichever member the code names, once it has proved one of that person's passkeys (or the owner marked the invite for a new passkey), which is what the code and the person allowed.

**What a member can reach** is a **separate route table**, `/v1/shared/*`: their own summary, the signed
manifests and items of the catalogs they hold now, redeeming a code, registering passkeys and unlocking,
and leaving. Every request re-checks their grants, so a revoke works on the very next request. Members
never see each other (Q14) and never share onward (Q16).

**Bounds.** 128 members and 512 member keys per publisher, 200 keys per member (so one leaked multi-use
code fills its own member, never the publisher), 64 live shares, 64 catalogs per share, 60 successful joins
and redeems an hour per share, 10 failed joins a minute per peer on the direct carrier. A full publisher refuses a
join and leaves the code live. A member key unused for 90 days is removed; the member stays. Until the sweep reaches it, such a key is already
refused (`4403`) and opening a session never refreshes it: one predicate decides both.

### A member's name is their user ID

A member's name is the **user ID** the owner knows them by, and it is unique on this machine. On the wire it is
still the `label` of a member and the `name` of a person in a mint, so nothing already built has to change.

- **One name, one person.** Two names are the same ID when `memberNameKey` (protocol) gives the same text: Unicode
  NFKC, trimmed, inner whitespace collapsed, case-folded. "Alice", " ALICE " and "Ａｌｉｃｅ" are one ID. NFKC also
  makes "bob²" and "bob2" one ID, so the stored spelling is what a screen should show. The schema refuses what a
  person cannot see or read as one name, each with its own message: hidden and format characters, private-use and
  unassigned code points (some fonts draw them as nothing or a box), and a name that mixes scripts the way a
  look-alike does. A name may be in any one script, and may add Latin to the East Asian sets that are written
  together (Japanese: Han, Hiragana, Katakana; Chinese: Han, Bopomofo; Korean: Han, Hangul), as Unicode's "highly
  restrictive" rule has it; digits, spaces and punctuation belong to no script. So "Аlice" with a Cyrillic А and
  "bοb" with a Greek ο are refused. **A gap remains:** a name written wholly in one script can still look like
  another (an all-Cyrillic name that looks Latin), and no check here catches it. Only the owner types names, and a
  joiner never picks one. The members file refuses two members with the same key. Every write checks the schema
  first, so a duplicate is a refusal with nothing written (`store_damaged`, "members.json was not written"). A
  file that already holds one (written before names were IDs) is upgraded, below, not called damaged.
- **Mint names a person by ID.** `member` takes `{ "name": "Alice" }`: whoever holds that ID is reached
  (`existing`), and an ID nobody holds makes a new person. The older arms stay accepted. `{ "kind": "new",
"label" }` for an ID that is taken is refused `409 member_exists` with the `memberId` that holds it ("Someone
  here already has the user ID ‹id›. Pick another."), so a mint never makes a second person of the same ID. A
  code for many people (a **group link**) takes only a name **nobody holds or reserves**: every browser then joins
  that one new person. For a name that is **reserved** (an invite for it is waiting, nobody has joined) it is refused
  `409 member_exists` with the `memberId` that holds it, because a reserved name IS the person: the second code
  would let every stranger who held it join as them, with no passkey to prove, once the first browser had one. Use a
  single-use code for them, or a name nobody holds. For someone **already in**, a code for many people is allowed and
  each browser proves a passkey of the person to join (join by proof, below).
- **A new ID is reserved.** An invite for an ID nobody holds yet holds it, as the shares themselves do (nothing
  is stored apart): the ID is held while any live share that names the person has not been used, and while a join
  with it is in flight, and lets go by itself when every invite naming them is used up, ended or expired and they
  have no browser. Removing a person who never joined frees the ID too. Once someone joins, the ID is theirs.
- **Rename keeps the person.** `PATCH /v1/catalog-members/:memberId` needs an ID nobody else holds or has
  reserved (`409 member_exists`); a person may change the case or spacing of their own. The `memberId` keeps
  every browser, catalog and passkey, and codes already minted still reach them. The rename is audited as
  `catalog.member.renamed` (member id only; the old and new names are the owner's own text).
- **Asking first.** `GET /v1/catalog-members?name=Alice` also answers `match`, the `memberId` that holds or
  has reserved that ID (nothing else, no name), so a share sheet can say "Alice is already in" before it mints.
  The same capability as the list; any other query parameter is a `400`.
- **Upgrading a machine that already has twins.** A `members.json` written before names were IDs may hold two
  people of one name. It is not damaged: the first read keeps the **oldest** member's name and makes the later
  ones "‹name› (2)", "(3)", … (within 80 characters). Nobody is merged, and no browser, catalog or passkey moves.
  The original file is kept as `state/catalogs/members.before-unique-names.json`, then the new one is written
  atomically, once; a crash before that leaves the old file and the next boot does it again. A name that was
  already unique never changes, and no one is given an ID someone already held (so a file with "Alice", "alice" and
  "Alice (2)" becomes "Alice", "alice (3)" and "Alice (2)": the second is renamed to the first number nobody holds).
  The backup is never replaced: when the plain name is taken by a different file, the next is numbered
  (`members.before-unique-names.2.json`). The upgrade runs in the same queue as every other write, and only
  after its write succeeded is each rename audited (`catalog.member.renamed`, `reason: "duplicate-name"`, IDs
  only) and the owner told once; if it cannot write, the members file is refused as unreadable, with nothing
  half-done and nothing audited, and the next boot tries again. The notice: "2 people had the same user ID, so the later one was renamed: alice → alice (2). Each still signs in with
  their passkeys. Rename or remove whichever is wrong in Sharing › People." (for several people: "Several people had the
  same user ID, so the later ones were renamed: …"). **GAP:** the notice has no path to the app yet. The daemon
  holds it for its own log (`bootNotices`, stderr), and no route or event carries it to the owner's browser, so the app
  cannot show it once. The sentence is final so that the day a channel exists nothing about the words changes.
- **A person's passkeys.** The daemon can list ONE person's passkeys across all of their browsers
  (`MemberPasskeyService.passkeysOf`). It is an internal read, not a route. A passkey's WebAuthn `user.id`
  is unchanged: a passkey belongs to a browser's member key, not to the person. The `user.id` stays per browser on
  purpose: a passkey manager that syncs would let one browser's registration overwrite another's if two shared a
  `user.id`, so the people of one ID would lose each other's passkeys. The join flow gained the proof below, which
  uses this read to find every passkey that can vouch for the person.
- **Removal is final.** Removing a person writes the members file first, then ends the invites that name them. If
  either write fails, the person is already gone in memory and their sessions are closed; asking again finishes
  the writes, and a restart does too (the person is gone from the file, the invites are still live to end).

### Joining as someone who is already here

**Feature flag: `catalogs.join-proof.1`**, reported on `/v1/health`, so the app knows this machine asks. An older
daemon does not, and the app then joins as it always did.

A share code for a person who already has a passkey is **not enough** to add a browser to them: whoever held a
forwarded invite for Alice would be Alice. So a later join **proves** the person first, and nothing is filed and no
code is spent until the proof holds.

1. The browser asks `join-options` with the code ([relay-protocol.md](relay-protocol.md) §14). The answer is one of
   `join-open` (no proof wanted), `join-challenge` (prove one of these passkeys) or the one generic refusal.
2. For a challenge, the app has the browser sign it with ONE of the person's passkeys. `allowCredentials` is the
   passkeys that person has made at this page's origin, **newest first, up to 64** (and at most 12 KiB of ids, so the
   sealed answer always fits), so a passkey synced to this browser, a passkey made on a newer browser, or one on a
   phone through its hybrid QR code, just works. (A step-up lists at most 8, one device's own passkeys; a person
   spans many devices, so `join-challenge` has its own larger bound.)
3. The browser sends `join` with that assertion. The daemon checks it exactly as an unlock does (origin, rpId, a
   challenge bound to this join, user verification as the unlock rule asks, and the signature counter), against the
   passkeys of THIS person only. Only then is the code spent and the browser's key filed.
4. That browser then registers its **own** passkey, in the usual ten-minute window. **Passkeys stay per browser**: a
   passkey's WebAuthn `user.id` is still its browser's member key id and never changes, so a synced password manager
   still never replaces one browser's passkey with another's.

The challenge is random, held in memory for two minutes, and issued per (share, browser key). It is spent when a `join`
arrives, whether or not the assertion verifies, so replaying a captured assertion, or an assertion made for another
share or another browser key, proves nothing. A failed or missing proof is the uniform refusal: the code is **not**
spent, the browser is **not** added, and the browser cannot tell why. A passkey of a revoked person or a removed
browser is no longer on the list, so it cannot prove either, and another person's passkey is refused. The Q5
cross-member refusal is unchanged.

**The app shows the sentence, the wire does not.** The daemon answers `join-refused` and nothing more. The app, which
knows from `join-challenge` whose passkey it asked for, says it (&B131 B3, `join-screen.tsx`). Every name is the
person's user ID with hidden characters spelled out (`revealHidden`); ‹machine› is the host of the link, on every
screen, because the machine has not named itself before the join: one name from the first screen to the last.

- **The heading** is "You're signing in as **alice** on ‹machine›." on every screen after the Join tap.
- **A first invite** (`join-open`, or an older daemon): once joined, "Create a passkey for **alice**. You'll use it to
  sign in here." The join answer is what names the person, so this line is shown after the join, not before.
- **A later invite** (`join-challenge`): "Sign in with your **alice** passkey to add this browser." and a **Sign in
  with passkey** button. The challenge is asked for on the **Join tap**, never on page load, and the passkey on the
  tap after it, because a browser only opens its passkey sheet from a tap. Nothing is filed until then.
- **No passkey here:** "This invite is for **alice**. Use alice's passkey (on another device: choose "use a phone or
  tablet"), or ask the person who sent you this link to let you set up a new one." with **Try again** (asks for a
  fresh challenge) and **Back to start**. It is shown when this browser has no passkey the daemon listed, when the
  person dismisses or times out the browser's sheet (a browser says all three the same way on purpose), and when the
  daemon refuses the proof: a wrong passkey and an expired challenge look the same as a dead code on the wire. ‹owner›
  is "the person who sent you this link", because the owner's own name is not known before joining.
- **On a relay** the same screens appear: `join-options` and `join` are each their own session, over the same carrier
  walk as a plain join (direct first, then the rendezvous), and only a transport failure moves the walk on. The two
  sessions carry the same browser key, because the challenge is per (share, browser key). An older daemon's `4400` on
  `join-options` makes the app send a plain `join`, but only once the options record has actually been sent.

#### Lost devices: "They need a new passkey"

A person whose every passkey is gone (a lost phone, a wiped laptop) cannot prove anything. The owner can mark ONE
invite **"They need a new passkey"** (owner decision D8), at mint (`newPasskey: true`) or on a live invite
(`PUT /v1/catalog-shares/:shareId/new-passkey`; `DELETE` takes it off). Putting it on needs the owner's fresh
`share-catalog` passkey, because it widens who a code can add. Such an invite joins like a first join, with no proof,
even though the person exists; the browser then registers its own passkey as usual.

- **It is never automatic.** Nothing sets it but the owner's own request. When the person has no passkey left, the
  mint's answer carries `noPasskeyLeft: true` so the app can pre-tick the box, but the owner still marks it.
- **It is per invite and single use.** The invite burns when used, taking the mark with it.
- **A multi-use code is refused it** (`400 new_passkey_multi`): a mark that opens a code for many browsers is a hole,
  so make one single-use invite per browser. An invite that is no longer live cannot be marked (`409 share_not_live`).
- **A ferret may not mint or mark**; it may list, as for every share route.

#### The decisions behind it

- **A group link is exempt.** A multi-use code made for a name nobody held or reserved (a workshop) has nobody to
  prove, so every browser joins that new person as before. The mint decides this, not the join: a code for many
  people is refused for a reserved name (above), so a multi-use code that names a new person can only be a group link.
  It stays open even when everyone has removed that person's browsers or skipped the passkey prompt: no passkey and no
  open window never blocks a group link. (Codes minted before this rule keep their old meaning for their lifetime, at
  most a day.)
- **An existing person with no passkey and no D8 mark is blocked.** The join is refused (the code stays live) rather
  than opened by default. The owner marks the invite, or mints one that does. A second invite for a person who
  has not joined (`memberKind: 'new'`) joins freely **only while a browser of theirs is inside its passkey window**
  (the owner made two invites and the second arrives while the first browser is registering); once no window is
  open, the person is as good as one who existed and the invite is blocked until the owner marks it.
- **`join-options` tells a holder of a live code three things:** the person's name (which the invite names anyway),
  the credential ids of the passkeys that can answer (ids, never keys), and that the code is live. It is the price of
  letting the browser pick the right passkey, and it needs only the code. It spends nothing and issues at most 16 live
  challenges per share, 1,024 in all.
- **Passkeys do not move between people or browsers.** Joining by proof proves the person; it does not copy anything.

**Audit** ([audit.md](audit.md)): `catalog.member.join-proved`, `catalog.member.new-passkey-used`,
`catalog.member.join-proof-refused` (at most one a minute per share), `catalog.share.new-passkey-marked` and
`catalog.share.new-passkey-cleared`. IDs only; never the code, the challenge or the assertion.

### Built in 2b-1: shares and members on the publisher

The publisher daemon keeps two files, `state/catalogs/members.json` and `shares.json` (directory 0700, files
0600, atomic writes, a `schemaVersion`, zod-checked on read; a damaged file is an error, never reset). Only the
SHA-256 of a code is stored.

- **Admission** (`catalog-members/admission.ts`) is relay-protocol §14 step 2 as one synchronous function:
  constant-time find against every share and a dummy, live/expired/ended, room (128 members, 512 keys, 200 per
  member), the share's hourly count (60), burn or count a use, reserve a key slot. Room and hourly refusals
  leave the code live. `commit` and `release` finish a reservation; a failed persist leaves the code spent.
- **A reservation can be voided.** A reservation lives 30 seconds, then lapses and frees its slot. A revoke,
  a catalog taken from a member or deleted, and an ended share void the reservations they touch in the same
  queue, and a `commit` refuses a reservation that is no longer held. A commit also files only the catalogs
  that the share still gives and that still exist, and a join for an existing member needs that member to be
  there, so nothing the owner removed comes back through a join already in flight. Whoever admits MUST commit
  or `release` in a try/finally.
  Taking a catalog away from a person, or deleting it, while they are mid-join refuses that WHOLE join, by design:
  the joiner is refused and the code stays spent, so the owner mints another.
- **A burn is on disk before the answer.** Every admission that changed a share (a burn, a counted use, a Q5
  refusal) returns `persisted`, a promise for the write; the caller awaits it before replying, and
  `flushed()` waits for every queued write. A failed write still leaves the code burned in memory.
- **The share list is bounded.** A share that has been over for 30 days is forgotten on the next write or
  sweep, the stored list holds at most 500, and a mint past that is refused with a sentence.
- **Redeem rules (owner decision Q5).** A single-use code burns before it is compared with the redeeming
  browser's member; another member, or a code made for a new member, is refused and the owner is told
  (`catalog.share.cross-member`). A multi-use code counts a use only when the redeem adds a catalog, and a
  different member's browser is refused without counting.
- **Sweep.** Passkey-less keys are removed when their 600 s window closes and idle keys after 90 days; a timer
  adapter calls the pure sweep every minute.
- **Owner routes**, all `sharing.use`: `POST/GET /v1/catalog-shares`, `DELETE /v1/catalog-shares/:shareId`,
  `PUT|DELETE /v1/catalog-shares/:shareId/new-passkey` (the D8 mark, above),
  `GET /v1/catalog-members`, `PATCH|DELETE /v1/catalog-members/:memberId`, and `DELETE` of one browser or one
  catalog of a member. A ferret may list and nothing else. Minting needs a fresh `share-catalog` passkey from a
  governed caller, claimed atomically. The code and link appear ONLY in the mint's answer. Minting is refused
  (`share_link_unavailable`, 503) only when **no carrier** reaches the daemon from another person's browser:
  no address another device can dial and no rendezvous it can discover (`catalog-members/link-target.ts`, fed
  the same `discoverableRelayUrl` that decides whether pairing draws a QR, so the two cannot disagree). The
  sentence says that and what to set — turn on the hosted relay (`{ "kind": "relay", "source": "discovery" }`,
  not switched off), or bind and set `publicUrl` — so no code is spent on a link nobody else could open. Two
  cases stay refused as pairing refuses them: a wildcard bind with no `publicUrl` (no address to put in `url`),
  and a machine reached only through a **self-hosted** relay, which a stock browser cannot discover
  (pairing's declared GAP, mirrored rather than widened).
- **Revoke writes first** and is idempotent. Closing a removed member's live sessions is built in 2b-2 (below).
  Deleting a catalog also removes it from every member and share.
- **CLI.** `fy catalog share <catalog...> (--member <name> | --to <person>) --expires 15m|1h|3h|8h|1d
[--multi [--cap N]]` prints the link once with a locally drawn QR; `fy catalog shares`, `fy catalog unshare`,
  `fy member ls|rename|revoke|forget-key|take`. `--json` prints one payload; the code is in the mint's only. `--to` warns what the link opens BEFORE it
  makes one and asks y/N; `--yes` skips the question and is required off a terminal.

### Built in 2b-2: join and member sessions on the publisher

The browser reaches the publisher on the same carriers a device does; the relay's sequence-1 union
now has `join` and `member` ([relay-protocol.md](relay-protocol.md) §14 "Member sessions").

- **Join** (`catalog-members/join.ts`) is a record, never a request. The order is contract: the per-peer
  budget of FAILED joins (10 a minute, direct carrier only), the stateless checks (code, member key, box key,
  client name, the proof over this session's transcript), then the 2b-1 admission, then AWAIT the write of
  the burn, then `commit`, then the sealed `joined`. A reservation is committed or released in a `finally`.
  Every refusal is the same refusal, and both outcomes are padded to `MEMBER_JOIN_OUTCOME_BYTES`. One
  attempt per session, then `4440`.
- **A member session** proves the filed key. An unknown, revoked or idle key, or a bad proof, is the one
  `4403`. Accepted, it answers `authenticated` and serves requests from the **member route table**
  only.
- **The member route table** (`/v1/shared/*`, `catalog-members/shared-routes.ts`) is a separate table
  the main router never contains. A member principal meets no minimum of the main table, the main
  dispatcher refuses it `403` before routing, and a test sweeps every route of the main table to prove
  it (and that no device credential reaches `/v1/shared/*`). Ten routes: passkey options and register,
  unlock options and unlock, then `GET /v1/shared/me`, a catalog's manifest (`ETag` is the revision,
  `304` on a match), an item's signed version list (3d-2), an item, `POST /v1/shared/redeem` and `DELETE /v1/shared/me/keys/self`.
  Every request re-checks the member's current grants, so a revoke applies to the very next request.
- **Member passkeys** (`catalog-members/passkeys.ts`): before the first unlock a key may register ONE
  passkey, and only in its own ten-minute window; after an unlock it may add more. One assertion unlocks a
  browser for `catalogs.memberUnlockDays` (default 30, range 1–90; read at start, set in the daemon's
  config file), kept in `state/catalogs/member-unlocks.json` so a restart does not ask everyone again.
  Member passkeys live in `state/catalogs/member-passkeys.json`, apart from the devices' file. A not-unlocked
  member reaches only unlock and, in the window, passkey registration.
- **Redeem** awaits the write of the burn before it answers anything — a Q5 refusal and a redeem that
  adds nothing included — and commits or releases its reservation in a `finally`.
- **Revoke closes sessions.** Removing a browser, revoking a member or deleting a catalog ends the
  member's live sessions with `4403`, after the write. A browser that **leaves** (`DELETE /v1/shared/me/keys/self`)
  gets its `200` first and then `4440` (concluded), never `4403`, so it can tell "I left" from "I was refused";
  the key's other sessions end with `4403`. The idle and passkey-less sweep that 2b-1 built runs in the
  daemon and now has sessions to close.
- **Audit** ([audit.md](audit.md)): `catalog.member.joined`, `catalog.member.passkey-added` (both kept),
  `catalog.member.unlocked` and `catalog.member.join-refused` (general; at most one a minute per carrier, with a `count`). Never the code, a key or a proof.
- **Not in 2b-2:** the app (built in 2c) and the end-to-end test with a real browser (built in 2d). Known limit: after a
  revoke the member's rows in `member-passkeys.json` are not removed when the member is (the closer is not told
  key ids), which is harmless because every request re-checks the key.

### Built in 2c: the app for members

**Owner, in Sharing › My catalogs.** A catalog's **Publish skills** (&B131 A3) lists every skill on this
machine once, by its SKILL.md path, with where it lives ("account claude-work", "project app", "Ferretry"), says which
ones the catalog already holds and their version, and publishes the rest through the same Add to catalog sheet, aimed
at that catalog; it reads `GET /v1/skills`. Its **Invite people…** sheet (&B131 B3) has one field, **Their user ID** (help: "Unique on this machine. They'll
create a passkey under it and sign in with it. The same ID always means the same person."; placeholder "e.g. alice"),
and no new/existing choice. As the owner types it lists up to five people already here whose ID holds the text
(those that start with it first); nothing is listed once the text is exactly someone's ID. Under the field one line says what the ID
means: for someone already here "**alice** already has access here (2 browsers · Team skills). This invite reaches
the same person: they sign in with their alice passkey."; for an ID nobody holds "New user ID. The person who opens
this invite creates a passkey for **alice**."; for an ID with a hidden character the daemon's refusal ("A user ID
can't contain hidden or invisible characters. Type it again.") and no invite. The app sends the typed ID as the
member name and the daemon decides whether it is a new, an existing or a reserved person. A multi-use invite for an ID
somebody holds or has reserved shows the daemon's 409 `member_exists` sentence ("Someone here already has the user
ID **sam**.") plainly. **GAP:** an ID reserved by an invite nobody has used is not in the people list, so the
sheet calls it "New user ID" and the daemon's 409 is the only thing that stops a multi-use invite for it.
The warning "whoever opens this can read everything they can read" is shown before anything is made, for 15 minutes, 1 hour, 3 hours, 8 hours or 1 day, for one person or many (at most 200). It asks for a passkey
(act `share-catalog`) and shows the link **once**: a QR drawn in the page, Copy link, a countdown and **End this code
now**. The app keeps and logs nothing about the code. **People and codes** lists each person, titled by their
**user ID** (the card's title is the ID itself, with no repeated "User ID" label), with their catalogs and browsers (remove one browser, take away a catalog,
revoke the member with the plain sentence of what stops) and the shares (live, used, expired).

**They need a new passkey (D8).** For a person who is already here, on a **single-use** invite only, the sheet offers
the checkbox "They need a new passkey (lost or new device)" with the line "Only tick this if alice can't use their
passkey any more. Whoever opens this invite can then sign in as alice." It is **never automatic**: it is
unticked unless the person has no passkey on any browser, in which case it is pre-ticked with "alice has no passkey
left, so this invite lets them create one." and the owner can untick it. The app works that out from the people list,
because the daemon only reports `noPasskeyLeft` on the mint answer, after the choice. A many-use invite never offers it (the daemon answers 400 `new_passkey_multi`).

**Change user ID.** Each person's card has **Change user ID**. The form says "alice becomes alicia. They keep
their browsers, passkeys and installs." It calls `PATCH /v1/catalog-members/:memberId` with `{ "label" }`. An ID
someone holds answers 409 `member_exists` and the form stays open with "Someone here already has the user ID **sam**.
Pick another." Any other failure closes the form with the plain failure line.

**Subscribing is by link.** **Subscribe with a link** is a paste field at the top of Sharing › Subscriptions, and only
there: My catalogs is the publisher's page and has neither it nor Install from a file. Subscribing installs nothing.
The context rail's Skills and MCP lists carry no link of their own (&B131 A1). A `/join` link (any app origin; read by path and fragment) opens `/join` with its
fragment, the same page the phone's camera opens, so there is one way in. A link whose fragment does not parse says
"This link is damaged or incomplete. Ask for a new one."; a pairing link says it links a device; anything else says it
is not a catalog share link. **Install from a file…** lives under **More** next to the paste field, for offline swaps. There is no in-app
QR scanner; the camera app already opens the link.

**A second link in the same tab is read, not left behind.** The join page re-reads the address when it changes (the
paste field's navigation, or a pasted `hashchange`), strips the fragment with `replaceState` at once so the code is
not left in the address bar or history, and starts the join flow over for the new link. The router's own state is
dropped by that `replaceState`, the same as the pairing link.

**Member, at `/join`.** The page is routed by its **path**, never by the fragment shape, because a share fragment also
matches a pairing fragment. The browser makes a non-extractable Ed25519 member key and an X25519 box key **for that
publisher**, proves the publisher against the link's fingerprint before sending anything, sends one `join`, and
keeps the keys only after `joined` (IndexedDB `ferretry-member-keys`, keyed by the verified daemon id). It then asks
for the one passkey inside the 10-minute window, with a countdown said before it ends, and unlocks. A key the
publisher refuses (`4403`, or `401` on an open session) is **marked, never deleted**: the person sees "Access refused"
and chooses **Try again** (asks once more with the kept key, and takes the mark off if the publisher answers; one
refusal can be a dropped connection, and a forged `4403` must not nudge anyone to delete a key), **Join with a new
link**, or last **Forget this catalog**. Leaving answers `200` and is never shown as a
refusal. A browser that already has a key opens a member session and redeems the code (`share_other_member` and
`share_new_member` have their own sentences).

**Subscriptions (online only): a store page per publisher.** One line under each publisher says that nothing installs
or updates by itself: "Install what you want; each install stays on its version until you update it." Every item is a
**store row**: its name and kind (`pdf-tools · Skill`), one line of what it is, and on the right **Install** (when this
browser has a paired machine to install on; it opens the item's review and install hand-off) beside the version the
publisher lists (`v3`). Once a paired machine's install records hold the item, the right side is a status chip that
carries the versions, so the title never does and no version is said twice, then the acts. One row on a desktop, at
most two on a phone, every target at least 44 px, no sideways scroll:

- **v2 installed**: the machine holds the version the manifest lists. Nothing else is offered.
- **v1 installed · v2 available**: the manifest lists a newer version. **Update** and **See changes** (the diff this
  machine computes, shown before anything is written) sit beside the chip; one **More** (⋯) menu holds **Stay on v1**,
  **Skip this version** and **Move to version…** (any version the publisher still offers, newer or older), each with a
  line saying what it does. **Stay** is `hold`: keep v1 and stop asking about every newer version until **Ask
  again**. **Skip** is `skippedVersion`: hide only the version now listed, so a newer one asks again. They are not
  the same, and both are kept.
- **v1 installed · Staying on v1** / **Skipped v2**: the person said no to the listed version. **Ask again** clears the
  choice. See changes (after a skip) and Move (in More) stay open. Stay and Skip are
  `PATCH /v1/catalog-installs/{scope}/:installId` (`hold` / `skippedVersion`) and touch no file, so they take no passkey.
- **v3 installed** when the publisher has since taken the newer version back: only **Move to version…** is offered, in
  More. In the Move list the installed version carries a check and "Installed" at full contrast.

Update and Move open a sheet that fetches the version from the publisher, verifies it in the browser, and sends it to
the machine that holds the install through the installer's own `/preview` and apply routes (no route is added for
this): the machine answers what changes and the app shows it; the one button that writes (**Update · confirm with
passkey** or **Move · confirm with passkey**) asks for a fresh passkey exactly where the installer requires one. A
version other than the listed one travels with the publisher's signed version list, and an older one is sent with
`allowOlder`. If the install was edited on the machine, the preview answers `catalog_install_edited` and the sheet
shows one neutral notice ("Not updated. You edited SKILL.md.", not an error: nothing failed) and offers **Keep my edits** (nothing changes) or **Replace my edits** (the same preview again with `replaceEdited`). If the
machine reads the version as something other than the one the publisher listed, the sheet refuses it in one sentence.
Nothing here ever runs on its own. **Unsubscribe** (was Leave) stops showing the publisher; what you installed stays and
keeps working. Each publisher shows the person's own label and the first 20 characters of its
fingerprint. Every manifest and item is verified before it is shown. **An item that opens must be the one the list names**: after the item verifies, its id
and version have to equal the entry the person tapped, otherwise it is refused ("This item is not the one the catalog
lists, so it was not opened.") and nothing from it is shown. **Withdrawn items are said, not hidden**: each catalog
block counts them ("2 items were withdrawn by the publisher") and offers none. An item a paired machine installed that is
now withdrawn is matched by item id against that machine's install records and named from the record (the list names
withdrawn items by id only), in one sentence: "pdf-merge was withdrawn by the publisher. If you installed it, it keeps
working but gets no updates; it can't be installed again." The count then says "1 more item". With no machine to read,
only the count shows. A name the publisher chose is shown with hidden and format characters marked. An item opens in the phase 1c review, and
**Install on a machine** hands the signed manifest and item to the member's **own** daemon's install preview, which
verifies them again. The offline library is phase 3 and is not built.

### The skill and MCP rows (catalogs 3b, reworked by &B131 A1)

The context rail's **Skills** list and its **MCP** list draw every item with **one** row
(`features/catalogs/catalog-item-row.tsx`). Since &B131 the side panel lists **what this session can use** and nothing
on a row publishes: a list of what an agent has is not a shop (owner, 2026-11-02: "the side panel should show skills
ACTIVE in this session … the add button is too overloaded").

- **The Skills header** says it in words: "16 active in this session · Claude · inserts /name · account ‹runtime›"
  (`activeSkillsLine`). The count is the skills no same-named skill elsewhere overrides.
- **Left**: the name in mono (tapping it still inserts the invocation), where it came from, a version chip when one is
  known, and one truncated description line (the full text is its tooltip, and **Open SKILL.md** shows the file).
  Hidden and format characters in any name, publisher or catalog name are marked.
- **Where it came from**: **This project** (the project's skills folder, so every session in that folder has it),
  **This account** (the account's own skills folder) or **Ferretry** (built in). A skill another one of the same name
  overrides stays listed, dimmed, with "Not active: the skill of the same name in ‹place› wins".
- **Version chip**: `v3` for an item in one of **this machine's** catalogs (the newest version it holds); for an item a
  catalog install wrote, **from ‹publisher› · v2** (the version it is pinned to; the tooltip names the catalog). No
  chip when no version is known. A withdrawn item is not held, so it shows none.
- **Which catalog holds an item** is read from the catalogs list the machine already answers, by source: the
  `SKILL.md` path (a list that only knows a skill's name matches by name) or the MCP server id. No new route.
- **Right: only ⋯** (44px). There is no Share and no Add on the row, and the side panel has no "Add from a link…".
  The ⋯ holds, in order:
  - **Open SKILL.md** or, on an MCP row, **Show details** / **Hide details** (so
    every MCP row has a ⋯);
  - **Publish in ‹default catalog›**, one tap with Undo, on a machine with `catalogs.quick-add.1` ([The app (catalogs
    3c-4)](#the-app-catalogs-3c-4)), or **Publish in a catalog…**, which opens the Add to catalog sheet. Once a catalog
    here holds the item, **Publish in another catalog…** too. Only for items this machine could share, never for what
    someone else's catalog installed;
  - **Uninstall**, for catalog installs only, with the same confirm ("Uninstall ‹item› from ‹place›?"). With several
    installs there is one per catalog, "Uninstall (from ‹catalog›)". The daemon removes exactly the files the install
    recorded and refuses one changed since, so a skill somebody wrote by hand never gets the item.
- **Sharing a catalog with people and its versions live in Sharing › My catalogs**, not on the row.
- **Show details** (MCP) opens a few plain lines under the row from the inventory the list already read: what it runs
  or its address, where it is declared, its project, the harness, and which runtimes see it with their approval. The
  address has no query and the program no arguments by construction, and hidden characters are marked.
- A row never shows a secret value. The side-panel lists have no paste field or **Install from a file…**: they are in
  Sharing › Shared with me.
- **A running Claude Code session picks up a newly installed skill** in an existing `skills/` folder without a restart.
  A `skills/` folder that did not exist when the session started needs `/reload-skills`
  ([Claude Code skills](https://code.claude.com/docs/en/skills)). Codex: see the finding below.

### + Add skills, the page (&B131 A2)

In 5.0 the page is Catalogs' (`plugins/catalogs/app/features/add-skills/`, screen `add-skills` at
`/d/<daemon>/ferrets/<id>/add-skills`). Skills' panel offers the slot `skills.add` beside its "N active" line and
Catalogs contributes the **+ Add skills** button to it; the ferret's folder, harness, runtime and where its skills come
from ride in the query. The page below is otherwise as it was, less the "from this machine" group.

The Skills tab has one **+ Add skills** button by its "N active in this session" line. It goes to a page of its own,
**Add skills** at `/d/<daemon>/session/<id>/skills` (`features/context-rail/add-skills-page.tsx`), with **Back to the
session** and **Refresh** at the top; the install review stays a sheet over it. The page:

- **From your subscriptions**: every skill of every catalog this browser subscribes to, **grouped under the catalog it
  is from**. Each group has the catalog's name, "from ‹publisher›" and its skill count; each row has the name, the
  version and **Install** (or **Installed**, read from the machine's install records by the publisher and item id). A
  search field (a search icon, "Search skills") narrows by every word typed. When more than one catalog lists a skill, a **filter chip per catalog**
  (All catalogs first, each with the count the search kept) narrows to one; two catalogs of the same name are told apart
  by their publisher. A publisher that cannot be read takes the place of its catalogs, in the list, under its own name: a
  locked one says so with **Unlock with passkey** inside that section (its catalog name is unknown while it is locked,
  so the heading is the publisher's); an unreachable one says so with **Try again**; a refused or failed one says why. Only the skills of a catalog that verified are listed.
- **Refresh** reads the subscriptions, every catalog and the machine's install records again, so a skill a catalog added
  after the page opened shows up. The rows already on screen stay while it reads, a filter on a catalog that vanished
  falls back to All. Beside the button the page says "Updated just now" (then "5m ago" and so on), or, when a
  publisher did not answer, "Could not reach ‹names›, so the list may be out of date." (the earlier rows stay), and the
  icon spins while it reads. On a phone, pulling the list down from the top runs the same Refresh with the same
  words. Nothing is polled. No stale cache serves the list: the members' reads are never cached, and the page reads
  again when it opens and **whenever the person comes back to its tab or app** (the page used to read only once, so
  a skill added while it sat in the background never showed).
- **Subscribe with a link…** opens Sharing › Shared with me, where an invite is pasted. The page never pastes a link.
- **Install** goes through the existing review and hand-off (`SharedItemSheet` → `InstallFromFileSheet`, the same
  passkey and the same `/v1/catalog-installs` routes). The only new behaviour is the **default place**:
  **this project (every session in this folder)** when the session's folder is inside a registered project (the
  deepest one wins), otherwise **this account (every session on ‹runtime›)**, by the runtime the skills inventory
  names. When neither can be told the page says so and the person picks. The person can always change it.
- **After an install** the Skills list re-reads and the page says where it went, in two sentences:
  - Claude: "It is active in this session now." When the session saw no skill of that kind before, so its skills
    folder was probably just created: "It may need /reload-skills in this session…". The daemon does not say whether it
    created the folder, so that line is a hint, worded as one.
  - Codex: "It is active from the next session."
  - An install the session does not read (another project, another account) says "This session does not read that
    place, so it is not active here."

**Codex finding (A2, 2026-11-02): hot reload is not verified, so the page promises the next session.** The Codex
0.156.1 binary contains a skills watcher (`skills_watcher.rs`), a `skills/changed` notification and the
`.agents/skills` folder name, which suggests a running session may notice a new skill. Confirming that a _running
session actually uses it_ needs a paid model run, which this slice did not make. Until it is checked the page claims
only what is known; changing the sentence is one constant (`CODEX_NEXT`).

### An account home outside the fleet: what each reader does with a link (BG-033)

A home the fleet places outside its own folder (an operator's own folder, a home-manager home whose `skills/`,
`settings.json` and `config.toml` link into a store) is read **read-only**, and each reader treats a link by its own rule.
"Inside" means the link's real path is inside that account home.

| Reader                       | A link inside the home                                  | A link out of the home (a store, `~/.ssh`)                                                                                   | A link to nothing, a loop, a sign-in file                   |
| ---------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Skills list (`skills()`)     | followed, listed (when its `SKILL.md` is a plain file)  | skipped silently                                                                                                             | skipped silently                                            |
| A skill's `SKILL.md`         | read                                                    | not read                                                                                                                     | not read                                                    |
| A file inside a skill folder | never followed (a link is listed as a link, unreadable) | never followed                                                                                                               | never followed                                              |
| The three documents          | followed, read                                          | **followed**, read (a regular file, a second name only in a proven-immutable store, at most 16 MiB, parsing as the document) | refused in one sentence naming the link; to nothing: absent |

Against the readers of the same homes before, reader by reader:

- **Skills list.** What `skills()` lists is a **superset** of the machine skill inventory of such a home in what it lists
  (a plain folder and an inside link are extra: that inventory listed neither), **except** where that inventory followed a
  link into `fleet/`: a link into the fleet's `assets/` it listed as Ferretry's, and here it is skipped (waived, because
  no root can name both the home and `assets/`). Skills closes it: it binds the homes and lists
  `fleet/assets/skills/<name>` itself as Ferretry's, so such a link is a duplicate path to the same skill and is never
  followed. The list is also **narrower** than the session
  skill picker (which listed store links too). A plain folder in such a home is listed only when it holds a plain,
  single-name, non-sign-in `SKILL.md`.
- **A skill's `SKILL.md`, and the files inside a skill folder.** The machine inventory followed links into `fleet/`, the
  session picker followed every link, and the skill-folder reader (tree and file) followed none; here `SKILL.md` follows a
  link inside the home only, and a walk or a file read follows none.
- **The three documents.** They follow a link out of the home, as the MCP document reader did, but under bounds that
  reader did not have, so they are **narrower** than it: a link to a folder, a pipe, a second-named file outside a proven-immutable store, the daemon's
  home, a target whose real name is a sign-in file's, or something that does not parse as the document is refused, and the
  refusal names only the link. A sign-in file's second name under another basename is refused outside the store (it is a
  hard link) and read inside it (see below).

A hard-linked `SKILL.md` is not listed. A file read is checked after it was read: if the name no longer reaches the file
that was judged, the bytes are dropped, and a followed document that grew after it was judged is refused rather than
returned cut short. A second name on a followed document is the kernel's own hard-link rule (S49): allowed only inside a
proven-immutable store such as `/nix/store`, so a home-manager link into an optimised store keeps working, and refused
everywhere else. What is refused: a target whose real basename is a sign-in file's (any letter case, after every link),
and any hard link that is not store-shaped. What is allowed: a store-shaped hard link (a file owned by root, in a closed
folder chain under the store), whatever its basename, unless that basename is a sign-in file's. So a second name of a
sign-in file under another basename inside the store is read; that exposes nothing, because the store is root-owned and
world-readable and only root can add a name there.
The refusal of a hard link costs about 200 ms (the kernel retries the check about twenty times, five milliseconds apart,
before it gives up, which is meant for a publish leftover); that retry is the kernel's and is left as it is, so up to
three refused documents cost about 0.6 s.

Four things the document follow still leaves, declared:

- **A swap of a folder above the target.** A folder above the target swapped for a link to another folder after the
  judge can make the read return that folder's same-named file: a regular file that parses (with a second name only
  inside a proven-immutable store), outside the daemon's private places, and never one whose own name is a sign-in file's.
- **A link to nothing in the daemon's home.** It answers absent, like any link to nothing, so whoever owns the link can
  tell whether a name exists there, never a byte of it; the MCP document reader answered the same.
- **A target under `/proc`, `/sys` or `/etc`.** What happens differs per case. A `/proc` file is never returned: the
  kernel syncs every file it reads durably, `/proc` refuses that sync, so a `/proc` target is refused whatever it holds,
  an empty one included. A `/sys` file is read up to the size it reports (often 4096 bytes), and an `/etc` file up to its
  real size; either one is returned whole when it parses as the document (a config file of comments only is valid TOML)
  or reads blank, as a blank file inside the home is (declared, not refused; the test of an empty linked document pins
  that answer), and dropped otherwise. That a readable file which parses is returned is the rule of
  every followed document (the table above). None of this is new exposure: the account owner who authors the link
  already reads these files as themselves, and the MCP document reader read all of these too.
- **A kernel test gap, kernel-owned.** The kernel's unit tests do not pin its store-root check against a looser match (a
  substring of the real path); the check that the file is owned by root still refuses, so nothing opens. It is left to
  the kernel's owner and is not changed here.

## Links (catalogs 3f)

> **PARTLY BUILT.** The libraries below (3f-1), the store Worker (3f-2) and the daemon's owner side (3f-4 and 3f-5,
> [The daemon](#the-daemon-3f-4)) exist, and the daemon reports `catalogs.links.1`. The Worker is bound behind the
> hosted relay (3f-3, merged at `f59c89df`; its relay deploy succeeded and `LINK_STORE` is bound), and no built-in app or CLI flow
> exists yet (3f-6 is the installer, 3f-8 the app), though an authorized owner API client can mint a link. Whether the store answers is a separate operator runtime control (the
> `available` and `serving` switches, [relay-protocol.md](relay-protocol.md#operator-routes-and-the-kill-switches)),
> not a release. Where a
> sentence says "the store", it means the link store of [relay-protocol.md](relay-protocol.md), a Worker of its own
> behind the relay by service binding.

A **link** is ONE skill or MCP setup, signed by its publisher and shared as a URL. Nobody joins, nothing is revised and
the publisher is not asked again. Two kinds:

- **one-time**: the first fetch uses it up. Ends within a day (default one hour).
- **public**: anyone holding the URL can install it until its end. Default a week; `never` is allowed, and an optional
  install cap (1 to 10,000).

Owners decided (2026-11-02): the `share-link` step-up act is confirmed; a public link with no end lapses after 30 days
of the publishing machine being off and revives when it returns; the store is its own Worker.

### The URL

```
https://<app>/get#v1;b=<bundleId>;k=<key>;fp=<fy_daemon_…>[;s=<store origin>]
```

- The key `k` (32 random bytes) lives **only in the fragment**: a browser never sends it, so no server, log, preview
  fetcher or `Referer` sees it. `b` is the bundle id (16 random bytes), `fp` the publisher the signature must be from.
- `s` is written only for a self-hosted store, and must be a pure `https:` origin (no path, no user name). Without it
  the app uses the store it discovers itself.
- `formatLinkFragment`, `parseLinkFragment` and `catalogLinkUrl` (`catalog-link.ts`) write and read it with the same
  field reader as pairing and share links. The `/get` reader **refuses** `code`, `share` and `url`; the pairing and
  share readers refuse `k`. A fragment that is two kinds of link is read by neither.

### The signed document and the bundle

`shared-catalog-link.ts`. The publisher signs `SharedCatalogLink`: publisher, name, `linkId`, `bundleId`, kind,
`sequence`, `issuedAt`, `notAfter` (`min(expiresAt, issuedAt + 30 days)`), optional `expiresAt` and the item line
(id, kind, name, summary, version, digest, size). The signature covers
`"ferretry-catalog-link-v1" ‖ 0x00 ‖ SHA-256(canonical JSON)`. The install cap is **not** signed: the store enforces it
and changing it needs no re-sign. A one-time link has sequence 1 and an end within a day; an artifact is not a link
item. The bundle is the signed document plus the one item, whose `catalogId` is `LINK_ITEM_CATALOG_ID`
(`cat_` and 22 `A`s, the id every shared copy is stored under, so a link item is never mistaken for a catalog item).

`verifyLinkBundle` (`catalog-signature.ts`) checks, in order, that the key hashes to the publisher the URL named, the
signature, the bundle id and sequence the envelope carried, the end (with 5 minutes of clock skew), and that the item is
exactly the one the signed line describes (digest, size, version, name, summary). Nothing is shown before it passes.

### The envelope

`link-bundle.ts`. What the store holds is opaque to it:

```
"FYL1" ‖ uint32be sequence ‖ nonce(12) ‖ AES-256-GCM(ciphertext ‖ tag)
key = HKDF-SHA256(k, salt = bundleId bytes, info = "ferretry-link-bundle-key-v1/" + decimal(sequence), 32)
AAD = "ferretry-link-envelope-v1" ‖ 0x00 ‖ bundleId(16) ‖ uint32be sequence
plaintext = uint32be L ‖ canonical JSON (L bytes) ‖ zero padding to a multiple of 16 KiB
```

- Padding is exact and all zero, or the envelope is refused. The size class (16 KiB) is all the store learns.
- The cap is 3 MiB (`LINK_ENVELOPE_MAX_BYTES`); over it is `link_too_big`, which the daemon reports from the preview
  before it asks for a passkey.
- The fetch token is `HKDF-SHA256(k, salt = bundleId, info = "ferretry-link-fetch-v1", 32)`. The store keeps only
  `SHA-256(token)`, which is useless without `k`.

### The store wire

`link-store.ts` (schemas, paths, refusals, transcripts) and `link-store-reducer.ts` (every rule below, as a pure
`reduceLinkStore(state, event) → [state, response]`; the Worker in 3f-2 only wraps it). Signed requests use the
transcripts below and the labels listed in [relay-protocol.md](relay-protocol.md) (signing domains); the full
"hosted link store" chapter of that document is written with the Worker in 3f-2. Each transcript is its label, then
length-prefixed (uint32be) fields: protocol id `ferretry-link-store/1`, daemon id, the host the store is serving, the
32-byte nonce, then the action's own fields (an absent optional is the empty string; status ids are sorted and joined
with `,`). The labels are `ferretry-link-store-upload-v1`, `-delete-v1` and `-status-v1`.

- **Gone is one answer.** Every failed peek or fetch (unknown id, wrong or malformed token, used, ended, lapsed,
  expired, capped) is the same frozen `410 link_gone`, byte for byte. A public link at its cap stays `live` in its
  owner's status, and answers 410 to peek and fetch alike.
- **The token is matched before the wrong-token window.** A request that presents the link's real token is never
  refused for wrong guesses at its id, so a stranger who knows only a bundle id cannot lock the recipient out or burn
  a one-time link. Only a wrong token counts toward, and is stopped by, that window.
- **Limits answer 429 by the id asked for, whether or not it exists**, so a 429 says nothing about an id. Defaults are
  operator configuration: per daemon 50 live links, 64 MiB and 100 uploads a day; per link 120 fetches a minute, 5,000
  a day and 20 wrong tokens a minute; per address 60 peeks and fetches and 20 challenges a minute; across the store
  20,000 live links, 4 GiB, 5,000 uploads and 200,000 fetches a day (one-time fetches count in that last figure).
- **One-time is serialised.** The first fetch sets `used` and drops the bytes in one step; a racing second fetch gets
  the uniform 410. A lost response costs the link, which is declared below.
- **Replace** (public only) is compare-and-swap on `expectSequence`, needs a higher sequence (the store refuses one that
  does not go up), keeps the kind and keeps the open count. Every upload's clear envelope sequence must equal the
  sequence the request names, and a sequence never exceeds 2^32 − 1. A **lapsed** public link is revived only by its own owner with a sequence above the stored one. Any
  other existing id, whatever its state, is `link_exists`.
- **Delete** ends a link, is idempotent and keeps a tombstone until `max(notAfter, now) + 30 days`, so a replayed URL
  stays 410 and the id cannot be reused.
- **Kill switches.** `available: false` refuses challenges and uploads; peek, fetch, delete and status keep working.
  `serving: false` answers peek and fetch 503, as an emergency act of the operator.
- **Uploads** may be at most 5 minutes in the past and must end within 30 days (one-time: one day). Every challenge nonce
  is spent by its first use.

### The owner's wire

`catalog-link.ts` holds the schemas for `/v1/catalog-links` (create, preview, move, update, list, copy, store status) and
their refusals. An owned link carries **no URL, no key, no bundle id and no store address**; the URL appears only in the
create answer (once; a one-time URL is never shown again) and in a public link's Copy answer. Making, moving and
widening a link want a passkey proved for the act `share-link` alone, so a `share-catalog` proof never buys a link and
the reverse. Copying needs only the unlock; turning a link off never asks.

### The daemon (3f-4)

`packages/daemon/src/lib/catalog-links/` is the domain, `adapters/catalog-links/` the file store, the sealed key vault,
the store client and the store locator, and `lib/runtime/mounts/catalog-links.ts` the routes. Every route is
`sharing`/`use`, `noStore`, minimum `operator`.

| Route                                   | Caller | What it does                                                                                                              |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/catalog-links/store`           | any    | whether a store is set up and reachable, and its origin (not a secret)                                                    |
| `POST /v1/catalog-links/preview`        | person | what a link would hold and whether it fits; no passkey; nothing is signed or uploaded                                     |
| `GET /v1/catalog-links[?itemId=]`       | any    | the owner's links, newest first; no URL, key, bundle id or store address                                                  |
| `POST /v1/catalog-links`                | person | mint; a fresh `share-link` passkey for a governed caller; `201 {link, url}`                                               |
| `GET /v1/catalog-links/:linkId`         | any    | one link                                                                                                                  |
| `PUT /v1/catalog-links/:linkId/version` | person | move the link to another kept version of its item; `share-link` passkey; `{version, from, digest}`                        |
| `PATCH /v1/catalog-links/:linkId`       | person | change a **public** link's end and cap (`{expires?, installCap?}`, `null` removes the cap); a passkey only when it widens |
| `POST /v1/catalog-links/:linkId/copy`   | person | a **public** link's URL again; a one-time link is `link_not_public`                                                       |
| `DELETE /v1/catalog-links/:linkId`      | person | turn off (idempotent, no passkey)                                                                                         |

A ferret holds the admin token and may only read (`GET`). Preview, mint, copy and turn off answer it 403 `forbidden`
(`ownerOnly`): a prompt-injected agent that could mint could hand a stranger a skill from this machine, and one that
could Copy would read a public link's key.

**Where the store is.** `catalogs.linkStore` in `daemon.json` is `{ "source": "discovery" }` (default: the origin the
relay advertisement names), `{ "url": "https://…" }` (a self-hosted store; links then carry `s=`) or
`{ "enabled": false }`. The daemon signs only for the **host of the origin it discovered or was configured with**; the
client uses `redirect: "error"`, `cache: "no-store"` and a 20 s timeout, and reports no store body: a closed refusal
code, or `unreachable`. Nothing is deployed by this slice; 3f-3 (merged) bound the Worker behind the hosted relay.

**Mint**, in this order: locate the store → daemon identity → quota (50 live) → `linkSubject` (the item frozen as a
shared item, **kept only after the upload succeeds**) → digest check against the preview → sign and envelope → seal the
key (`vault.put`, public only) → write a `pending` record → upload → keep the item → write `live`. A crash between
steps leaves a `pending` record. **Boot reconciliation** (and every 60 s) settles it against the store's status: live
there ⇒ `live`; absent ⇒ `ended`. A link being turned off is `ending` and is retried with jittered backoff until the
store has confirmed the delete.

**The key.** A public link's key is sealed in `link-keys.json` (AES-256-GCM, AAD `catalog-link:<linkId>`) under the
vault's own key: the seventh holder in [secrets.md](secrets.md). A one-time link's key is never written; the URL is
shown once. `links.json` holds ids, kinds, states and times, the store's origin, the daemon id that uploaded the link
and the **bundle id**, and no URL, key or fetch token. The bundle id has to be there (the store names a link by it) and
it is not a secret: it opens nothing without the key. No owner answer and no audit line carries it, and
`wire-secrets.test.ts` walks every owner schema for such a field. If the vault key (`secrets.key`) is lost, Copy
answers `500 links_store_damaged`; the link keeps working for anyone who holds the URL.

**Turning a link off under another identity.** A store answers `404 link_unknown` to a delete from anyone but the
uploader, exactly as it does for a bundle it never had. So `link_unknown` counts as "already gone" only while the
daemon id that uploaded the link (`publisher` in `links.json`) is still this machine's. If the identity has changed
(pairing state was reset, or `state/catalogs/` was restored onto a fresh machine), Turn off keeps the link and its key,
answers `503 signing_unavailable` with "made under this machine's previous identity, so it cannot be turned off from
here. It stops working by ‹end›", and retries only slowly. The link is marked `expired` once its own end has passed.

**Hostile or broken stores.** The address the daemon signs for must be `https:` (an `http:` address only for this
computer itself), whether it comes from `catalogs.linkStore.url` or from the relay directory origin; a stored link's
`storeOrigin` is held to the same rule. A store's answer is read through a 64 KiB cap and the 20 s deadline: more than
that, or too slow, is `unreachable`. A store that fails a status call is not asked again for a minute, so a reader that
polls the list cannot hold up Mint or Turn off. A mint whose upload answer never came says "the link may have been
made", not "no link was made": the pending record stays and reconciliation settles it.

**Audit.** `catalog.link.minted` (link id, item id, version, kind, expiry, install cap, and `created` when the link
made a new item), `catalog.link.copied`, `catalog.link.ended`, `catalog.link.moved` (`from`, `to`, `sequence`),
`catalog.link.changed` (the new end and cap) and `catalog.link.revived` (written by the daemon itself, with the
sequence) ([audit.md](audit.md)). Never the URL, the key, the token or the bundle id.

**Move (3f-5).** `PUT /v1/catalog-links/:linkId/version` points a **live public** link at another kept version of the
same item. The request names the version it is moving `from`, so a move from a stale screen is `409 current_changed`, and
the digest the person reviewed, so a version that changed since is `changed_since_preview`. The link keeps its URL,
bundle id and key; the daemon re-signs the document at `sequence + 1` and uploads it as a compare-and-swap on the old
sequence, with the same pending-record order as Mint (pending record, upload, commit). The link then reads
`movedFrom`. A one-time link is `409 link_not_public` (it is made once and cannot be changed); a pending, ending or
ended link is `409 link_not_live`; moving to the version it serves already is `nothing_to_publish`. The check that the target version is still kept runs again after the pending record is written,
so a retire that races the move cannot leave a link serving a version that is gone.

**Change (3f-5).** `PATCH /v1/catalog-links/:linkId` changes a public link's end and install cap. Narrowing (an
earlier end, a lower cap) needs only the unlock, like turning a link off; **widening** (a later end, a higher cap or
removing the cap) is a `share-link` act. The route asks the service whether the change widens before it claims the
passkey, and the service refuses an unproven widening as `current_changed`.

**Lease, refresh and revival (3f-5).** The store keeps a link only for its `notAfter`, at most 30 days after the
document was signed, so a link with no end of its own is re-signed. `refresh()` runs at boot and every six hours: a
live public link with less than 23 days of lease left (a week after its last signing) is re-signed at `sequence + 1`
up to the new lease, never past its own end. A link the store reports **lapsed** (this machine was off past the lease,
or the store no longer knows the bundle) stays `live`, shows `storeState: lapsed` and a sentence in the list, and is
**revived**: uploaded again with action `create` at `sequence + 1`, under the same id and key, then `revivedAt` is set
and `catalog.link.revived` is written. A lapsed **one-time** link becomes `expired` instead (it cannot be revived: a
spent or lost one-time link is never put back). A store that cannot be reached leaves everything as it was.

**Identity rotation (3f-5).** The store takes a link's owner only from the daemon id that uploaded it. When the
daemon id is no longer the link's `publisher`, every pending or live link of that publisher is ended with reason
`identity-changed` and its key is forgotten; `stopsBy` is the last time the store may still serve it (its own end) and
the list sentence says how many are stranded. Turning one off remains the slow retry described above.

**Retire and usage (3f-5).** A kept version that a pending, live or ending link serves cannot be retired: the item
route answers `409 version_linked`. `usedBy.linkIds` on the item's versions lists those links. The retire check sees a
version whose link is still `pending`, so a Mint cannot race a retire either.

**Reported.** The feature `catalogs.links.1` is reported by the daemon (`NOT_YET_REPORTED` is empty). There is no built-in app
or CLI flow for links yet (3f-6 is the installer, 3f-8 the app). The Worker is deployed and bound; the operator `available` and
`serving` switches are a separate runtime control that can still turn the store off.

**Built in 3f-4 and left to later slices:**

- 3f-6 (the installer), 3f-7 and 3f-8 (the app). (3f-3, the Worker binding, merged at `f59c89df` and its relay deploy succeeded with `LINK_STORE` bound.)
- Preview returns no `matches`, and it needs no summary, so a skill that needs one is `source_refused` at preview.
  `link_kind_unsupported` is unreachable today. A stored link carries the item's name and kind.
- **A new item whose upload answer never came is never kept**, so its `pending` public link reconciles to `ended`
  (`item-gone`). The link is safe (the store was not told, or its delete was retried); the owner makes it again.
- `storeState` stays `ok` on a link the refresh has just found used.
- **The link URL's app origin is the hosted app's (`HOSTED_APP_ORIGIN`) in the daemon.** `FY_APP_URL` is read only by
  the CLI, so a daemon run for a self-hosted app still mints links that point at the hosted one. The review of 3f-4 (F8)
  asked for it; it is left until the daemon has a configured app origin of its own, which also shares need.

### Declared gaps

- **A link cannot be recalled from what was already downloaded.** Turning it off stops new fetches; a copy already
  fetched stays with whoever has it.
- **A malicious store can withhold or replay until `notAfter`.** It cannot read or alter an item (it holds no key and
  every check is signed), but it can answer 410 early or serve an older signed copy; the reader refuses a lower
  sequence it has seen.
- **A one-time link whose response is lost is spent.** The store cannot know the bytes arrived.
- **The open count is fetches, not installs.**
- **A self-hosted store (`s=`) is trusted for availability only**, and the app names its host before fetching.
- **A lapsed "never" link's id can be squatted once its tombstone is purged.** After the tombstone window another
  daemon could upload under the same bundle id and the old URL would then reach that daemon's link. It cannot read or
  forge anything (the key and the signature are the publisher's), so this is an availability gap only.

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
- **A damaged shared copy is healed only when something writes it again.** A blob's name is the digest of its
  text, so writing one replaces a file that holds other text (atomically, 0600). The upgrade and a new
  version write the shared copies they need, so a damaged one is repaired then. A copy no write touches stays
  damaged until it is needed: every read checks it against its `contentDigest` and answers `store_damaged`,
  so nothing wrong is served. Restore the file from a backup in the meantime.
- **One damaged version 1 blob stops the upgrade for every catalog** (it fails closed rather than
  upgrade some). Nothing is written, and the daemon keeps answering `store_damaged` for catalogs until
  the file is restored or the previous version is installed.
- **Going back loses changes and can reuse revisions** ([Storage](#upgrading-from-version-1)). Orphaned
  items (a deleted catalog's, or the old per-catalog blobs) are kept; nothing collects them yet.
- **Retiring hides a version, it does not recall one.** A retired version stays in the store and in anything already
  installed from it, and a member who already holds its bytes keeps them. It stops being offered by the list and
  the item route. The owner's app shows retired versions (3d-4); nothing installs from the version list yet (3d-3).
- `public` and members are not available; a file is the only way a catalog leaves.

## What is built

| Phase                                                                                                        | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. The contract**: items, manifests, files, canonical JSON, signing and checking, the review, the warnings | **Built.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **1. Signed catalog files**: make catalogs, export a file, install it on another machine with the review     | **Built**: the publisher side (`fy catalog`, the owner routes, the `sharing` capability), the installer side (`fy catalog install`, the install routes, a passkey per install), and the app screens (Add to catalog, Sharing › My catalogs, Install from a file). The next phase is 2 (members, live), once decided.                                                                                                                                                                                                                                                                                                                                                                                  |
| **2. Members, live**: shares and codes, joining, member passkeys, the member route table, revoke             | **2a contract written** ([Members](#members-phase-2), relay-protocol §14 "Member sessions"). **2b-1 built**: shares, members, the owner routes and `fy catalog share` / `fy member` ([Built in 2b-1](#built-in-2b-1-shares-and-members-on-the-publisher)). **2b-2 built**: relay `join`/`member` records, the member route table, member passkeys, closing sessions on revoke ([Built in 2b-2](#built-in-2b-2-join-and-member-sessions-on-the-publisher)). **2c built**: the app for owners and members ([Built in 2c](#built-in-2c-the-app-for-members)). **2d built**: the end-to-end test of join, passkey, install, join again and revoke in Chromium (`tests/e2e/catalogs-members.e2e.test.ts`). |
| 3–7. The offline library, public catalogs, revoke clean-up, hosted artifacts, passkey-locked ones            | Designed ([design/catalogs.md](design/catalogs.md) §6), not started. **Download links (3f)**: the daemon side is built ([The daemon](#the-daemon-3f-4)), no Worker deploy or app yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
