/**
 * WHAT A SUB-FERRET MAY NOT DO (docs/pack-mode.md § Sub-ferret limits).
 *
 * A **sub-ferret** is a session another session started (`config.parent`); a **lead** has none. Leads raise
 * the owner's agenda items and move the board's cards; a sub-ferret reports to its lead with `fy send` and
 * only adds notes and PR/branch links to its own card. The daemon refuses the rest by the caller's session
 * identity, so a weaker model cannot talk its way past it, and every refusal says whom to tell instead.
 *
 * Pure except for the {@link SubFerretDirectory} it reads: the agenda service, the board service and the
 * lane route each ask the same question here, so the three cannot disagree about who is a sub-ferret.
 */

/** The two facts the limits rest on. */
export interface SubFerretDirectory {
  /** The session that started this one (`config.parent`); `undefined` for a lead or an unknown session. */
  leadOf(sessionId: string): Promise<string | undefined>;
  /** What `fy send` takes to reach a session: its callsign when it has one, else its id. */
  addressOf(sessionId: string): Promise<string>;
  /**
   * Whether this session's lineage could be read at all. Optional: absent, a lineage that cannot be read is taken as a
   * lead (the board's rule). A directory that says `false` makes {@link subFerretRefusal} REFUSE, because an agenda
   * raise from a ferret that cannot be placed must not land on the owner's agenda (docs/pack-mode.md).
   */
  readable?(sessionId: string): Promise<boolean>;
}

/** No session is a sub-ferret: every caller is a lead. The default for a service built without a directory. */
export const NO_SUB_FERRETS: SubFerretDirectory = {
  leadOf: async () => undefined,
  addressOf: async sessionId => sessionId,
};

/** What a sub-ferret may still do on the board: its own card, and every card in its own subtree. */
const SUB_FERRET_MAY_ON_BOARD =
  'note on, set the status and How to test of, and link a PR or branch to your own card, and drop or reassign cards in your own subtree';

/** What a sub-ferret may still do on the agenda: read it and report to its lead. */
export const SUB_FERRET_MAY_ON_AGENDA = 'read the agenda and report to your lead';

/**
 * The sentence a refused sub-ferret reads: what it may not do, what it MAY do instead, and the command that reaches
 * who can do the rest. It speaks to the caller, never of "sub-ferrets" at large: a sub-ferret that leads a subtree of
 * its own is told what its subtree allows.
 */
const subFerretRefusalMessage = (doing: string, may: string, leadAddress: string, claim?: string): string =>
  `You are a sub-ferret, so you can't ${doing}. You may ${may}. ${
    claim === undefined
      ? `For anything else ask your lead: fy send ${leadAddress} "…"`
      : `Your lead holds this card: claim it first: ${claim}`
  }`;

/**
 * The refusal for `sessionId` doing `doing`, or `null` when it is a lead (or nobody the daemon knows has
 * started it). A directory that cannot answer refuses nothing: the limit narrows a ferret that is known to
 * be a sub-ferret, it never locks out one it cannot place. `claim` is the command that takes a card its lead holds
 * (`fy task claim &F12`): given, the refusal sends the caller there instead of to its lead.
 */
export const subFerretRefusal = async (
  directory: SubFerretDirectory,
  sessionId: string,
  doing: string,
  may: string = SUB_FERRET_MAY_ON_BOARD,
  claim?: string,
): Promise<string | null> => {
  if (directory.readable !== undefined && !(await directory.readable(sessionId).catch(() => false)))
    return `You can't ${doing} just now: who started you cannot be read, so the daemon cannot tell whether you are a lead. Try again shortly, or ask the owner.`;
  const lead = await directory.leadOf(sessionId).catch(() => undefined);
  if (lead === undefined) return null;
  const address = await directory.addressOf(lead).catch(() => lead);
  return subFerretRefusalMessage(doing, may, address, claim);
};

/** Whether `sessionId` was started by another session. */
export const isSubFerret = async (directory: SubFerretDirectory, sessionId: string): Promise<boolean> =>
  (await directory.leadOf(sessionId).catch(() => undefined)) !== undefined;

/** Deepest lineage the ancestor walk follows; a longer chain is treated as not an ancestor. */
const MAX_LINEAGE_DEPTH = 16;

/**
 * Whether `ancestorId` started `sessionId`, directly or through a chain of leads. Fails closed: a directory
 * that cannot answer, a cycle, or a chain past {@link MAX_LINEAGE_DEPTH} is "no", because this widens authority.
 */
export const isAncestorOf = async (
  directory: SubFerretDirectory,
  ancestorId: string,
  sessionId: string,
): Promise<boolean> => {
  const seen = new Set<string>([sessionId]);
  let current = sessionId;
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
    let lead: string | undefined;
    try {
      lead = await directory.leadOf(current);
    } catch {
      return false;
    }
    if (lead === undefined || seen.has(lead)) return false;
    if (lead === ancestorId) return true;
    seen.add(lead);
    current = lead;
  }
  return false;
};
