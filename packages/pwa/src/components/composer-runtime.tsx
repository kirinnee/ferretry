/**
 * The model AND reasoning switches, ON the chat bar.
 *
 * The composer's status line already NAMES the model. The reader asked for the bar
 * to be the place you CHANGE things too — one tap from where you already are,
 * instead of buried in the `⋯` details sheet, which is a hard one-handed reach on a
 * phone. That request was explicitly about the REASONING level, for BOTH harnesses.
 *
 * So the bar carries TWO tap targets side by side, each opening a focused picker —
 * a bottom sheet on a phone, a small popover anchored to the chip elsewhere:
 *   - The MODEL chip opens the model switcher.
 *   - The REASONING chip opens the reasoning switcher. Claude effort is a real
 *     in-session command that persists to the account's settings; Codex reasoning
 *     is not a string command at all — its levels are advertised per model and the
 *     daemon drives the native picker.
 *   - Harness-OBSERVED truth wins. The model and (Codex) reasoning readouts go
 *     stale-until-evidence after a switch — for a bounded time, after which they
 *     say the switch went unconfirmed rather than promise it forever. Claude
 *     effort is shown as the level last SENT this session (a confirmed persisted
 *     write), because Claude does not echo it back.
 *   - BEFORE THE HARNESS HAS SAID ANYTHING the readouts fall back to the runtime
 *     the session was LAUNCHED with: the model on its launch argv and the level
 *     the start request or the runtime's settings file named, else the harness
 *     default. A brand-new session has no transcript, and "model unavailable"
 *     beside an empty effort chip was answering a question the launch already
 *     answered. The spoken label says which of the two it is.
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
import { createPortal } from 'react-dom';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { isTopEscapeLayer, pushEscapeLayer } from '../hooks/use-dialog-focus.ts';
import { useKeyboardOpen } from '../hooks/use-keyboard-open.ts';
import { cn } from '../lib/class-names.ts';
import { isTerminalSessionStatus } from '../lib/session-screens.ts';
import { BottomSheet } from '../shell/bottom-sheet.tsx';
import { clampMenuPosition, type MenuPosition, type MenuSize, type MenuViewport } from '../shell/context-menu.tsx';
import type { RuntimePickerPresentation } from './runtime-controls.tsx';

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

/** Where a submitted switch stands: nothing in flight, awaiting the harness, or given up on. */
export type RuntimeSwitchState = 'settled' | 'pending' | 'unconfirmed';

/**
 * How long a chip may say "switching…" before it admits the switch was not confirmed. Long enough
 * for the daemon's 15-second monitor tick to fold the harness's answer in and a refresh to carry it
 * here; short enough that nobody stares at a promise the harness never kept.
 */
export const RUNTIME_SWITCH_CONFIRM_MS = 20_000;

interface SwitchConfirmation {
  readonly state: RuntimeSwitchState;
  readonly mark: () => void;
  readonly clear: () => void;
}

/**
 * The stale-until-evidence bookkeeping for ONE readout, and the bound on it.
 *
 * "switching…" is a claim that evidence is on its way, so it must never be permanent. It ends in
 * exactly one of these ways:
 *   - the observed fact CHANGES (any change — re-selecting the running value moves only the
 *     timestamp) → settled, the readout is current again;
 *   - the submit FAILED → settled, nothing was switched;
 *   - the session goes BUSY or TERMINAL → settled: a new turn restates the runtime anyway, and a
 *     finished session will never confirm anything;
 *   - `timeoutMs` passes with none of the above → unconfirmed, which keeps naming the last OBSERVED
 *     value and says it could not confirm the switch. Late evidence still settles it.
 * A different session is a different runtime, so nothing carries across one.
 */
