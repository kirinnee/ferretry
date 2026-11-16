/**
 * The fleet as lineage resolution may consult it: id, label, parent, stamp, and nothing else.
 *
 * Snapshotted per spawn rather than held, because descent is decided against the fleet as it is at that moment: a
 * cached map would let a session resolve against an ancestor that has since been pruned, or miss one that has since
 * appeared, and both answers outlive the request that made them.
 */

import { SessionConfigSchema } from '../../../lib/protocol/session.ts';
import { tryParseSessionId } from '../../../lib/session-id.ts';
import type { SessionAncestry } from '../../../lib/session/provenance/recorder.ts';
import type { SessionAncestor } from '../../../lib/session/provenance/types.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

/** A fleet member as the registry knows it: what it was ASKED to be, without any stamp. */
export type RegisteredAncestor = Omit<SessionAncestor, 'provenance'>;

export class StorageSessionAncestry implements SessionAncestry {
  constructor(
    private readonly storage: Pick<DaemonStorage, 'listSessions' | 'readConfig'>,
    /** The registry's fleet. Consulted for a member's label and parent only when it has no session document. */
    private readonly registered: () => readonly RegisteredAncestor[],
  ) {}

  /**
   * A FAILED READ IS NOT AN EMPTY FLEET, and the difference is the whole shield.
   *
   * Every member is read STRICTLY: the storage index and the registry together name the set, and each member's
   * session document then either proves its label, parent and stamp, or the snapshot throws. A document that cannot
   * be read, or is there and fails `SessionConfigSchema`, throws; so does an indexed session whose document has
   * vanished by that read. Damage to a parent must never become the false fact that the parent carries no stamp, or
   * that it is not labelled `warden`.
   *
   * So the failure propagates, and both callers fail SAFE without either of them deciding to: a start's stamp raises
   * and the start is refused, and a resume's recorder raises before it writes, so the stored stamp stays as it was.
   *
   * A registered ferret with NO document yet is an ancestor with no stamp, its label and parent taken from the
   * registry: nothing in this build writes that document for a ferret Ferrets' own service starts (GAP(provenance)).
   * The label and parent of a member WITH a document are the document's, never the registry's, because the stamper
   * writes the forced `warden` label into the document and nowhere else.
   */
  async snapshot(): Promise<ReadonlyMap<string, SessionAncestor>> {
    const registered = new Map(this.registered().map(ancestor => [ancestor.id, ancestor]));
    const indexed = new Set<string>(this.storage.listSessions().map(session => session.id));
    const members = await Promise.all(
      [...new Set([...registered.keys(), ...indexed])].map(
        async id => await this.member(id, registered.get(id), indexed.has(id)),
      ),
    );
    return new Map(members.map(member => [member.id, member]));
  }

  private async member(
    id: string,
    registered: RegisteredAncestor | undefined,
    indexed: boolean,
  ): Promise<SessionAncestor> {
    const sessionId = tryParseSessionId(id);
    // No catch: an unreadable document is a failed snapshot.
    const document = sessionId === undefined ? undefined : await this.storage.readConfig(sessionId);
    if (document === undefined) {
      if (indexed || registered === undefined)
        throw new Error(`indexed session ${id} disappeared while its spawn ancestry was being read`);
      return registered;
    }
    const parsed = SessionConfigSchema.safeParse(document);
    // Named by id only: the document is not quoted, and neither is the schema's account of it.
    if (!parsed.success)
      throw new Error(`session ${id}'s configuration is damaged, so its spawn ancestry cannot be proved`);
    return {
      id,
      ...(parsed.data.label === undefined ? {} : { label: parsed.data.label }),
      ...(parsed.data.parent === undefined ? {} : { parent: parsed.data.parent }),
      ...(parsed.data.provenance === undefined ? {} : { provenance: parsed.data.provenance }),
    };
  }
}
