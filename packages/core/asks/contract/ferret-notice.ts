/**
 * The only words a FERRET reads of a Warden notice on an Asks board: three fixed sentences. They live in the contract
 * so the two programs that must agree on them hold ONE copy: Asks says them when a ferret reads a Warden-sourced item
 * (`daemon/lib/routes/ferret-reads.ts`), and the Warden says the same ones in its own ferret views
 * (`warden/daemon/lib/ferret-sentences.ts`). Nothing a model wrote is among them.
 */
export const FERRET_NOTICE_SENTENCES = {
  subject: 'The Warden has a flag on your work.',
  why: 'The Warden asked the owner to look at this. The Warden’s reasons are the owner’s to read.',
  howToResolve: 'Nothing to answer here: the owner decides. Carry on with your work.',
} as const;
