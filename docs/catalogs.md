# Catalogs: sharing skills and MCP setups, signed

A **catalog** is a named list of skills and MCP setups on one machine, the **publisher**. Someone who
is not one of your devices can install an item from it on **their own** machine, the **installer**.
Every catalog is **signed by the publisher's daemon identity**, so the installer checks where it came
from itself, whatever carried it: a file, a browser, an offline copy.

This page is the **contract**: what is built, the bytes both ends agree on, and the checks an installer
runs. The full approved design, with the people, sharing codes, offline library and artifacts still to
come, is [design/catalogs.md](design/catalogs.md); the Sharing page, skill rows, versions and links that build on it are
[design/catalogs-sharing.md](design/catalogs-sharing.md). Where they differ, this page wins for what exists.

**Where it is in the app.** The **Sharing** page, `/d/<machine>/sharing/<tab>`, with four tabs: **My catalogs**
(`catalogs`), **Shared with me** (`shared`), **People** (`people`) and **Skills** (`skills`). Phone: **More › Sharing**.
Desktop: the top bar, the sidebar footer and the narrow rail. The palette also finds **Sharing**, **Shared with me** and
**Share a skill…**. Settings › Machine › Catalogs is only a link to Sharing › My catalogs. `/shared` stays for a browser
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

Exactly one catalog's revision rises for a rename, a description, an add (new or existing), a withdrawal or a relist. A new version raises the revision of **every catalog that lists the item live** (one write carries all of them), and leaves a catalog that withdrew the item alone. Making a catalog the default changes no manifest, so no revision rises.

A catalog serves the versions from the one it joined at (or was relisted at) onward: the entry's optional `sinceVersion` (absent means 1, so catalogs made before 3c-2 serve every version) is set to the item's current version when an existing item is added or relisted, and `frozenItem` refuses any older version as `item_unknown`. Only the current version is exported. A 3c-1 daemon refuses a document carrying `sinceVersion` (it fails closed and never writes), so a downgrade after this slice needs the catalogs file restored from before it.

The publisher name the manifest carries is **stored with the catalog** when it is made (the machine's
name then) and signed from the store at every export, so a change of host name does not change the bytes
of a revision. `PATCH` may set it, which is a change like a rename. Restoring `catalogs.json` from a
backup can **reuse revision numbers**: an installer that saw a newer revision of this catalog refuses
the restored older one, and the fix is to publish something new so the revision passes theirs.

### Routes

All are `sharing`/`use`, `noStore`, and the writes answer a ferret 403 `forbidden`.

| Route                                          | Does                                                                                              | Ferret  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------- |
| `GET /v1/catalogs[?sourceState=1]`             | every catalog, its items and versions (`sourceState` only when asked), and which is the default   | may     |
| `GET /v1/catalog-items[?sourceState=1]`        | every shared item once, with the catalogs that list it and where each version is used             | may     |
| `POST /v1/catalogs`                            | make one (201)                                                                                    | refused |
| `PATCH /v1/catalogs/:id`                       | rename, describe, set the publisher name, or `role: "default"` (no revision)                      | refused |
| `DELETE /v1/catalogs/:id`                      | delete it (its items and versions are kept in the store)                                          | refused |
| `POST /v1/catalogs/:id/items/preview`          | freeze a source for review; writes nothing                                                        | may     |
| `POST /v1/catalogs/:id/items`                  | add the previewed source as a new item, or `{itemId, version}` to list an item already kept (201) | refused |
| `POST /v1/catalogs/:id/items/:itemId/versions` | publish the next version (201)                                                                    | refused |
| `DELETE /v1/catalogs/:id/items/:itemId`        | withdraw an item                                                                                  | refused |
| `POST /v1/catalog-items/quick-add`             | one-tap Add into the default catalog: 201 `added`, 200 `already` or `review`                      | refused |
| `POST /v1/catalog-items/quick-add/undo`        | take that add back with its token (single use, 60 s)                                              | refused |
| `POST /v1/catalogs/:id/export`                 | sign and return the catalog file                                                                  | refused |

