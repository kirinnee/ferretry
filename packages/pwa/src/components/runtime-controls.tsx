/**
 * IN-PLACE MODEL AND REASONING SWITCHES — the two sheet bodies.
 *
 * Ported from the runtime half of kteam `ui/src/components/SessionDetails.tsx`
 * (`RuntimeModelControls`, `RuntimeEffortControls` and their choice lists). kteam
 * deliberately kept ONE implementation and imported it into both the details
 * sheet and the composer runtime bar, so the harness rules could not drift apart.
 * That is why they live in their own module here rather than inside either
 * consumer: `composer-runtime.tsx` takes its sheet bodies as render props, and
 * these are what it is handed.
 *
 * The two surfaces are separate on purpose, because the harnesses answer "change
 * the thinking level" very differently:
 *
 *   - Claude has a real in-session effort command with four persistable levels.
 *     It writes the account's settings and the next turn uses it. Claude does not
 *     echo the level back, so there is no stale-until-evidence spinner: the
 *     persist is confirmed by the command completing, and it is shown as SENT,
 *     never as an observed running value.
 *   - Codex combines model AND reasoning in one native two-stage picker; there is
 *     no reasoning verb. The sheet reads the current model's ordered efforts from
 *     the daemon's catalog, then asks the daemon to drive that native picker.
 *
 * Anything a harness cannot actually do is never rendered as a live control.
 *
 * kteam also carried an "in-session switching is not available for this harness"
 * fallback. `Harness` in the shared protocol is exactly `claude | codex`, so that
 * branch is unreachable here and is deliberately absent rather than kept as dead
 * markup the coverage ledger could never execute.
 *
 * DAEMON SCOPE. kteam fetched the catalog with `fetchRuntimeModelCatalog(sessionId)`
 * against one implicit daemon. Here every request is bound to an explicit
 * `DaemonConnection`, the catalog is read through the `(daemonId, sessionId)`
 * scoped store from `lib/runtime-models.ts`, and the reset effect keys on the
 * daemon id as well as the session id — so a same-named session on a second
 * daemon can neither receive this command nor be shown the first daemon's
 * choices.
 */

