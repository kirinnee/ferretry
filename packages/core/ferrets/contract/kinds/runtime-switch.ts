import type { Harness as HarnessFamily } from '../view/session-base.ts';
import type { FerretView } from '../view/ferret-view.ts';
import type { RuntimeModelCatalog, RuntimeModelChoice } from '../view/runtime-control.ts';
import type { DeliveryOutcome, FormKey, PickerKey } from './runner.ts';

/**
 * A harness's own part of changing what a RUNNING ferret runs: how its model, reasoning level and fast mode are switched,
 * what it may be switched to, and how a half-driven picker is undone. It is an additive member of the harness kind
 * (`Harness.runtimeSwitch`), so a harness that offers it is served by Ferrets' one runtime-control service without any
 * edit to Ferrets; a harness that does not is answered `422 runtime_control_unsupported`.
 *
 * Ferrets owns what is the same for every harness (the four preconditions, the durable request ledger, the busy-pane
 * refusal, the view re-read afterwards); the harness owns what is not. The harness never receives a pane handle or a
 * tmux address: it is handed ONE ferret's pane as {@link RuntimeSwitchPane}, which is Ferrets' own harness seam.
 */

/** What an idle-prompt read of a ferret's pane shows. */
export interface RuntimeSwitchFrame {
  readonly alive: boolean;
  /** The pane exists but its process is gone. */
  readonly dead: boolean;
  /** The harness is at a prompt and will accept typed input. */
  readonly promptReady: boolean;
  /** The screen as shown, already masked. */
  readonly visible: string;
}

/**
 * ONE ferret's pane, as a harness's runtime switch reaches it. Every act is the ferret's runner acting on that pane
 * through Ferrets' harness seam (`FerretHarness`), so Vault's input holds apply and a hold types nothing.
 */
export interface RuntimeSwitchPane {
  /** One read of the pane; it never writes. Rejects when the pane cannot be read. */
  observe(): Promise<RuntimeSwitchFrame>;
  /**
   * Types one native command (`/model`, `/fast`, `/compact`) at an idle prompt and says how the harness took it: it
   * `turn-started` when it read the text as a message, `handled-local` when it consumed it itself. Rejects when
   * nothing could be typed.
   */
  command(text: string): Promise<DeliveryOutcome>;
  /** One closed navigation key at the pane. Rejects when it could not be pressed. */
  key(key: FormKey): Promise<void>;
  /** One numbered picker row's digit, from its own closed set (never a navigation key). Rejects when it could not be pressed. */
  pickerKey(key: PickerKey): Promise<void>;
  /** Stops the ferret. */
  stop(): Promise<void>;
}

/** What a harness's quarantine of an unconfirmed picker writes durably, plus the evidence for the event. */
export interface PickerQuarantine {
  readonly needsHumanKind: 'codex_picker_cleanup';
  readonly reason: string;
  /** The instruction a human sees on the session. */
  readonly needsHuman: string;
  readonly evidence: {
    readonly driveError: string;
    readonly cleanupError: string;
  };
}

interface CodexReasoningChoice {
  readonly value: string;
}

/** One model as the live Codex account advertises it. */
export interface CodexModelChoice {
  readonly value: string;
  /** The name Codex's own picker renders the model under — its `displayName`, which is not its id. */
  readonly label?: string;
  readonly reasoningEfforts: readonly CodexReasoningChoice[];
  /** The effort the quick picker applies when a row is chosen directly. Absent when the account does not advertise one. */
  readonly defaultReasoningEffort?: string;
}

export interface CodexModelCatalog {
  readonly choices: readonly CodexModelChoice[];
}

/** What the picker driver has to reach. */
export interface CodexPickerTarget {
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
  readonly harness: HarnessFamily;
  readonly model?: string;
  readonly effort?: string;
  /** Turn fast mode on or off. A switch of its own: it is never combined with a model or an effort. */
  readonly fast?: boolean;
}

/** What the planner needs to know about fast mode for the model a session is running. */
export interface FastModeFacts {
  /** Whether that model offers fast mode. Absent when nothing can say, which plans as "try it". */
  readonly supported?: boolean;
  /** What the refusal calls the model: its label, else its id. */
  readonly model?: string;
  /** Whether fast mode is on right now — the harness's report, else the launch's, else the model's default. */
  readonly current?: boolean;
}

export interface HarnessRuntimeSwitchContext {
  /** Models the wrapper permits mid-session, for a harness that switches by command. An empty list means none. */
  readonly allowedModels?: readonly string[];
  /** Whether the login's model catalog takes ids beyond `allowedModels` ("Custom id…", docs/model-catalog.md). */
  readonly acceptsCustomModels?: boolean;
  /** The wrapper the session runs, named in refusals so the operator knows which account could not serve the request. */
  readonly wrapper: string;
  /** The live catalog, for a harness that switches through its picker. */
  readonly catalog?: CodexModelCatalog;
  /** Fast mode facts for a fast request. */
  readonly fast?: FastModeFacts;
}

