import { randomBytes } from 'node:crypto';
import type { CapabilityGrants } from '@ferretry/protocol';
import type { GrantAuditEntry, GrantAuditPort, GrantClock, GrantDocumentPort, UnlockTokenFactory } from '../../lib/index.ts';

/** The daemon configuration document, seen as the one thing the grant subsystem needs from it. */
export interface GrantConfigStore {
  readGrants(): Promise<CapabilityGrants>;
  writeGrants(grants: CapabilityGrants): Promise<void>;
}

/**
 * The grants, in the operator's own configuration document.
 *
 * A THIN ADAPTER over the configuration store rather than a second file, because grants are exactly
 * the kind of thing `--print-config` exists to report with provenance: an operator asking what this
 * daemon believes it may do should read the answer beside `port` and `corsOrigins`, not hunt for a
 * separate document. The verifier that gates changing them is what lives elsewhere — see
 * `FoundationPaths.operatorPassword` for why those two belong apart.
 */
export class ConfigGrantDocument implements GrantDocumentPort {
  constructor(private readonly config: GrantConfigStore) {}

  async read(): Promise<CapabilityGrants> {
    return await this.config.readGrants();
  }

  async write(grants: CapabilityGrants): Promise<void> {
    await this.config.writeGrants(grants);
  }
}

/**
 * Unlock identifiers.
 *
 * MINTED FROM REAL ENTROPY and never derived from the password, so an unlock that leaks says nothing
 * about the secret behind it. 128 bits, base64url, carrying the `fy_unlock_` prefix the protocol
 * grammar checks — a prefixed identifier is greppable in a support thread in a way an opaque blob is
 * not, and the prefix is not the secret.
 */
export class RandomUnlockTokens implements UnlockTokenFactory {
  constructor(private readonly random: (bytes: number) => Uint8Array = bytes => randomBytes(bytes)) {}

  mint(): string {
    return `fy_unlock_${Buffer.from(this.random(16)).toString('base64url')}`;
  }
}

export class SystemGrantClock implements GrantClock {
  nowMs(): number {
    return Date.now();
  }
}

/** Where one recorded grant change is written. */
export interface GrantJournalSink {
  append(line: string): Promise<void>;
}

/**
 * A grant change, journalled.
 *
 * WHY IT IS NOT OPTIONAL. Board permissions were made auditable rather than implicit for the same
 * reason: a permission model whose changes leave no trace can only ever be understood by its effects,
 * so the question "when did this machine start letting a phone apply the fleet, and who said so"
 * becomes unanswerable at exactly the moment somebody needs it answered.
 *
 * IT RECORDS THE ACTOR, NEVER A CREDENTIAL. `device:<id>` and `admin-ui` say who; a token would say
 * how, and putting that in an append-only file is how a durable log becomes a durable secret.
 */
export class JournalGrantAudit implements GrantAuditPort {
  constructor(private readonly sink: GrantJournalSink) {}

  async record(entry: GrantAuditEntry): Promise<void> {
    await this.sink.append(
      JSON.stringify({ kind: 'grant.changed', at: entry.at, actor: entry.actor, changes: entry.changes }),
    );
  }
}
