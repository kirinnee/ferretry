# Recorded answers for a fixed catalogs store

`v3-state.json` is a version 3 catalogs store: the `document` that `catalogs.json` holds and the shared copies
(`blobs`, digest → canonical text) beside it. `main-output.json` is what a known-good build's `SharedCatalogService`
answered for that store: `exportCatalog` and `signedManifest` for each catalog, and `list()` and
`list({ sourceState: true })`.

Neither file is produced by the current code. `main-output.json` was recorded once from the version 1 daemon (commit
`888b96621`) with the fixed identity `newIdentity()` in `../support.ts` (an Ed25519 signature is deterministic, so the
bytes do not change). `v3-state.json` is that same store written once in the version 3 shape, so the answers can be
held to it without keeping a reader for the old shape: the version 1 store the answers were recorded from was run once
through that build's upgrade, and the result committed. `golden.test.ts` installs it under a rig and checks every
export, manifest and list against `main-output.json` byte for byte. If the service ever answers differently, the
answer changed; do not regenerate these files to make the test pass.
