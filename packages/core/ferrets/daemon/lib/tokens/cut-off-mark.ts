import type { Instant } from '@ferretry/std';
import type { FerretId } from '../../../contract/index.ts';
import type { SessionId } from '../session-id.ts';
import type { SessionCapabilityHashStore } from '../session/lifecycle/index.ts';
import type { FerretTokenDirectory, TokenEntry } from './tokens.ts';

/**
 * The session document's half of an owner's cut-off (`credentialRevoked`, and the erased `capabilityHash`), as Ferrets'
 * service reads and writes it. The OTHER half is the token directory's (`tokens.json`). A person cutting a ferret off
 * has ONE intention, so a cut-off is written to both and read from both: a ferret is cut off when EITHER says so.
 */
export interface SessionCutOffMark {
  isCutOff(id: string): Promise<boolean>;
  cutOff(id: string): Promise<void>;
  restore(id: string): Promise<void>;
}

/** The token directory's half, as the lifecycle's hash store reaches it: `cutOff` and `restore` also persist `tokens.json`. */
export interface TokenCutOff {
  isCutOff(id: string): Promise<boolean>;
  cutOff(id: string): Promise<void>;
  restore(id: string): Promise<void>;
}

/**
 * The lifecycle's credential-hash store with the token directory's cut-off in step.
 *
 * - `cutOff` writes the DOCUMENT first (it also erases the stored hash, so the pane's value names nobody), then the
 *   directory; one that fails leaves the other written, and a read of either refuses a launch.
 * - `isCutOff` is true when either says so, so `SessionCredentialRotation.rotate` refuses for a cut-off the service wrote.
 * - `restore` clears the document first, then the directory: a failure between them leaves the ferret cut off.
 *
 * Every other member is the inner store's, untouched.
 */
export class CoupledCapabilityHashStore implements SessionCapabilityHashStore {
  constructor(
    private readonly inner: Required<SessionCapabilityHashStore>,
    private readonly tokens: TokenCutOff,
  ) {}

  async record(id: SessionId, hash: string): Promise<void> {
    await this.inner.record(id, hash);
  }

  async erase(id: SessionId): Promise<void> {
    await this.inner.erase(id);
  }

  async cutOff(id: SessionId): Promise<void> {
    await this.inner.cutOff(id);
    await this.tokens.cutOff(id);
  }

  async isCutOff(id: SessionId): Promise<boolean> {
    return (await this.tokens.isCutOff(id)) || (await this.inner.isCutOff(id));
  }

  async restore(id: SessionId): Promise<void> {
    await this.inner.restore(id);
    await this.tokens.restore(id);
  }
}

/** What the token directory's cut-off needs: the loaded directory, its durable write, and the clock. */
export interface DirectoryCutOffPorts {
  /** Settles once the held tokens are loaded: an unloaded directory would read "not cut off". */
  ready(): Promise<void>;
  readonly tokens: FerretTokenDirectory;
  save(entries: readonly TokenEntry[]): Promise<void>;
  now(): Instant;
}

/**
 * The token directory's half of an owner's cut-off, as the lifecycle's hash store reaches it. Every write persists
 * `tokens.json`; a write that cannot be saved leaves the MEMORY on the cut-off side too (a restore rolls back, a cut-off
 * stays cut), so the process never runs less cut off than the durable file says.
 */
export class DirectoryCutOff implements TokenCutOff {
  constructor(private readonly ports: DirectoryCutOffPorts) {}

  async isCutOff(id: string): Promise<boolean> {
    await this.ports.ready();
    return this.ports.tokens.isCutOff(id as FerretId);
  }

  async cutOff(id: string): Promise<void> {
    await this.ports.ready();
    this.ports.tokens.cutOff(id as FerretId, this.ports.now());
    await this.ports.save(this.ports.tokens.snapshot());
  }

  async restore(id: string): Promise<void> {
    await this.ports.ready();
    this.ports.tokens.restore(id as FerretId);
    try {
      await this.ports.save(this.ports.tokens.snapshot());
    } catch (error) {
      this.ports.tokens.cutOff(id as FerretId, this.ports.now());
      throw error;
    }
  }
}
