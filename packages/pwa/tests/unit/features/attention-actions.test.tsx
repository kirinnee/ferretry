/** The answer bar's in-flight state: a send that is already going cannot be sent twice. */

import { describe, expect, it } from 'bun:test';
import { AttentionActions, type AttentionActionsProps } from '../../../src/features/attention/attention-actions.tsx';
import { interact, mount, must } from '../../support/dom.ts';

const props = (overrides: Partial<AttentionActionsProps>): AttentionActionsProps => ({
  answers: [],
  extraOptions: [],
  swipeHints: false,
  busy: false,
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

  it('has no text box or send-reply button: answering is replying in the message box', async () => {
    const view = await mount(<AttentionActions {...props({ composerHint: 'Reply in the message box below.' })} />);
    expect(view.container.querySelector('textarea, input')).toBeNull();
    expect(view.container.querySelector('[data-attention-send]')).toBeNull();
    expect(view.container.querySelector('[data-attention-composer-hint]')?.textContent).toBe(
      'Reply in the message box below.',
    );
    await view.unmount();
  });

  it('draws the second row as Skip, Details, then the ⋯ menu — each only where it applies', async () => {
    let details = 0;
    const full = await mount(
      <AttentionActions
        {...props({
          dismissInMenu: true,
          onOpenDetail: () => (details += 1),
          onSkip: () => undefined,
        })}
      />,
    );
    const row = must(full.container.querySelector('.fy-attn-actions__row--secondary'), 'the second row');
    expect(
      [...row.children].map(
        node =>
          ['data-attention-skip', 'data-attention-details', 'data-attention-more'].find(
            name => node.hasAttribute(name) || node.querySelector(`[${name}]`) !== null,
          ) ?? '',
      ),
    ).toEqual(['data-attention-skip', 'data-attention-details', 'data-attention-more']);
    await interact(() =>
      must(full.container.querySelector<HTMLButtonElement>('[data-attention-details]'), 'Details').click(),
    );
    expect(details).toBe(1);
    await full.unmount();

    const bare = await mount(<AttentionActions {...props({})} />);
    expect(bare.container.querySelector('.fy-attn-actions__row--secondary')).toBeNull();
    await bare.unmount();
  });

  it('disables every answer while an answer is going', async () => {
    const view = await mount(
      <AttentionActions
        {...props({ busy: true, answers: [{ direction: 'right', does: 'approve', label: 'Allow' }] })}
      />,
    );
    expect(view.container.querySelector<HTMLButtonElement>('[data-attention-answer="right"]')?.disabled).toBe(true);
    await view.unmount();
  });
});
