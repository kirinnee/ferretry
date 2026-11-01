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
  it('says Got it on a notice, the one action it has, and locks it while it is going', async () => {
    let cleared = 0;
    const idle = await mount(<AgendaActions {...props({ clear: () => (cleared += 1) })} />);
    const gotIt = must(idle.container.querySelector<HTMLButtonElement>('[data-agenda-clear]'), 'Got it');
    expect(gotIt.textContent).toBe('Got it');
    await interact(() => gotIt.click());
    expect(cleared).toBe(1);
    await idle.unmount();

    const busy = await mount(<AgendaActions {...props({ clear: () => (cleared += 1), busy: true })} />);
    const locked = must(busy.container.querySelector<HTMLButtonElement>('[data-agenda-clear]'), 'Got it');
    expect(locked.disabled).toBe(true);
    expect(busy.container.querySelector('[data-agenda-send-answers]')).toBeNull();
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

describe('AgendaActions highlights one answer', () => {
  const answers: AgendaActionsProps['answers'] = [
    { direction: 'left', does: 'choose', label: 'Edit' },
    { direction: 'right', does: 'choose', label: 'Accept' },
  ];
  const highlighted = (container: HTMLElement): string[] =>
    [...container.querySelectorAll<HTMLElement>('[data-agenda-answer][data-variant="primary"]')].map(
      node => node.dataset['agendaOption'] ?? '',
    );

  it('highlights → (yes) when the card recommends none of its answers', async () => {
    const view = await mount(<AgendaActions {...props({ answers })} />);
    expect(highlighted(view.container)).toEqual(['Accept']);
    await view.unmount();
  });

  it('highlights the recommended answer instead, wherever it sits, and leaves → plain', async () => {
    const view = await mount(<AgendaActions {...props({ answers, recommended: 'Edit' })} />);
    expect(highlighted(view.container)).toEqual(['Edit']);
    await view.unmount();
  });
});
