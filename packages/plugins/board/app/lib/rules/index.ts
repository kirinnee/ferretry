/**
 * The board's pure rules and wire views, as the app reads them. Vendored from today's `protocol/src/lib/board*.ts`
 * with the words renamed (task -> card, phase -> lane, status -> progress, session -> ferret). The app imports from
 * here only, so when the Board contract carries the same strict schemas and rules this folder is replaced by imports
 * of `../../contract/index.ts` and nothing above it changes.
 */
export * from './board-history.ts';
export * from './board-lanes.ts';
export * from './board-projects.ts';
export * from './board-refs.ts';
export * from './board.ts';
export * from './tasks.ts';
