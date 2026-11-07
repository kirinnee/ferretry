/**
 * Where a Machines page is, as a linkable address (docs/design/account-model.md §4.2, O1): the Settings page's hash,
 * `#machines/<machine>/<tab>[/<item>]`.
 *
 * Runtimes draws its own tabs (`runtimes`, `profiles`) and links to the ones other plugins draw (`sign-ins`,
 * `machine`); the id is the word in the link, so a link a person copies reads as the page they were looking at.
 */

/** The tabs this half names in a link. */
export type MachineTabId = 'runtimes' | 'agents' | 'sign-ins' | 'profiles' | 'browser' | 'machine';

/** The Settings section id that owns the Machines pages, and the first word of its hash. */
export const MACHINES_SECTION = 'machines';

/** The hash for one machine's tab. */
export const machineHash = (machine: string, tab: MachineTabId): string =>
  `#${MACHINES_SECTION}/${encodeURIComponent(machine)}/${tab}`;
