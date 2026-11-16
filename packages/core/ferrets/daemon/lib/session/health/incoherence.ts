import type { SessionHealthSettings } from './settings.ts';
import type { IncoherenceLedger, IncoherencePass, SessionHealthEvent } from './types.ts';

export const emptyIncoherenceLedger: IncoherenceLedger = { consecutive: 0 };

function found(pass: IncoherencePass): boolean {
  return (
    pass.missingFromIndex.length > 0 ||
    pass.staleRows.length > 0 ||
    pass.zombies.length > 0 ||
    pass.repaired.length > 0 ||
    pass.unhealable.length > 0
  );
}

export interface IncoherenceOutcome {
  readonly ledger: IncoherenceLedger;
  /** True when the index has resisted repair often enough that only a clean restart is left. */
  readonly escalate: boolean;
  /** Absent when the pass found nothing and had nothing to retract — silence is the healthy case. */
  readonly event: SessionHealthEvent | undefined;
}

/**
 * Folds one consistency pass into the incoherence history.
 *
 * The counter advances on what is STILL missing after repair, never on what was found: a pass that
 * discovered forty stale rows and healed all forty is a success, and counting it would restart a
 * daemon that is working exactly as designed.
 *
 * The ancestor emitted its incoherence event on every pass, including passes that found nothing, so
 * the signal that should mean "the index is broken" fired once a minute forever. Here a clean pass
 * is silent — except for the one clean pass that clears a non-zero streak, which an operator
 * watching a degrading daemon genuinely needs to see.
 */
export function recordIncoherencePass(
  ledger: IncoherenceLedger,
  pass: IncoherencePass,
  settings: SessionHealthSettings,
): IncoherenceOutcome {
  const consecutive = pass.unhealable.length > 0 ? ledger.consecutive + 1 : 0;
  const escalate = pass.unhealable.length > 0 && consecutive >= settings.incoherentRestartThreshold;
  const recovered = consecutive === 0 && ledger.consecutive > 0;
  const event: SessionHealthEvent | undefined =
    found(pass) || recovered
      ? {
          type: 'fleet.index_incoherent',
          data: {
            missingFromIndex: [...pass.missingFromIndex],
            staleRows: [...pass.staleRows],
            zombies: [...pass.zombies],
            // Only a repair the verification pass confirms is reported as one.
            repaired: pass.repaired.filter(id => !pass.unhealable.includes(id)),
            unhealable: [...pass.unhealable],
            consecutive,
            recovered,
          },
        }
      : undefined;
  return { ledger: { consecutive }, escalate, event };
}
