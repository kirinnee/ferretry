/**
 * A send that is not (yet) in the conversation — still sending, held in the agent's queue, typed into its
 * composer but never submitted, settled without arriving, or taken back — shown as the reader's own
 * bubble with ONE receipt mark saying where it is (`send-receipt.tsx`), plus a small word when the state
 * needs the reader.
 *
 * The mark is a button: tapping it reads out WHY, which is the part a reader needs when a send is
 * anything but plainly fine. Beside it sits ONE small "⋯" button (`fy-ledger-more`) that opens a menu of
 * exactly the actions valid for the send's state, so a message that never lands is never something the
 * reader has to live with and never grows a toolbar either:
 *
 *   * CANCEL — takes it back, one tap. The daemon says what that did on the agent's screen (erased from
 *     the composer, or left in the agent's own queue, which Ferretry cannot edit); the row then says so.
 *   * PRESS ENTER — only for a message sitting typed in the composer: the harness never submits that by
 *     itself, so this presses Enter once. One tap, because the daemon refuses unless the composer holds
 *     exactly this message.
 *   * COPY TEXT — always, so cancelling never costs the words.
 *   * DISMISS — every message that is not delivered can be put away, on this device, with no question
 *     asked; and a settled one the reader opened can be hidden back to its one-line note.
 *   * RETRY, and every retry re-sends under the ORIGINAL id, so the daemon's ledger can never turn it
 *     into a second copy the agent reads without the reader being told:
 *       - NOT DELIVERED — the daemon proved it never arrived. Retry is one tap, because it cannot duplicate.
 *       - UNCONFIRMED — it could be proven neither way and may well have landed. "Send again" opens a
 *         warning that says what a second copy costs; nothing is sent until its own button is pressed.
 *       - SENDING / QUEUED — it may already be on its way. "Send again" opens the same warning first.
 *       - UNCONFIRMABLE — the daemon can prove no transcript is this session's, so NOTHING it sends can be
 *         confirmed. Offering "send again" there only types another copy into an agent that most likely
 *         has the first; the row says so instead, and the workspace's notice carries the remedies.
 *
 * Every action is latched synchronously through one ref, so a double activation is one request. When
 * the daemon refuses, its own sentence is shown — it knows why (the pane still shows the message typed,
 * the agent is holding it) and a generic "failed" would hide it.
 */

