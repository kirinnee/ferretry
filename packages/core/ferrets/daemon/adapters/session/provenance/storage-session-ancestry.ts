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

/**
 * The snapshot's map: a member whose document could not be proved is NOT in it and is not an empty answer either —
 * asking for it throws, so only a start that actually walks through that member is refused.
 */
class AncestryMap extends Map<string, SessionAncestor> {
  constructor(
    members: Iterable<readonly [string, SessionAncestor]>,
    private readonly unproven: ReadonlyMap<string, string>,
  ) {
    super(members);
  }

  override get(id: string): SessionAncestor | undefined {
    const why = this.unproven.get(id);
    if (why !== undefined) throw new Error(why);
    return super.get(id);
  }
}

export class StorageSessionAncestry implements SessionAncestry {
  private readonly told = new Set<string>();

  constructor(
    private readonly storage: Pick<DaemonStorage, 'listSessions' | 'readConfig'>,
    /** The registry's fleet. Consulted for a member's label and parent only when it has no session document. */
    private readonly registered: () => readonly RegisteredAncestor[],
    /** Says one unprovable member, once per member for this daemon's life: the log line of a skipped session. */
    private readonly report: (id: string, reason: string) => void = () => {},
  ) {}

  /**
   * A FAILED READ IS NOT AN EMPTY FLEET, and the difference is the whole shield, but it is DRAWN AROUND THE MEMBER.
   *
   * Every member is read STRICTLY: the storage index and the registry together name the set, and each member's
   * session document either proves its label, parent and stamp, or that member is UNPROVEN. Damage to a parent must
   * never become the false fact that the parent carries no stamp, or that it is not labelled `warden`; so asking the
   * snapshot for an unproven member THROWS, and a start or resume whose walk reaches one is refused (a start's stamp
   * raises; a resume's recorder raises before it writes, so the stored stamp stays as it was).
   *
   * One damaged session elsewhere in the fleet is not on any walk and must not stop every other ferret from starting
   * (2026-11-24: one unreadable indexed session refused EVERY start). It is skipped, and said once in the log.
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
    const proven: Array<readonly [string, SessionAncestor]> = [];
    const unproven = new Map<string, string>();
    for (const member of members) {
      if ('unproven' in member) {
        unproven.set(member.id, member.unproven);
        if (!this.told.has(member.id)) {
          this.told.add(member.id);
          this.report(member.id, member.unproven);
        }
      } else proven.push([member.id, member]);
    }
    return new AncestryMap(proven, unproven);
  }

  private async member(
    id: string,
    registered: RegisteredAncestor | undefined,
    indexed: boolean,
  ): Promise<SessionAncestor | { readonly id: string; readonly unproven: string }> {
    const sessionId = tryParseSessionId(id);
    let document: Awaited<ReturnType<DaemonStorage['readConfig']>>;
    try {
      document = sessionId === undefined ? undefined : await this.storage.readConfig(sessionId);
    } catch {
      // Named by id only: the failure's own text may carry a path or a fragment of the document.
      return {
        id,
        unproven: `session ${id}'s configuration could not be read, so its spawn ancestry cannot be proved`,
      };
    }
    if (document === undefined) {
      if (indexed || registered === undefined)
        return { id, unproven: `indexed session ${id} disappeared while its spawn ancestry was being read` };
      return registered;
    }
    const parsed = SessionConfigSchema.safeParse(document);
    // Named by id only: the document is not quoted, and neither is the schema's account of it.
    if (!parsed.success)
      return { id, unproven: `session ${id}'s configuration is damaged, so its spawn ancestry cannot be proved` };
    return {
      id,
      ...(parsed.data.label === undefined ? {} : { label: parsed.data.label }),
      ...(parsed.data.parent === undefined ? {} : { parent: parsed.data.parent }),
      ...(parsed.data.provenance === undefined ? {} : { provenance: parsed.data.provenance }),
    };
  }
}
