# daemon

The per-host Ferretry daemon. This package owns the durable state-home foundation; later units add
the API and runtime subsystems on top of it.

## State-home layout

`FY_HOME` selects the root. If it is unset, the daemon resolves `.ferretry` below the injected user
home. Overrides must be non-empty absolute paths; filesystem roots and `~`-prefixed literals are
refused.

```text
$FY_HOME/
├── layout-version
├── daemon.lock
├── config/
│   └── daemon.json                 # reserved daemon configuration
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

## Architecture

Pure layout, validation, journal scanning, rebuild, and reconciliation decisions live in
`src/lib`. Environment, filesystem, clock, lock, SQLite, and storage orchestration live behind
injected interfaces in `src/adapters`. The package root exports the pure tier; consumers opt into
runtime adapters through `@ferretry/daemon/adapters`.
