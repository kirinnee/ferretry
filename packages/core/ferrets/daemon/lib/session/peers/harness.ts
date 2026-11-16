/**
 * PEER: today's `packages/daemon/src/lib/session/harness/{quarantine,runtime-switch,picker-screen,picker-drive,
 * model-catalog,fast-mode,service,codex-catalog-cache}.ts` (owners: claude-code+codex) — the part the runtime-control
 * service reads.
 *
 * Ferrets is core and cannot import a plugin's code (§2.1). The shapes a harness plugin provides are the contract's
 * (`contract/kinds/runtime-switch.ts`, reached through `Harness.runtimeSwitch`) and are re-exported here by the names
 * the session code was written against; what stays here is what only the service reads.
 */
import type { RuntimeModelCatalog, RuntimeModelChoice, SessionView } from '../../protocol/session.ts';
import type {
  CodexModelCatalog,
  CodexModelPickerDriver,
  CodexPickerDrivePort,
  FastModeFacts,
  PickerSleeper,
  RuntimeSwitchAccount,
} from '../../../../contract/kinds/runtime-switch.ts';
import type { CoreAccount } from './core.ts';

export type {
  CodexPickerDrivePort,
  CodexRuntimeCatalogCache,
  HarnessQuirkService,
  HarnessRuntimeSwitchContext,
  HarnessRuntimeSwitchRequest,
  PickerSleeper,
  RuntimeSwitchPlan,
} from '../../../../contract/kinds/runtime-switch.ts';

// --- harness/quarantine.ts --------------------------------------------------------------------------------------

/** Marks the durable quarantine so input gates can recognise this specific cause
 *  and refuse with an instruction that fits it. */
const CODEX_PICKER_QUARANTINE_KIND = 'codex_picker_cleanup';

/** A failure's message, whatever it was thrown as. */
export function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** True when a session is holding the picker quarantine and must accept no
 *  input. Read from durable state, so it survives a daemon restart. */
export function isPickerQuarantined(state: { readonly needsHumanKind?: string }): boolean {
  return state.needsHumanKind === CODEX_PICKER_QUARANTINE_KIND;
}

/** Why a send or a runtime control was refused on a quarantined session. */
export function pickerInputRefusal(binaryName: string): string {
  return (
    'input is blocked because Codex picker cleanup was not confirmed; ' +
    `run \`${binaryName} resume <session>\` or \`${binaryName} stop <session>\` ` +
    'before sending or retrying runtime control'
  );
}

// --- harness/{model-catalog,fast-mode,picker-drive}.ts ----------------------------------------------------------

/**
 * The service's whole catalog seam, whole: the harness plugin's catalog projections and picker driver, which the
 * runtime-control service calls as free functions and `new CodexModelPickerDriver(...)`. A harness supplies the members
 * it has through `HarnessRuntimeSwitch.catalogs`; the ones it lacks are filled in by Ferrets with a refusal.
 */
export interface HarnessRuntimeCatalogs {
  /** Today's `claudeRuntimeCatalog(account)`. */
  claudeRuntimeCatalog(account: RuntimeSwitchAccount): RuntimeModelCatalog;
  /** Today's `codexRuntimeCatalog(choices, account?)`. */
  codexRuntimeCatalog(
    choices: readonly RuntimeModelChoice[],
    account?: Pick<CoreAccount, 'models' | 'modelCatalog'> & Partial<Pick<CoreAccount, 'defaultModel'>>,
  ): RuntimeModelCatalog;
  /** Today's `codexSwitchContext(choices)`. */
  codexSwitchContext(choices: readonly RuntimeModelChoice[]): CodexModelCatalog;
  /** Today's `fastModeFacts(view, catalog)`. */
  fastModeFacts(view: SessionView, catalog: RuntimeModelCatalog): FastModeFacts;
  /** Today's `new CodexModelPickerDriver(transport, sleeper)`. */
  pickerDriver(transport: CodexPickerDrivePort, sleeper: PickerSleeper): CodexModelPickerDriver;
}
