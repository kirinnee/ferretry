/**
 * The model AND reasoning switches, ON the chat bar.
 *
 * The composer's status line already NAMES the model. The reader asked for the bar
 * to be the place you CHANGE things too — one tap from where you already are,
 * instead of buried in the `⋯` details sheet, which is a hard one-handed reach on a
 * phone. That request was explicitly about the REASONING level, for BOTH harnesses.
 *
 * So the bar carries TWO tap targets side by side, each opening a focused bottom
 * sheet:
 *   - The MODEL chip opens the model switcher.
 *   - The REASONING chip opens the reasoning switcher. Claude effort is a real
 *     in-session command that persists to the account's settings; Codex reasoning
 *     is not a string command at all — its levels are advertised per model and the
 *     daemon drives the native picker.
 *   - Only harness-OBSERVED truth is shown. The model and (Codex) reasoning
 *     readouts go stale-until-evidence after a switch; Claude effort is shown as
 *     the level last SENT this session (a confirmed persisted write), never as an
 *     observed running value, because Claude does not echo it back.
 *   - The IN-PLACE switches here are deliberately kept apart from the destructive
 *     "move account + relaunch", which stays in the details sheet only.
 *
 * Each trigger disables on a busy, terminal or read-only session — a switch cannot
 * land on any of those — and the reason is carried non-visually.
 *
 * HIT AREA: both chips are ordinary buttons that take the app's standard 44px
 * coarse-pointer target floor. The row is `data-kb-hide`, so it is `display:none`
 * while the keyboard is up — the same state the reclaimed composer height is
 * measured in — which means a 44px rest height here costs the typing layout
 * nothing. kteam's earlier downward `::after` overlay could only reach ~33px at the
 * composer's bottom edge, because there was no dead space beneath it to grow into.
 *
 * Ported from kteam's `src/components/ComposerRuntime.tsx`.
 *
 * WHAT THIS FILE DOES NOT CARRY, AND WHY. kteam imported `RuntimeModelControls`
 * and `RuntimeEffortControls` from `SessionDetails` — deliberately, so the harness
 * rules had ONE implementation shared with the details sheet. Those controls are
 * not ported yet, and reimplementing them here would create the second copy the
 * original was written to avoid. So the sheet BODIES arrive as render props: this
 * file owns the bar, the two triggers, the sheets, and the stale-until-evidence
 * bookkeeping, and hands each body the pending callbacks it must drive. When the
 * runtime controls land, they are passed in — nothing here changes.
 */

import type { SessionView } from '@ferretry/protocol';
import { Brain, ChevronsUpDown } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useKeyboardOpen } from '../hooks/use-keyboard-open.ts';
import { cn } from '../lib/class-names.ts';
import { isTerminalSessionStatus } from '../lib/session-screens.ts';
import { BottomSheet } from '../shell/bottom-sheet.tsx';

/** The model fact a switch is measured against: its value AND its timestamp. */
export interface ModelObservation {
  readonly model?: string;
  readonly observedAt?: string;
}

export interface CodexReasoningObservation {
  readonly effort?: string;
  readonly observedAt?: string;
}

/**
 * A switch is confirmed by ANY change to the observed model fact — including
 * re-selecting the model already running, which changes only the timestamp.
 */
export const modelObservationChanged = (before: ModelObservation, current: ModelObservation): boolean =>
  before.model !== current.model || before.observedAt !== current.observedAt;

/**
 * Codex echoes model + effort as one runtime-settings fact, so the model
 * observation timestamp is also the freshness token for reasoning. Comparing the
 * effort value alone left "switching…" stuck when the reader re-selected the
 * already-observed level.
 */
export const codexReasoningObservationChanged = (
  before: CodexReasoningObservation,
  current: CodexReasoningObservation,
): boolean => before.effort !== current.effort || before.observedAt !== current.observedAt;

/**
 * Why a switch cannot be offered, in precedence order, or undefined when it can.
 * Read-only wins over finished, which wins over busy: the outermost fact about the
 * reader's authority is the one worth telling them.
 */
