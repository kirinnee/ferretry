/**
 * PACK MODE, PER FERRET: whether a ferret is told it may delegate to helpers (docs/pack-mode.md),
 * `PATCH /v1/ferrets/:ferretId/pack`. Today's `SessionPackService.set` and `packSwitchNote`, unchanged in meaning.
 *
 * Absent means ON. A running ferret is never re-instructed: the change waits for its next launch, and the answer says
 * so. A restart is asked for only when the switch CHANGED on a ferret that is running.
 */

/** What the switch knows about one ferret before it is written. */
export interface PackSwitchFacts {
  /** The recorded switch; absent reads as on. */
  readonly enabled: boolean | undefined;
  readonly running: boolean;
}

export interface PackSwitchOutcome {
  readonly restartRequired: boolean;
  readonly note: string;
}

/** The answer's sentence, said as what the ferret will be told and when. */
export function packSwitchNote(enabled: boolean, changed: boolean, running: boolean): string {
  const state = enabled ? 'on' : 'off';
  if (!changed) return `Pack mode was already ${state}.`;
  return running
    ? `Pack mode is ${state}. This ferret is running, so it is told when it restarts${enabled ? '' : '; it can start no sub-ferret from now'}.`
    : `Pack mode is ${state}; this ferret is not running, so it takes effect at its next launch.`;
}

/** What setting the switch to `enabled` answers, given what was recorded before. */
export function packSwitchOutcome(facts: PackSwitchFacts, enabled: boolean): PackSwitchOutcome {
  const changed = (facts.enabled ?? true) !== enabled;
  return { restartRequired: changed && facts.running, note: packSwitchNote(enabled, changed, facts.running) };
}
