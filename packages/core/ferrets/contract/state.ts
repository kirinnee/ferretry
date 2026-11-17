/** Ferrets' declared files (§9.2). Every JSON document has `format: 1` first. */
// One file per state area in `state/`; this re-exports the generated barrel, so a new state file edits no list here.
export * from './generated/state.ts';
