# Packs: what is not bound on this base

Each line names the seam it waits on and who owns it. Nothing here is stood in for: the code answers the gap plainly.

## Daemon

- **Helper start (`fy new`) and `fy wait`** are not Packs' (lead decision D2 #14): `fy new` is Ferrets', `fy wait`
  Conversation's. Packs shapes a start only through its `start.decide` taker and the start options. With `new` went
  the candidate order for `--auto`, Jev's ranking and its spend ledger (`jev-spend.json`), the probe-then-start loop,
  the named-scratch-folder refusal and the helper's brief footer. They return when Ferrets' helper start asks Packs
  for an order; copy them from today's `packages/daemon/src/lib/pack/service.ts` (and this package's history). Packs
  therefore needs no Vault, calls no host and names no secret.
- **Card reservation** (a helper started without `--card` gets a child card under the lead's focus card, as today):
  returns when Ferrets' helper start lands with `start.decide` carrying the brief and card, plus an additive Board
  `delegate`/`reserve` member. Packs → Board is an approved optional `uses` (D2 #15) with no call site until then.
- **Clean up's folder** (`guide clean-up`, `guide write`: V-0274, V-0278 stay unticked): today's builder ran in the Ferretry
  home. Ferrets starts a ferret in a folder the start names (`StartRequest.workFolder`, a trusted plugin's own choice), but
  no seam hands Pack mode a folder the KERNEL chose for a builder (D2 #19, the WorkFolders seam), and the only folders a
  plugin can name are inside the state home (`state.pathOf`), where an unattended model run could reach the credentials and
  sessions the state-home fence keeps agents out of. Using one would be a side door, so both verbs refuse to start, say what
  is missing and how to edit `config/packs.yaml` by hand, and spend nothing. A ruling for britnee: which kernel seam hands
  out a builder's folder. Clean up stays a person-only act.
- **The start check** proves only that a runtime resolves, is switched on and is signed in (`RuntimesApi.resolve`).
  Today's "reply OK" run, which caught a login out of quota, is an additive `RuntimesApi.probe(runtime)` through the
  harness plugins. It spends, so it runs only on an owner's act (Clean up is person-only); nothing in Packs checks or
  starts a runtime unattended, and Packs arms no job.
- **Warden lineage** is read from labels: a ferret whose own label, or any ancestor's, is `fleet-warden` is never told
  about Pack mode. Today's start also stamped `provenance.wardenLineage`, which outlived a pruned warden; no 5.0 start
  writes that stamp yet (Ferrets'), so it is read only as a second guard.
- **Routing prompt accept and undo** (V-0273, V-0277) are bound: they write the `routing` section of `packs.yaml` through
  the kernel's config writer (`ConfigPort.write`, the service behind `PUT /v1/config/file`; `adapters/guide-config.ts`),
  against the etag read with the file, so Gate's per-file rules apply unchanged. A stale etag is refused (409), a write
  the owner must confirm is answered `held` and keeps no undo (nothing was replaced), and one undo restores exactly.
- **A pack table's last line**: today's was the newer of the card's last note and the last message the member sent to
  the AUTHENTICATED CALLER. The sitrep lines carry no addressee, so the "message to the caller" half needs a
  Conversation read; until then the newest dated sitrep line is used, masked whole before it is cut.
- **`POST /v1/recommend`** (R-0321, the account recommender) is still declared by Runtimes at that path; the placement
  lists it with Packs. V-0260/V-0261 (`fy fleet`, `fy fleet recommend`) have no verb here. Both are the lead's to settle.
- **Pane limits** (the logins live panes prove spent) are Usage's own read, `UsageApi.paneLimits()`, which aggregates what
  Ferrets reports from live session documents (`FerretsApi.paneLimits`, derived on every call, kept nowhere): each carries
  presence, the harness sentence, spend and the optional reset time, so a non-spend limit with no reset time holds until its
  ferret is released or stops. A ferret that records no login is known by its runtime and mapped to a login here. A Usage,
  Ferrets or Logins that fails to answer reads as nothing known (quota `unknown`).
- **Pane limits, second reader**: Packs reads each login's sign-in, quota windows and budget from the Logins port
  (`LoginView`), and also asks the REAL Ferrets port directly (`list()` + `prompt().limit`, `adapters/login-quota.ts`):
  a limit a live ferret's own session records wins for the login it names; Usage's read adds the rest. Both only ever
  ADD a limit the provider's windows did not say.

## CLI

- The shell's `CliContext` carries only `manifest`, `client` and `io` (kernel item L adds clock, sleep and env), so:
  `fy pack` needs the ferret named, `guide clean-up --prompt-file` says it cannot read files, `guide clean-up`/`write`
  look at their run once, and `fy pack` dates rows against the daemon's reading time.

## App

- **The transcript card** (`app/components/pack-call.tsx`) is a panel in Conversation's `conversation.row` slot
  (`pack-call`, an optional `uses` of Conversation). The slot hands it a tool row's shell calls whose whole script is one plain `fy` command (no `cd … &&`, pipe or
  redirect) and what they printed (masked as the daemon masked the transcript; never the device outbox, never a refused send's text). The card
  sees one row at a time: a `wait` folds into its start only in the same row (otherwise it is its own "Waited for"
  card), and "retried" is marked only within a row. Conversation's tool group still draws the raw call in the row; the
  card is beside it. Its PeerName, MessageFooter and command list are the card's own (`components/card-parts.tsx`):
  the chat's are Conversation's files, which another half may not import.
- **Settings › Pack mode** reads and saves `packs.yaml` through the kernel's `GET`/`PUT /v1/config/file`
  (`app/lib/config-files-client.ts`), as Runtimes does for a profile file; a loosening edit comes back held and the tab says
  it waits for the owner's confirmation. It never confirms: that is the owner's act elsewhere.
- **One ferret's own switch**: no read of a single ferret's Pack switch exists, so the panel's switch shows ON until the
  daemon has answered on that page.
- **CSS**: `app/components/pack-call.css` (theme roles only) is loaded by the shell with the Packs views.

## What is masked (not a gap; stated so a reader does not assume more)

Every text a ferret wrote is masked inside ONE `Redaction.read` before Packs keeps or serves it, and a redactor that
fails withholds it — never the raw text:

- **A finished ferret's result** (`FerretsApi.summary` is NOT masked): masked in the daemon half's one result read,
  which `GET /v1/ferrets/:ferretId/result` (503 when masking fails), `PacksApi.result` (rejects) and Clean up all use.
- **Clean up's rewrite**: masked before it is checked and kept with the run; a run whose rewrite could not be masked
  fails and keeps nothing. `GET /v1/pack/routing/jobs/:jobId` (`guard: 'secrets'`) masks the before and after again as
  it serves them.
- **A pack table's last lines**: masked whole before they are cut; every excerpt reads withheld on failure.

Not masked: model ids, runtime and login names, readiness, quota, and the routing prompt (the owner's own words).