export function useSwitchConfirmation<T>(
  evidence: T,
  changed: (before: T, current: T) => boolean,
  sessionId: string,
  busy: boolean,
  terminal: boolean,
  timeoutMs: number,
): SwitchConfirmation {
  const atSwitch = useRef<T | undefined>(undefined);
  const [state, setState] = useState<RuntimeSwitchState>('settled');

  // Adjusted DURING render rather than in an effect, so the new session never paints one frame
  // carrying the previous session's "switching…".
  const [sessionAtReset, setSessionAtReset] = useState(sessionId);
  if (sessionAtReset !== sessionId) {
    setSessionAtReset(sessionId);
    atSwitch.current = undefined;
    setState('settled');
  }

  const clear = useCallback(() => {
    atSwitch.current = undefined;
    setState('settled');
  }, []);

  // No dependency list: the evidence is a fresh object every render, and the check is a comparison.
  useEffect(() => {
    const before = atSwitch.current;
    if (state !== 'settled' && before !== undefined && changed(before, evidence)) clear();
  });

  useEffect(() => {
    if (terminal || (busy && state === 'pending')) clear();
  }, [busy, terminal, state, clear]);

  useEffect(() => {
    if (state !== 'pending') return;
    const timer = setTimeout(() => setState('unconfirmed'), timeoutMs);
    return () => clearTimeout(timer);
  }, [state, timeoutMs]);

  const evidenceRef = useRef(evidence);
  evidenceRef.current = evidence;
  const mark = useCallback(() => {
    atSwitch.current = evidenceRef.current;
    setState('pending');
  }, []);

  return { state, mark, clear };
}

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

const present = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

/**
 * The model the session was LAUNCHED on. The daemon puts the resolved model on
 * the argv and appends the operator's own flags after it, so a `--model` (or
 * Codex's `-m`) among those flags is the one the harness actually started on.
 */
export const launchedModel = (config: SessionView['config']): string | undefined => {
  // A hand-built view (a fixture, a harness frame) may omit the flags; the wire never does.
  const flags: readonly string[] = config.harnessFlags ?? [];
  let flagged: string | undefined;
  flags.forEach((flag, index) => {
    if (flag === '--model' || flag === '-m') flagged = present(flags[index + 1]) ?? flagged;
    else if (flag.startsWith('--model=')) flagged = present(flag.slice('--model='.length)) ?? flagged;
  });
  return flagged ?? present(config.model) ?? present(config.modelHint);
};

/**
 * The model chip's readout: the observed runtime model, going STALE (not wrong)
 * after a switch until fresh evidence lands — else, before the harness has
 * reported one, the model it was launched on.
 */
export const runtimeModelChipLabel = (view: SessionView): string =>
  present(view.state.observedModel) ?? launchedModel(view.config) ?? 'model unavailable';

/** What the reasoning chip prints, and what it says aloud about where that came from. */
export interface RuntimeEffortReadout {
  readonly label: string;
  readonly aria: string;
}

/**
 * The reasoning chip: what the harness reported (Codex) or what was last sent
 * this session (Claude), else the level the session was launched on, else the
 * harness's own default — said as `default`, never left blank.
 */
export const runtimeEffortReadout = (view: SessionView, sentClaudeEffort: string | undefined): RuntimeEffortReadout => {
  const codex = view.config.harness === 'codex';
  const verb = codex ? 'Set reasoning level' : 'Set reasoning effort';
  const current = codex ? present(view.state.observedReasoningEffort) : present(sentClaudeEffort);
  if (current !== undefined)
    return {
      label: current,
      aria: codex ? `${verb} — currently ${current}` : `${verb} — last set to ${current} this session`,
    };
  const launched = present(view.config.launchReasoningEffort);
  if (launched !== undefined) return { label: launched, aria: `${verb} — launched with ${launched}` };
  return { label: 'default', aria: `${verb} — the harness default` };
};

