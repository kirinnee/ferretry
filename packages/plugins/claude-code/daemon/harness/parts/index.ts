/**
 * The registry of the Claude harness's parts: ONE line per part, sorted by name, nothing else in this file. To add a
 * part, add its file here and one line `export * as <name> from './<file>.ts';` in its sorted place; the file must export
 * `<name>Part`. `list.ts` builds the ordered list from this namespace, so the line order carries no meaning (it sorts by
 * name), and two parts added at once merge without a conflict.
 */
export * as deliver from './deliver.ts';
export * as dialogs from './dialogs.ts';
export * as history from './history.ts';
export * as home from './home.ts';
export * as identity from './identity.ts';
export * as launchSettings from './launch-settings.ts';
export * as lifecycle from './lifecycle.ts';
export * as runtimeSwitch from './runtime-switch.ts';
export * as transcript from './transcript.ts';
export * as usage from './usage.ts';
