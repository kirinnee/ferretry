/**
 * The registry of the Codex harness's parts: ONE line per part, sorted by name, nothing else in this file. To add a
 * part, add its file here and one line `export * as <name> from './<file>.ts';` in its sorted place; the file must export
 * `<name>Part`. `list.ts` builds the ordered list from this namespace, so the line order carries no meaning (it sorts by
 * name), and two parts added at once merge without a conflict. A part owns its members (each `Harness` member lives in
 * exactly one part); `codex-harness.ts` composes them and a unit test pins member -> part.
 */
export * as conversation from './conversation.ts';
export * as credentials from './credentials.ts';
export * as deliver from './deliver.ts';
export * as discover from './discover.ts';
export * as fork from './fork.ts';
export * as history from './history.ts';
export * as home from './home.ts';
export * as identity from './identity.ts';
export * as inject from './inject.ts';
export * as launchSettings from './launch-settings.ts';
export * as lifecycle from './lifecycle.ts';
export * as runtimeSwitch from './runtime-switch.ts';
export * as startFailure from './start-failure.ts';
export * as transcript from './transcript.ts';
