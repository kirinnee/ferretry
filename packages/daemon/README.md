# daemon

The per-host Ferretry daemon. This package owns the durable state-home foundation; later units add
the API and runtime subsystems on top of it.

## State-home layout

`FY_HOME` selects the root. If it is unset, the daemon resolves `.<product>` below the injected user
home — derived from this package's own scope, not written out, because the client derives the same
default and a literal in a `.ts` file does not survive `scripts/local/rename.sh --product` while a
package scope does. Overrides must be non-empty absolute paths; filesystem roots and `~`-prefixed
literals are refused.

```text
$FY_HOME/
├── layout-version
├── daemon.lock
├── config/
│   └── daemon.json                 # daemon configuration, incl. the analytics pricing catalog
├── fleet/
│   └── manifest.json               # reserved for the fleet unit
└── state/
    ├── index/
    │   ├── sessions.sqlite         # disposable derived index
    │   ├── sessions.sqlite-wal     # transient SQLite sidecar
    │   └── sessions.sqlite-shm     # transient SQLite sidecar
    ├── sessions/
    │   └── <session-id>/
    │       ├── session-version
    │       ├── config.json
    │       ├── state.json
    │       └── events.jsonl
    └── tmp/                        # atomic-write staging; swept at boot
```

Only the paths shown above belong to this foundation. Later subsystems derive their own paths from
the parsed root instead of extending a shared path hub.

### Creating a state home and claiming it are ONE operation

`layout-version` is not the daemon's private bookkeeping — it is the claim that says the directory
belongs to Ferretry, and **whichever side creates the home writes it**. The command-line client
creates state here too (`logs/` before it launches the daemon, `fleet/**` when it provisions a
fleet), and it does so before this daemon has ever run.

The two are held to one rule by `decideLayout` in `@ferretry/protocol`, which both packages import —
they cannot import each other, and neither may apply a rule of its own. The rule is
**never adopt a directory Ferretry did not create**, and it is applied at the moment either side is
about to create state. A client that wrote the marker under its own weaker rule would be free to
provision into a stranger's directory, so moving the decision rather than only the constant is the
point. `scripts/validate/cli-contracts.sh state-home-layout-claim` pins it.

This has shipped wrong three times, each time as "one artefact, two writers, no agreement":

1. the client created `logs/` unclaimed, and the daemon refused its own log directory on every clean
   machine — the reason `logs` is a declared part of the layout above;
2. the daemon's own `start()` loaded configuration before claiming, writing `config/daemon.json`
   into an unmarked home and refusing at its own next step — fixed by claiming first, which is the
   remedy generalised here;
3. `fy fleet init` wrote `fleet/**` unclaimed, so a home the client had just provisioned was refused
   **permanently** and the only move the product left an owner was `rm -rf`.

Because instance 3 shipped, every home provisioned by an earlier release carries no marker.
**`fy daemon adopt`** is the upgrade path: it reports what the home holds, then claims it — and
refuses, naming them, if it finds any entry Ferretry does not write. It is deliberately broader than
the daemon's automatic `bootstrapShape` (which admits only an _empty_ `fleet/`), because `fyd` adopts
silently on boot and must stay conservative, whereas this is a person claiming a home after being
shown what is in it. The daemon's automatic shape is **not** widened to swallow a provisioned fleet,
and the `missing-marker` refusal names this command so the refusal is never a dead end.

One tolerance is shared by both sides rather than being a relaxation: a home holding **only** an
unclaimed `logs/` is adopted automatically. An older client on the same host creates exactly that
before launching the daemon, so every upgrading installation arrives in that state, and the daemon's
`preBootstrapShape` already treats it as legitimate.

## Invariants

- Files are authoritative. SQLite stores lean session metadata and byte pointers, never document
  or event payloads and never absolute paths. Removing the index and its sidecars is recoverable;
  the explicit `reconcile()` and `rebuildIndex()` operations restore it from session files.
- `layout-version` and the SQLite schema generation are independent. An unknown home layout fails
  before mutation. An unknown index generation or stale schema shape is dropped and recreated;
  rebuilding its derived rows is explicit, and there are no index migrations.