/** The callbacks a sheet body drives so the bar's readouts stay honest. */
export interface RuntimeSwitchLifecycle {
  /** Whether this particular sheet is open. The shared body uses this to read
   * its catalog only while it is visible, without maintaining a second sheet
   * state outside the composer runtime. */
  readonly open: boolean;
  /** Which shell the body is drawn in, so a popover body can drop the prose a
   *  sheet has room for. */
  readonly presentation: RuntimePickerPresentation;
  /** The Claude effort the chip shows as in force — last sent this session, else
   *  the launch level — so the picker can check the same value the chip names. */
  readonly claudeEffort?: string;
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
  /** `sheet` (the default) on a phone; `popover` — a small menu anchored to the
   *  chip — wherever there is a pointer and room, so a two-word choice does not
   *  raise a panel the width of the window. */
  readonly presentation?: RuntimePickerPresentation;
  /** The model switcher's body. Not built here — see the file header. */
  readonly renderModelControls?: (lifecycle: RuntimeSwitchLifecycle) => ReactNode;
  /** The reasoning switcher's body. Not built here — see the file header. */
  readonly renderEffortControls?: (lifecycle: RuntimeSwitchLifecycle) => ReactNode;
  /** The fast-mode toggle, drawn after the two chips. A switch, not a picker: it owns no sheet. */
  readonly renderFast?: () => ReactNode;
  /**
   * Draw the popovers and sheets at the document's root instead of beside the chips. For a host that
   * is itself inside a moving panel (Info's phone sheet is a transformed box): a fixed overlay inside
   * one is placed against that panel rather than the screen, so a sheet would open half off-screen.
   */
  readonly portalOverlays?: boolean;
  /** How long "switching…" may stand unconfirmed; {@link RUNTIME_SWITCH_CONFIRM_MS} unless a test shortens it. */
  readonly switchConfirmMs?: number;
}

export interface ComposerRuntimeWithKeyboardProps extends ComposerRuntimeProps {
  /** The already-observed shared keyboard signal. */
  readonly keyboardOpen: boolean;
}

interface ChipProps {
  readonly id: string;
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
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
  readonly switchState?: RuntimeSwitchState;
}

/** What a chip appends — on screen, aloud and on hover — for a switch that has not settled. */
const SWITCH_MARK: Readonly<
  Record<Exclude<RuntimeSwitchState, 'settled'>, { text: string; aria: string; title: string }>
> = {
  pending: { text: '· switching…', aria: ', switching', title: 'Switching — waiting for the harness to confirm' },
  unconfirmed: {
    text: '· unconfirmed',
    aria: ', could not confirm the switch; showing the last reported value',
    title: 'Couldn’t confirm the switch — showing the last value the harness reported',
  },
};

/**
 * One bar chip: a small readout that is also a 44px dialog trigger. It takes the
 * standard target floor rather than an overlay, so both chips share the row's real
 * height.
 */
function RuntimeChip({
  id,
  buttonRef,
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
  switchState = 'settled',
}: ChipProps) {
  const mark = switchState === 'settled' ? undefined : SWITCH_MARK[switchState];
  return (
    <button
      aria-controls={open ? sheetId : undefined}
      aria-describedby={disabledReason ? reasonId : undefined}
      aria-disabled={disabled}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={`${ariaLabel}${mark?.aria ?? ''}`}
      className={cn(
        'fy-composer__runtime mono inline-flex min-w-[44px] items-center gap-xs rounded-control px-1 text-chrome text-fg-soft',
        'hover:text-accent disabled:cursor-not-allowed disabled:hover:text-fg-soft',
      )}
      disabled={disabled}
      id={id}
      onClick={onOpen}
      ref={buttonRef}
      title={disabledReason ?? mark?.title ?? title}
      type="button"
    >
      {leadingIcon}
      <span className="min-w-0 truncate">{label}</span>
      {mark ? (
        <span aria-hidden="true" className="shrink-0 not-italic text-faint" data-switch-state={switchState}>
          {mark.text}
        </span>
      ) : null}
      <ChevronsUpDown aria-hidden="true" className="shrink-0" size={11} />
    </button>
  );
}

