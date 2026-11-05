# Saved pictures — the daemon's render store

A ferret saves an `svg` or `html` picture as a file the daemon keeps, and cites it with a short token,
`%svg:7k2m9q` or `%html:4wd0hs`, instead of pasting the source into the conversation. This page is the
contract of the **store and its routes**. It is slice 2 of the design in the card &F959: there is no CLI, no
MCP tool, no app rendering and no prompt teaching yet — those are slices 3 to 5, and until they ship
nothing calls these routes. Read [fy-render.md](fy-render.md) for the grammar a picture is checked against
and [grants.md](grants.md) for who may call a route.

## What is stored

**Only two kinds: `svg` and `html`** (owner decision, !A377). Every other `fy-render` type — `mermaid`,
`chart`, `map`, `lottie`, `card`, `board`, the media types — stays an inline fence exactly as today, with no
store and no token.

A render is **immutable**. It is saved once and never changed. An edit is a new save with a new id; the old
render and every message that cites it keep the old picture (see [Supersedes](#supersedes-an-edit-is-a-new-id)).

## Where it lives

```text
<FY_HOME>/state/renders/
  ab/                  the first two characters of the id (keeps directories small)
    abcdef.payload     the payload text, exactly as saved
    abcdef.json        the meta (below)
```

- It sits in the daemon's state home beside `state/sessions/`, **not under one session**: a card or the
  machine agenda cites a picture with no session behind it.
- Both files are written atomically and owner-only, **payload first, meta second**. A crash can leave a
  payload nothing points at, never a meta that points at nothing. A later save of the same content writes
  both again.
- The id is checked against the id grammar before it becomes a path, so no caller-supplied string can name a
  file outside the directory. A meta that does not parse, that sits under another id's name, or that is a
  symlink is skipped: it is not a render.
- The payload is stored **as text** (both kinds are text), UTF-8.

The meta (`StoredRenderMetaSchema` in `packages/protocol/src/lib/renders.ts`):

| field        | meaning                                                                                 |
| ------------ | --------------------------------------------------------------------------------------- |
| `v`          | `1`                                                                                     |
| `id`         | the id                                                                                  |
| `kind`       | `svg` or `html`                                                                         |
| `alt`        | the one-line description, the same rules as a fence's `alt:`                            |
| `bytes`      | the payload's UTF-8 size                                                                |
| `sha256`     | the content digest (below), hex                                                         |
| `createdAt`  | when it was first saved                                                                 |
| `author`     | `{ sessionId }` — the ferret session that saved it; `{}` for a save made at the machine |
| `supersedes` | the older render this one replaces, if the saver said so                                |

## Ids: the content digest

`digest = SHA-256(kind ‖ 0x00 ‖ alt ‖ 0x00 ‖ payload)`.
`id = the first N characters of the digest in lowercase Crockford base32`, with **N = 6 to start**.

- The alphabet is the digits and the letters but `i`, `l`, `o` and `u` — the ones read as other characters.
  A six-character id is 30 bits: short enough to type, long enough that a collision is rare on one machine.
- **The same kind, alt and payload always give the same id.** A retried save is the same render and writes
  nothing; `created` in the answer says which happened.
- **Collisions are handled, not assumed away.** Content already stored is found **first, by its digest**
  (the index keeps a map from digest to render), whatever length its id was given, and answered as it is. Only
  new content walks the lengths: if the six-character id is already held by _different_ content, the daemon
  tries 8, 10, … up to 52 characters (the whole digest) until the id is free. So a shorter id whose record was
  lost later is never issued again for content that survives under a longer one, and a restart cannot make a
  retry duplicate it.
- **An id grants nothing.** It has to be unique, not secret. Access is the route's gate.
- The id grammar is `RenderIdSchema` (`^[0-9a-hjkmnp-tv-z]{6,52}$`); the token is `%<kind>:<id>`.

## Validation: before anything is written

A save is checked on the daemon with `renderSaveRefusal` (`packages/protocol/src/lib/render-save.ts`), which
is built from the same `fy-render` grammar core the reader runs ([fy-render.md](fy-render.md)): the alt rules
(`parseFyRenderHeaders`), `validateSvg` for an `svg` and `validateHtml` for an `html`, so **a save the
daemon refuses is a block the app would have refused**. On top of that: a payload that is empty or only white
space is refused, and a lone UTF-16 surrogate in the alt or payload is refused (UTF-8 would turn it into
U+FFFD and the digest would name other bytes). A refusal is `422 render_invalid` and carries the rule's own
sentence.

What the daemon cannot check is what only a browser can: it does not run the picture.

## Routes

All three are `operator` and `caller: 'any'` in the route table. **None carries a capability**
([grants.md](grants.md#saved-pictures)).

### `POST /v1/renders`

Body (`RenderSaveRequestSchema`, strict): `{ kind: 'svg' | 'html', alt, payload, supersedes? }`. The body is read
with a bound of `RENDER_MAX_BODY_BYTES` (the largest payload with JSON's worst-case escaping, plus the
envelope) before any byte of it is held.

**Who may save: a ferret's own session credential, or the host's admin token that arrived at the machine**
(`arrivedOnHost`: the admin token over a loopback _carrier_). Everyone else — a paired device, a browser on the
host, a session carried over the relay, the warden — gets `403 render_save_host_only` **before the body is
read**. "Arrived at the machine" is how the request arrived, decided from the carrier: a relayed hop is never
loopback, whatever address it appears to carry. Nothing in the app saves a picture, so there is no remote write
to govern; a later feature that lets the app save would need its own decision.

Answers `201` for a new render and `200` for one already saved, with
`{ id, token, created, meta }` (`meta` may carry `supersededBy`). The picture is attributed to the session
credential's session, or to the session an older `fy` names in `x-ferretry-session-id`, or to nobody (`{}`).

**Saves in flight are bounded.** Saves write one at a time, so every one waiting holds its whole payload in
memory. The service counts the saves in flight (admitted and not yet finished); once
`RENDER_MAX_PENDING_SAVES` (8, `packages/protocol/src/lib/renders.ts`) are, a further save is refused at once
with `429 render_busy` ("too many pictures are being saved at once; retry") and is never queued. The mount
checks this after the caller check and **before the body is read**, so an excess request's body is never
read; the service enforces it too, since other callers can reach it. A slot is released when its save ends,
however it ends.

Refusals: `400` (a body that does not fit the schema, including an unknown kind or field), `403`, `404
render_supersedes_not_found`, `422 render_invalid`, `429 render_busy`, `507 render_quota_exceeded`.

### `GET /v1/renders/:id/meta`

`{ …meta, supersededBy? }` — the stored record plus, when something replaced this render, the id of the
**newest** render in the chain. It is `no-store`: "a newer version exists" changes, so this is the one answer
that is not cached. `404 render_not_found` for an id nothing holds, `400 invalid_render_id` for a string that
is not an id.

### `GET /v1/renders/:id`

`{ meta, payload }` where `meta` is the stored record (no `supersededBy`) — an answer that never changes, so it
is served `private, max-age=31536000, immutable` with the strong tag `"<sha256>"`, and `If-None-Match`
answers `304`. Before it answers, the daemon recomputes the digest of the stored kind, alt and payload and
compares it with the meta: bytes that no longer match, or a payload that is gone, are `500 render_damaged`,
never a picture.

### The invariant: a picture is never a document on the daemon's origin

**Both reads answer `application/json; charset=utf-8` with `X-Content-Type-Options: nosniff`, whatever the
request's `Accept` says, and so does every answer a handler produces — errors included** (one wrapper renders a
refused id, caller, body or store as the dispatcher's usual envelope, status and code, plus the header; the `304`
keeps `application/json` too). The one thing it cannot reach is an answer the dispatcher gives **before** a
handler runs — the boundary's `401` and `403` — and those are JSON error envelopes with no payload in them. A stored `html` picture opened directly in a browser tab is therefore JSON text and
cannot run on the daemon's origin; the only way it runs is the opaque sandbox frame the app puts it in
([fy-render.md](fy-render.md)). This is the security invariant of the feature and it is pinned by tests that
request the raw route with `Accept: text/html` and `image/svg+xml` (`tests/unit/runtime/mounts/renders.test.ts`).
Never add a route that serves a payload with any other content type.

## Quotas

A save is refused with `507 render_quota_exceeded`, naming the quota that was hit, when it would pass:

| quota                | limit  |
| -------------------- | ------ |
| pictures per session | 2,000  |
| bytes per session    | 64 MiB |
| pictures per machine | 20,000 |
| bytes per machine    | 1 GiB  |

A save made with no session behind it (the owner's `fy` at the machine) has a bucket of its own, "the owner's
own saves". A save of content already stored is not charged. The numbers are `RENDER_QUOTAS`; they are
guesses to tune, not doctrine. The size cap of one picture is the `fy-render` cap of its kind
(`RENDER_PAYLOAD_BYTES`: svg 100 KiB, html 200 KiB), read from `fy-render-caps.ts`, not restated.

## Supersedes: an edit is a new id

`supersedes` names the render this one replaces. It is checked (`404` if that render is not saved) and stored
**once, in the new render's meta**. The old render is not touched. `supersededBy` on the meta route is derived:
the daemon follows the links from the old id to the newest render, so an old message can show a "newer version"
link (the app's side of that is slice 4). Links only ever point at an older render, so a chain cannot loop.

If the content being saved is already stored, the answer is the existing render and a `supersedes` in the
request is ignored: an immutable render's lineage is not rewritten by a later save.

## The in-memory index

The store is the files. On first use the daemon lists them once and keeps what it needs — each meta, the
`supersedes` links and the quota totals — in memory, updated by every save under a single queue, so the
collision check and the quotas never read a store another save has not finished changing. A failed listing is
retried by the next request and is never remembered as an empty store. A restart rebuilds it from the files.

## Garbage collection: not yet

**Nothing deletes a render in this release.** The planned rule (card &F959, slice 7): a render stays while
something can cite it — its author session, a card field, an agenda item or tab — and only a render whose author
session is gone and that nothing else cites is deleted, after a 7-day grace period, with a dry run in
`fy doctor` first. Until then the quotas above are the bound on growth.

## What this page does not own

- The grammar and the caps of the two kinds: [fy-render.md](fy-render.md) and `packages/protocol`.
- The token's place in the reference grammar and how the app proves and draws it: slice 4, which will update
  [reference-standard.md](reference-standard.md).
- Who may call a route: [grants.md](grants.md).
