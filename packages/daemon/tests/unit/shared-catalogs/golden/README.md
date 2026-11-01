# Golden answers of the version 1 daemon

`v1-state.json` is a catalogs store as the version 1 daemon left it (the `catalogs.json` text and the frozen files
by digest). `main-output.json` is what origin/main's version 1 `SharedCatalogService` answered for that store:
`exportCatalog` and `signedManifest` for each catalog, and `list()` and `list({ sourceState: true })`.

They were made once, by the version 1 code at commit `888b96621`, with the fixed identity `newIdentity()` in
`../support.ts` (an Ed25519 signature is deterministic, so the bytes do not change), by running that service in a
checkout of that commit against the store in `v1-state.json`, with the fixture servers and skill folder that
`install()` in `../legacy.ts` sets up. Nothing in this folder is produced by the current code. A test in
`migration.test.ts` checks that `legacyState()` still builds exactly `v1-state.json`.
