/** Pack (sub-ferret) requests (`pack.*`). One fragment of `DAEMON_FEATURES`; `index.ts` spreads them all. */
export const PACK_FEATURES = {
  /** `idea` on a Pack clean-up request takes up to 4,000 characters (an older daemon refuses past 500). */
  packIdea4000: 'pack.idea.4000',
} as const;
