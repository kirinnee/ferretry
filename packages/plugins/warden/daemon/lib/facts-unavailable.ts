/**
 * The fleet facts cannot be read because a provider that owns them (Logins, Runtimes) is absent or failing. It is an
 * OUTAGE, not a verdict on the ferret: nothing is chosen blind, and the move is tried again on the next sweep.
 */
export class FactsUnavailableError extends Error {
  override readonly name = 'FactsUnavailableError';
}