import { Ban, ChevronUp, Copy, CornerDownLeft, Ellipsis, Pencil, RotateCw, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { browserClipboardWriter, type ClipboardWriter } from '../features/onboarding/copy-button.tsx';
import { useInputModality } from '../hooks/use-input-modality.ts';
import { displayCallsign } from '../lib/callsign.ts';
import { type LedgerBlockPlacement, ledgerPlacementCopy } from '../lib/ledger-placement.ts';
import { clockOfInstant } from '../lib/message-clock.ts';
import { chipFromSender, ferretryChip, stripFraming } from '../lib/message-framing.ts';
import { peerFrom } from '../lib/peer-message.ts';
import type { LedgerSendRecord } from '../lib/send-ledger.ts';
import { effectiveQueueState } from '../lib/send-queue.ts';
import { ContextMenu, type ContextMenuItem, type MenuAnchor } from '../shell/context-menu.tsx';
import { Textarea } from '../shell/primitives.tsx';
import { useQueueActions } from './queue-actions-context.tsx';
import { MessageFooter } from './send-receipt.tsx';
import type { SendDismiss, SendExpand } from './settled-send-note.tsx';

export const UNBOUND_SEND_COPY =
  'Ferretry can’t confirm this, because it can’t find this session’s transcript. Check the Console tab before sending it again.';

export const RESEND_RISK_COPY =
  'The original may still have reached the agent. Sending again could make it read this twice — continue only if that is acceptable.';

export const OPEN_RESEND_RISK_COPY =
  'It may already be on its way. Sending again can make the agent read it twice — continue only if that is acceptable.';

export const QUEUED_CANCEL_COPY =
  'Cancelling removes it here only: the agent is holding it in its own queue and may still read it.';

/** Runs `action` at most once at a time. The latch is a ref and is set
 *  SYNCHRONOUSLY, so two activations in the same tick cannot both start. */
export const runResendOnce = async (
  latch: { current: boolean },
  action: () => Promise<boolean>,
): Promise<boolean | undefined> => {
  if (latch.current) return undefined;
  latch.current = true;
  try {
    return await action();
  } finally {
    latch.current = false;
  }
};

/** Re-sends a send under its original id. `force` is "send again anyway" for an unconfirmed or still-open one.
 *  Answers true only when the daemon accepted the new attempt. */
export type SendRetry = (record: LedgerSendRecord, force: boolean) => Promise<boolean>;

/** Takes a send back. Answers true only when the daemon accepted the cancel. */
export type SendCancel = (record: LedgerSendRecord) => Promise<boolean>;

/** Presses Enter once for a send typed in the agent's composer. Answers true only when the daemon did. */
export type SendSubmit = (record: LedgerSendRecord) => Promise<boolean>;

export interface LedgerMessageProps {
  readonly record: LedgerSendRecord;
  readonly placement?: LedgerBlockPlacement;
  readonly onRetry?: SendRetry;
  readonly onCancel?: SendCancel;
  readonly onSubmit?: SendSubmit;
  readonly onDismiss?: SendDismiss;
  readonly onCollapse?: SendExpand;
  readonly write?: ClipboardWriter;
}

type ActionKind = 'retry' | 'cancel' | 'enter' | 'edit';

/** What an action settled to. `message` is the daemon's own refusal sentence, when it gave one. */
interface Note {
  readonly kind: 'cancel' | 'enter' | 'edit';
  readonly result: 'done' | 'error';
  readonly message?: string | undefined;
}

const refusal = (error: unknown): string | undefined =>
  error instanceof Error && error.message.trim().length > 0 ? error.message.trim() : undefined;

export function LedgerMessage({
  record,
  placement = 'chronological',
  onRetry,
  onCancel,
  onSubmit,
  onDismiss,
  onCollapse,
  write = browserClipboardWriter(),
}: LedgerMessageProps) {
  const { from, body: peerBody } = peerFrom(record.message);
  const framed = stripFraming(peerBody);
  const body = framed.body;
  const chip =
    chipFromSender(record.queue?.by, displayCallsign) ??
    (from
      ? displayCallsign(from.name)
      : framed.ferretry || framed.feature !== undefined
        ? ferretryChip(framed)
        : undefined);
  const boundary = ledgerPlacementCopy(placement);
  return (
    <div className="kt-bubble-row" data-ledger-placement={placement}>
      <span className="sr-only">{from ? `${displayCallsign(from.name)} sent:` : 'You said:'}</span>
      <div className="kt-bubble">
        {/* No "You" header: the bubble's alignment already says who sent it. A teammate's message
            keeps its sender's name, because alignment cannot. */}
        {chip === undefined ? null : (
          <div className="px-panel pt-1 text-[10.5px] font-medium text-muted" data-sender-chip>
            {chip}
          </div>
        )}
        {boundary === undefined ? null : (
          <span className="sr-only" data-ledger-boundary>
            {boundary}
          </span>
        )}
        {body ? (
          <div className="kt-user-copy min-w-0 max-w-full whitespace-pre-wrap break-words px-panel pb-0 pt-1 text-[13px] leading-snug text-[color:var(--bubble-fg)]">
            {body}
          </div>
        ) : null}
        <LedgerActionsHost
          onCancel={onCancel}
          onCollapse={onCollapse}
          onDismiss={onDismiss}
          onRetry={onRetry}
          onSubmit={onSubmit}
          record={record}
          write={write}
        >
          {({ trigger, panels }) => (
            <>
              <div className="px-panel pb-1">
                <MessageFooter clock={clockOfInstant(record.acceptedAt)} record={record} trailing={trigger} />
              </div>
              {panels}
            </>
          )}
        </LedgerActionsHost>
      </div>
    </div>
  );
}

/**
 * How long a send still on its way keeps its "⋯" actions button out of sight. Almost every message
 * lands within a poll or two, and a control that appears beside the time only to vanish a second later
 * is the flicker a reader sees right after sending. A message still travelling after this long is the
 * one whose way out matters, and it gets it. A message typed into the agent's composer and never
 * submitted is not on its way at all, so its Press Enter shows at once.
 */
export const OPEN_SEND_SETTLE_MS = 8_000;

/** How long "Copied" stays up before the line folds away. */
const COPIED_NOTICE_MS = 2_500;

/** True until `settleMs` after `since`, re-rendering once when that moment passes. */
const useStillSettling = (since: number, settleMs: number, enabled: boolean): boolean => {
  const remaining = enabled && Number.isFinite(since) ? since + settleMs - Date.now() : 0;
  const [, settled] = useState(0);
  const settling = remaining > 0;
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => settled(tick => tick + 1), remaining);
    return () => clearTimeout(timer);
  });
  return settling;
};

