/** The answer bar's in-flight state: a send that is already going cannot be sent twice. */

import { describe, expect, it } from 'bun:test';
import { createRef } from 'react';

import { AttentionActions, type AttentionActionsProps } from '../../../src/features/attention/attention-actions.tsx';
import { interact, mount, must } from '../../support/dom.ts';

const props = (overrides: Partial<AttentionActionsProps>): AttentionActionsProps => ({
  answers: [],
  extraOptions: [],
  swipeHints: false,
  busy: false,
  reply: '',
  onReplyChange: () => undefined,
  replyOpen: false,
  onReplyOpenChange: () => undefined,
  replyRef: createRef<HTMLTextAreaElement>(),
  replyIsAnswer: false,
  canSendReply: false,
  onSendReply: () => undefined,
  onAnswer: () => undefined,
  onOption: () => undefined,
  dismissInMenu: false,
  onDismiss: () => undefined,
  ...overrides,
});

describe('AttentionActions in flight', () => {
  it('spins and locks the Send answers button while the answers are going, and sends once idle', async () => {
    let sends = 0;
    const sendAnswers = { ready: true, onSend: () => (sends += 1) };

    const idle = await mount(<AttentionActions {...props({ sendAnswers })} />);
    const send = must(idle.container.querySelector<HTMLButtonElement>('[data-attention-send-answers]'), 'Send answers');
    expect(send.querySelector('svg.animate-spin')).toBeNull();
    await interact(() => send.click());
    expect(sends).toBe(1);
    await idle.unmount();

    const busy = await mount(<AttentionActions {...props({ sendAnswers, busy: true })} />);
    const locked = must(
      busy.container.querySelector<HTMLButtonElement>('[data-attention-send-answers]'),
      'Send answers',
    );
    expect(locked.disabled).toBe(true);
    expect(locked.querySelector('svg.animate-spin')).not.toBeNull();
    await interact(() => locked.click());
    expect(sends).toBe(1);
    await busy.unmount();
  });

  it('spins and locks the Send button of a text-only answer while it is going', async () => {
    let sends = 0;
    const base = { replyIsAnswer: true, canSendReply: true, reply: 'Ship it', onSendReply: () => (sends += 1) };

    const idle = await mount(<AttentionActions {...props(base)} />);
    const send = must(idle.container.querySelector<HTMLButtonElement>('[data-attention-send]'), 'Send answer');
    expect(send.disabled).toBe(false);
    expect(send.querySelector('svg.animate-spin')).toBeNull();
    await idle.unmount();

    const busy = await mount(<AttentionActions {...props({ ...base, busy: true })} />);
    const locked = must(busy.container.querySelector<HTMLButtonElement>('[data-attention-send]'), 'Send answer');
    expect(locked.disabled).toBe(true);
    expect(locked.querySelector('svg.animate-spin')).not.toBeNull();
    await busy.unmount();
    expect(sends).toBe(0);
  });
});
