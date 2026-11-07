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
- **Clean up's folder**: today's builder ran in the Ferretry home. Its 5.0 folder is a kernel-chosen work folder given
  through a Ferrets start with a work folder (D2 #19, the kernel WorkFolders seam). Until then Clean up refuses to
  start and says so.
- **The start check** proves only that a runtime resolves, is switched on and is signed in (`RuntimesApi.resolve`).
  Today's "reply OK" run, which caught a login out of quota, is an additive `RuntimesApi.probe(runtime)` through the
  harness plugins. It spends, so it runs only on an owner's act (Clean up is person-only); nothing in Packs checks or
  starts a runtime unattended, and Packs arms no job.
- **Runtimes facts**: `catalog()`, `tools()` and `modelCatalogs()` are additive Runtimes members (D2 #15) not on this
  base. Until they are, Pack mode lists no usable model and says so.
- **Routing prompt accept and undo** answer `503 config_write_unavailable` until the kernel's config write port
  (D2 #16) lands.
- **A pack table's last line**: today's was the newer of the card's last note and the last message the member sent to
  the AUTHENTICATED CALLER. The sitrep lines carry no addressee, so the "message to the caller" half needs a
  Conversation read; until then the newest dated sitrep line is used, masked whole before it is cut.
- **`POST /v1/recommend`** (R-0321, the account recommender) is still declared by Runtimes at that path; the placement
  lists it with Packs. V-0260/V-0261 (`fy fleet`, `fy fleet recommend`) have no verb here. Both are the lead's to settle.
- **Usage**: Packs reads quota through its own stand-in port (`UsagePort`, D2 #15); it is dropped once Packs binds the
  merged Usage contract.

## CLI

- The shell's `CliContext` carries only `manifest`, `client` and `io` (kernel item L adds clock, sleep and env), so:
  `fy pack` needs the ferret named, `guide clean-up --prompt-file` says it cannot read files, `guide clean-up`/`write`
  look at their run once, and `fy pack` dates rows against the daemon's reading time.

## App

- **The transcript card** (`app/components/pack-call.tsx`) draws with the chat's reference-proved Markdown, PeerName,
  MessageFooter and ToolGroup, which `@ferretry/app/ui` does not offer, and Conversation's transcript row hosts it
  (`ports-pending.json` `pendingAppPorts`).
- **Settings › Pack mode** reads and saves `packs.yaml` through a configuration-file port the shell does not hand a
  plugin half yet (and the kernel write port, D2 #16); until then the tab says to edit the file by hand.
- **One ferret's own switch**: no read of a single ferret's Pack switch exists, so the panel's switch shows ON until the
  daemon has answered on that page.
- **CSS**: `app/components/pack-call.css` (theme roles only) is loaded by the shell with the Packs views.
