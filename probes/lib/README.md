# Shared probe authoring helpers

Self-verification probe definitions: each probe proves a repo mechanism works by running it in a
sandboxed checkout (`baseline`), and — for `gate` probes — by sabotaging the tree and asserting
the mechanism turns red (`mutation`).

- `defineGate` emits exactly one healthy baseline and one meaningful mutation.
- `defineSmoke` emits a healthy baseline only.
- `definePresence` emits an exists/parses check only.

`contracts.ts` holds the local type surface (adapted from diene's `@cyanprint/contracts` — this
repo has no cyanprint runner; probes are executable documentation for any harness that provides
a `ProbeRepo`). `probes/features.json` is the class ledger: one entry per probe definition.
