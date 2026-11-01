import type { SessionId } from '../../session-id.ts';
import {
  SESSION_BOARD_CAPABILITY_VARIABLE,
  type SessionCapabilityHashStore,
  type SessionCredentialIssuer,
  type SessionCredentialRotator,
  type SessionEnvironmentStore,
} from './types.ts';

/** Everything a rotation touches: the mint, the plaintext's one home, and the hash's one home. */
export interface SessionCredentialRotationPorts {
  readonly credentials: SessionCredentialIssuer;
  /**
   * The STORED environment, never a view that adds derived switches on read: whatever is read here
   * is written straight back, and a derived value written back would stop being derived.
   */
  readonly environment: SessionEnvironmentStore;
  readonly hashes: SessionCapabilityHashStore;
}

/**
 * Gives the pane about to launch a credential no earlier pane ever held.
 *
 * THE PLAINTEXT IS DURABLE BEFORE THE HASH THAT NAMES IT, exactly as at creation: the other order
 * would let a crash publish a hash whose plaintext exists only in dead daemon memory, and the pane
 * launched next could hold nothing the daemon accepts.
 *
 * A CRASH BETWEEN THE TWO WRITES IS HEALED BY THE NEXT LAUNCH, not by this method. It leaves the new
 * plaintext beside the old hash, and no pane holds either, because a rotation always runs before the
 * pane it is for exists. Whatever launches that session next rotates again — a fresh pair, both
 * writes in order — so the torn pair is never launched and never needs adopting. Every other
 * variable the environment holds is carried over unchanged.
 */
export class SessionCredentialRotation implements SessionCredentialRotator {
  constructor(private readonly ports: SessionCredentialRotationPorts) {}

  async rotate(id: SessionId): Promise<string> {
    const credential = this.ports.credentials.issue();
    const stored = await this.ports.environment.read(id);
    await this.ports.environment.write(id, { ...stored, [SESSION_BOARD_CAPABILITY_VARIABLE]: credential.capability });
    await this.ports.hashes.record(id, credential.hash);
    return credential.hash;
  }

  async revoke(id: SessionId): Promise<void> {
    await this.ports.hashes.erase(id);
  }
}
