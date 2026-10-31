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
letter or digit) and a one-line `summary`.

**A skill** is a folder: `SKILL.md` at its root and up to 200 text files. The bundle rules are Clone's
([cross-daemon.md](cross-daemon.md) §3a′, §3b), plus two more, so the review lists exactly what gets
written:

- every path is one plain relative path (no leading `/`, `~` or `$`, no `.` or `..`, no `\`, no
  control or text-direction characters), at most 16 folders deep;
- no file is carried twice, **including two paths a Mac would treat as one** (`SKILL.md` and
  `skill.md`, or `é` written two ways);
- no path is both a file and a folder;
- at most 256 KiB per file and 2 MiB in total, counted in UTF-8 bytes.

Files are text. A skill with a binary file cannot be added yet.

**An MCP setup** is a program to start (`command`, `args`, `env`) or a server to reach (`url`, with an
optional `auth: "oauth"`). It carries **no secret value and nothing that could reach one**:

- A secret is named only as a **whole** environment value, `${secret:NAME}`. That is a placeholder the
  installer fills in.
- **Nothing else may contain `${`**: not a command, not an argument, not the address, and not part of a
  value. Otherwise a setup could ask for `${GITHUB_TOKEN}` and have the installer's own environment
  expand into its program.
- A value that looks like a raw key is refused, by the rule the MCP forms already use
  (`mcpServerRefusal`).
- An address is plain `http://` or `https://`, with no user name or password in it. A signed-in server
  is `https://` only.
- An OAuth **client secret has no field**. The installer signs in on their own machine
  ([mcp-oauth.md](mcp-oauth.md)), and no token is ever copied.

**An artifact** item is listed in the schema now so the contract does not change later, but it carries
only a reference to an encrypted snapshot (design §3.8). Artifacts are opened, never installed, and
nothing publishes one yet.

**Labels** (a catalog's name, the publisher's name, a summary) refuse control characters and the
Unicode text-direction overrides. Those could make "Anthropic" out of other letters, or hide the end of
a name. A description may hold line breaks and nothing else invisible.

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

A reader refuses a file larger than **32 MiB before parsing it**. The schema then refuses any item the
manifest does not list, at another version or name, from another catalog, or carried twice. Who made
it is decided only by the signature.

## What the installer checks, in order

The installer is the subscriber's **own** daemon. It never talks to the publisher, and it never takes
the caller's word for what the publisher said:

1. **The signature.** The public key hashes to the publisher's daemon id
   (`fy_daemon_` ‖ base64url(SHA-256(spki))), and the signature holds over the manifest.
2. **The item.** It is the version, kind, name and summary its manifest line lists, and its digest and
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

- **Every file in full**: `SKILL.md` first, then every other file by path.
- **Every command line**, quoted the way a person would type it, and **every variable**, with
  placeholders shown as written.
- **Warnings**, in words:
  - `unpinned-package`: `npx foo`, `npx foo@latest`, a range, `uvx foo`, `pipx run foo`, or a container
    image with no tag or `:latest`. The text says it runs whatever is newest each time a ferret starts,
    so it can change without an update. This is a warning, not a refusal (owner decision Q15), because
    refusing would block most real servers.
  - `network-url`: a server at an address runs on someone else's computer and can change at any time.
  - `carries-scripts`: a skill carries scripts, named one by one.
  - Only the installer can know `first-publisher`, `older-version` and `edited-locally`, so it adds those
    itself.

## Declared gaps

What this does **not** protect against, said plainly (more in design §4.8):

- **Trust on first use (G5).** A valid signature proves the bytes came from the machine with that
  fingerprint. It does not prove that machine is the person you meant. Compare the fingerprint with them
  if it matters.
- **Unpinned package managers (G6)** change what runs without an update. Warned, not refused.
- **A program you install is a program you run.** Leaving a secret unbound stops that secret from
  being handed over. It does not stop the program reading whatever else its process can reach.
- **Signed means attributable (G9).** Anyone holding a signed manifest can prove the publisher
  published it.

## What is built

| Phase                                                                                                        | State                                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **0. The contract**: items, manifests, files, canonical JSON, signing and checking, the review, the warnings | **Built.** No routes and no screens yet.                                                                  |
| **1. Signed catalog files**: make catalogs, export a file, install it on another machine with the review     | Next: the publisher side (`fy catalog`, the `sharing` capability), then the installer side, then the app. |
| 2–7. Members, the offline library, public catalogs, revoke clean-up, hosted artifacts, passkey-locked ones   | Designed ([design/catalogs.md](design/catalogs.md) §6), not started.                                      |
