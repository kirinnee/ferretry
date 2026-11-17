/** What `fy events <ferret>` and `fy stream <ferret>` need of the daemon to name the ferret they follow. */
export interface FerretLookup {
  get(reference: string): Promise<{ readonly id: string }>;
}

/** The HTTP status a refusal carried, when it carried one. */
const statusOf = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
    ? error.status
    : undefined;

/** How the transport words a stream the daemon refused (`http-transport.ts`): the one place a 404 shows through. */
const REFUSED_AS_MISSING = /HTTP 404/u;

/**
 * Follows the ferret a reference names. The journal socket knows session ids only, so a callsign (`fy events kraig`)
 * is resolved by the daemon first, the same way every other ferret verb has it resolved. A reference the daemon does
 * not know as a live ferret is handed to the socket as typed, because an archived ferret's journal is still served by
 * id; if the socket then refuses it as missing, the answer is the daemon's own "no ferret …", not a bare status.
 */
export async function followFerret<Done>(
  ferrets: FerretLookup,
  reference: string,
  follow: (ferretId: string) => Promise<Done>,
): Promise<Done> {
  let ferretId = reference;
  let unknown: Error | undefined;
  try {
    ferretId = (await ferrets.get(reference)).id;
  } catch (error) {
    if (statusOf(error) !== 404 || !(error instanceof Error)) throw error;
    unknown = error;
  }
  try {
    return await follow(ferretId);
  } catch (error) {
    if (unknown !== undefined && error instanceof Error && REFUSED_AS_MISSING.test(error.message)) throw unknown;
    throw error;
  }
}
