/**
 * PEER: today's `packages/daemon/src/lib/session/harness/{quarantine,runtime-switch,picker-screen,picker-drive,
 * model-catalog,fast-mode,service,codex-catalog-cache}.ts` (owners: claude-code+codex) — the part the runtime-control
 * service reads.
 *
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the
 * host.
 */
import type { RuntimeModelCatalog, RuntimeModelChoice, SessionView } from '../../protocol/session.ts';
import type { CoreAccount } from './core.ts';
import type { HarnessKind } from './fleet.ts';
import type { InjectionOutcome } from './tmux-lifecycle.ts';

// --- harness/quarantine.ts --------------------------------------------------------------------------------------

/** Marks the durable quarantine so input gates can recognise this specific cause
 *  and refuse with an instruction that fits it. */
const CODEX_PICKER_QUARANTINE_KIND = 'codex_picker_cleanup';

/** The durable state a quarantine writes, plus the evidence for the event. */
interface PickerQuarantine {
  readonly needsHumanKind: typeof CODEX_PICKER_QUARANTINE_KIND;
  readonly reason: string;
  /** The instruction a human sees on the session. */
  readonly needsHuman: string;
  readonly evidence: {
    readonly driveError: string;
    readonly cleanupError: string;
  };
}

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

// --- harness/runtime-switch.ts ----------------------------------------------------------------------------------

interface CodexReasoningChoice {
  readonly value: string;
}

/** One model as the live Codex account advertises it. */
interface CodexModelChoice {
  readonly value: string;
  /** The name Codex's own picker renders the model under — its `displayName`, which is not its id. */
  readonly label?: string;
  readonly reasoningEfforts: readonly CodexReasoningChoice[];
  /** The effort the quick picker applies when a row is chosen directly. Absent
   *  when the account does not advertise one. */
  readonly defaultReasoningEffort?: string;
}

interface CodexModelCatalog {
  readonly choices: readonly CodexModelChoice[];
}

/** What the picker driver has to reach. */
interface CodexPickerTarget {
  readonly model: string;
  /** The name the picker's row carries when it is not the id (a catalog's "DeepSeek V4 Pro"). */
  readonly rowName?: string;
  /** Absent only for a model that advertises no reasoning level: choosing its row applies it whole. */
  readonly effort?: string;
  /** The effort the quick row would apply instead of the requested one, when the account advertises it. */
  readonly quickPickerDefaultEffort?: string;
  /**
   * The quick picker would apply SOME preset level for this model rather than offering the requested one, and
   * that preset is not provably the requested effort.
   */
  readonly quickPickerAppliesPreset?: true;
}

export interface HarnessRuntimeSwitchRequest {
  readonly harness: HarnessKind;
  readonly model?: string;
  readonly effort?: string;
  /** Turn fast mode on or off. A switch of its own: it is never combined with a model or an effort. */
  readonly fast?: boolean;
}

/** What the planner needs to know about fast mode for the model a session is running. */
interface FastModeFacts {
  /** Whether that model offers fast mode. Absent when nothing can say, which plans as "try it". */
  readonly supported?: boolean;
  /** What the refusal calls the model: its label, else its id. */
  readonly model?: string;
  /** Whether fast mode is on right now — the harness's report, else the launch's, else the model's default. */
  readonly current?: boolean;
}

export interface HarnessRuntimeSwitchContext {
  /** Models the wrapper permits mid-session, for a harness that switches by
   *  command. An empty list means the wrapper supports no switching at all. */
  readonly allowedModels?: readonly string[];
  /** Whether the login's model catalog takes ids beyond `allowedModels` ("Custom id…", docs/model-catalog.md). */
  readonly acceptsCustomModels?: boolean;
  /** The wrapper the session runs, named in refusals so the operator knows which
   *  account could not serve the request. */
  readonly wrapper: string;
  /** The live catalog, for a harness that switches through its picker. */
  readonly catalog?: CodexModelCatalog;
  /** Fast mode facts for a fast request. */
  readonly fast?: FastModeFacts;
}

