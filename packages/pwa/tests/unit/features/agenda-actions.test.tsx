/** The answer bar's in-flight state: a send that is already going cannot be sent twice. */

import { describe, expect, it } from 'bun:test';
import { AgendaActions, type AgendaActionsProps } from '../../../src/features/agenda/agenda-actions.tsx';
import { interact, mount, must, pressKey } from '../../support/dom.ts';

const props = (overrides: Partial<AgendaActionsProps>): AgendaActionsProps => ({
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

describe('AgendaActions in flight', () => {
  it('spins and locks the Send answers button while the answers are going, and sends once idle', async () => {
    let sends = 0;
    const sendAnswers = { ready: true, onSend: () => (sends += 1) };

    const idle = await mount(<AgendaActions {...props({ sendAnswers })} />);
    const send = must(idle.container.querySelector<HTMLButtonElement>('[data-agenda-send-answers]'), 'Send answers');
    expect(send.querySelector('svg.animate-spin')).toBeNull();
    await interact(() => send.click());
    expect(sends).toBe(1);
    await idle.unmount();

    const busy = await mount(<AgendaActions {...props({ sendAnswers, busy: true })} />);
    const locked = must(busy.container.querySelector<HTMLButtonElement>('[data-agenda-send-answers]'), 'Send answers');
    expect(locked.disabled).toBe(true);
    expect(locked.querySelector('svg.animate-spin')).not.toBeNull();
    await interact(() => locked.click());
    expect(sends).toBe(1);
    await busy.unmount();
  });

  it('has no text box or send-reply button: answering is replying in the message box', async () => {
    const view = await mount(<AgendaActions {...props({ composerHint: 'Reply in the message box below.' })} />);
    expect(view.container.querySelector('textarea, input')).toBeNull();
    expect(view.container.querySelector('[data-agenda-send]')).toBeNull();
    expect(view.container.querySelector('[data-agenda-composer-hint]')?.textContent).toBe(
      'Reply in the message box below.',
    );
    await view.unmount();
  });

  it('draws the second row as Skip, Details, then the ⋯ menu — each only where it applies', async () => {
    let details = 0;
    const full = await mount(
      <AgendaActions
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
          ['data-agenda-skip', 'data-agenda-details', 'data-agenda-more'].find(
            name => node.hasAttribute(name) || node.querySelector(`[${name}]`) !== null,
          ) ?? '',
      ),
    ).toEqual(['data-agenda-skip', 'data-agenda-details', 'data-agenda-more']);
    await interact(() =>
      must(full.container.querySelector<HTMLButtonElement>('[data-agenda-details]'), 'Details').click(),
    );
    expect(details).toBe(1);
    await full.unmount();

    const bare = await mount(<AgendaActions {...props({})} />);
    expect(bare.container.querySelector('.fy-attn-actions__row--secondary')).toBeNull();
    await bare.unmount();
  });

  it('disables every answer while an answer is going', async () => {
    const view = await mount(
      <AgendaActions {...props({ busy: true, answers: [{ direction: 'right', does: 'approve', label: 'Allow' }] })} />,
    );
    expect(view.container.querySelector<HTMLButtonElement>('[data-agenda-answer="right"]')?.disabled).toBe(true);
    await view.unmount();
  });
});

describe('the ⋯ menu', () => {
  it('opens on Not needed…, moves with ↓ and ↑ (wrapping), and Esc closes it back to its button', async () => {
    let dismissed = 0;
    const view = await mount(<AgendaActions {...props({ dismissInMenu: true, onDismiss: () => (dismissed += 1) })} />);
    const trigger = must(view.container.querySelector<HTMLButtonElement>('[data-agenda-more]'), 'the ⋯ button');
    await interact(() => trigger.click());
    const item = must(view.container.querySelector<HTMLElement>('[role="menuitem"]'), 'Not needed…');
    expect(item.textContent).toContain('Not needed');
    expect(document.activeElement).toBe(item);
    await interact(() => pressKey(item, 'ArrowDown'));
    expect(document.activeElement).toBe(item);
    await interact(() => pressKey(item, 'ArrowUp'));
    expect(document.activeElement).toBe(item);
    await interact(() => pressKey(item, 'Escape'));
    expect(view.container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await interact(() => trigger.click());
    await interact(() => must(view.container.querySelector<HTMLElement>('[role="menuitem"]'), 'again').click());
    expect(dismissed).toBe(1);
    await view.unmount();
  });
});
