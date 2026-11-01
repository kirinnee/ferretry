import type { SessionId } from '../../session-id.ts';
import {
  SESSION_BOARD_CAPABILITY_VARIABLE,
  type SessionCapabilityHashStore,
  type SessionCredentialIssuer,
  SessionCredentialRevokedError,
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
    // A session a person cut off is handed no credential by ANY launch until a person resumes it: this is the one
    // place every launch path passes through, so a Warden revive, a peer's resume, a restart and a migration all
    // fail closed here rather than each needing its own check.
    if ((await this.ports.hashes.isCutOff?.(id)) === true) throw new SessionCredentialRevokedError(id);
    const credential = this.ports.credentials.issue();
    const stored = await this.ports.environment.read(id);
    await this.ports.environment.write(id, { ...stored, [SESSION_BOARD_CAPABILITY_VARIABLE]: credential.capability });
    await this.ports.hashes.record(id, credential.hash);
    return credential.hash;
  }

  async revoke(id: SessionId): Promise<void> {
    await this.ports.hashes.erase(id);
  }

  /**
   * The hash and the mark go first, in one write, so the value the pane holds names nobody even if anything
   * below fails. Then the plaintext leaves the stored environment: nothing re-derives a hash from it, but a
   * credential that names nobody has no reason to stay on disk either.
   */
  async cutOff(id: SessionId): Promise<void> {
    const cutOff = this.ports.hashes.cutOff;
    if (cutOff === undefined) throw new Error('this hash store cannot mark a session cut off');
    await cutOff.call(this.ports.hashes, id);
    const { [SESSION_BOARD_CAPABILITY_VARIABLE]: _revoked, ...kept } = await this.ports.environment.read(id);
    await this.ports.environment.write(id, kept);
  }

  async restore(id: SessionId): Promise<void> {
    await this.ports.hashes.restore?.(id);
  }
}
