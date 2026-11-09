/**
 * What a failed apply says it left behind. Shared by the catalogue and the setup, which both write configuration files
 * BEFORE the fleet plan, so both must name what stays written whenever the plan then fails. Pure.
 */
import { FleetApplyAfterConfigError, FleetApplyFailureError } from '../provisioning.ts';

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error);

/**
 * What a failed apply says it left behind, for EVERY way it can fail. A document of the fleet folder rides the
 * provisioner's own boundary and rolls back with the plan. A configuration file is written BEFORE the plan (the files
 * are the source of truth, and the next republish retries the plan from them) and is NOT rolled back with it, so when
 * the adapter says files landed (`FleetApplyAfterConfigError`) the sentence names them, whatever the apply then threw:
 * a rollback, a refused source, a claim it could not take. "Nothing was left half-changed" is said only when the fleet
 * was rolled back cleanly AND no configuration file landed first; a rollback that could not be verified, and a fleet
 * that committed before its history failed, already say in their own words what they left and add no such claim.
 */
export function failedApplySentence(error: unknown, landed: readonly string[] = []): string {
  const cause = error instanceof FleetApplyAfterConfigError ? error.failure : error;
  const failure = errorMessage(cause);
  const written = [...new Set([...landed, ...(error instanceof FleetApplyAfterConfigError ? error.written : [])])];
  if (written.length > 0) return `${failure}; ${configurationLanded(written)}`;
  const cleanRollback = cause instanceof FleetApplyFailureError && cause.failure.kind === 'rolled-back';
  return cleanRollback ? `${failure}; nothing was left half-changed` : failure;
}

/** What a person is told when configuration files were written before the change then failed. */
export function configurationLanded(written: readonly string[]): string {
  const named =
    written.length === 1
      ? `the configuration ${written[0]} was written first and is`
      : `the configuration files ${written.join(', ')} were written first and are`;
  return `${named} NOT rolled back with the fleet`;
}
