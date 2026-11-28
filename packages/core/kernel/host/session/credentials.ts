/** Credential helpers extracted unchanged from layer.ts to keep the state machine within its size limit. */
import type { SessionId } from '../../contract/ids.ts';
import type { ModeHolder, ModeProof, SessionMode, SessionPrincipal } from '../../contract/session.ts';
import { instantFromEpochMs } from '@ferretry/std';

export async function askHolder(mode: SessionMode | undefined, proof: ModeProof): Promise<ModeHolder | undefined> {
  if (mode?.holder === undefined) return undefined;
  try {
    return await mode.holder(proof);
  } catch {
    return undefined;
  }
}

export function instant(ms: number): SessionPrincipal['leaseUntil'] {
  return instantFromEpochMs(ms);
}

/**
 * A session's name: its transcript hash, hex. Unique per session and public to both ends, so it names one
 * without being a secret. It is the {@link SessionId} a principal carries.
 */
export function transcriptKey(transcript: Uint8Array): string {
  return [...transcript].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