- One daemon owns a home at a time through the lifetime `daemon.lock` transaction. Layout repair,
  temp sweeping, reconciliation, and writes happen only after that lock is acquired.
- Directories are repaired to mode `0700`; markers, documents, journals, the lock, and index files
  use `0600`. Derived paths stay below the parsed root, and symbolic links at or below that root are
  refused before reads, writes, or index deletion.
- JSON is validated before writes and parsed at reads. Document failures retain their file path.
  Session IDs and event records are schema-validated rather than trusted at filesystem boundaries.
- Document replacement is write + file sync + rename + directory sync. Journal appends are synced
  before their disposable pointer row is committed.
- A malformed journal record remains unchanged for diagnosis. A later append inserts a separator,
  so torn bytes cannot absorb a valid event; rebuilds return the problem as data. Records are
  capped at 1 MiB in both the encoder and scanner. Oversized input is reported once and
  stream-discarded through its next newline, keeping retained memory bounded.
- Reconciliation verifies the last indexed event before trusting a journal fingerprint. Unchanged
  journals refresh metadata without a chunk scan; append-only growth scans only the suffix while
  retaining absolute source-line context. Replacements, shrinks, unsafe line continuations, and
  mismatched pointers fall back to a byte-zero rescan.

## Analytics pricing catalog

`fy analytics` reports what usage would have cost. It never guesses a rate: the daemon ships with
an EMPTY catalog, and a model you have not priced stays `unpriced` with a reason rather than
resolving to zero. Supply your own rates under `analyticsPricing` in `config/daemon.json`.

The catalog belongs to one daemon's state home and is never shared with another.

```jsonc
{
  "analyticsPricing": [
    {
      // Your own stable reference for this price. It is retained on every session it prices, so a
      // later catalog edit cannot silently rewrite what a historical run was billed at.
      "pricingKey": "acme:claude-opus-5:2026-08",
      "modelId": "claude-opus-5",
      // Other spellings the same model appears under in transcripts.
      "aliases": ["opus-5"],
      "provider": "anthropic",
      // Integer USD MICROS per MILLION tokens. $15.00 per million input = 15000000.
      // Never floating-point dollars: money that rounds is money that disagrees with itself.
      "ratesUsdMicrosPerMillion": {
        "input": 15000000,
        "cachedRead": 1500000,
        "cacheWrite5m": 18750000,
        "cacheWrite1h": 30000000,
        "output": 75000000,
      },
      // When YOU last checked this rate against its authoritative source.
      "verifiedAt": "2026-08-01T00:00:00.000Z",
      "validFrom": "2026-08-01T00:00:00.000Z",
      // "validThrough" closes the window when you supersede this rate with a later entry.
    },
  ],
}
```

Rules the daemon enforces, and what they cost you if you ignore them:

- **A malformed catalog refuses startup.** Duplicate `pricingKey`s, two rates covering the same
  model from the same instant, or one alias claimed by two models are all rejected before the
  daemon runs. A daemon that started on an ambiguous catalog would report an amount that depended
  on catalog order.
- **`provider` decides how cache writes are billed.** For `anthropic`, set BOTH `cacheWrite5m` and
  `cacheWrite1h` — Anthropic bills the two retentions differently, so a session that wrote to cache
  is reported unpriced until both exist. For `openai`, set the single `cacheWrite` (use `0` if your
  provider does not bill cache writes).
- **Prices apply from `validFrom` onward, matched against when the session was created.** Raising a
  rate does not re-bill last month; add a new entry and close the old one with `validThrough`.
- **This is not your bill.** These rates value tokens as if they were bought per token. If the
  account is a subscription, the marginal token cost is not what you pay, and every surface says so.

## Architecture

Pure layout, validation, journal scanning, rebuild, and reconciliation decisions live in
`src/lib`. Environment, filesystem, clock, lock, SQLite, and storage orchestration live behind
injected interfaces in `src/adapters`. The package root exports the pure tier; consumers opt into
runtime adapters through `@ferretry/daemon/adapters`.
