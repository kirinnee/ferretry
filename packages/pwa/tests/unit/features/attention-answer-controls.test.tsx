/**
 * The gesture contract for row 40, asserted against a real DOM.
 *
 * THE DESIGN UNDER TEST: every finite labelled answer is its own tappable,
 * keyboard-reachable control, and on a phone that SAME control can be swiped
 * right to submit exactly the response written on it. There is deliberately no
 * global left/right enum — that shape can express two answers and silently
 * loses the third, which is wrong for an ask with five named options.
 *
 * So the assertions below are about a swipe never being able to submit
 * something other than the label under the reader's finger, and about every
 * ambiguous gesture — too short, vertical, leftward, cancelled — submitting
 * NOTHING. Approving a permission by accident is not recoverable.
 */

import type { AttentionAsk, AttentionResponse } from '@ferretry/protocol';
import { describe, expect, it } from 'bun:test';

import {
  AttentionAnswerControls,
  attentionAnswerChoices,
} from '../../../src/features/attention/attention-answer-controls.tsx';
import { interact, mount, must } from '../../support/dom.ts';

const PERMISSION: AttentionAsk = { kind: 'permission' };
const CHOICE: AttentionAsk = {
  kind: 'multiple-choice',
  options: [{ label: 'Deploy Friday' }, { label: 'Wait for Monday', description: 'Ship after the freeze.' }],
};
const REVIEW: AttentionAsk = { kind: 'answer-review' };
const OPEN: AttentionAsk = { kind: 'open-question' };

/** React reads pointer fields off the native event, so a plain Event carrying
 *  them is exactly what the handler sees. */
const firePointer = (
  target: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture',
  fields: { pointerId?: number; clientX?: number; clientY?: number; button?: number } = {},
): void => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, clientX: 0, clientY: 0, button: 0, ...fields });
  target.dispatchEvent(event);
};

/** A plain, deliberate tap: press, release, click — no travel at all. */
const tap = async (action: HTMLButtonElement): Promise<void> => {
  await interact(() => firePointer(action, 'pointerdown', { clientX: 0, clientY: 0 }));
  await interact(() => firePointer(action, 'pointerup', { clientX: 0, clientY: 0 }));
  await interact(() => action.click());
};

const actionNamed = (container: HTMLElement, label: string): HTMLButtonElement =>
  must(
    Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes(label)),
    `the “${label}” action`,
  );