export interface LedgerActionsProps {
  readonly record: LedgerSendRecord;
  readonly onRetry?: SendRetry | undefined;
  readonly onCancel?: SendCancel | undefined;
  readonly onSubmit?: SendSubmit | undefined;
  readonly onDismiss?: SendDismiss | undefined;
  readonly onCollapse?: SendExpand | undefined;
  readonly write?: ClipboardWriter;
  /** False draws nothing and keeps no timer — a send that is already in the conversation. */
  readonly enabled?: boolean;
}

/** The two halves of a send's actions: the small button that goes on the message's foot, and everything that is drawn under it. */
export interface LedgerActions {
  /** The "⋯" button and the menu it opens; null when this send offers nothing. Goes in `MessageFooter`'s `trailing`. */
  readonly trigger: ReactNode;
  /** The warning that guards a second copy, and what each action came to. Goes under the foot. */
  readonly panels: ReactNode;
}

const BUSY_COPY: Readonly<Record<ActionKind, string>> = {
  retry: 'Retrying…',
  cancel: 'Cancelling…',
  enter: 'Pressing Enter…',
  edit: 'Saving…',
};

/**
 * Everything a send that is NOT in the conversation offers: Retry, Send again, Cancel, Press Enter, Copy
 * text, Hide and Dismiss, plus the warnings that guard a second copy and what each action came to. The
 * actions live in ONE small "⋯" menu beside the status mark, so a message keeps the height it has when
 * nothing is wrong with it; the menu lists exactly the actions valid for the send's state. It is its own
 * component so the reader's own bubble and a teammate's draw the same controls, whichever shell carries
 * them: `children` receives the two halves and puts each where its shell wants it.
 */
export function LedgerActionsHost({
  children,
  ...props
}: LedgerActionsProps & { readonly children: (actions: LedgerActions) => ReactNode }) {
  return <>{children(useLedgerActions(props))}</>;
}

/** The "⋯" button and the menu it opens. Mounted only when a send has actions, so a row with none pays for nothing. */
function LedgerMoreMenu({
  items,
  busy,
  triggerRef,
}: {
  readonly items: readonly ContextMenuItem[];
  readonly busy: boolean;
  readonly triggerRef: { current: HTMLButtonElement | null };
}) {
  const modality = useInputModality();
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const openMenu = (): void => {
    if (busy) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    setAnchor({ x: rect?.right ?? 0, y: (rect?.bottom ?? 0) + 4 });
  };
  return (
    <>
      <button
        aria-busy={busy ? true : undefined}
        aria-expanded={anchor !== null}
        aria-haspopup="menu"
        aria-label="Message actions"
        className="fy-ledger-more"
        data-ledger-more=""
        onClick={openMenu}
        ref={triggerRef}
        title="Message actions"
        type="button"
      >
        <Ellipsis aria-hidden="true" size={16} />
      </button>
      <ContextMenu
        anchor={anchor ?? { x: 0, y: 0 }}
        ariaLabel="Message actions"
        items={items}
        onClose={() => setAnchor(null)}
        open={anchor !== null}
        touch={modality.touchAffected}
        triggerRef={triggerRef}
      />
    </>
  );
}

