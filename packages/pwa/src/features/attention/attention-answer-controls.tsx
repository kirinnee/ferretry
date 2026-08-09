import type { AttentionAsk, AttentionResponse } from '@ferretry/protocol';
import { Check, LoaderCircle, MessageCircleQuestion, Send } from 'lucide-react';
import { type CSSProperties, type PointerEvent as ReactPointerEvent, useId, useRef, useState } from 'react';

import { cn } from '../../lib/class-names.ts';
import { Button, Textarea } from '../../shell/primitives.tsx';

export type AttentionAnswerTone = 'affirmative' | 'negative' | 'neutral';

export type AttentionAnswerChoice =
  | {
      readonly kind: 'response';
      readonly key: string;
      readonly label: string;
      readonly description?: string;
      readonly tone: AttentionAnswerTone;
      readonly response: AttentionResponse;
    }
  | {
      readonly kind: 'clarification';
      readonly key: 'clarification';
      readonly label: string;
      readonly description: string;
      readonly tone: 'neutral';
    };

/**
 * The finite actions for an ask, derived from the protocol-owned discriminant.
 *
 * This is the PWA's one action presenter: the ordinary buttons and the mobile
 * swipe controls consume the same choices, so a gesture can never submit a
 * different response from the label underneath the reader's finger.
 */
export function attentionAnswerChoices(ask: AttentionAsk): readonly AttentionAnswerChoice[] {
  switch (ask.kind) {
    case 'permission':
      return [
        {
          kind: 'response',
          key: 'reject',
          label: 'Reject',
          description: 'Do not allow the requested action.',
          tone: 'negative',
          response: { kind: 'permission', decision: 'reject' },
        },
        {
          kind: 'response',
          key: 'approve',
          label: 'Approve',
          description: 'Allow the requested action.',
          tone: 'affirmative',
          response: { kind: 'permission', decision: 'approve' },
        },
      ];
    case 'multiple-choice':
      return ask.options.map(option => ({
        kind: 'response' as const,
        key: option.label,
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
        tone: 'neutral' as const,
        response: { kind: 'multiple-choice' as const, choice: option.label },
      }));
    case 'answer-review':
      return [
        {
          kind: 'clarification',
          key: 'clarification',
          label: 'Needs clarification',
          description: 'Write what the agent should clarify before continuing.',
          tone: 'neutral',
        },
        {
          kind: 'response',
          key: 'good',
          label: 'The answer is good',
          description: 'Accept the answer and let the agent continue.',
          tone: 'affirmative',
          response: { kind: 'answer-review', verdict: 'good' },
        },
      ];
    case 'open-question':
      return [];
  }
}

interface SwipeGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  distance: number;
  horizontal: boolean;
}

const SWIPE_SLOP_PX = 7;
const SWIPE_MINIMUM_PX = 64;
const SWIPE_MAXIMUM_PX = 104;

const swipeThreshold = (width: number): number => Math.min(SWIPE_MAXIMUM_PX, Math.max(SWIPE_MINIMUM_PX, width * 0.28));

interface SwipeAttentionActionProps {
  readonly label: string;
  readonly description?: string;
  readonly tone: AttentionAnswerTone;
  readonly busy: boolean;
  readonly swipeEnabled: boolean;
  readonly onActivate: () => void;
}

/**
 * One explicitly-labelled answer that can be tapped everywhere and swiped on a
 * phone. The swipe belongs to THIS button, so arbitrary multiple-choice asks do
 * not need a lossy left/right convention: swiping “Deploy Friday” can only ever
 * submit “Deploy Friday”.
 */