const typeInto = async (container: HTMLElement, text: string): Promise<void> => {
  const textarea = must(container.querySelector('textarea'), 'the answer textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, text);
  await interact(() => textarea.dispatchEvent(new Event('input', { bubbles: true })));
};

const controls = async (ask: AttentionAsk, swipeEnabled = true) => {
  const sent: AttentionResponse[] = [];
  const view = await mount(
    <AttentionAnswerControls ask={ask} busy={false} swipeEnabled={swipeEnabled} onRespond={r => sent.push(r)} />,
  );
  return { ...view, sent };
};

/** A right swipe that clears the 64px floor, then the click the browser
 *  synthesizes afterwards — which must not answer a second time. */
const swipeRight = async (action: HTMLButtonElement, distance: number): Promise<void> => {
  await interact(() => firePointer(action, 'pointerdown', { clientX: 0, clientY: 0 }));
  await interact(() => firePointer(action, 'pointermove', { clientX: distance, clientY: 0 }));
  await interact(() => firePointer(action, 'pointerup', { clientX: distance, clientY: 0 }));
  await interact(() => action.click());
};

describe('attentionAnswerChoices', () => {
  it('derives the exact protocol response for every finite answer of all four ask kinds', () => {
    // Assert — the wire values, spelled out. A gesture can only ever submit one
    // of these, so this table is the whole safety property of the swipe.
    expect(attentionAnswerChoices(PERMISSION).map(choice => choice.key)).toEqual(['reject', 'approve']);
    expect(attentionAnswerChoices(PERMISSION).flatMap(c => (c.kind === 'response' ? [c.response] : []))).toEqual([
      { kind: 'permission', decision: 'reject' },
      { kind: 'permission', decision: 'approve' },
    ]);
    expect(attentionAnswerChoices(CHOICE).flatMap(c => (c.kind === 'response' ? [c.response] : []))).toEqual([
      { kind: 'multiple-choice', choice: 'Deploy Friday' },
      { kind: 'multiple-choice', choice: 'Wait for Monday' },
    ]);
    expect(attentionAnswerChoices(REVIEW).map(choice => choice.kind)).toEqual(['clarification', 'response']);
    expect(attentionAnswerChoices(REVIEW).flatMap(c => (c.kind === 'response' ? [c.response] : []))).toEqual([
      { kind: 'answer-review', verdict: 'good' },
    ]);
    // An open question has NO finite answer. Row 40 says so explicitly: it is
    // text, and there is nothing to swipe.
    expect(attentionAnswerChoices(OPEN)).toEqual([]);
  });

  it('carries an option description through without inventing one', () => {
    const [friday, monday] = attentionAnswerChoices(CHOICE);

    expect(friday?.description).toBeUndefined();
    expect(monday?.description).toBe('Ship after the freeze.');
  });
});

describe('AttentionAnswerControls', () => {
  it('answers a permission by tap, with no gesture involved at all', async () => {
    const { container, sent, unmount } = await controls(PERMISSION);

    await interact(() => actionNamed(container, 'Approve').click());

    expect(sent).toEqual([{ kind: 'permission', decision: 'approve' }]);
    await unmount();
  });

  it('keeps every answer tappable when swiping is not offered', async () => {
    const { container, sent, unmount } = await controls(CHOICE, false);

    // Assert — the affordance line says so too, so a reader is not told to
    // swipe on a machine where the gesture is not wired.
    expect(container.textContent).toContain('Choose this answer');
    expect(container.textContent).not.toContain('Swipe right or tap');
    await interact(() => actionNamed(container, 'Wait for Monday').click());

    expect(sent).toEqual([{ kind: 'multiple-choice', choice: 'Wait for Monday' }]);
    await unmount();
  });

  it('submits exactly the swiped label, for an ask with more than two answers', async () => {
    const { container, sent, unmount } = await controls(CHOICE);

    // Act — swipe the SECOND option. A global left/right enum could not express
    // this at all; the per-action gesture can.
    await swipeRight(actionNamed(container, 'Wait for Monday'), 90);

    expect(sent).toEqual([{ kind: 'multiple-choice', choice: 'Wait for Monday' }]);
    await unmount();
  });

  it('does not answer on a swipe that stops short of the threshold', async () => {
    const { container, sent, unmount } = await controls(PERMISSION);
    const approve = actionNamed(container, 'Approve');

    // Act — 40px: a real drag, but not a commitment.
    await interact(() => firePointer(approve, 'pointerdown', { clientX: 0 }));
    await interact(() => firePointer(approve, 'pointermove', { clientX: 40 }));
    await interact(() => firePointer(approve, 'pointerup', { clientX: 40 }));
    // The browser still synthesizes a click after that drag. It must not become
    // an approval the reader deliberately backed out of.
    await interact(() => approve.click());

    expect(sent).toEqual([]);
    await unmount();
  });

  it('does not answer when the drag is vertical, and lets the tap-after-scroll go nowhere', async () => {
    const { container, sent, unmount } = await controls(PERMISSION);
    const approve = actionNamed(container, 'Approve');

    await interact(() => firePointer(approve, 'pointerdown', { clientX: 0, clientY: 0 }));
    await interact(() => firePointer(approve, 'pointermove', { clientX: 4, clientY: 60 }));
    await interact(() => firePointer(approve, 'pointerup', { clientX: 4, clientY: 60 }));
    await interact(() => approve.click());

    expect(sent).toEqual([]);
    // …and the reader is not now locked out. A scroll that produced no click at
    // all must not leave the suppression armed against their next real tap.
    await tap(approve);
    expect(sent).toEqual([{ kind: 'permission', decision: 'approve' }]);
    await unmount();
  });

  it('does not answer when the drag goes LEFT, away from the action', async () => {
    const { container, sent, unmount } = await controls(PERMISSION);
    const approve = actionNamed(container, 'Approve');

    // Act — dragging away from the affordance is the clearest possible "no".
    // Measuring only rightward travel would make this look like a motionless
    // press and let the synthesized click approve.
    await interact(() => firePointer(approve, 'pointerdown', { clientX: 200, clientY: 0 }));
    await interact(() => firePointer(approve, 'pointermove', { clientX: 60, clientY: 0 }));
    await interact(() => firePointer(approve, 'pointerup', { clientX: 60, clientY: 0 }));
    await interact(() => approve.click());

    expect(sent).toEqual([]);
    // The left-drag safety is a refusal of THAT gesture, not a lockout.
    await tap(approve);
    expect(sent).toEqual([{ kind: 'permission', decision: 'approve' }]);
    await unmount();
  });

  it('does not answer when the gesture is cancelled past the threshold', async () => {
    const { container, sent, unmount } = await controls(PERMISSION);
    const approve = actionNamed(container, 'Approve');

    await interact(() => firePointer(approve, 'pointerdown', { clientX: 0 }));
    await interact(() => firePointer(approve, 'pointermove', { clientX: 120 }));
    await interact(() => firePointer(approve, 'pointercancel', { clientX: 120 }));

    expect(sent).toEqual([]);
    // A cancel delivers no click, so the suppression must not survive it.
    await tap(approve);
    expect(sent).toEqual([{ kind: 'permission', decision: 'approve' }]);
    await unmount();
  });

  it('drops a gesture whose pointer capture is taken away mid-drag', async () => {
    const { container, sent, unmount } = await controls(PERMISSION);
    const approve = actionNamed(container, 'Approve');

    await interact(() => firePointer(approve, 'pointerdown', { clientX: 0 }));
    await interact(() => firePointer(approve, 'pointermove', { clientX: 120 }));
    await interact(() => firePointer(approve, 'lostpointercapture', { clientX: 120 }));
    // The release now belongs to no gesture, so it cannot complete one.
    await interact(() => firePointer(approve, 'pointerup', { clientX: 120 }));

    expect(sent).toEqual([]);
    // A withdrawn capture delivers no click either.
    await tap(approve);
    expect(sent).toEqual([{ kind: 'permission', decision: 'approve' }]);
    await unmount();
  });

  it('ignores pointer traffic from a second finger', async () => {
    const { container, sent, unmount } = await controls(PERMISSION);
    const approve = actionNamed(container, 'Approve');

    await interact(() => firePointer(approve, 'pointerdown', { pointerId: 1, clientX: 0 }));
    await interact(() => firePointer(approve, 'pointermove', { pointerId: 2, clientX: 200 }));
    await interact(() => firePointer(approve, 'pointerup', { pointerId: 2, clientX: 200 }));

    expect(sent).toEqual([]);
    await unmount();
  });

  it('refuses a non-primary button and a busy control', async () => {
    const busy = await mount(
      <AttentionAnswerControls ask={PERMISSION} busy swipeEnabled onRespond={() => undefined} />,
    );
    expect(actionNamed(busy.container, 'Approve').disabled).toBe(true);
    await busy.unmount();

    const { container, sent, unmount } = await controls(PERMISSION);
    const approve = actionNamed(container, 'Approve');
    await interact(() => firePointer(approve, 'pointerdown', { clientX: 0, button: 2 }));
    await interact(() => firePointer(approve, 'pointermove', { clientX: 200 }));
    await interact(() => firePointer(approve, 'pointerup', { clientX: 200 }));

    expect(sent).toEqual([]);
    await unmount();
  });

  it('answers an open question with typed text and nothing else', async () => {
    const { container, sent, unmount } = await controls(OPEN);

    // Assert — no swipeable action exists to be swiped.
    expect(container.querySelector('.kt-attn-swipe-action')).toBeNull();
    expect(actionNamed(container, 'Send answer').disabled).toBe(true);
    await typeInto(container, 'Use the pairing flow.');
    await interact(() => actionNamed(container, 'Send answer').click());

    expect(sent).toEqual([{ kind: 'open-question', answer: 'Use the pairing flow.' }]);
    await unmount();
  });

  it('accepts a reviewed answer by its own labelled action', async () => {
    const { container, sent, unmount } = await controls(REVIEW);

    await swipeRight(actionNamed(container, 'The answer is good'), 90);

    expect(sent).toEqual([{ kind: 'answer-review', verdict: 'good' }]);
    await unmount();
  });

  it('turns the clarification action into text, and can back out of it', async () => {
    const { container, sent, unmount } = await controls(REVIEW);

    // Act — clarification is the one finite label that opens a text field
    // rather than submitting, because the protocol requires the words.
    await interact(() => actionNamed(container, 'Needs clarification').click());
    expect(sent).toEqual([]);
    await typeInto(container, 'Cite the daemon status.');
    await interact(() => actionNamed(container, 'Back').click());
    // Backing out discards the draft rather than keeping it primed to send.
    expect(container.querySelector('textarea')).toBeNull();

    await interact(() => actionNamed(container, 'Needs clarification').click());
    await typeInto(container, 'Cite the daemon status.');
    await interact(() => actionNamed(container, 'Ask to clarify').click());

    expect(sent).toEqual([{ kind: 'answer-review', verdict: 'clarify', clarification: 'Cite the daemon status.' }]);
    await unmount();
  });

  it('refuses to send whitespace as an answer', async () => {
    const { container, sent, unmount } = await controls(OPEN);

    await typeInto(container, '   ');

    expect(actionNamed(container, 'Send answer').disabled).toBe(true);
    expect(sent).toEqual([]);
    await unmount();
  });

  it('names the answers as one group and describes the gesture on every action', async () => {
    const { container, unmount } = await controls(CHOICE);

    // `<fieldset>`, not `role="group"`: the repo's a11y gate rejects the role on
    // a generic element, and the group still needs a name.
    const group = must(container.querySelector('fieldset'), 'the answers fieldset');
    expect(group.getAttribute('aria-label')).toBe('Valid attention answers');
    const action = must(container.querySelector('.kt-attn-swipe-action'), 'a swipe action');
    const hint = must(action.getAttribute('aria-describedby'), 'the action hint id');
    expect(must(container.querySelector(`#${CSS.escape(hint)}`), 'the hint').textContent).toBe(
      'Swipe right or tap to choose',
    );
    await unmount();
  });
});