function useLedgerActions({
  record,
  onRetry,
  onCancel,
  onSubmit,
  onDismiss,
  onCollapse,
  write = browserClipboardWriter(),
  enabled = true,
}: LedgerActionsProps): LedgerActions {
  const body = stripFraming(peerFrom(record.message).body).body;
  const queueApi = useQueueActions();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const actionHeld = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState<ActionKind | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [note, setNote] = useState<Note | null>(null);
  const [outcome, setOutcome] = useState<{
    readonly result: 'accepted' | 'error';
    readonly attempt: number;
    readonly message?: string | undefined;
  } | null>(null);
  const attempt = record.attempt ?? 1;
  // A retry's word is about THAT attempt. Once a newer one has settled, the row says its own state, so
  // "Sending again" can never outlive the send it described.
  const settledSince =
    outcome !== null && attempt > outcome.attempt && record.fate !== 'accepted' && record.fate !== 'queued';
  const result = settledSince ? null : (outcome?.result ?? null);
  const retryable = record.fate === 'timed_out' && record.retryable === true;
  const unbound = record.fate === 'unaccounted' && record.unaccountedReason === 'transcript_unbound';
  const unconfirmed = record.fate === 'unaccounted' && !unbound;
  const delivered = record.fate === 'delivered';
  const open = (record.fate === 'accepted' || record.fate === 'queued') && record.held !== true;
  // A message the durable queue holds is already safe on the daemon: its tick says where it is and why it waits,
  // so it never offers a resend. Until it is typed it can be edited or cancelled in the queue itself.
  const queueState = effectiveQueueState(record);
  const queueBacked = queueState === 'queued' || queueState === 'typing' || queueState === 'failed';
  const queueEditable = queueState === 'queued' && record.fate === 'accepted' && queueApi !== null;
  const typed = record.typedNotSent === true && open;
  const settling = useStillSettling(Date.parse(record.acceptedAt), OPEN_SEND_SETTLE_MS, enabled && open && !typed);
  // Held for a revive is kept deliberately; delivered and cancelled are done. Everything else can be taken back.
  const actionable =
    !queueBacked && (open || ((record.fate === 'timed_out' || record.fate === 'unaccounted') && record.held !== true));
  const showCopy = !delivered && body.length > 0;
  const openRetry = open && !typed && !queueBacked && onRetry !== undefined && result !== 'accepted';
  const unconfirmedRetry = unconfirmed && onRetry !== undefined && result !== 'accepted';
  const resendable = openRetry || unconfirmedRetry;
  const retryOnce = retryable && !queueBacked && onRetry !== undefined && result !== 'accepted';
  const queuedCancel = record.fate === 'queued' && !typed && !queueBacked;

  // The warning is gone, so focus goes back to the button that opened the menu rather than to the page.
  const closeConfirm = (): void => {
    setConfirming(false);
    triggerRef.current?.focus();
  };

  const retry = async (force: boolean): Promise<void> => {
    if (!onRetry || actionHeld.current) return;
    setBusy('retry');
    setOutcome(null);
    setNote(null);
    try {
      const accepted = await runResendOnce(actionHeld, () => onRetry(record, force));
      if (accepted !== undefined) setOutcome({ result: accepted ? 'accepted' : 'error', attempt });
      if (accepted === true) closeConfirm();
    } catch (error) {
      setOutcome({ result: 'error', attempt, message: refusal(error) });
    } finally {
      setBusy(null);
    }
  };

  const act = async (kind: 'cancel' | 'enter', action: () => Promise<boolean>): Promise<void> => {
    if (actionHeld.current) return;
    setBusy(kind);
    setNote(null);
    setOutcome(null);
    try {
      const done = await runResendOnce(actionHeld, action);
      if (done !== undefined) setNote({ kind, result: done ? 'done' : 'error' });
    } catch (error) {
      setNote({ kind, result: 'error', message: refusal(error) });
    } finally {
      setBusy(null);
    }
  };

  const saveEdit = async (): Promise<void> => {
    const text = draft.trim();
    if (queueApi === null || text.length === 0 || actionHeld.current) return;
    setBusy('edit');
    setNote(null);
    try {
      const done = await runResendOnce(actionHeld, () => queueApi.edit(record, text));
      if (done !== undefined) setNote({ kind: 'edit', result: done ? 'done' : 'error' });
      if (done === true) setEditing(false);
    } catch (error) {
      // A refusal (typed in the meantime, or gone) means this row is stale: the refresh it triggered fixes it.
      setEditing(false);
      setNote({ kind: 'edit', result: 'error', message: refusal(error) });
    } finally {
      setBusy(null);
    }
  };

  const copy = (): void => {
    void write(body).then(
      () => setCopied('copied'),
      () => setCopied('failed'),
    );
  };

  useEffect(() => {
    if (copied !== 'copied') return;
    const timer = setTimeout(() => setCopied('idle'), COPIED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  // The warning is a new place to be, so focus goes to its safe button: a stray Enter keeps waiting.
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);

  // An action that leaves the row in place hands focus back to the button that opened the menu, so a
  // keyboard reader is never dropped at the top of the page. One that removes the row has nowhere to hand it.
  const stay = (run: () => void) => (): void => {
    triggerRef.current?.focus();
    run();
  };

  const items: ContextMenuItem[] = [];
  if (enabled && !settling) {
    if (typed && onSubmit !== undefined)
      items.push({
        key: 'enter',
        label: 'Press Enter',
        hint: 'Submit it in the agent’s composer',
        icon: <CornerDownLeft aria-hidden="true" size={16} />,
        onSelect: stay(() => void act('enter', () => onSubmit(record))),
      });
    if (retryOnce)
      items.push({
        key: 'retry',
        label: 'Retry',
        hint: 'It never arrived, so this cannot send it twice',
        icon: <RotateCw aria-hidden="true" size={16} />,
        onSelect: stay(() => void retry(false)),
      });
    if (resendable)
      items.push({
        key: 'send-again',
        label: 'Send again',
        hint: 'May make a second copy',
        icon: <RotateCw aria-hidden="true" size={16} />,
        onSelect: () => setConfirming(true),
      });
    if (queueEditable)
      items.push(
        {
          key: 'edit',
          label: 'Edit',
          hint: 'Change the words before they are typed in',
          icon: <Pencil aria-hidden="true" size={16} />,
          onSelect: () => {
            setDraft(record.message);
            setEditing(true);
          },
        },
        {
          key: 'cancel',
          label: 'Cancel',
          hint: 'Take it back before it is typed in',
          icon: <Ban aria-hidden="true" size={16} />,
          onSelect: stay(() => void act('cancel', () => queueApi.cancel(record))),
        },
      );
    if (actionable && onCancel !== undefined)
      items.push({
        key: 'cancel',
        label: 'Cancel',
        hint: queuedCancel ? QUEUED_CANCEL_COPY : 'Take it back',
        icon: <Ban aria-hidden="true" size={16} />,
        onSelect: stay(() => void act('cancel', () => onCancel(record))),
      });
    if (showCopy)
      items.push({
        key: 'copy',
        label: 'Copy text',
        icon: <Copy aria-hidden="true" size={16} />,
        onSelect: stay(copy),
      });
    if (onCollapse !== undefined && !delivered)
      items.push({
        key: 'hide',
        label: 'Hide',
        hint: 'Fold it back to one line',
        icon: <ChevronUp aria-hidden="true" size={16} />,
        separatorBefore: items.length > 0,
        onSelect: () => onCollapse(record, false),
      });
    if (onDismiss !== undefined && !delivered)
      items.push({
        key: 'dismiss',
        label: 'Dismiss',
        hint: 'Put it away on this device',
        icon: <X aria-hidden="true" size={16} />,
        separatorBefore: items.length > 0 && onCollapse === undefined,
        onSelect: () => onDismiss(record),
      });
  }

  const trigger =
    items.length === 0 ? null : <LedgerMoreMenu busy={busy !== null} items={items} triggerRef={triggerRef} />;

  const panels = !enabled ? null : (
    <>
      {resendable && confirming ? (
        <div
          className="mx-panel mb-2 rounded-control border border-warn-border bg-warn-bg px-2 py-1.5 text-[11px] text-warn"
          data-ledger-retry-confirm=""
        >
          <p>{openRetry ? OPEN_RESEND_RISK_COPY : RESEND_RISK_COPY}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <button
              className="kt-btn kt-btn--sm shrink-0"
              data-variant="danger"
              disabled={busy !== null}
              onClick={() => void retry(true)}
              type="button"
            >
              {busy === 'retry' ? 'sending…' : 'Send again anyway'}
            </button>
            <button className="kt-btn kt-btn--sm shrink-0" onClick={closeConfirm} ref={keepRef} type="button">
              {openRetry ? 'Keep waiting' : 'Not now'}
            </button>
          </div>
        </div>
      ) : null}
      {unbound ? (
        <p
          className="mx-panel mb-2 mt-0 border-t border-border-soft pt-1.5 text-[11px] text-muted"
          data-send-unbound=""
        >
          {UNBOUND_SEND_COPY}
        </p>
      ) : null}
      {editing && queueEditable ? (
        <div className="mx-panel mb-2" data-ledger-edit="">
          <Textarea
            aria-label="Edit message"
            className="w-full"
            onChange={event => setDraft(event.target.value)}
            rows={3}
            value={draft}
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <button
              className="kt-btn kt-btn--sm shrink-0"
              data-ledger-edit-save=""
              disabled={busy !== null || draft.trim().length === 0}
              onClick={() => void saveEdit()}
              type="button"
            >
              Save
            </button>
            <button className="kt-btn kt-btn--sm shrink-0" onClick={() => setEditing(false)} type="button">
              Keep as it was
            </button>
          </div>
        </div>
      ) : null}
      {busy !== null ? (
        <div className="mx-panel mb-2 text-[11px] text-muted" data-ledger-busy="" role="status">
          {BUSY_COPY[busy]}
        </div>
      ) : null}
      {copied === 'copied' ? (
        <div className="mx-panel mb-2 text-[11px] text-muted" role="status">
          Copied
        </div>
      ) : null}
      {copied === 'failed' ? (
        <div className="mx-panel mb-2 text-[11px] text-warn" role="status">
          Copy was blocked — select the text instead
        </div>
      ) : null}
      {result === 'accepted' ? (
        <div className="mx-panel mb-2 text-[11px] text-muted" role="status">
          Sending again — this row updates when the agent has it.
        </div>
      ) : null}
      {result === 'error' ? (
        <div className="mx-panel mb-2 text-[11px] text-err" role="alert">
          The retry did not go through — {outcome?.message ?? 'check this row before trying again.'}
        </div>
      ) : null}
      {note?.result === 'done' ? (
        <div className="mx-panel mb-2 text-[11px] text-muted" role="status">
          {note.kind === 'cancel'
            ? 'Cancel sent — this row updates once the agent’s screen has been checked.'
            : note.kind === 'edit'
              ? 'Saved — it waits with its new words.'
              : 'Enter pressed — this row updates when the agent has it.'}
        </div>
      ) : null}
      {note?.result === 'error' ? (
        <div className="mx-panel mb-2 text-[11px] text-err" role="alert">
          {note.kind === 'cancel'
            ? 'Cancel did not go through'
            : note.kind === 'edit'
              ? 'The edit was not saved'
              : 'Enter was not pressed'}{' '}
          — {note.message ?? 'check this row before trying again.'}
        </div>
      ) : null}
    </>
  );

  return { trigger, panels };
}