/** The chip's box, as far as placing a popover against it is concerned. */
export interface ChipBox {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Where a picker popover sits against its chip. The chips live on the composer's
 * bottom edge, so the popover opens UPWARD, left-aligned with the chip and clear
 * of it by `gap`; only when there is no room above does it drop below instead.
 * The context menu's clamp is the final guarantee that it stays on screen. Pure,
 * so the placement is asserted without a layout engine.
 */
export const runtimePopoverPosition = (
  chip: ChipBox,
  size: MenuSize,
  viewport: MenuViewport,
  gap = 6,
  margin = 8,
): MenuPosition => {
  const above = chip.top - gap - size.height;
  const y = above >= margin ? above : chip.bottom + gap;
  return clampMenuPosition({ x: chip.left, y }, size, viewport, margin);
};

interface RuntimePopoverProps {
  readonly id: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly anchorRef: RefObject<HTMLButtonElement | null>;
  readonly title: string;
  readonly harness: string;
  readonly children: ReactNode;
}

/**
 * The desktop shell for a picker: a small non-modal panel anchored to its chip.
 *
 * It borrows the context menu's clamp and the app's escape-layer stack, and the
 * theme popover's focus policy: Escape closes and hands focus back to the chip,
 * an outside press or focus leaving the panel just closes (the reader has put
 * focus somewhere on purpose), and a window resize closes because the chip it
 * was measured against has moved. Not `aria-modal`: the page behind stays live.
 */
function RuntimePopover({ id, open, onClose, anchorRef, title, harness, children }: RuntimePopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const layer = useRef<object>({});
  // Read through a ref so the listeners below depend on `open` alone: a
  // re-registration would push this layer back to the TOP of the escape stack.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const token = layer.current;
    const release = pushEscapeLayer(token);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !isTopEscapeLayer(token)) return;
      event.stopPropagation();
      onCloseRef.current();
      anchorRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      // A press on a layer above this one belongs to that layer; a press on the
      // chip is the chip's own toggle.
      if (!isTopEscapeLayer(token)) return;
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    const onResize = () => onCloseRef.current();
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onResize);
      release();
    };
  }, [open, anchorRef]);

  // Focus the panel as it opens, in a LAYOUT effect, so the choice list's own
  // passive effect can then move focus on to the value in force.
  useLayoutEffect(() => {
    if (open) panelRef.current?.focus();
    else setPosition(null);
  }, [open]);

  // The placement is a function of the chip, the panel's size and the window.
  // The write keeps the previous object when nothing moved, so it cannot loop.
  const place = useCallback(() => {
    const panel = panelRef.current;
    const chip = anchorRef.current;
    if (!panel || !chip) return;
    const next = runtimePopoverPosition(
      chip.getBoundingClientRect(),
      { width: panel.offsetWidth, height: panel.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPosition(current => (current?.left === next.left && current.top === next.top ? current : next));
  }, [anchorRef]);

  // Place after every render of this shell, and again whenever the panel itself
  // changes size: the body re-renders on its own when its catalog arrives, and a
  // taller panel must be lifted rather than left hanging off the window's edge.
  useLayoutEffect(() => {
    if (open) place();
  });
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => place());
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open, place]);

  if (!open) return null;
  return (
    <div
      aria-label={title}
      className="kt-panel fixed z-50 flex w-[min(22rem,calc(100vw-16px))] flex-col overflow-hidden font-ui shadow-popover"
      data-runtime-popover={id}
      id={id}
      onBlur={event => {
        const next = event.relatedTarget as Node | null;
        if (next && !event.currentTarget.contains(next) && !anchorRef.current?.contains(next)) onClose();
      }}
      ref={panelRef}
      role="dialog"
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }}
      tabIndex={-1}
    >
      <div className="flex shrink-0 items-baseline gap-sm border-b border-border-soft px-cell-x py-1.5">
        <span className="min-w-0 flex-1 truncate font-semibold text-fg text-ui">{title}</span>
        <span className="fy-label shrink-0">{harness}</span>
      </div>
      <div className="max-h-[min(26rem,calc(100dvh-6rem))] min-h-0 overflow-y-auto scroll-thin p-1">{children}</div>
    </div>
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

