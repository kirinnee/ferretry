/**
 * WHERE THE SETUP FLOW IS and the two words its address carries: `phase` (which half to start in) and `journey` (which
 * client steps a machine's flow asks). Plain values, so the daemon-less first run (O5), the Home card, the steps opener
 * and the redirect all build the same address.
 */
import { daemonHomeHref } from '@ferretry/app';
import type { Journey, Phase } from '../../lib/index.ts';

export interface FlowAddress {
  readonly phase?: Phase;
  readonly journey?: Journey;
}

const PHASES: readonly Phase[] = ['daemon', 'client'];
const JOURNEYS: readonly Journey[] = ['first-time', 'pair', 'add-daemon'];

/** `/d/<machine>/onboarding/setup`, with `?phase=…&journey=…` only for the words that were given. */
export const setupFlowHref = (daemon: string, address: FlowAddress = {}): string => {
  const query = new URLSearchParams();
  if (address.phase !== undefined) query.set('phase', address.phase);
  if (address.journey !== undefined) query.set('journey', address.journey);
  const text = query.toString();
  return `${daemonHomeHref(daemon)}/onboarding/setup${text === '' ? '' : `?${text}`}`;
};

/**
 * The journey and phase an address asks for. Pair starts in the client phase; anything else starts with the machine.
 * An unknown or missing word is the default, never an error.
 */
export function readFlowAddress(search: string): { readonly phase: Phase; readonly journey: Journey } {
  const query = new URLSearchParams(search);
  const phase = PHASES.find(candidate => candidate === query.get('phase')) ?? 'daemon';
  const asked = JOURNEYS.find(candidate => candidate === query.get('journey'));
  return { phase, journey: asked ?? (phase === 'client' ? 'pair' : 'first-time') };
}