import type { SessionView } from '@ferretry/protocol';
import { LoaderCircle, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../lib/daemon-scope.ts';
import {
  type RuntimeModelCatalog,
  type RuntimeModelChoice,
  runtimeModelCatalogErrorMessage,
} from '../lib/runtime-models.ts';
import { TERMINAL_STATUSES } from '../shell/status-mark.tsx';
import type { RuntimeSwitchLifecycle } from './composer-runtime.tsx';

/**
 * The four persistable levels the installed Claude CLI accepts. `auto` (reset to
 * the model default) and the session-only `max`/`ultracode` aliases are
 * deliberately absent — this surface only offers what persists as a default.
 */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

/** What the component asks a daemon to do. The host adapter turns this into the
 *  protocol request; keeping it structural is what lets the same body drive both
 *  the details sheet and the composer bar without either owning a transport. */
export type RuntimeControlCommand =
  | { readonly action: 'model'; readonly model?: string; readonly effort?: string }
  | { readonly action: 'effort'; readonly effort: string };

export interface RuntimeControlApi {
  /** The host must send this to the exact paired daemon it is handed. The request
   *  id is fresh per click, so the daemon applies it once and a retry is a new
   *  user decision rather than a replay. */
  runtime(
    daemon: DaemonConnection,
    sessionId: string,
    command: RuntimeControlCommand,
    requestId: string,
  ): Promise<void>;
}

/** The daemon-scoped catalog reader. `DaemonRuntimeModelCatalogStore` satisfies
 *  it; tests and the harness can supply anything with the same shape. */
export interface RuntimeModelCatalogSource {
  load(daemon: DaemonConnection, scope: DaemonSessionScope): Promise<RuntimeModelCatalog>;
}

type RuntimeFailure = { readonly code?: unknown; readonly message?: unknown; readonly status?: unknown };

const failureFields = (failure: unknown): RuntimeFailure | null =>
  typeof failure === 'object' && failure !== null ? (failure as RuntimeFailure) : null;

/**
 * A missing runtime route is daemon/UI version skew; an ordinary 404 can still be
 * a missing session and must keep its normal error treatment.
 */
export const isRuntimeEndpointUnavailable = (failure: unknown): boolean => {
  const fields = failureFields(failure);
  return fields?.status === 404 && fields.code === 'unknown_route';
};

/**
 * A daemon that predates the effort action rejects it with the 400 it raises for
 * any unknown action. That is version skew — the account CAN tune effort, the
 * running daemon just has not learned the verb — so it earns the same "update the
 * daemon" treatment as a missing route, not a red error.
 */
export const isEffortActionUnsupported = (failure: unknown): boolean => {
  const fields = failureFields(failure);
  return fields?.status === 400 && /runtime action/i.test(String(fields.message));
};

export const runtimeControlUnavailableMessage = (control: 'model' | 'effort'): string =>
  `The running daemon is older than this web UI and does not provide in-session ${control} switching. Update the daemon build to enable it; restarting the same build will not help.`;

/**
 * WHETHER THE PROMPT IS KNOWN TO BE BUSY — never whether it is known to be idle.
 *
 * `promptReady` is optional on the wire and carries THREE answers, not two:
 * `true` is an idle prompt, `false` is a busy one, and ABSENT is a daemon that
 * did not say. Both sheets used to read `=== true`, which folds the third answer
 * into the second and refuses on no evidence. That is not theoretical: the
 * shipping daemon omits the field for idle sessions whose runtime-control POST
 * it then accepts, because it inspects the LIVE PANE at command time — so
 * reading absent as busy disabled controls the daemon would have honoured.
 *
 * The pane inspection is also why deferring is safe rather than reckless. The
 * daemon refuses a genuinely busy pane itself (`paneRefusal` in
 * `session/runtime-control/policy.ts`) and the refusal is surfaced verbatim
 * below, so an unknown prompt costs a round trip and an honest message, while a
 * pre-refusal costs the reader a capability they actually had. Explicit `false`
 * still pre-refuses and says why: that one IS evidence.
 *
 * EXPORTED BECAUSE THE CHIP AND THE SUBMISSION MUST AGREE. `SessionChatPage`
 * decides whether the trigger opens at all and these bodies decide whether a
 * choice can be sent; spelling the same tri-state twice is exactly how a chip
 * that opens onto a sheet that can only refuse — or worse, the reverse — gets
 * built. One predicate, read from both ends, and the rationale lives here.
 */
export const isPromptKnownBusy = (state: SessionView['state']): boolean => state.promptReady === false;

const failureMessage = (failure: unknown): string => {
  if (failure instanceof Error) return failure.message;
  const fields = failureFields(failure);
  return typeof fields?.message === 'string' ? fields.message : String(failure);
};

/**
 * Codex's native Terminal picker is the escape hatch, offered exactly when the
 * live catalog cannot answer: it errored, it is empty, the required choice is
 * missing, or the chosen model advertises no reasoning levels.
 */
export const codexPickerFallbackNeeded = (
  catalog: RuntimeModelCatalog | null,
  error: unknown,
  choice?: RuntimeModelChoice,
  requireChoice = false,
): boolean => {
  if (error) return true;
  if (!catalog) return false;
  if (catalog.choices.length === 0) return true;
  if (requireChoice && !choice) return true;
  return choice?.reasoningEfforts.length === 0;
};

/**
 * The lifecycle a sheet body drives so its host's readouts stay honest.
 *
 * DERIVED FROM `composer-runtime.tsx`, not re-declared beside it: that file owns
 * the contract and hands one of these to each sheet body it renders, so a
 * spread — `renderModelControls={lifecycle => <RuntimeModelControls {...lifecycle} … />}`
 * — is the whole wiring, and the two cannot drift. The details sheet supplies
 * only `onClose`, which is why the rest are optional here.
 */
export interface RuntimeSwitchCallbacks extends Partial<Omit<RuntimeSwitchLifecycle, 'onClose' | 'open'>> {
  readonly onClose: RuntimeSwitchLifecycle['onClose'];
}

interface RuntimeControlBase extends RuntimeSwitchCallbacks {
  readonly api: RuntimeControlApi;
  readonly catalogs: RuntimeModelCatalogSource;
  readonly daemon: DaemonConnection;
  readonly view: SessionView;
  /** A token-less origin is read-only and cannot send a runtime command. */
  readonly canControl: boolean;
  /** Codex's native picker lives in the Terminal view. Returns whether the host
   *  actually managed to show it. */
  readonly onOpenTerminal?: () => boolean;
  /** Injected so a test can assert the per-click identity without a real crypto. */
  readonly newRequestId?: () => string;
}

const defaultRequestId = (): string => crypto.randomUUID();

/**
 * Reads one session's catalog from the daemon-scoped store, and reports nothing
 * until the answer belongs to the scope currently on screen. The request key
 * carries the daemon id, so a daemon switch discards the previous daemon's
 * catalog rather than rendering it under the new one.
 */
function useRuntimeModelCatalog(
  catalogs: RuntimeModelCatalogSource,
  daemon: DaemonConnection,
  sessionId: string,
  enabled: boolean,
  expectedHarness: RuntimeModelCatalog['harness'],
): { catalog: RuntimeModelCatalog | null; error: unknown } {
  const [catalog, setCatalog] = useState<RuntimeModelCatalog | null>(null);
  const [error, setError] = useState<unknown>(null);
  const requestKey = `${daemon.daemonId}\0${sessionId}\0${expectedHarness}`;
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setCatalog(null);
    setError(null);
    setLoadedFor(null);
    void catalogs
      .load(daemon, daemonSessionScope(daemon, sessionId))
      .then(value => {
        if (cancelled) return;
        if (value.harness !== expectedHarness)
          throw new Error(`daemon returned a ${value.harness} model catalog for a ${expectedHarness} session`);
        setCatalog(value);
        setLoadedFor(requestKey);
      })
      .catch(reason => {
        if (cancelled) return;
        setError(reason);
        setLoadedFor(requestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [catalogs, daemon, enabled, expectedHarness, requestKey, sessionId]);
  return loadedFor === requestKey ? { catalog, error } : { catalog: null, error: null };
}

export interface RuntimeModelControlsProps extends RuntimeControlBase {
  /** The sheet is open. A closed sheet neither fetches a catalog nor keeps a
   *  half-finished Codex two-step around. */
  readonly open: boolean;
}

/**
 * One account-aware model list for both harnesses. Claude's values come from its
 * wrapper allowlist; Codex's come from that wrapper's app-server model list, and
 * Codex needs a second step because model and reasoning are applied together.
 */
export function RuntimeModelControls({
  api,
  canControl,
  catalogs,
  daemon,
  newRequestId = defaultRequestId,
  onClose,
  onSwitchFailed,
  onSwitchSubmitted,
  onOpenTerminal,
  open,
  view,
}: RuntimeModelControlsProps) {
  const { config, state } = view;
  const terminal = TERMINAL_STATUSES.has(state.status);
  const promptRefused = isPromptKnownBusy(state);
  const { catalog, error: catalogError } = useRuntimeModelCatalog(
    catalogs,
    daemon,
    config.id,
    open && canControl && !terminal,
    config.harness,
  );
  const [selectedCodexModel, setSelectedCodexModel] = useState<RuntimeModelChoice | null>(null);
  const [submittingTarget, setSubmittingTarget] = useState<{ model: string; effort?: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runtimeControlUnavailable, setRuntimeControlUnavailable] = useState(false);
  const submitting = submittingTarget !== null;

  // The scope identity is the trigger: a daemon switch must discard a notice or a
  // half-finished Codex step that belonged to the previous daemon's session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope reset trigger, see above
  useEffect(() => {
    setRuntimeControlUnavailable(false);
    setFailure(null);
    setNotice(null);
    setSelectedCodexModel(null);
    setSubmittingTarget(null);
  }, [daemon.daemonId, config.id]);

  useEffect(() => {
    if (open) return;
    setRuntimeControlUnavailable(false);
    setSelectedCodexModel(null);
  }, [open]);

  const codexPickerFallback =
    config.harness === 'codex' && codexPickerFallbackNeeded(catalog, catalogError, selectedCodexModel ?? undefined);

  async function runModelCommand(model?: string, effort?: string) {
    if (!canControl || terminal || promptRefused || submitting || runtimeControlUnavailable) return;
    const targeted = Boolean(model);
    setSubmittingTarget({ model: model ?? 'native-picker', ...(effort ? { effort } : {}) });
    setFailure(null);
    setNotice(null);
    if (targeted) onSwitchSubmitted?.();
    try {
      await api.runtime(
        daemon,
        config.id,
        { action: 'model', ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
        newRequestId(),
      );
      if (config.harness === 'codex' && !model) {
        if (onOpenTerminal?.()) {
          onClose();
          return;
        }
        setNotice('Codex opened its native picker in Terminal. No switch is claimed until Codex reports one.');
      } else if (config.harness === 'codex') {
        setSelectedCodexModel(null);
        setNotice(`Codex confirmed ${model} · ${effort} from its runtime settings.`);
      } else {
        setNotice('Model command sent. Verification updates after the next model response.');
      }
    } catch (cause) {
      if (targeted) onSwitchFailed?.();
      if (isRuntimeEndpointUnavailable(cause)) {
        setRuntimeControlUnavailable(true);
        return;
      }
      setFailure(failureMessage(cause));
    } finally {
      setSubmittingTarget(null);
    }
  }

  const title = 'Switch model in place';
  if (terminal) {
    return (
      <div className="border-border-soft border-t pt-3" data-daemon-id={daemon.daemonId}>
        <h3 className="m-0 font-semibold text-fg text-ui">{title}</h3>
        <p className="mt-1 text-meta text-muted leading-base">
          In-session model switching requires a running session. Resume or relaunch this session before changing its
          runtime model.
        </p>
      </div>
    );
  }
  if (!canControl) {
    return (
      <div className="border-border-soft border-t pt-3" data-daemon-id={daemon.daemonId}>
        <h3 className="m-0 font-semibold text-fg text-ui">{title}</h3>
        <p className="mt-1 text-meta text-muted leading-base">
          This paired daemon is read-only, so it cannot send a native model command to the running session.
        </p>
      </div>
    );
  }

  return (
    <div className="border-border-soft border-t pt-3" data-daemon-id={daemon.daemonId}>
      <h3 className="m-0 font-semibold text-fg text-ui">{title}</h3>
      <p className="mt-1 text-meta text-muted leading-base">
        Changes the model inside this running session. It does not move accounts, relaunch the pane, or discard its
        context.
      </p>
      {promptRefused ? (
        <p className="mt-2 text-meta text-warn leading-base">
          Wait for an idle prompt before switching model. The daemon refuses a busy pane instead of queueing this
          command.
        </p>
      ) : null}

      {runtimeControlUnavailable ? (
        <p className="mt-2 rounded-control border border-warn-border bg-surface-2 p-3 text-ui text-warn" role="alert">
          {runtimeControlUnavailableMessage('model')}
        </p>
      ) : selectedCodexModel ? (
        <RuntimeReasoningStep
          backDisabled={submitting}
          currentEffort={state.observedModel === selectedCodexModel.value ? state.observedReasoningEffort : undefined}
          disabled={submitting || promptRefused}
          model={selectedCodexModel}
          onBack={() => setSelectedCodexModel(null)}
          onChoose={effort => void runModelCommand(selectedCodexModel.value, effort)}
          submittingEffort={submittingTarget?.effort}
        />
      ) : (
        <RuntimeModelChoices
          choices={catalog?.choices ?? null}
          currentModel={state.observedModel}
          disabled={submitting || promptRefused}
          error={catalogError}
          harness={config.harness}
          onChoose={choice => {
            if (config.harness === 'codex') setSelectedCodexModel(choice);
            else void runModelCommand(choice.value);
          }}
          submittingModel={submittingTarget?.model}
        />
      )}

      {codexPickerFallback && !runtimeControlUnavailable ? (
        <NativePickerButton
          disabled={submitting || promptRefused}
          onClick={() => void runModelCommand()}
          submitting={submitting}
        />
      ) : null}

      <RuntimeOutcome failure={failure} notice={notice} />
    </div>
  );
}

/** The shared Codex escape hatch, so both sheets offer it identically. */
function NativePickerButton({
  disabled,
  onClick,
  submitting,
}: {
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly submitting: boolean;
}) {
  return (
    <button
      className="kt-btn !h-auto !justify-between !whitespace-normal !text-left mt-3 flex min-h-[44px] w-full min-w-[44px] items-center gap-sm py-2"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span>{submitting ? 'Opening native picker…' : 'Use native picker in Terminal'}</span>
      {submitting ? (
        <LoaderCircle aria-hidden="true" className="shrink-0 animate-spin" size={15} />
      ) : (
        <Terminal aria-hidden="true" className="shrink-0" size={15} />
      )}
    </button>
  );
}

/** Notice and failure read the same in both sheets, so they are one component. */
function RuntimeOutcome({ failure, notice }: { readonly failure: string | null; readonly notice: string | null }) {
  return (
    <>
      {notice ? (
        <p className="mt-2 text-ok text-ui leading-base" role="status">
          {notice}
        </p>
      ) : null}
      {failure ? (
        <p
          className="mt-2 rounded-control border border-err-border bg-surface-2 p-3 text-err text-ui leading-base"
          role="alert"
        >
          {failure}
        </p>
      ) : null}
    </>
  );
}

export interface RuntimeModelChoicesProps {
  readonly harness: 'claude' | 'codex';
  readonly choices: readonly RuntimeModelChoice[] | null;
  readonly error: unknown;
  readonly currentModel?: string;
  readonly submittingModel?: string;
  readonly disabled: boolean;
  readonly onChoose: (model: RuntimeModelChoice) => void;
}

/** Presentational: the parent owns submit, notices and the Codex second step. */
export function RuntimeModelChoices({
  choices,
  currentModel,
  disabled,
  error,
  harness,
  onChoose,
  submittingModel,
}: RuntimeModelChoicesProps) {
  if (error) {
    return (
      <p
        className="mt-2 rounded-control border border-err-border bg-surface-2 p-3 text-err text-ui leading-base"
        role="alert"
      >
        Account-aware model choices are unavailable: {runtimeModelCatalogErrorMessage(error)}
      </p>
    );
  }
  if (choices === null) {
    return (
      <div className="mt-2 flex min-h-[44px] items-center gap-sm text-muted text-ui" role="status">
        <LoaderCircle aria-hidden="true" className="animate-spin" size={15} />
        Loading account-aware model choices…
      </div>
    );
  }
  if (choices.length === 0) {
    return (
      <p className="mt-2 text-meta text-muted leading-base">
        This account does not advertise any in-place model choices.
      </p>
    );
  }
  return (
    <div className="mt-3">
      <p aria-live="polite" className="m-0 text-meta text-muted leading-base" role="status">
        {harness === 'codex'
          ? 'Live choices from this account’s Codex model catalog. Choose a model, then one of its advertised reasoning levels.'
          : 'Only this account’s advertised Claude choices are shown. Verification updates after the next model response.'}
      </p>
      {/* A real list, not a labelled div: `aria-label` needs a role, and the role
          a choice list wants is the one `<ul>`/`<li>` already carry. */}
      <ul aria-label={`Switch ${harness} model in place`} className="mt-2 grid list-none gap-2 p-0">
        {choices.map(choice => {
          const current = choice.value === currentModel;
          const pending = choice.value === submittingModel;
          return (
            <li key={choice.value}>
              <button
                aria-busy={pending || undefined}
                aria-current={current ? 'true' : undefined}
                aria-label={`Switch model in place to ${choice.label}${current ? ', current' : ''}`}
                className="kt-btn !h-auto !justify-between !whitespace-normal !text-left flex min-h-[44px] w-full min-w-[44px] items-center gap-sm py-2"
                disabled={disabled}
                onClick={() => onChoose(choice)}
                type="button"
              >
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-sm">
                    <span className="truncate font-semibold text-ui">{choice.label}</span>
                    {current ? <span className="kt-label shrink-0">Current</span> : null}
                    {!current && choice.isDefault ? <span className="kt-label shrink-0">Default</span> : null}
                  </span>
                  {choice.label === choice.value ? null : (
                    <span className="mono block truncate text-meta text-muted">{choice.value}</span>
                  )}
                  {choice.description ? (
                    <span className="mt-1 block text-meta text-muted leading-base">{choice.description}</span>
                  ) : null}
                </span>
                {pending ? <LoaderCircle aria-hidden="true" className="shrink-0 animate-spin" size={15} /> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** `xhigh` is the one level whose spoken name is not just its value capitalised. */
export const effortDisplayName = (effort: string): string =>
  effort === 'xhigh' ? 'Extra high' : effort.charAt(0).toUpperCase() + effort.slice(1);

export interface RuntimeReasoningStepProps {
  readonly model: RuntimeModelChoice;
  readonly currentEffort?: string;
  readonly submittingEffort?: string;
  readonly disabled: boolean;
  readonly backDisabled: boolean;
  readonly onBack: () => void;
  readonly onChoose: (effort: string) => void;
}

/**
 * Codex's second step. kteam put `autoFocus` on Back so the reader is never
 * stranded in a sub-step they cannot leave by keyboard; the same move is made
 * here with a ref, which is this repo's idiom and keeps the a11y rule honest.
 */
export function RuntimeReasoningStep({
  backDisabled,
  currentEffort,
  disabled,
  model,
  onBack,
  onChoose,
  submittingEffort,
}: RuntimeReasoningStepProps) {
  const backRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    backRef.current?.focus();
  }, []);
  return (
    <div className="mt-3">
      <button
        className="kt-btn flex min-h-[44px] min-w-[44px] items-center px-3"
        disabled={backDisabled}
        onClick={onBack}
        ref={backRef}
        type="button"
      >
        Back to models
      </button>
      <RuntimeReasoningChoices
        currentEffort={currentEffort}
        disabled={disabled}
        model={model}
        onChoose={onChoose}
        submittingEffort={submittingEffort}
      />
    </div>
  );
}

export interface RuntimeReasoningChoicesProps {
  readonly model: RuntimeModelChoice;
  readonly currentEffort?: string;
  readonly submittingEffort?: string;
  readonly disabled: boolean;
  readonly onChoose: (effort: string) => void;
}

export function RuntimeReasoningChoices({
  currentEffort,
  disabled,
  model,
  onChoose,
  submittingEffort,
}: RuntimeReasoningChoicesProps) {
  if (model.reasoningEfforts.length === 0)
    return (
      <p className="mt-2 rounded-control border border-err-border bg-surface-2 p-3 text-err text-ui" role="alert">
        {model.label} did not advertise any supported reasoning levels. Use Codex’s native Terminal picker instead.
      </p>
    );
  return (
    <div className="mt-3">
      <p aria-live="polite" className="m-0 text-meta text-muted leading-base" role="status">
        Reasoning for <span className="mono text-fg-soft">{model.value}</span>. The switch stays pending until Codex
        reports this exact model and level.
      </p>
      <ul aria-label={`Set reasoning for ${model.label}`} className="mt-2 grid list-none gap-2 p-0">
        {model.reasoningEfforts.map(effort => {
          const current = effort.value === currentEffort;
          const pending = effort.value === submittingEffort;
          const isDefault = effort.value === model.defaultReasoningEffort;
          return (
            <li key={effort.value}>
              <button
                aria-busy={pending || undefined}
                aria-current={current ? 'true' : undefined}
                aria-label={`Set ${model.label} reasoning to ${effortDisplayName(effort.value)}${current ? ', current' : ''}`}
                className="kt-btn !h-auto !justify-between !whitespace-normal !text-left flex min-h-[44px] w-full min-w-[44px] items-center gap-sm py-2"
                disabled={disabled}
                onClick={() => onChoose(effort.value)}
                type="button"
              >
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-sm">
                    <span className="truncate font-semibold text-ui">{effortDisplayName(effort.value)}</span>
                    {current ? <span className="kt-label shrink-0">Current</span> : null}
                    {!current && isDefault ? <span className="kt-label shrink-0">Default</span> : null}
                  </span>
                  {effort.description ? (
                    <span className="mt-1 block text-meta text-muted leading-base">{effort.description}</span>
                  ) : null}
                </span>
                {pending ? <LoaderCircle aria-hidden="true" className="shrink-0 animate-spin" size={15} /> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The four Claude levels as a 2-column grid of 44px targets, mirroring
 *  `RuntimeModelChoices`. Presentational: the parent owns submit + notices. */
export function ClaudeEffortChoices({
  disabled,
  onChoose,
}: {
  readonly disabled: boolean;
  readonly onChoose: (level: ClaudeEffortLevel) => void;
}) {
  return (
    <div className="mt-3">
      <p className="m-0 text-meta text-muted leading-base">
        Reasoning effort for new Claude turns. Persists to this account’s settings (saved as the default for new
        sessions). Claude does not echo the level back, so it is shown as sent, not re-verified.
      </p>
      <ul aria-label="Set Claude reasoning effort" className="mt-2 grid list-none grid-cols-2 gap-2 p-0">
        {CLAUDE_EFFORT_LEVELS.map(level => (
          <li key={level}>
            <button
              aria-label={`Set reasoning effort to ${level}`}
              className="kt-btn flex min-h-[44px] w-full items-center justify-center capitalize"
              disabled={disabled}
              onClick={() => onChoose(level)}
              type="button"
            >
              {level}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type RuntimeEffortControlsProps = RuntimeControlBase;

/**
 * The reasoning-effort sibling of `RuntimeModelControls`. It is deliberately a
 * SEPARATE surface, not a section grafted into the model control — see the file
 * header for why the two harnesses cannot share one flow.
 */
export function RuntimeEffortControls({
  api,
  canControl,
  catalogs,
  daemon,
  newRequestId = defaultRequestId,
  onClaudeEffortSent,
  onClose,
  onSwitchFailed,
  onSwitchSubmitted,
  onOpenTerminal,
  view,
}: RuntimeEffortControlsProps) {
  const { config, state } = view;
  const terminal = TERMINAL_STATUSES.has(state.status);
  const promptRefused = isPromptKnownBusy(state);
  const [submitting, setSubmitting] = useState(false);
  const [codexSubmittingEffort, setCodexSubmittingEffort] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runtimeControlUnavailable, setRuntimeControlUnavailable] = useState(false);
  const { catalog, error: catalogError } = useRuntimeModelCatalog(
    catalogs,
    daemon,
    config.id,
    canControl && !terminal && config.harness === 'codex',
    config.harness,
  );

  // Same scope-identity reset as the model sheet: a daemon switch clears any
  // result that belonged to the previous daemon's session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope reset trigger, see above
  useEffect(() => {
    setRuntimeControlUnavailable(false);
    setFailure(null);
    setNotice(null);
    setCodexSubmittingEffort(null);
  }, [daemon.daemonId, config.id]);

  const currentCodexModel = catalog?.choices.find(choice => choice.value === state.observedModel);
  const codexPickerFallback =
    config.harness === 'codex' && codexPickerFallbackNeeded(catalog, catalogError, currentCodexModel, true);

  async function runEffortCommand(level: string) {
    if (!canControl || terminal || promptRefused || submitting || runtimeControlUnavailable) return;
    setSubmitting(true);
    setCodexSubmittingEffort(null);
    setFailure(null);
    setNotice(null);
    try {
      await api.runtime(daemon, config.id, { action: 'effort', effort: level }, newRequestId());
      onClaudeEffortSent?.(level);
      setNotice(`Effort set to ${level}. Saved as this account’s default for new sessions, and the next turn uses it.`);
    } catch (cause) {
      if (isRuntimeEndpointUnavailable(cause) || isEffortActionUnsupported(cause)) {
        setRuntimeControlUnavailable(true);
        return;
      }
      setFailure(failureMessage(cause));
    } finally {
      setCodexSubmittingEffort(null);
      setSubmitting(false);
    }
  }

  async function runCodexEffort(model: RuntimeModelChoice, effort: string) {
    if (!canControl || terminal || promptRefused || submitting || runtimeControlUnavailable) return;
    setSubmitting(true);
    setCodexSubmittingEffort(effort);
    setFailure(null);
    setNotice(null);
    onSwitchSubmitted?.();
    try {
      await api.runtime(daemon, config.id, { action: 'model', model: model.value, effort }, newRequestId());
      setNotice(`Codex confirmed ${model.value} · ${effort} from its runtime settings.`);
    } catch (cause) {
      onSwitchFailed?.();
      if (isRuntimeEndpointUnavailable(cause)) {
        setRuntimeControlUnavailable(true);
        return;
      }
      setFailure(failureMessage(cause));
    } finally {
      setCodexSubmittingEffort(null);
      setSubmitting(false);
    }
  }

  async function openCodexPickerFallback() {
    if (!canControl || terminal || promptRefused || submitting || runtimeControlUnavailable) return;
    setSubmitting(true);
    setCodexSubmittingEffort(null);
    setFailure(null);
    setNotice(null);
    try {
      await api.runtime(daemon, config.id, { action: 'model' }, newRequestId());
      if (onOpenTerminal?.()) {
        onClose();
        return;
      }
      setNotice('Codex opened its native picker in Terminal. No switch is claimed until Codex reports one.');
    } catch (cause) {
      if (isRuntimeEndpointUnavailable(cause)) {
        setRuntimeControlUnavailable(true);
        return;
      }
      setFailure(failureMessage(cause));
    } finally {
      setSubmitting(false);
    }
  }

  const title = 'Reasoning effort';
  if (terminal) {
    return (
      <div className="mt-4 border-border-soft border-t pt-3" data-daemon-id={daemon.daemonId}>
        <h3 className="m-0 font-semibold text-fg text-ui">{title}</h3>
        <p className="mt-1 text-meta text-muted leading-base">
          Changing the reasoning level requires a running session. Resume or relaunch this session first.
        </p>
      </div>
    );
  }
  if (!canControl) {
    return (
      <div className="mt-4 border-border-soft border-t pt-3" data-daemon-id={daemon.daemonId}>
        <h3 className="m-0 font-semibold text-fg text-ui">{title}</h3>
        <p className="mt-1 text-meta text-muted leading-base">
          This paired daemon is read-only, so it cannot change the running session’s reasoning level.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 border-border-soft border-t pt-3" data-daemon-id={daemon.daemonId}>
      <h3 className="m-0 font-semibold text-fg text-ui">{title}</h3>
      {promptRefused ? (
        <p className="mt-2 text-meta text-warn leading-base">
          Wait for an idle prompt before changing the reasoning level. The daemon refuses a busy pane instead of
          queueing this command.
        </p>
      ) : null}

      {runtimeControlUnavailable ? (
        <p className="mt-2 rounded-control border border-warn-border bg-surface-2 p-3 text-ui text-warn" role="alert">
          {runtimeControlUnavailableMessage('effort')}
        </p>
      ) : config.harness === 'claude' ? (
        <ClaudeEffortChoices disabled={submitting || promptRefused} onChoose={level => void runEffortCommand(level)} />
      ) : (
        <div className="mt-3">
          {catalogError ? (
            <p
              className="m-0 rounded-control border border-err-border bg-surface-2 p-3 text-err text-ui leading-base"
              role="alert"
            >
              Account-aware reasoning choices are unavailable: {runtimeModelCatalogErrorMessage(catalogError)}
            </p>
          ) : catalog === null ? (
            <div className="flex min-h-[44px] items-center gap-sm text-muted text-ui" role="status">
              <LoaderCircle aria-hidden="true" className="animate-spin" size={15} />
              Loading account-aware reasoning choices…
            </div>
          ) : currentCodexModel ? (
            <RuntimeReasoningChoices
              currentEffort={state.observedReasoningEffort}
              disabled={submitting || promptRefused}
              model={currentCodexModel}
              onChoose={effort => void runCodexEffort(currentCodexModel, effort)}
              submittingEffort={codexSubmittingEffort ?? undefined}
            />
          ) : (
            <p className="m-0 rounded-control border border-err-border bg-surface-2 p-3 text-err text-ui" role="alert">
              The observed model ({state.observedModel || 'unknown'}) is not in this account’s current Codex catalog.
              Refresh the session or use the native Terminal picker.
            </p>
          )}
          {codexPickerFallback && !runtimeControlUnavailable ? (
            <NativePickerButton
              disabled={submitting || promptRefused}
              onClick={() => void openCodexPickerFallback()}
              submitting={submitting}
            />
          ) : null}
        </div>
      )}

      <RuntimeOutcome failure={failure} notice={notice} />
    </div>
  );
}