/** Production wrapper: there is exactly one keyboard signal and every host observes it. */
export function ComposerRuntime(props: ComposerRuntimeProps) {
  const keyboardOpen = useKeyboardOpen();
  return <ComposerRuntimeWithKeyboard {...props} keyboardOpen={keyboardOpen} />;
}

/**
 * The runtime controls after the shared keyboard signal has been observed.
 * Keeping this seam explicit lets the behavior suite drive a transition
 * without racing other DOM suites over the process-wide `<html>` attribute.
 */
export function ComposerRuntimeWithKeyboard({
  view,
  canControl,
  busy,
  presentation = 'sheet',
  renderModelControls,
  renderEffortControls,
  renderFast,
  portalOverlays = false,
  switchConfirmMs = RUNTIME_SWITCH_CONFIRM_MS,
  keyboardOpen,
}: ComposerRuntimeWithKeyboardProps) {
  const { config, state } = view;
  const baseId = useId();
  const modelTriggerId = `${baseId}-model`;
  const effortTriggerId = `${baseId}-effort`;
  const modelSheetId = `${baseId}-model-sheet`;
  const effortSheetId = `${baseId}-effort-sheet`;
  const reasonId = `${baseId}-reason`;
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const modelChipRef = useRef<HTMLButtonElement | null>(null);
  const effortChipRef = useRef<HTMLButtonElement | null>(null);

  // The row is `data-kb-hide`, and these chips own dialogs — the one thing that
  // subtree class must never hide with an open panel inside it. In practice a chip
  // tap blurs the composer so the keyboard is already down when a sheet is open,
  // but close defensively if the keyboard ever rises under an open sheet.
  useEffect(() => {
    if (keyboardOpen) {
      setModelOpen(false);
      setEffortOpen(false);
    }
  }, [keyboardOpen]);

  const terminal = isTerminalSessionStatus(state.status);
  const modelSwitch = useSwitchConfirmation<ModelObservation>(
    { model: state.observedModel?.trim(), observedAt: state.observedModelAt },
    modelObservationChanged,
    config.id,
    busy,
    terminal,
    switchConfirmMs,
  );
  const reasoningSwitch = useSwitchConfirmation<CodexReasoningObservation>(
    {
      effort: config.harness === 'codex' ? state.observedReasoningEffort?.trim() : undefined,
      observedAt: state.observedModelAt,
    },
    codexReasoningObservationChanged,
    config.id,
    busy,
    terminal,
    switchConfirmMs,
  );

  // Claude effort is not observable, so the chip reflects the level last SENT this
  // session, and resets when the session does — during render, like the switches above,
  // so a new session never paints one frame with the previous one's level.
  const [sentClaudeEffort, setSentClaudeEffort] = useState<string | undefined>(undefined);
  const [sessionAtReset, setSessionAtReset] = useState(config.id);
  if (sessionAtReset !== config.id) {
    setSessionAtReset(config.id);
    setSentClaudeEffort(undefined);
  }

  // Codex reports model and reasoning together, so either switch makes BOTH
  // readouts stale until one observation confirms them.
  const codex = config.harness === 'codex';
  const { mark: markModel, clear: clearModel } = modelSwitch;
  const { mark: markReasoning, clear: clearReasoning } = reasoningSwitch;
  const submitted = useCallback(() => {
    markModel();
    if (codex) markReasoning();
  }, [codex, markModel, markReasoning]);
  const failed = useCallback(() => {
    clearModel();
    if (codex) clearReasoning();
  }, [codex, clearModel, clearReasoning]);

  const disabledReason = runtimeSwitchDisabledReason(canControl, terminal, busy);
  const disabled = disabledReason !== undefined;

  const modelLabel = runtimeModelChipLabel(view);
  const modelAria =
    present(state.observedModel) === undefined && launchedModel(config) !== undefined
      ? `Switch model — launched on ${modelLabel}`
      : `Switch model — currently ${modelLabel}`;
  const { label: effortLabel, aria: effortAria } = runtimeEffortReadout(view, sentClaudeEffort);

  const claudeEffort = present(sentClaudeEffort) ?? present(config.launchReasoningEffort);
  const closeModel = useCallback(() => setModelOpen(false), []);
  const closeEffort = useCallback(() => setEffortOpen(false), []);
  const modelLifecycle: RuntimeSwitchLifecycle = {
    open: modelOpen,
    presentation,
    ...(claudeEffort === undefined ? {} : { claudeEffort }),
    onSwitchSubmitted: submitted,
    onSwitchFailed: failed,
    onClaudeEffortSent: setSentClaudeEffort,
    onClose: closeModel,
  };
  const effortLifecycle: RuntimeSwitchLifecycle = {
    ...modelLifecycle,
    open: effortOpen,
    onClose: closeEffort,
  };
  const modelBody = renderModelControls?.(modelLifecycle);
  const effortBody = renderEffortControls?.(effortLifecycle);
  // The pickers' popovers or sheets: beside the chips, or at the document root when the host asks.
  const overlays =
    presentation === 'popover' ? (
      <>
        <RuntimePopover
          anchorRef={modelChipRef}
          harness={config.harness}
          id={modelSheetId}
          onClose={closeModel}
          open={modelOpen}
          title="Switch model"
        >
          {modelBody}
        </RuntimePopover>
        <RuntimePopover
          anchorRef={effortChipRef}
          harness={config.harness}
          id={effortSheetId}
          onClose={closeEffort}
          open={effortOpen}
          title="Reasoning effort"
        >
          {effortBody}
        </RuntimePopover>
      </>
    ) : (
      <>
        <BottomSheet
          ariaLabel="Switch model"
          closeLabel="Close model switcher"
          id={modelSheetId}
          labelledBy={modelTriggerId}
          onClose={closeModel}
          open={modelOpen}
          zIndexClass="z-50"
        >
          <SheetHead harness={config.harness} title="Switch model" />
          <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
            <div className="mx-auto w-full max-w-2xl px-panel py-row-y">{modelBody}</div>
          </div>
        </BottomSheet>

        <BottomSheet
          ariaLabel="Change reasoning level"
          closeLabel="Close reasoning switcher"
          id={effortSheetId}
          labelledBy={effortTriggerId}
          onClose={closeEffort}
          open={effortOpen}
          zIndexClass="z-50"
        >
          <SheetHead harness={config.harness} title="Reasoning effort" />
          <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
            <div className="mx-auto w-full max-w-2xl px-panel py-row-y">{effortBody}</div>
          </div>
        </BottomSheet>
      </>
    );

  return (
    <>
      <div className="fy-composer__runtime-row inline-flex min-w-0 items-center gap-xs" data-kb-hide>
        <RuntimeChip
          ariaLabel={modelAria}
          buttonRef={modelChipRef}
          disabled={disabled}
          disabledReason={disabledReason}
          id={modelTriggerId}
          label={modelLabel}
          onOpen={() => setModelOpen(open => !open)}
          open={modelOpen}
          switchState={modelSwitch.state}
          reasonId={reasonId}
          sheetId={modelSheetId}
          title="Switch model in place"
        />
        <RuntimeChip
          ariaLabel={effortAria}
          buttonRef={effortChipRef}
          disabled={disabled}
          disabledReason={disabledReason}
          id={effortTriggerId}
          label={effortLabel}
          leadingIcon={<Brain aria-hidden="true" className="shrink-0" size={11} />}
          onOpen={() => setEffortOpen(open => !open)}
          open={effortOpen}
          switchState={codex ? reasoningSwitch.state : 'settled'}
          reasonId={reasonId}
          sheetId={effortSheetId}
          title="Change the reasoning level"
        />
        {renderFast?.()}
      </div>
      {disabledReason ? (
        <span className="sr-only" id={reasonId}>
          {disabledReason}
        </span>
      ) : null}

      {portalOverlays && typeof document !== 'undefined' ? createPortal(overlays, document.body) : overlays}
    </>
  );
}
