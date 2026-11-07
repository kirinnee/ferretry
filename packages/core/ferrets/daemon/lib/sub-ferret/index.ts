/** Lineage queries over a ferret directory. Authority comes from the server-held registry. */
/** The two facts the limits rest on. */
export interface SubFerretDirectory {
  /** The session that started this one (`config.parent`); `undefined` for a lead or an unknown session. */
  leadOf(sessionId: string): Promise<string | undefined>;
  /** What `fy send` takes to reach a session: its callsign when it has one, else its id. */
  addressOf(sessionId: string): Promise<string>;
}

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
