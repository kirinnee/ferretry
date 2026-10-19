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
import { Check, LoaderCircle, Terminal } from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { cn } from '../lib/class-names.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../lib/daemon-scope.ts';
import {
  type RuntimeModelCatalog,
  type RuntimeModelChoice,
  runtimeModelCatalogErrorMessage,
} from '../lib/runtime-models.ts';
import { CUSTOM_MODEL_ID, contextWords, groupByTier } from '../lib/model-tiers.ts';
import { TERMINAL_STATUSES } from '../shell/status-mark.tsx';
import { launchedModel, type RuntimeSwitchLifecycle } from './composer-runtime.tsx';

/**
 * The four persistable levels the installed Claude CLI accepts. `auto` (reset to
 * the model default) and the session-only `max`/`ultracode` aliases are
 * deliberately absent — this surface only offers what persists as a default.
 */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;

/**
 * The effort levels a Claude session's model in force takes: what its login's model catalog says
 * that model takes (empty means none) when the login reads one, Claude Code's own levels otherwise —
 * and before the catalog has answered.
 */
export const claudeEffortLevels = (
  catalog: RuntimeModelCatalog | null,
  model: string | undefined,
): readonly string[] => {
  if (catalog?.catalog === undefined) return CLAUDE_EFFORT_LEVELS;
  const choice = catalog.choices.find(entry => entry.value === model);
  return choice === undefined ? CLAUDE_EFFORT_LEVELS : choice.reasoningEfforts.map(effort => effort.value);
};

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
 *
 * THE TURN WATCHER'S `turnState` WINS WHEN THE DAEMON SENT ONE. `promptReady`
 * is written `false` by every send that starts a turn and nothing writes it back
 * when that turn ends — the daemon's turn watcher owns `turnState` and leaves
 * `promptReady` alone. Read on its own, the stored `false` therefore outlived its
 * turn: after the first message of a session both chips stayed disabled forever,
 * and on a phone, where a disabled button's reason is only a tooltip, tapping
 * "claude-opus-5-5 ⌃" or "default ⌃" did nothing at all. A daemon with the
 * watcher says `your-turn` the moment the harness is back at its prompt, which
 * is the one state a runtime command can land in; `working` and `needs-input`
 * (a dialog on screen) are both known-busy. Only a daemon that predates the
 * watcher falls back to the stored `promptReady`.
 */
export const isPromptKnownBusy = (state: SessionView['state']): boolean =>
  state.turnState === undefined ? state.promptReady === false : state.turnState !== 'your-turn';

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
 * The model a picker checks as in force: what the harness last reported, else —
 * before it has said anything — the one the session was LAUNCHED on. The chip
 * reads the same fallback, so the chip and the checked choice always agree.
 */