export const runtimeSwitchDisabledReason = (
  canControl: boolean,
  terminal: boolean,
  busy: boolean,
): string | undefined => {
  if (!canControl) return 'Read-only origin: it cannot change the running session.';
  if (terminal) return 'Session finished: resume it before switching.';
  if (busy) return 'Busy: wait for an idle prompt to switch.';
  return undefined;
};

/**
 * The model chip's readout: the observed runtime model, going STALE (not wrong)
 * after a switch until fresh evidence lands. The launch request is a last resort
 * and is never presented as observed truth.
 */
export const runtimeModelChipLabel = (view: SessionView): string => {
  const observed = view.state.observedModel?.trim();
  if (observed) return observed;
  const requested = view.config.model?.trim() || view.config.modelHint?.trim();
  return requested || 'set model';
};

/** The callbacks a sheet body drives so the bar's readouts stay honest. */
export interface RuntimeSwitchLifecycle {
  /** A switch was submitted: the readout goes stale-until-evidence. */
  readonly onSwitchSubmitted: () => void;
  /** The submit failed, so nothing is pending and the readout is current again. */
  readonly onSwitchFailed: () => void;
  /** Claude effort is not observable; a successful send is all there is to show. */
  readonly onClaudeEffortSent: (effort: string) => void;
  readonly onClose: () => void;
}

export interface ComposerRuntimeProps {
  readonly view: SessionView;
  /** A token-less origin is read-only and cannot send a runtime command. */
  readonly canControl: boolean;
  /** The session is mid-turn: a switch needs an idle prompt, so the trigger is
   *  disabled, matching the details sheet's refusal of a busy pane. */
  readonly busy: boolean;
  /** The model switcher's body. Not built here — see the file header. */
  readonly renderModelControls?: (lifecycle: RuntimeSwitchLifecycle) => ReactNode;
  /** The reasoning switcher's body. Not built here — see the file header. */
  readonly renderEffortControls?: (lifecycle: RuntimeSwitchLifecycle) => ReactNode;
}

interface ChipProps {
  readonly id: string;
  readonly sheetId: string;
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly reasonId: string;
  /** Full spoken purpose, e.g. "Switch model — currently claude-opus-5". */
  readonly ariaLabel: string;
  readonly title: string;
  /** Leading glyph; the model chip has none, the reasoning chip carries a Brain so
   *  the two are told apart without relying on their text alone. */
  readonly leadingIcon?: ReactNode;
  readonly label: string;
  /** Only the model and Codex-reasoning readouts are ever "switching"; Claude
   *  effort never claims a stale-until-evidence state — it is not observed. */
  readonly pending?: boolean;
}

/**
 * One bar chip: a small readout that is also a 44px dialog trigger. It takes the
 * standard target floor rather than an overlay, so both chips share the row's real
 * height.
 */
function RuntimeChip({
  id,
  sheetId,
  open,
  onOpen,
  disabled,
  disabledReason,
  reasonId,
  ariaLabel,
  title,
  leadingIcon,
  label,
  pending,
}: ChipProps) {
  return (
    <button
      aria-controls={open ? sheetId : undefined}
      aria-describedby={disabledReason ? reasonId : undefined}
      aria-disabled={disabled}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={`${ariaLabel}${pending ? ', switching' : ''}`}
      className={cn(
        'fy-composer__runtime mono inline-flex min-w-[44px] items-center gap-xs rounded-control px-1 text-chrome text-fg-soft',
        'hover:text-accent disabled:cursor-not-allowed disabled:hover:text-fg-soft',
      )}
      disabled={disabled}
      id={id}
      onClick={onOpen}
      title={disabledReason ?? title}
      type="button"
    >
      {leadingIcon}
      <span className="min-w-0 truncate">{label}</span>
      {pending ? (
        <span aria-hidden="true" className="shrink-0 not-italic text-faint">
          · switching…
        </span>
      ) : null}
      <ChevronsUpDown aria-hidden="true" className="shrink-0" size={11} />
    </button>
  );
}