export type RuntimeSwitchPlan =
  /**
   * Type one native command into the session. `claimsOutcome` is false for a bare picker open, where the choice is a
   * human's and the daemon must make no claim about what was selected.
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

export type CodexPickerKind =
  | 'quick-models'
  | 'all-models'
  | 'reasoning'
  | 'advanced-reasoning'
  | 'plan-scope'
  | 'none';

/** One selectable row: the digit that chooses it and the name it shows. */
export interface CodexPickerRow {
  readonly number: number;
  readonly name: string;
}

/** One frame of the pane the picker is on. */
export interface CodexPickerFrame {
  readonly alive: boolean;
  readonly dead: boolean;
  readonly promptReady: boolean;
  readonly visible: string;
}

/** The exact row a queued keystroke is aimed at, re-verified by the transport before it is sent. */
export interface CodexPickerKeyExpectation {
  readonly kind: CodexPickerKind;
  readonly title?: string;
  readonly row: CodexPickerRow;
}

/** The IO seam a picker driver needs, so its decisions never learn what a terminal is. */
export interface CodexPickerDrivePort {
  /** Type the picker-opening command. `turn-started` means the harness read it as a message instead. */
  openPicker(): Promise<DeliveryOutcome>;
  readPane(): Promise<CodexPickerFrame>;
  /** Send one digit to the exact pane, refusing if the pane no longer shows `expected`. */
  sendKey(key: string, expected: CodexPickerKeyExpectation): Promise<void>;
}

/** Sleeping is a capability, not a decision. */
export interface PickerSleeper {
  sleep(milliseconds: number): Promise<void>;
}

/** Reach the target, or throw with the stage that was not reached; success means the picker returned to an idle prompt. */
export interface CodexModelPickerDriver {
  drive(target: CodexPickerTarget): Promise<void>;
}

export type PickerRecovery =
  /** Cleanup confirmed the pane is idle. The switch failed; the session is fine. */
  | { readonly kind: 'recovered' }
  /**
   * Cleanup could not be confirmed. The session must be quarantined durably BEFORE its pane is stopped, so a failure to
   * stop still leaves the input gates closed.
   */
  | { readonly kind: 'quarantine'; readonly quarantine: PickerQuarantine };

/** The per-harness switch decision and the recovery for a picker drive that failed part-way. */
export interface HarnessQuirkService {
  /** How to change the model or effort of a live session on this harness. */
  planSwitch(request: HarnessRuntimeSwitchRequest, context: HarnessRuntimeSwitchContext): RuntimeSwitchPlan;
  /** Recover from a picker drive that threw part-way through. */
  recoverFromFailedDrive(session: string, driveFailure: unknown): Promise<PickerRecovery>;
  /** The message for the caller whose switch failed, once the outcome of stopping the pane is known. */
  report(quarantine: PickerQuarantine, stopFailure?: unknown): string;
}

/** One held catalog per `(executable, cwd)`. */
export interface CodexRuntimeCatalogCache {
  get(binary: string, cwd: string): Promise<readonly RuntimeModelChoice[]>;
}

/** The account facts a catalog projection reads (a published account satisfies it). */
export interface RuntimeCatalogAccount {
  readonly models: readonly {
    readonly id: string;
    readonly displayName?: string;
    readonly tier?: 'best' | 'balanced' | 'fast';
    readonly context?: number;
  }[];
  readonly defaultModel?: string | null;
  readonly modelCatalog?: { readonly id: string; readonly label: string; readonly customIds: boolean };
}

/** The harness's catalog projections and picker driver. A harness that has no live catalog or picker leaves them out. */
export interface HarnessRuntimeCatalogs {
  /** The catalog a Codex session may be switched within: what its own app-server advertised, described by its account. */
  codexRuntimeCatalog?(choices: readonly RuntimeModelChoice[], account?: RuntimeCatalogAccount): RuntimeModelCatalog;
  /** The advertised choices in the planner's vocabulary. */
  codexSwitchContext?(choices: readonly RuntimeModelChoice[]): CodexModelCatalog;
  /** The facts the planner needs for a fast switch on this session. */
  fastModeFacts?(view: FerretView, catalog: RuntimeModelCatalog): FastModeFacts;
  /**
   * The driver of this harness's modal picker, over the ferret's pane transport Ferrets built (open the picker, read a
   * frame, press a digit). The harness wraps it with what only it knows: proving a row is still on screen before a digit is
   * let through.
   */
  pickerDriver?(transport: CodexPickerDrivePort, sleeper: PickerSleeper): CodexModelPickerDriver;
}

/** What a harness offers Ferrets' runtime control for ONE ferret (`Harness.runtimeSwitch`). */
export interface HarnessRuntimeSwitch {
  readonly quirks: HarnessQuirkService;
  readonly catalogs: HarnessRuntimeCatalogs;
  /** The harness's own live model list, held per `(executable, cwd)`: absent when its models are a published inventory. */
  readonly liveCatalog?: CodexRuntimeCatalogCache;
}