Refusals keep their code: 404 `catalog_unknown` / `item_unknown` / `source_unknown`; 409 `item_withdrawn`,
`name_taken`, `catalog_full`, `catalogs_full` (256 catalogs), `items_full` (4,096 items), `item_listed`, `current_changed`, `source_ambiguous`, `changed_since_preview`, `nothing_to_publish`; 400
`public_unavailable`; 410 `undo_expired`; 413 `export_too_big` (the file would be over 32 MiB: export fewer items); 422
`source_refused`; 503 `signing_unavailable`; 500 `store_damaged` / `export_failed`.

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
`catalogs.items.1`. Not here yet: the app's use of these, and versions.

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
- Declared gap: **the undo record is in memory.** A restart forgets every token, so Undo then answers 410 and the item is
  withdrawn the ordinary way; it also forgets which revisions were signed, which is why no add survives a restart as
  retractable. The feature flag is `catalogs.quick-add.1`. Audit: `catalog.changed`, `publish` or `undo`, ids only
  ([audit.md](audit.md)); a `review` or `already` answer changed nothing and is not recorded.

### Why a ferret may only list

A ferret holds the admin token, but a catalog hands skills and MCP setups to other machines. A
prompt-injected agent that could publish would be one that could hand a skill, or the address of a
server, to whoever the owner next sends the file to. So the daemon refuses a ferret (an agent caller)
every route above except the two reads. Governed remote callers also need a passkey step-up for
`sharing.use` ([grants.md](grants.md#capability-eight-was-added-sharing)).

### Storage

Under `<FY_HOME>/state/catalogs/`, directory `0700`, files `0600`, written atomically:

- `catalogs.json` (**schema version 2**): one shared **item table** and the catalogs that list its items.
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

### Audit

Ids only, never what an item holds ([audit.md](audit.md)): `catalog.changed` (`create`, `update` (a rename, or a role change, which records `role`), `delete`, `publish` (a new item, a new version or an existing item listed in another catalog) and `withdraw`,
with item id, version, digest and revision) and `catalog.exported` (revision and
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
  so before a code is minted for an existing member, and suggests a new member instead when in doubt.
- **The link carries it in the fragment only**: `https://<app>/join#v1;url=…;fp=…;share=…`. The pairing
  link's grammar and the same reader, but the code is under its own field name: a share reader refuses a
  link carrying `code=`, a pairing reader one carrying `share=`, so no link is read by both. The app routes
  by path (`/join` is a share). The publisher's address must be http(s). A link-preview fetcher never sees
  a fragment.

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
browser that joins instead becomes whichever member the code names, which is what the code allowed anyway.

**What a member can reach** is a **separate route table**, `/v1/shared/*`: their own summary, the signed
manifests and items of the catalogs they hold now, redeeming a code, registering passkeys and unlocking,
and leaving. Every request re-checks their grants, so a revoke works on the very next request. Members
never see each other (Q14) and never share onward (Q16).

**Bounds.** 128 members and 512 member keys per publisher, 200 keys per member (so one leaked multi-use
code fills its own member, never the publisher), 64 live shares, 64 catalogs per share, 60 successful joins
and redeems an hour per share, 10 failed joins a minute per peer on the direct carrier. A full publisher refuses a
join and leaves the code live. A member key unused for 90 days is removed; the member stays. Until the sweep reaches it, such a key is already
refused (`4403`) and opening a session never refreshes it: one predicate decides both.

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
  `GET /v1/catalog-members`, `PATCH|DELETE /v1/catalog-members/:memberId`, and `DELETE` of one browser or one
  catalog of a member. A ferret may list and nothing else. Minting needs a fresh `share-catalog` passkey from a
  governed caller, claimed atomically. The code and link appear ONLY in the mint's answer. Minting is refused
  (`share_link_unavailable`, 503) when the daemon has no address another person could open, so no code is
  spent on a link that only works on this machine.
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
  it (and that no device credential reaches `/v1/shared/*`). Nine routes: passkey options and register,
  unlock options and unlock, then `GET /v1/shared/me`, a catalog's manifest (`ETag` is the revision,
  `304` on a match), an item, `POST /v1/shared/redeem` and `DELETE /v1/shared/me/keys/self`.
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

**Owner, in Sharing › My catalogs.** A catalog's **Share…** sheet makes a code for a new person (by name) or an
existing member (with the warning "whoever opens this can read everything they can read" shown before anything is
made), for 15 minutes, 1 hour, 3 hours, 8 hours or 1 day, for one person or many (at most 200). It asks for a passkey
(act `share-catalog`) and shows the link **once**: a QR drawn in the page, Copy link, a countdown and **End this code
now**. The app keeps and logs nothing about the code. **People and codes** lists each member with their catalogs and
browsers (remove one browser, take away a catalog, revoke the member with the plain sentence of what stops) and the
shares (live, used, expired).

**Adding a catalog is by link.** **Add a catalog from a link** is a paste field at the top of Sharing › Shared with me
and Sharing › My catalogs. The context rail's Skills and MCP lists carry none: each has one small text link, **Add from
a link…**, that opens Sharing › Shared with me. A `/join` link (any app origin; read by path and fragment) opens `/join` with its
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

**Shared with me (online only).** Each publisher shows the person's own label and the first 20 characters of its
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

### The skill and MCP rows (catalogs 3b)

The context rail's **Skills** list, its **MCP** list and the skills surface draw every item with **one** row
(`features/catalogs/catalog-item-row.tsx`). It replaces the old strip under each row ("From ‹catalog›", Remove, "Add
to catalog…") and the inline Open button.

- **Left**: the name in mono (tapping it still inserts the invocation), a scope chip, a version chip when one is known,
  and one truncated description line (the full text is its tooltip, and **Open SKILL.md** shows the file). Hidden and
  format characters in any name, publisher or catalog name are marked.
- **Version chip**: `v3` for an item in one of **this machine's** catalogs (the newest version it holds); for an item a
  catalog install wrote, **from ‹publisher› · v2** (the version it is pinned to; the tooltip names the catalog). No
  chip when no version is known. A withdrawn item is not held, so it shows none.
- **Right, always visible, 44px tall**: **Share**, **Add** (only for items this machine could share, so not for
  installs from someone else's catalog) and **⋯**. The columns keep their place so rows line up.
- **Which catalog holds an item** is read from the catalogs list the machine already answers, by source: the
  `SKILL.md` path (a list that only knows a skill's name matches by name) or the MCP server id. No new route.
- **Add** opens the Add to catalog sheet. When it has saved the item and the row is the one that opened it, the last
  step offers **Share it now** (or **Not now**): it opens the Share sheet for the catalog the item just joined.
- **Share** depends on where the item sits: in **one** catalog, the Share sheet for it; in **several**, a small picker of
  those catalogs and then the Share sheet; in **none**, the Add to catalog sheet, ending in **Share it now**. Sharing
  still asks for the owner's passkey, as before; nothing about a share reaches the row.
- **⋯** holds **Open SKILL.md** (on the skills surface, Show detail) or, on an MCP row, **Show details** / **Hide details**
  (so every MCP row has a ⋯), **Add to another catalog…** (items this machine could share) and
  **Remove** (catalog installs only, with the same confirm; with several installs, one per catalog named
  "Remove (from ‹catalog›)"). **Versions…** and **Stop sharing** are not here yet.
- **Show details** (MCP) opens a few plain lines under the row from the inventory the list already read: what it runs
  or its address, where it is declared, its project, the harness, and which runtimes see it with their approval. The
  address has no query and the program no arguments by construction, and hidden characters are marked.
- A row never shows a secret value. The side-panel lists have no paste field or **Install from a file…**: they moved
  to Sharing › Shared with me, so the lists stay uncluttered.

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
- `public` and members are not available; a file is the only way a catalog leaves.

## What is built

| Phase                                                                                                        | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. The contract**: items, manifests, files, canonical JSON, signing and checking, the review, the warnings | **Built.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **1. Signed catalog files**: make catalogs, export a file, install it on another machine with the review     | **Built**: the publisher side (`fy catalog`, the owner routes, the `sharing` capability), the installer side (`fy catalog install`, the install routes, a passkey per install), and the app screens (Add to catalog, Sharing › My catalogs, Install from a file). The next phase is 2 (members, live), once decided.                                                                                                                                                                                                                                                                                                                                                                                  |
| **2. Members, live**: shares and codes, joining, member passkeys, the member route table, revoke             | **2a contract written** ([Members](#members-phase-2), relay-protocol §14 "Member sessions"). **2b-1 built**: shares, members, the owner routes and `fy catalog share` / `fy member` ([Built in 2b-1](#built-in-2b-1-shares-and-members-on-the-publisher)). **2b-2 built**: relay `join`/`member` records, the member route table, member passkeys, closing sessions on revoke ([Built in 2b-2](#built-in-2b-2-join-and-member-sessions-on-the-publisher)). **2c built**: the app for owners and members ([Built in 2c](#built-in-2c-the-app-for-members)). **2d built**: the end-to-end test of join, passkey, install, join again and revoke in Chromium (`tests/e2e/catalogs-members.e2e.test.ts`). |
| 3–7. The offline library, public catalogs, revoke clean-up, hosted artifacts, passkey-locked ones            | Designed ([design/catalogs.md](design/catalogs.md) §6), not started.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
