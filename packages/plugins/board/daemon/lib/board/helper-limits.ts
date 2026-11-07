/**
 * WHAT A HELPER MAY NOT DO (docs/pack-mode.md § Helper limits).
 *
 * A **helper** is a ferret another ferret started (`FerretSummary.parent`); a **lead** has none. Leads raise the owner's
 * asks and move the board's cards; a helper reports to its lead with `fy send` and only adds notes and PR/branch links to
 * its own card. The daemon refuses the rest by the caller's ferret identity, so a weaker model cannot talk its way past
 * it, and every refusal says whom to tell instead.
 *
 * Pure except for the {@link HelperDirectory} it reads. The adapter maps it onto the Ferrets contract:
 * `leadOf` is `FerretsApi.get(ferret)?.parent`, `addressOf` is the ferret's callsign (`name`) when it has one, else its id.
 */

/** The two facts the limits rest on. */
export interface HelperDirectory {
  /** The ferret that started this one; `undefined` for a lead or an unknown ferret. */
  leadOf(ferret: string): Promise<string | undefined>;
  /** What `fy send` takes to reach a ferret: its callsign when it has one, else its id. */
  addressOf(ferret: string): Promise<string>;
}

/** No ferret is a helper: every caller is a lead. The default for a service built without a directory. */
export const NO_HELPERS: HelperDirectory = {
  leadOf: async () => undefined,
  addressOf: async ferret => ferret,
};

/** What a helper may still do on the board: its own card, and every card in its own subtree. */
const HELPER_MAY_ON_BOARD =
  'note on, set the progress and How to test of, and link a PR or branch to your own card, and drop or reassign cards in your own subtree';

/** The sentence a refused helper reads: what it may not do, what it MAY do instead, and the command that reaches who can do the rest. */
const helperRefusalMessage = (doing: string, may: string, leadAddress: string, claim?: string): string =>
  `You are a helper, so you can't ${doing}. You may ${may}. ${
    claim === undefined
      ? `For anything else ask your lead: fy send ${leadAddress} "…"`
      : `Your lead holds this card: claim it first: ${claim}`
  }`;

/**
 * The refusal for `ferret` doing `doing`, or `null` when it is a lead (or nobody the daemon knows has started it). A
 * directory that cannot answer refuses nothing: the limit narrows a ferret that is known to be a helper, it never locks
 * out one it cannot place. `claim` is the command that takes a card its lead holds (`fy card claim &F12`): given, the
 * refusal sends the caller there instead of to its lead.
 */
export const helperRefusal = async (
  directory: HelperDirectory,
  ferret: string,
  doing: string,
  may: string = HELPER_MAY_ON_BOARD,
  claim?: string,
): Promise<string | null> => {
  const lead = await directory.leadOf(ferret).catch(() => undefined);
  if (lead === undefined) return null;
  const address = await directory.addressOf(lead).catch(() => lead);
  return helperRefusalMessage(doing, may, address, claim);
};

/** Whether `ferret` was started by another ferret. */
export const isHelper = async (directory: HelperDirectory, ferret: string): Promise<boolean> =>
  (await directory.leadOf(ferret).catch(() => undefined)) !== undefined;

/**
 * Who a board nudge about `ferret`'s card is typed to: its lead when it is a helper (the lead moves the card and decides
 * what the helper does next), else the ferret itself.
 */
export const nudgeTarget = async (directory: HelperDirectory, ferret: string): Promise<string> =>
  (await directory.leadOf(ferret).catch(() => undefined)) ?? ferret;