export const runtimeModelInForce = (view: SessionView): string | undefined =>
  view.state.observedModel?.trim() || launchedModel(view.config);

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
  presentation = 'sheet',
  view,
}: RuntimeModelControlsProps) {
  const popover = presentation === 'popover';
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
        setNotice('Model command sent. The model chip updates when Claude confirms the switch.');
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
    <div className={popover ? undefined : 'border-border-soft border-t pt-3'} data-daemon-id={daemon.daemonId}>
      {popover ? null : (
        <>
          <h3 className="m-0 font-semibold text-fg text-ui">{title}</h3>
          <p className="mt-1 text-meta text-muted leading-base">
            Changes the model inside this running session. It does not move accounts, relaunch the pane, or discard its
            context.
          </p>
        </>
      )}
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
          presentation={presentation}
          submittingEffort={submittingTarget?.effort}
        />
      ) : (
        <RuntimeModelChoices
          choices={catalog?.choices ?? null}
          // Before the harness has reported a model, the one it was LAUNCHED on is the
          // one in force — the same fallback the chip reads, so the two agree.
          currentModel={runtimeModelInForce(view)}
          disabled={submitting || promptRefused}
          error={catalogError}
          harness={config.harness}
          onChoose={choice => {
            if (config.harness === 'codex') setSelectedCodexModel(choice);
            else void runModelCommand(choice.value);
          }}
          onCustom={
            config.harness === 'claude' && catalog?.catalog?.customIds === true
              ? model => void runModelCommand(model)
              : undefined
          }
          presentation={presentation}
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

/**
 * WHERE A PICKER IS DRAWN. The composer opens these bodies in one of two shells:
 * a bottom sheet on a phone, where the thumb is and a full-width list is the
 * comfortable target, and a small popover anchored to the chip everywhere else,
 * where a sheet rising from the bottom of a wide window was all chrome and no
 * choice. The `popover` bodies drop the headings and the explanatory prose — the
 * popover's own title says what it is — and keep every warning, refusal, notice
 * and failure, because those are the facts a switch is honest about.
 */
export type RuntimePickerPresentation = 'sheet' | 'popover';

/** One choice in a runtime picker: what it reads as, and what choosing it does. */
export interface RuntimeChoiceItem {
  readonly key: string;
  readonly label: string;
  /** The full spoken name; the consumers keep their established phrasing. */
  readonly ariaLabel: string;
  /** The value in force: drawn with a check and announced as checked. */
  readonly checked: boolean;
  readonly pending?: boolean;
  /** A short tag beside the name, such as `Default`. */
  readonly badge?: string;
  /** The raw value, when it differs from the name a reader is shown. */
  readonly detail?: string;
  /** The catalog's own one-line description, when it has one. */
  readonly description?: string;
  /** The heading of the group it is listed under (a model catalog's tier); items of one group are adjacent. */
  readonly group?: string;
  readonly onSelect: () => void;
}

/** Adjacent items under one heading, in order; one headless run when no item has a group. */
const menuGroups = (items: readonly RuntimeChoiceItem[]): readonly { group?: string; items: RuntimeChoiceItem[] }[] => {
  const groups: { group?: string; items: RuntimeChoiceItem[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.group === item.group) last.items.push(item);
    else groups.push({ ...(item.group === undefined ? {} : { group: item.group }), items: [item] });
  }
  return groups;
};

export interface RuntimeChoiceMenuProps {
  readonly ariaLabel: string;
  readonly items: readonly RuntimeChoiceItem[];
  readonly disabled: boolean;
  /** Rows sized for a pointer (popover) or for a thumb (sheet). */
  readonly presentation?: RuntimePickerPresentation;
}

const MENU_ITEM = '[role="menuitemradio"]:not(:disabled)';

/**
 * The single-choice list both pickers draw, in both shells.
 *
 * A `menu` of `menuitemradio`s rather than a radiogroup, because choosing here is
 * an ACTION — it sends a command to a running harness — and a radiogroup's arrow
 * keys select as they move. Arrow keys and Home/End only move focus; Enter or
 * Space chooses. The tab stop roves with focus and starts on the value in force,
 * which is also where focus lands when the list appears, so a keyboard reader who
 * opened the picker is standing on the current choice.
 *
 * A `div`, not the `<ul>` it replaced: a list element cannot take an interactive
 * role, and the menu role is what carries the label and the single-choice group.
 */
export function RuntimeChoiceMenu({ ariaLabel, items, disabled, presentation = 'sheet' }: RuntimeChoiceMenuProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const initial = items.find(item => item.checked)?.key ?? items[0]?.key;
  const [activeKey, setActiveKey] = useState(initial);
  const stop = items.some(item => item.key === activeKey) ? activeKey : initial;

  // Land on the value in force when the list first appears.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const nodes = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(MENU_ITEM)];
    const at = nodes.indexOf(document.activeElement as HTMLButtonElement);
    const last = nodes.length - 1;
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = at < 0 || at === last ? 0 : at + 1;
        break;
      case 'ArrowUp':
        next = at <= 0 ? last : at - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      case 'Enter':
      case ' ':
        // Handled here rather than left to the button so one key press is one
        // choice in every engine; a choice that was focused but became disabled
        // (a submit in flight) is simply not in `nodes`.
        event.preventDefault();
        nodes[at]?.click();
        return;
      default:
        return;
    }
    event.preventDefault();
    nodes[next]?.focus();
  };

  const dense = presentation === 'popover';
  return (
    <div
      aria-label={ariaLabel}
      aria-orientation="vertical"
      className={cn('grid gap-px', dense ? 'm-0' : 'mt-2')}
      onKeyDown={onKeyDown}
      ref={listRef}
      role="menu"
    >
      {menuGroups(items).map(({ group, items: grouped }) => {
        const buttons = grouped.map(item => (
          <button
            aria-busy={item.pending || undefined}
            aria-checked={item.checked}
            aria-label={item.ariaLabel}
            className={cn(
              'flex w-full items-center gap-sm rounded-control px-cell-x text-left',
              dense ? 'min-h-[34px] py-1' : 'min-h-[44px] py-1.5',
              'hover:bg-surface-2 focus:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
              item.checked ? 'text-fg' : 'text-fg-soft',
            )}
            disabled={disabled}
            key={item.key}
            onClick={item.onSelect}
            onFocus={() => setActiveKey(item.key)}
            role="menuitemradio"
            tabIndex={item.key === stop ? 0 : -1}
            title={item.description}
            type="button"
          >
            <span aria-hidden="true" className="flex w-4 shrink-0 justify-center text-accent">
              {item.checked ? <Check size={14} /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-sm">
                <span className="truncate font-semibold text-ui">{item.label}</span>
                {item.badge ? <span className="kt-label shrink-0">{item.badge}</span> : null}
                {item.detail ? (
                  <span className="mono ml-auto min-w-0 truncate text-meta text-muted">{item.detail}</span>
                ) : null}
              </span>
              {item.description ? (
                <span className="block truncate text-meta text-muted leading-base">{item.description}</span>
              ) : null}
            </span>
            {item.pending ? <LoaderCircle aria-hidden="true" className="shrink-0 animate-spin" size={15} /> : null}
          </button>
        ));
        if (group === undefined) return buttons;
        return (
          <fieldset aria-label={group} className="m-0 grid min-w-0 gap-px border-0 p-0" key={group}>
            <div aria-hidden="true" className="kt-label px-cell-x pt-1.5 pb-0.5">
              {group}
            </div>
            {buttons}
          </fieldset>
        );
      })}
    </div>
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
  /** Offered when the login's provider takes ids beyond its catalog: sends the typed id. */
  readonly onCustom?: ((model: string) => void) | undefined;
  readonly presentation?: RuntimePickerPresentation;
}

/** Presentational: the parent owns submit, notices and the Codex second step. */
export function RuntimeModelChoices({
  choices,
  currentModel,
  disabled,
  error,
  harness,
  onChoose,
  onCustom,
  presentation = 'sheet',
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
    <div className={presentation === 'popover' ? undefined : 'mt-3'}>
      {presentation === 'popover' ? null : (
        <p aria-live="polite" className="m-0 text-meta text-muted leading-base" role="status">
          {harness === 'codex'
            ? 'Live choices from this account’s Codex model catalog. Choose a model, then one of its advertised reasoning levels.'
            : 'Only this account’s advertised Claude choices are shown. The model chip updates when Claude confirms a switch.'}
        </p>
      )}
      <RuntimeChoiceMenu
        ariaLabel={`Switch ${harness} model in place`}
        disabled={disabled}
        items={groupByTier(choices).flatMap(group =>
          group.items.map(choice => {
            const current = choice.value === currentModel;
            const description = choice.description ?? contextWords(choice.context);
            return {
              key: choice.value,
              label: choice.label,
              ariaLabel: `Switch model in place to ${choice.label}${current ? ', current' : ''}`,
              checked: current,
              pending: choice.value === submittingModel,
              ...(group.heading === undefined ? {} : { group: group.heading }),
              ...(!current && choice.isDefault ? { badge: 'Default' } : {}),
              ...(choice.label === choice.value ? {} : { detail: choice.value }),
              ...(description ? { description } : {}),
              onSelect: () => onChoose(choice),
            };
          }),
        )}
        presentation={presentation}
      />
      {onCustom ? <CustomModelForm disabled={disabled} onSubmit={onCustom} presentation={presentation} /> : null}
    </div>
  );
}

/**
 * "Custom id…": for a login whose provider serves ids beyond its catalog (docs/model-catalog.md). The
 * id is checked as one word a CLI takes after `/model` before it is sent; the daemon checks it again.
 */
export function CustomModelForm({
  disabled,
  onSubmit,
  presentation = 'sheet',
}: {
  readonly disabled: boolean;
  readonly onSubmit: (model: string) => void;
  readonly presentation?: RuntimePickerPresentation;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const id = value.trim();
  const valid = CUSTOM_MODEL_ID.test(id);
  const dense = presentation === 'popover';
  if (!open)
    return (
      <button
        className={cn(
          'mt-1 flex w-full items-center rounded-control px-cell-x text-left text-fg-soft text-ui hover:bg-surface-2',
          dense ? 'min-h-[34px]' : 'min-h-[44px]',
        )}
        disabled={disabled}
        onClick={() => setOpen(true)}
        type="button"
      >
        <span className="w-4 shrink-0" />
        <span className="pl-sm">Custom id…</span>
      </button>
    );
  return (
    <form
      className="mt-1 flex flex-wrap items-center gap-sm border-border-soft border-t px-cell-x pt-2"
      onSubmit={event => {
        event.preventDefault();
        if (valid) onSubmit(id);
      }}
    >
      <input
        aria-describedby={id.length > 0 && !valid ? 'custom-model-id-problem' : undefined}
        aria-label="Custom model id"
        className="kt-input mono min-h-[36px] min-w-0 flex-1"
        onChange={event => setValue(event.target.value)}
        placeholder="provider/model-id"
        spellCheck={false}
        value={value}
      />
      <button className="kt-btn min-h-[36px]" disabled={disabled || !valid} type="submit">
        Switch
      </button>
      {id.length > 0 && !valid ? (
        <p className="m-0 w-full text-err text-meta" id="custom-model-id-problem">
          One word: letters, digits and . _ : ~ / @ + - (a context suffix such as [1m] is fine).
        </p>
      ) : null}
    </form>
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
  readonly presentation?: RuntimePickerPresentation;
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
  presentation,
  submittingEffort,
}: RuntimeReasoningStepProps) {
  const backRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    backRef.current?.focus();
  }, []);
  return (
    <div className={presentation === 'popover' ? undefined : 'mt-3'}>
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
        presentation={presentation}
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
  readonly presentation?: RuntimePickerPresentation | undefined;
}

export function RuntimeReasoningChoices({
  currentEffort,
  disabled,
  model,
  onChoose,
  presentation = 'sheet',
  submittingEffort,
}: RuntimeReasoningChoicesProps) {
  if (model.reasoningEfforts.length === 0)
    return (
      <p className="mt-2 rounded-control border border-err-border bg-surface-2 p-3 text-err text-ui" role="alert">
        {model.label} did not advertise any supported reasoning levels. Use Codex’s native Terminal picker instead.
      </p>
    );
  return (
    <div className={presentation === 'popover' ? undefined : 'mt-3'}>
      {presentation === 'popover' ? null : (
        <p aria-live="polite" className="m-0 text-meta text-muted leading-base" role="status">
          Reasoning for <span className="mono text-fg-soft">{model.value}</span>. The switch stays pending until Codex
          reports this exact model and level.
        </p>
      )}
      <RuntimeChoiceMenu
        ariaLabel={`Set reasoning for ${model.label}`}
        disabled={disabled}
        items={model.reasoningEfforts.map(effort => {
          const current = effort.value === currentEffort;
          return {
            key: effort.value,
            label: effortDisplayName(effort.value),
            ariaLabel: `Set ${model.label} reasoning to ${effortDisplayName(effort.value)}${current ? ', current' : ''}`,
            checked: current,
            pending: effort.value === submittingEffort,
            ...(!current && effort.value === model.defaultReasoningEffort ? { badge: 'Default' } : {}),
            ...(effort.description ? { description: effort.description } : {}),
            onSelect: () => onChoose(effort.value),
          };
        })}
        presentation={presentation}
      />
    </div>
  );
}

/** The four Claude levels, mirroring `RuntimeModelChoices`. Presentational: the
 *  parent owns submit + notices. `current` is the level last SENT this session,
 *  else the one the session launched with — Claude never echoes it back. */
export function ClaudeEffortChoices({
  current,
  disabled,
  levels = CLAUDE_EFFORT_LEVELS,
  model,
  onChoose,
  presentation = 'sheet',
}: {
  readonly current?: string | undefined;
  readonly disabled: boolean;
  /** The levels the model in force takes, from its login's model catalog; Claude Code's own when it has none. */
  readonly levels?: readonly string[];
  /** The model in force, named when it takes no effort at all. */
  readonly model?: string | undefined;
  readonly onChoose: (level: string) => void;
  readonly presentation?: RuntimePickerPresentation | undefined;
}) {
  if (levels.length === 0)
    return (
      <p
        className={cn('text-meta text-muted leading-base', presentation === 'popover' ? 'm-0 px-cell-x py-1' : 'mt-3')}
      >
        {model ?? 'This model'} takes no reasoning effort, so there is nothing to set.
      </p>
    );
  return (
    <div className={presentation === 'popover' ? undefined : 'mt-3'}>
      {presentation === 'popover' ? null : (
        <p className="m-0 text-meta text-muted leading-base">
          Reasoning effort for new Claude turns. Persists to this account’s settings (saved as the default for new
          sessions). Claude does not echo the level back, so it is shown as sent, not re-verified.
        </p>
      )}
      <RuntimeChoiceMenu
        ariaLabel="Set Claude reasoning effort"
        disabled={disabled}
        items={levels.map(level => ({
          key: level,
          label: effortDisplayName(level),
          ariaLabel: `Set reasoning effort to ${level}`,
          checked: level === current,
          onSelect: () => onChoose(level),
        }))}
        presentation={presentation}
      />
      {presentation === 'popover' ? (
        <p className="mt-1 mb-0 border-border-soft border-t px-cell-x pt-1.5 pb-0.5 text-meta text-muted leading-base">
          Also saved as this account’s default for new sessions.
        </p>
      ) : null}
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
  claudeEffort,
  daemon,
  newRequestId = defaultRequestId,
  onClaudeEffortSent,
  onClose,
  onSwitchFailed,
  onSwitchSubmitted,
  onOpenTerminal,
  presentation = 'sheet',
  view,
}: RuntimeEffortControlsProps) {
  const popover = presentation === 'popover';
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
    canControl && !terminal,
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

  const runningModel = runtimeModelInForce(view);
  const currentCodexModel = catalog?.choices.find(choice => choice.value === runningModel);
  const claudeLevels = claudeEffortLevels(catalog, runningModel);
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
      setNotice(
        level === 'max'
          ? 'Effort set to max for this session. Claude Code does not save max as a default; the next turn uses it.'
          : `Effort set to ${level}. Saved as this account’s default for new sessions, and the next turn uses it.`,
      );
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
    <div className={popover ? undefined : 'mt-4 border-border-soft border-t pt-3'} data-daemon-id={daemon.daemonId}>
      {popover ? null : <h3 className="m-0 font-semibold text-fg text-ui">{title}</h3>}
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
        <ClaudeEffortChoices
          current={claudeEffort}
          disabled={submitting || promptRefused}
          levels={claudeLevels}
          model={currentCodexModel?.label ?? runningModel}
          onChoose={level => void runEffortCommand(level)}
          presentation={presentation}
        />
      ) : (
        <div className={popover ? undefined : 'mt-3'}>
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
              currentEffort={state.observedReasoningEffort?.trim() || config.launchReasoningEffort}
              disabled={submitting || promptRefused}
              model={currentCodexModel}
              onChoose={effort => void runCodexEffort(currentCodexModel, effort)}
              presentation={presentation}
              submittingEffort={codexSubmittingEffort ?? undefined}
            />
          ) : (
            <p className="m-0 rounded-control border border-err-border bg-surface-2 p-3 text-err text-ui" role="alert">
              The running model ({runningModel ?? 'unknown'}) is not in this account’s current Codex catalog. Refresh
              the session or use the native Terminal picker.
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
