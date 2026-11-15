/**
 * WHAT THE FIRST RUN KNOWS ABOUT THE HOSTED RELAY, AND WHERE IT LEARNS IT.
 *
 * Connections owns the discovery (the advertisement read, its validation, its four answers); Onboarding is TOLD the
 * answer through the shell's daemon-less ports (`DaemonlessPorts.hostedRelay`) and reads no directory, validates no
 * endpoint and opens no connection of its own. The type is the shell's, so Onboarding imports nothing of Connections.
 */
import type { HostedRelayState } from '@ferretry/app';

export type HostedRelayFallback = HostedRelayState;

/** The answer before the read has settled: the only state this module invents. */
export const CHECKING_HOSTED_RELAY: HostedRelayFallback = Object.freeze({ kind: 'checking' });

/**
 * The read, settled: the shell's answer, or `undetermined` when asking it threw — never left at `checking` (the note
 * would say "checking" forever) and never turned into `disabled` (which claims the operator switched the relay off).
 */
export const settleHostedRelay = async (read: () => Promise<HostedRelayFallback>): Promise<HostedRelayFallback> => {
  try {
    return await read();
  } catch {
    return { kind: 'undetermined', reason: 'the hosted relay advertisement could not be read' };
  }
};
