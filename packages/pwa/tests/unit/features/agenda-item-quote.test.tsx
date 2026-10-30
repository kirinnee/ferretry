import { afterEach, describe, expect, test } from 'bun:test';
import { AgendaItemView } from '../../../src/features/agenda/agenda-item-view.tsx';
import type { DaemonId } from '../../../src/lib/daemon-connection.ts';
import { registerComposerQuoteTarget } from '../../../src/lib/quote.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  window.getSelection()?.removeAllRanges();
});

const scope = { daemonId: 'daemon-a' as DaemonId, sessionId: 'session-a' };

const item = agendaItem('A47', {
  title: 'Database for the board',
  subject: 'Which database should keep the board’s finished items?',
  ask: choices('SQLite', 'Postgres'),
  premise: 'The board keeps every finished item.',
  context: 'Postgres means another service.',
});

const draw = async (quoteScope: typeof scope | null): Promise<HTMLElement> => {
  view = await mount(
    <AgendaItemView
      busy={false}
      error={null}
      ferret="Zoe"
      history={[]}
      item={item}
      now={Date.parse('2026-08-01T12:00:00.000Z')}
      onAct={() => undefined}
      onClose={() => undefined}
      onNext={() => undefined}
      onPrevious={() => undefined}
      onProgress={async () => undefined}
      position={{ index: 0, total: 1 }}
      quoteScope={quoteScope}
      renderProse={text => <p>{text}</p>}
      swipeable
    />,
  );
  return must(view.container, 'the view');
};

const selectIn = (root: HTMLElement, text: string): HTMLElement => {
  const target = must(
    [...root.querySelectorAll<HTMLElement>('p')].find(p => p.textContent?.includes(text)),
    `prose containing "${text}"`,
  );
  const range = document.createRange();
  range.selectNodeContents(target);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  return target;
};

const mouseDown = (target: HTMLElement): void => {
  const down = new Event('pointerdown', { bubbles: true });
  Object.assign(down, { pointerType: 'mouse' });
  target.dispatchEvent(down);
};

const openMenu = async (target: HTMLElement): Promise<void> => {
  await interact(() => {
    mouseDown(target);
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
};

describe('quoting from the open agenda item', () => {
  test('selected premise text is quoted into the composer of the item’s own chat', async () => {
    let draft = '';
    const dispose = registerComposerQuoteTarget({
      ...scope,
      draft: () => draft,
      replaceDraft: next => {
        draft = next;
      },
    });
    try {
      const root = await draw(scope);
      await openMenu(selectIn(root, 'keeps every finished item'));
      const entry = must(
        [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(i => i.textContent?.includes('Quote')),
        'the Quote item',
      );
      await interact(() => entry.click());
      expect(draft).toContain('> The board keeps every finished item.');
    } finally {
      dispose();
    }
  });

  test('context text is quotable too', async () => {
    const root = await draw(scope);
    const target = selectIn(root, 'another service');
    await openMenu(target);
    expect(document.querySelector('[role="menu"][aria-label="Quote menu"]')).not.toBeNull();
  });

  test('without a composer scope the browser’s own menu stays', async () => {
    const root = await draw(null);
    const target = selectIn(root, 'keeps every finished item');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await interact(() => target.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"][aria-label="Quote menu"]')).toBeNull();
  });

  test('a right-click with nothing selected leaves the browser’s menu alone', async () => {
    const root = await draw(scope);
    const target = must(root.querySelector('p'), 'prose');
    window.getSelection()?.removeAllRanges();
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await interact(() => target.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  });
});
