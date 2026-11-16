/**
 * The kinds Ferrets offers (§4.3 harness, §4.4 login, §4.6 runner): the interfaces a plugin's provide hook value
 * implements. Each has a conformance suite in `@ferretry/core-ferrets/contract/testing`. A harness never reads its
 * own sign-in files; a runner never sees a secret value (the Vault resolves `${secret:…}` into a `ChildEnvironment`).
 */
// One file per kind in `kinds/`; this re-exports the generated barrel, so a new kind edits no list here.
export * from './generated/kinds.ts';
