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
}

/** No session is a sub-ferret: every caller is a lead. The default for a service built without a directory. */
export const NO_SUB_FERRETS: SubFerretDirectory = {
  leadOf: async () => undefined,
  addressOf: async sessionId => sessionId,
};

/** The sentence a refused sub-ferret reads: what it may not do, and the command that reaches who may. */
const subFerretRefusalMessage = (doing: string, leadAddress: string): string =>
  `Sub-ferrets don't ${doing}; tell your lead: fy send ${leadAddress} "…"`;

/**
 * The refusal for `sessionId` doing `doing`, or `null` when it is a lead (or nobody the daemon knows has
 * started it). A directory that cannot answer refuses nothing: the limit narrows a ferret that is known to
 * be a sub-ferret, it never locks out one it cannot place.
 */
export const subFerretRefusal = async (
  directory: SubFerretDirectory,
  sessionId: string,
  doing: string,
): Promise<string | null> => {
  const lead = await directory.leadOf(sessionId).catch(() => undefined);
  if (lead === undefined) return null;
  const address = await directory.addressOf(lead).catch(() => lead);
  return subFerretRefusalMessage(doing, address);
};

/** Whether `sessionId` was started by another session. */
export const isSubFerret = async (directory: SubFerretDirectory, sessionId: string): Promise<boolean> =>
  (await directory.leadOf(sessionId).catch(() => undefined)) !== undefined;

/** The session registry as the directory reads it: `config.parent` is the lead, `config.teammate` the callsign. */
export interface SessionConfigReader {
  get(
    sessionId: string,
  ): Promise<{ readonly config: { readonly parent?: string; readonly teammate?: string } } | undefined>;
}

/** The directory over the session registry, so the lineage fact has one owner: the session's own configuration. */
export const sessionSubFerretDirectory = (sessions: SessionConfigReader): SubFerretDirectory => ({
  leadOf: async sessionId => {
    const parent = (await sessions.get(sessionId))?.config.parent;
    return parent === undefined || parent === '' ? undefined : parent;
  },
  addressOf: async sessionId => (await sessions.get(sessionId))?.config.teammate || sessionId,
});

/**
 * Who a board nudge about `sessionId`'s card is typed to: its lead when it is a sub-ferret (the lead moves the
 * card and decides what the sub-ferret does next), else the session itself.
 */
export const nudgeTarget = async (directory: SubFerretDirectory, sessionId: string): Promise<string> =>
  (await directory.leadOf(sessionId).catch(() => undefined)) ?? sessionId;