function SwipeAttentionAction({ label, description, tone, busy, swipeEnabled, onActivate }: SwipeAttentionActionProps) {
  const hintId = useId();
  const button = useRef<HTMLButtonElement | null>(null);
  const gesture = useRef<SwipeGesture | null>(null);
  const suppressClick = useRef(false);
  const [offset, setOffset] = useState(0);

  const reset = (): void => {
    gesture.current = null;
    setOffset(0);
  };

  const begin = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    // SUPPRESSION LASTS ONE PRESS, NOT UNTIL A CLICK ARRIVES.
    //
    // It is armed by a drag so the click the browser synthesizes afterwards
    // cannot answer a second time — but plenty of gestures produce no click at
    // all: a vertical scroll the page took over, a `pointercancel`, a capture
    // the browser withdrew. Clearing it only in the click handler left the flag
    // armed after those, and the reader's NEXT genuine tap was swallowed. A new
    // press is a new decision, so the disarm belongs here, ahead of every guard.
    suppressClick.current = false;
    if (!swipeEnabled || busy || event.button !== 0) return;
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      distance: 0,
      horizontal: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const move = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const active = gesture.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    // TRAVEL IS UNSIGNED, COMMITTED DISTANCE IS NOT. Measuring only the
    // rightward component would leave a leftward drag looking like a motionless
    // press: the gesture would never start, the click would never be suppressed,
    // and dragging AWAY from the action would submit it on release. A drag is a
    // drag in either direction; only a rightward one can answer.
    const dx = event.clientX - active.startX;
    const travel = Math.abs(dx);
    const y = Math.abs(event.clientY - active.startY);
    if (!active.horizontal) {
      if (travel < SWIPE_SLOP_PX && y < SWIPE_SLOP_PX) return;
      if (y >= travel) {
        // Vertical: the scroller owns this pointer now. Past the slop it was
        // never a tap either, so the synthesized click must not answer.
        suppressClick.current = true;
        reset();
        return;
      }
      active.horizontal = true;
    }
    active.distance = Math.max(0, dx);
    suppressClick.current = true;
    setOffset(Math.min(active.distance, SWIPE_MAXIMUM_PX + 24));
  };

  /**
   * The browser can take a capture away without ever delivering an up or a
   * cancel — a re-render that replaces the node is enough. Dropping the gesture
   * here is what stops the next tap from resuming a swipe that already ended.
   */
  const lost = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (gesture.current?.pointerId === event.pointerId) reset();
  };

  const end = (event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean): void => {
    const active = gesture.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const answered =
      !cancelled && active.horizontal && active.distance >= swipeThreshold(button.current?.clientWidth ?? 0);
    suppressClick.current = active.horizontal;
    reset();
    if (answered) onActivate();
  };

  const activateFromClick = (): void => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    onActivate();
  };

  return (
    <div
      className="kt-attn-swipe-shell"
      data-swipe-enabled={swipeEnabled || undefined}
      data-tone={tone}
      style={{ '--attention-swipe': `${offset}px` } as CSSProperties}
    >
      {swipeEnabled ? (
        <span className="kt-attn-swipe-reveal" aria-hidden="true">
          Answer
          <span>→</span>
        </span>
      ) : null}
      <button
        ref={button}
        type="button"
        aria-describedby={hintId}
        className={cn('kt-attn-swipe-action', busy && 'cursor-wait')}
        disabled={busy}
        onClick={activateFromClick}
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={event => end(event, false)}
        onPointerCancel={event => end(event, true)}
        onLostPointerCapture={lost}
      >
        <span className="kt-attn-swipe-action__mark" aria-hidden="true">
          {busy ? <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" /> : <Check size={14} />}
        </span>
        <span className="kt-attn-swipe-action__body">
          <span className="kt-attn-swipe-action__label">{label}</span>
          {description ? <span className="kt-attn-swipe-action__description">{description}</span> : null}
          <span id={hintId} className="kt-attn-swipe-action__hint">
            {swipeEnabled ? 'Swipe right or tap to choose' : 'Choose this answer'}
          </span>
        </span>
      </button>
    </div>
  );
}

export interface AttentionAnswerControlsProps {
  readonly ask: AttentionAsk;
  readonly busy: boolean;
  readonly swipeEnabled?: boolean;
  readonly onRespond: (response: AttentionResponse) => void;
}

/** The one direct-answer control set used by both the ledger and action modal. */
export function AttentionAnswerControls({ ask, busy, swipeEnabled = false, onRespond }: AttentionAnswerControlsProps) {
  const [text, setText] = useState('');
  const [clarifying, setClarifying] = useState(false);

  if (ask.kind === 'open-question' || clarifying) {
    const clarification = ask.kind === 'answer-review';
    return (
      <div className="flex flex-col gap-xs">
        <Textarea
          rows={4}
          value={text}
          onChange={event => setText(event.target.value)}
          aria-label={clarification ? 'Clarification request' : 'Your answer'}
          placeholder={clarification ? 'What needs clarifying?' : 'Write your answer…'}
        />
        <div className="flex flex-col gap-xs sm:flex-row sm:justify-end">
          {clarification ? (
            <Button
              size="sm"
              variant="ghost"
              className="min-h-[44px]"
              disabled={busy}
              onClick={() => {
                setText('');
                setClarifying(false);
              }}
            >
              Back
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            className="min-h-[44px]"
            disabled={busy || !text.trim()}
            onClick={() =>
              onRespond(
                clarification
                  ? { kind: 'answer-review', verdict: 'clarify', clarification: text }
                  : { kind: 'open-question', answer: text },
              )
            }
          >
            {busy ? (
              <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />
            ) : clarification ? (
              <MessageCircleQuestion size={14} />
            ) : (
              <Send size={14} />
            )}
            {clarification ? 'Ask to clarify' : 'Send answer'}
          </Button>
        </div>
      </div>
    );
  }

  // `<fieldset>` rather than `role="group"`: the repo's a11y gate rejects the
  // explicit role on a generic element, and a fieldset carries the same implicit
  // grouping with a real accessible name.
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-xs border-0 p-0" aria-label="Valid attention answers">
      {attentionAnswerChoices(ask).map(choice => (
        <SwipeAttentionAction
          key={choice.key}
          busy={busy}
          description={choice.description}
          label={choice.label}
          onActivate={() => {
            if (choice.kind === 'clarification') setClarifying(true);
            else onRespond(choice.response);
          }}
          swipeEnabled={swipeEnabled}
          tone={choice.tone}
        />
      ))}
    </fieldset>
  );
}
