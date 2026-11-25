import { daemonTitle } from '../daemons/daemon-list.ts';
import { UPDATE_DAEMON_COMMAND } from '../client/sentences.ts';
import type { ShellRuntime } from './runtime.ts';

/**
 * EVERY "THIS BROWSER CANNOT USE THIS MACHINE AT ALL" END STATE, as ONE full-page screen instead of a line over an empty
 * shell. The shell asks {@link stopOf} about the machine a route is on; when it answers, the frame leaves its chrome and draws
 * {@link describeStop}'s words on one page (`machine-stop-page.tsx`). Pure: the words live here so they can be proved without
 * a browser, and no state of the machine is read except through the runtime's own answers.
 *
 * Nothing here is a verdict about a plugin: a single plugin that is off, missing or of another build keeps its own line in its
 * own screen (`blockedLine`); this is only for the states where NO screen of the machine can work.
 */

export type StopKind =
  /** The machine closed a session with `4403`: this browser was removed, or went unused for too long. */
  | 'refused'
  /** The machine answered the plugin list with a `401`/`403`: it knows this browser and will not serve it. */
  | 'turned-away'
  /** The browser holds a pairing but cannot open any session (no key kept for it, or no carrier). */
  | 'no-key'
  /** The plugin list could not be read, or was not a plugin list. */
  | 'unreadable'
  /** The app is newer than the machine (protocol or a core piece differs): the machine needs `fy update`. */
  | 'needs-update'
  /** The machine is newer than the app (or the same version, a different build): reloading gets the new app. */
  | 'needs-reload'
  /** The address names a machine this browser holds no pairing for. */
  | 'not-paired';

/** What the page's one main button does. */
type StopAction = 'pair-again' | 'reload' | 'pair-new';

export interface StopFacts {
  readonly kind: StopKind;
  /** The machine's name as this browser knows it; `undefined` for a machine it holds no pairing for. */
  readonly machine: string | undefined;
  /** The machine's own sentence, for `turned-away` (never a body). */
  readonly reason?: string;
  /** Which core piece or why the read failed, for the reference line (names and ids only). */
  readonly detail?: string;
  /** The status the machine answered, for `turned-away`. */
  readonly status?: number;
}

export interface MachineStop {
  readonly kind: StopKind;
  /** Plain words, no error code. */
  readonly headline: string;
  /** One or two sentences of why, and what repairs it. */
  readonly why: string;
  /** The command a person runs on the machine, when the repair is one. */
  readonly command?: string;
  readonly primary: { readonly action: StopAction; readonly label: string };
  /** A small line for a person helping: the code or the piece, never in the headline. */
  readonly reference: string;
}

const the = (machine: string | undefined): string => machine ?? 'that machine';

/** The page's words for one end state. Total: every kind has them. */
export function describeStop(facts: StopFacts): MachineStop {
  const name = the(facts.machine);
  switch (facts.kind) {
    case 'refused':
      return {
        kind: 'refused',
        headline: `This browser isn't connected to ${name} any more`,
        why: `This browser was removed from ${name}, or it went unused for too long. Pair it again to keep using ${name}.`,
        primary: { action: 'pair-again', label: 'Pair again' },
        reference: 'Reference: the machine ended the session as not accepted (4403).',
      };
    case 'turned-away': {
      const said =
        facts.reason === undefined || facts.reason === ''
          ? 'It did not say why.'
          : `It said: ${facts.reason.replace(/[.\s]+$/u, '')}.`;
      return {
        kind: 'turned-away',
        headline: `This browser was turned away by ${name}`,
        why: `${said} Pairing this browser again usually fixes it.`,
        primary: { action: 'pair-again', label: 'Pair again' },
        reference: `Reference: the machine answered ${facts.status ?? 403} to the plugin list.`,
      };
    }
    case 'no-key':
      return {
        kind: 'no-key',
        headline: `This browser can't reach ${name}`,
        why: `It has no saved key for ${name} here, which happens when this browser's site data was cleared. Pair it again.`,
        primary: { action: 'pair-again', label: 'Pair again' },
        reference: 'Reference: no session could be opened for this pairing.',
      };
    case 'unreadable':
      return {
        kind: 'unreadable',
        headline: `Can't read what ${name} offers right now`,
        why: `The app keeps trying on its own. Check that ${name} is running and reachable, or reload.`,
        primary: { action: 'reload', label: 'Reload' },
        reference: `Reference: ${facts.detail ?? 'the plugin list could not be read'}.`,
      };
    case 'needs-update':
      return {
        kind: 'needs-update',
        headline: `Update ${name} to keep using it`,
        why: `This app is newer than ${name}. Run the command below on that machine, then reload here.`,
        command: UPDATE_DAEMON_COMMAND,
        primary: { action: 'reload', label: 'Reload' },
        reference: facts.detail === undefined ? 'Reference: versions differ.' : `Reference: ${facts.detail}.`,
      };
    case 'needs-reload':
      return {
        kind: 'needs-reload',
        headline: `This app needs a reload to use ${name}`,
        why: 'That machine is newer than this app. Reloading gets the new one.',
        primary: { action: 'reload', label: 'Reload' },
        reference: facts.detail === undefined ? 'Reference: versions differ.' : `Reference: ${facts.detail}.`,
      };
    case 'not-paired':
      return {
        kind: 'not-paired',
        headline: `This browser isn't paired with ${name}`,
        why: 'The pairing was forgotten here, or this link is old. Pair this browser with a machine to continue.',
        primary: { action: 'pair-new', label: 'Pair a machine' },
        reference: 'Reference: no pairing for this address.',
      };
  }
}

/**
 * Which end state (if any) the machine at `daemon` is in right now. `undefined` means the machine's pages may draw: it is
 * connecting, connected and read, or a plugin alone is blocked. Opens a connection on the first ask, like every other read of
 * the runtime.
 */
export function stopOf(runtime: ShellRuntime, daemon: string): StopFacts | undefined {
  const paired = runtime.daemons.get(daemon);
  if (paired === undefined) return { kind: 'not-paired', machine: undefined };
  const machine = daemonTitle(paired);
  if (runtime.isRefused(daemon)) return { kind: 'refused', machine };
  const connection = runtime.connection(daemon);
  if (connection.kind === 'unreachable') return { kind: 'no-key', machine };
  if (connection.kind !== 'connected') return undefined;
  if (runtime.wholeDaemonLine(daemon) === undefined) return undefined;
  const inventory = connection.client.inventory;
  const detail = runtime.wholeDaemonDetail(daemon);
  const withDetail = detail === undefined ? {} : { detail };
  if (inventory?.kind === 'unreadable') {
    const refusal = inventory.refusal;
    return refusal === undefined
      ? { kind: 'unreadable', machine, ...withDetail }
      : {
          kind: 'turned-away',
          machine,
          status: refusal.status,
          ...(refusal.reason === undefined ? {} : { reason: refusal.reason }),
        };
  }
  return { kind: runtime.remedy(daemon) === 'update-daemon' ? 'needs-update' : 'needs-reload', machine, ...withDetail };
}