export type RuntimeSwitchPlan =
  /**
   * Type one native command into the session. `claimsOutcome` is false for a
   * bare picker open, where the choice is a human's and the daemon must make no
   * claim about what was selected.
   */
  | {
      readonly kind: 'inject';
      readonly command: string;
      readonly requestedModel?: string;
      readonly requestedEffort?: string;
      readonly requestedFast?: boolean;
      readonly claimsOutcome: boolean;
    }
  /** Nothing to type: the session already is in the state asked for. */
  | { readonly kind: 'unchanged' }
  /** Drive the modal picker to an exact model and effort, then verify. */
  | { readonly kind: 'drive_picker'; readonly target: CodexPickerTarget }
  /** The request cannot be served. */
  | { readonly kind: 'refused'; readonly reason: string };

// --- harness/picker-screen.ts -----------------------------------------------------------------------------------

type CodexPickerKind = 'quick-models' | 'all-models' | 'reasoning' | 'advanced-reasoning' | 'plan-scope' | 'none';

/** One selectable row: the digit that chooses it and the name it shows. */
interface CodexPickerRow {
  readonly number: number;
  readonly name: string;
}

// --- harness/picker-drive.ts ------------------------------------------------------------------------------------

/** One frame of the pane the picker is on. */
interface CodexPickerFrame {
  readonly alive: boolean;
  readonly dead: boolean;
  readonly promptReady: boolean;
  readonly visible: string;
}

/** The exact row a queued keystroke is aimed at, re-verified by the transport before it is sent. */
interface CodexPickerKeyExpectation {
  readonly kind: CodexPickerKind;
  readonly title?: string;
  readonly row: CodexPickerRow;
}

/** The IO seam the driver needs, so the decisions above never learn what a terminal is. */
export interface CodexPickerDrivePort {
  /** Type the picker-opening command. `turn-started` means Codex read it as a message instead. */
  openPicker(): Promise<InjectionOutcome>;
  readPane(): Promise<CodexPickerFrame>;
  /** Send one digit to the exact pane, refusing if the pane no longer shows `expected`. */
  sendKey(key: string, expected: CodexPickerKeyExpectation): Promise<void>;
}

/** Sleeping is a capability, not a decision. */
export interface PickerSleeper {
  sleep(milliseconds: number): Promise<void>;
}

/**
 * INJECTED: today's `CodexModelPickerDriver` class. Reach the target, or throw with the stage that was not reached;
 * success means the picker positively returned to a parsed idle prompt.
 */
interface CodexModelPickerDriver {
  drive(target: CodexPickerTarget): Promise<void>;
}

// --- harness/service.ts (INJECTED) ------------------------------------------------------------------------------

/** What the daemon must do after a picker drive failed. */
type PickerRecovery =
  /** Cleanup confirmed the pane is idle. The switch failed; the session is fine. */
  | { readonly kind: 'recovered' }
  /**
   * Cleanup could not be confirmed. The session must be quarantined durably
   * BEFORE its pane is stopped, so a failure to stop still leaves the input gates
   * closed.
   */
  | { readonly kind: 'quarantine'; readonly quarantine: PickerQuarantine };

/** INJECTED: today's `HarnessQuirkService` class — the per-harness switch decision and the failed-drive recovery. */
export interface HarnessQuirkService {
  /** How to change the model or effort of a live session on this harness. */
  planSwitch(request: HarnessRuntimeSwitchRequest, context: HarnessRuntimeSwitchContext): RuntimeSwitchPlan;
  /** Recover from a picker drive that threw part-way through. */
  recoverFromFailedDrive(session: string, driveFailure: unknown): Promise<PickerRecovery>;
  /** The message for the caller whose switch failed, once the outcome of stopping the pane is known. */
  report(quarantine: PickerQuarantine, stopFailure?: unknown): string;
}

// --- harness/codex-catalog-cache.ts (INJECTED) ------------------------------------------------------------------

/** INJECTED: today's `CodexRuntimeCatalogCache` class — one held Codex catalog per `(executable, cwd)`. */
export interface CodexRuntimeCatalogCache {
  get(binary: string, cwd: string): Promise<readonly RuntimeModelChoice[]>;
}

// --- harness/{model-catalog,fast-mode,picker-drive}.ts (INJECTED) -----------------------------------------------

/**
 * INJECTED: the harness plugin's catalog projections and picker driver, which the runtime-control service called as
 * free functions and `new CodexModelPickerDriver(...)` today. Each member keeps today's exact signature.
 */
export interface HarnessRuntimeCatalogs {
  /** Today's `claudeRuntimeCatalog(account)`. */
  claudeRuntimeCatalog(account: CoreAccount): RuntimeModelCatalog;
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