/** Shared sheet header, so the two bar sheets read identically to each other. */
function SheetHead({ title, harness }: { readonly title: string; readonly harness: string }) {
  return (
    <div className="shrink-0 border-b border-border-soft">
      <div className="mx-auto flex w-full min-w-0 max-w-2xl items-baseline gap-sm px-panel pb-row-y">
        <span className="min-w-0 flex-1 truncate font-display font-semibold tracking-display text-fg text-title">
          {title}
        </span>
        <span className="fy-label shrink-0">{harness}</span>
      </div>
    </div>
  );
}

export function ComposerRuntime({
  view,
  canControl,
  busy,
  renderModelControls,
  renderEffortControls,
}: ComposerRuntimeProps) {
  const { config, state } = view;
  const baseId = useId();
  const modelTriggerId = `${baseId}-model`;
  const effortTriggerId = `${baseId}-effort`;
  const modelSheetId = `${baseId}-model-sheet`;
  const effortSheetId = `${baseId}-effort-sheet`;
  const reasonId = `${baseId}-reason`;
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);

  // The row is `data-kb-hide`, and these chips own dialogs — the one thing that
  // subtree class must never hide with an open panel inside it. In practice a chip
  // tap blurs the composer so the keyboard is already down when a sheet is open,
  // but close defensively if the keyboard ever rises under an open sheet.
  const keyboardOpen = useKeyboardOpen();
  useEffect(() => {
    if (keyboardOpen) {
      setModelOpen(false);
      setEffortOpen(false);
    }
  }, [keyboardOpen]);

  const observedModel = state.observedModel?.trim();
  const modelAtSwitchRef = useRef<ModelObservation | undefined>(undefined);
  const [modelPending, setModelPending] = useState(false);
  useEffect(() => {
    const before = modelAtSwitchRef.current;
    if (
      modelPending &&
      before &&
      modelObservationChanged(before, { model: observedModel, observedAt: state.observedModelAt })
    )
      setModelPending(false);
  }, [modelPending, observedModel, state.observedModelAt]);

  const observedReasoning = config.harness === 'codex' ? state.observedReasoningEffort?.trim() : undefined;
  const reasoningAtSwitchRef = useRef<CodexReasoningObservation | undefined>(undefined);
  const [reasoningPending, setReasoningPending] = useState(false);
  useEffect(() => {
    const before = reasoningAtSwitchRef.current;
    if (
      reasoningPending &&
      before &&
      codexReasoningObservationChanged(before, { effort: observedReasoning, observedAt: state.observedModelAt })
    )
      setReasoningPending(false);
  }, [reasoningPending, observedReasoning, state.observedModelAt]);

  // Claude effort is not observable, so the chip reflects the level last SENT this
  // session, and resets when the session does.
  const [sentClaudeEffort, setSentClaudeEffort] = useState<string | undefined>(undefined);

  // A different session is a different runtime: nothing observed about the last one
  // is evidence about this one. Adjusted DURING render rather than in an effect, so
  // the new session never paints one frame carrying the previous session's
  // "switching…" or its last-sent effort.
  const [sessionAtReset, setSessionAtReset] = useState(config.id);
  if (sessionAtReset !== config.id) {
    setSessionAtReset(config.id);
    modelAtSwitchRef.current = undefined;
    reasoningAtSwitchRef.current = undefined;
    setModelPending(false);
    setReasoningPending(false);
    setSentClaudeEffort(undefined);
  }

  const markModelPending = useCallback(() => {
    modelAtSwitchRef.current = { model: observedModel, observedAt: state.observedModelAt };
    setModelPending(true);
  }, [observedModel, state.observedModelAt]);

  const markReasoningPending = useCallback(() => {
    reasoningAtSwitchRef.current = { effort: observedReasoning, observedAt: state.observedModelAt };
    setReasoningPending(true);
  }, [observedReasoning, state.observedModelAt]);

  const clearModelPending = useCallback(() => {
    modelAtSwitchRef.current = undefined;
    setModelPending(false);
  }, []);

  const clearReasoningPending = useCallback(() => {
    reasoningAtSwitchRef.current = undefined;
    setReasoningPending(false);
  }, []);

  // Codex reports model and reasoning together, so either switch makes BOTH
  // readouts stale until one observation confirms them.
  const codex = config.harness === 'codex';
  const submitted = useCallback(() => {
    markModelPending();
    if (codex) markReasoningPending();
  }, [codex, markModelPending, markReasoningPending]);
  const failed = useCallback(() => {
    clearModelPending();
    if (codex) clearReasoningPending();
  }, [codex, clearModelPending, clearReasoningPending]);

  const terminal = isTerminalSessionStatus(state.status);
  const disabledReason = runtimeSwitchDisabledReason(canControl, terminal, busy);
  const disabled = disabledReason !== undefined;

  const modelLabel = runtimeModelChipLabel(view);
  // The reasoning chip's readout: Codex shows its observed level; Claude shows the
  // level it last sent, else a neutral verb. Never an unverified claim.
  const effortLabel = codex ? observedReasoning || 'reasoning' : sentClaudeEffort || 'effort';
  const effortAria = codex
    ? `Set reasoning level — currently ${observedReasoning || 'unknown'}`
    : sentClaudeEffort
      ? `Set reasoning effort — last set to ${sentClaudeEffort} this session`
      : 'Set reasoning effort';

  const modelLifecycle: RuntimeSwitchLifecycle = {
    onSwitchSubmitted: submitted,
    onSwitchFailed: failed,
    onClaudeEffortSent: setSentClaudeEffort,
    onClose: () => setModelOpen(false),
  };
  const effortLifecycle: RuntimeSwitchLifecycle = {
    ...modelLifecycle,
    onClose: () => setEffortOpen(false),
  };

  return (
    <>
      <div className="fy-composer__runtime-row inline-flex min-w-0 items-center gap-xs" data-kb-hide>
        <RuntimeChip
          ariaLabel={`Switch model — currently ${modelLabel}`}
          disabled={disabled}
          disabledReason={disabledReason}
          id={modelTriggerId}
          label={modelLabel}
          onOpen={() => setModelOpen(true)}
          open={modelOpen}
          pending={modelPending}
          reasonId={reasonId}
          sheetId={modelSheetId}
          title="Switch model in place"
        />
        <RuntimeChip
          ariaLabel={effortAria}
          disabled={disabled}
          disabledReason={disabledReason}
          id={effortTriggerId}
          label={effortLabel}
          leadingIcon={<Brain aria-hidden="true" className="shrink-0" size={11} />}
          onOpen={() => setEffortOpen(true)}
          open={effortOpen}
          pending={codex && reasoningPending}
          reasonId={reasonId}
          sheetId={effortSheetId}
          title="Change the reasoning level"
        />
      </div>
      {disabledReason ? (
        <span className="sr-only" id={reasonId}>
          {disabledReason}
        </span>
      ) : null}

      <BottomSheet
        ariaLabel="Switch model"
        closeLabel="Close model switcher"
        id={modelSheetId}
        labelledBy={modelTriggerId}
        onClose={() => setModelOpen(false)}
        open={modelOpen}
        zIndexClass="z-50"
      >
        <SheetHead harness={config.harness} title="Switch model" />
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto w-full max-w-2xl px-panel py-row-y">{renderModelControls?.(modelLifecycle)}</div>
        </div>
      </BottomSheet>

      <BottomSheet
        ariaLabel="Change reasoning level"
        closeLabel="Close reasoning switcher"
        id={effortSheetId}
        labelledBy={effortTriggerId}
        onClose={() => setEffortOpen(false)}
        open={effortOpen}
        zIndexClass="z-50"
      >
        <SheetHead harness={config.harness} title="Reasoning effort" />
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto w-full max-w-2xl px-panel py-row-y">{renderEffortControls?.(effortLifecycle)}</div>
        </div>
      </BottomSheet>
    </>
  );
}
