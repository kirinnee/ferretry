import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '../../../../app/wire/index.ts';
import { useState } from 'react';
import { AgendaLineage } from '../../../../app/features/agenda/agenda-merge-control.tsx';
import { agendaProse } from '../../../../app/features/agenda/agenda-prose.tsx';
import type { AgendaMergeView } from '../../../../app/features/agenda/use-item-lifecycle.ts';
import { agendaItem } from '../../../support/app/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../../support/app/dom.ts';
import { settleUntil } from '../../../support/app/settle.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const item = (overrides: Partial<AgendaItem> = {}): AgendaItem =>
  agendaItem('A5', { subject: 'Queue choice', ...overrides });

interface Sent {
  readonly survivor: string;
  readonly absorbed: string;
}

const mergeView = (
  sent: Sent[],
  candidates: readonly AgendaItem[] = [agendaItem('A2', { subject: 'Pick the queue' })],
  failure?: Error,
): AgendaMergeView => ({
  candidates,
  merge: async (survivor, absorbed) => {
    sent.push({ survivor, absorbed });
    if (failure !== undefined) throw failure;
  },
});

/**
 * The ⋯ menu's "Merge with…" row stands in here as a plain button, so the panel is driven the way the menu drives it:
 * the row opens it, its Cancel or a sent merge closes it (the row itself is the item view's, tested there).
 */
function MenuHost({
  current,
  merge,
  titles,
}: {
  readonly current: AgendaItem;
  readonly merge: AgendaMergeView | undefined;
  readonly titles: Readonly<Record<string, string>> | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {merge === undefined || open ? null : (
        <button data-agenda-merge-open="" onClick={() => setOpen(true)} type="button">
          Merge with…
        </button>
      )}
      <AgendaLineage
        item={current}
        merge={merge}
        mergeOpen={open}
        onMergeClose={() => setOpen(false)}
        renderProse={agendaProse()}
        {...(titles === undefined ? {} : { titles })}
      />
    </>
  );
}

const draw = async (
  current: AgendaItem,
  merge: AgendaMergeView | undefined,
  titles?: Readonly<Record<string, string>>,
): Promise<HTMLElement> => {
  view = await mount(<MenuHost current={current} merge={merge} titles={titles} />);
  return view.container;
};

const click = async (root: HTMLElement, selector: string): Promise<void> => {
  await interact(() => must(root.querySelector<HTMLElement>(selector), selector).click());
};

describe('the lineage lines', () => {
  test('draws nothing for an item with no lineage and no merge', async () => {
    expect((await draw(item(), undefined)).innerHTML).toBe('');
  });

  test('says where a merged item went, as a reference', async () => {
    const root = await draw(item({ mergedInto: 'A2' } as never), undefined);
    const line = must(root.querySelector('[data-agenda-lineage-line="merged-into"]'), 'merged-into line');
    expect(line.textContent).toContain('Merged into !A2');
    expect(root.querySelector('[data-agenda-merge-open]')).toBeNull();
  });

  test('names each target by its title where it is given, and by its id where it is not', async () => {
    const root = await draw(item({ splitInto: ['A7', 'A8'] } as never), undefined, { A7: 'the snooze copy' });
    expect(root.querySelector('[data-agenda-lineage-line="split-into"]')?.textContent).toContain(
      'Split into !A7 (the snooze copy), !A8',
    );
  });

  test('says where a split came from and where it went', async () => {
    const root = await draw(item({ splitFrom: 'A3', splitInto: ['A7', 'A8'] } as never), undefined);
    expect(root.querySelector('[data-agenda-lineage-line="split-from"]')?.textContent).toContain('Split from !A3');
    expect(root.querySelector('[data-agenda-lineage-line="split-into"]')?.textContent).toContain('Split into !A7, !A8');
    expect(root.textContent).not.toContain('Split off');
  });
});

describe('Merge with…', () => {
  test('draws no panel when the host offers no merge, even if asked to open one', async () => {
    view = await mount(
      <AgendaLineage
        item={item()}
        merge={undefined}
        mergeOpen
        onMergeClose={() => undefined}
        renderProse={agendaProse()}
      />,
    );
    expect(view.container.innerHTML).toBe('');
  });

  test('lists the open agendas, then says what will happen before sending anything', async () => {
    const sent: Sent[] = [];
    const root = await draw(item(), mergeView(sent));
    await click(root, '[data-agenda-merge-open]');
    const picker = must(root.querySelector('[data-agenda-merge-picker]'), 'picker');
    expect(picker.textContent).toContain('Merge this item with which open agenda?');
    expect(picker.textContent).not.toContain('Queue choice');
    expect(must(root.querySelector('[data-agenda-merge-candidate="A2"]'), 'candidate').textContent).toBe(
      '!A2 Pick the queue',
    );

    await click(root, '[data-agenda-merge-candidate="A2"]');
    const confirm = must(root.querySelector('[data-agenda-merge-confirm]'), 'confirm step');
    expect(confirm.textContent).toBe(
      'Merge !A2 into this item?' +
        '!A2 closes; this item keeps its ask. Both conversations and all cards are kept.' +
        'Keep !A2 instead' +
        'CancelMerge',
    );
    expect(confirm.textContent).not.toContain('Pick the queue');
    expect(confirm.textContent).not.toContain('Queue choice');
    expect(sent).toEqual([]);

    await click(root, '[data-agenda-merge-go]');
    expect(sent).toEqual([{ survivor: 'A5', absorbed: 'A2' }]);
    expect(root.querySelector('[data-agenda-merge-confirm]')).toBeNull();
    expect(root.querySelector('[data-agenda-merge-open]')).not.toBeNull();
  });

  test('draws the confirm step with the negative choices left and the confirming merge right', async () => {
    const root = await draw(item(), mergeView([]));
    await click(root, '[data-agenda-merge-open]');
    await click(root, '[data-agenda-merge-candidate="A2"]');
    const actions = must(root.querySelector('.fy-merge__actions'), 'actions');
    const labels = [...actions.querySelectorAll('button')].map(button => button.textContent?.trim());
    expect(labels).toEqual(['Cancel', 'Merge']);
    expect(actions.lastElementChild?.hasAttribute('data-agenda-merge-go')).toBe(true);
  });

  test('can keep the other agenda instead', async () => {
    const sent: Sent[] = [];
    const root = await draw(item(), mergeView(sent));
    await click(root, '[data-agenda-merge-open]');
    await click(root, '[data-agenda-merge-candidate="A2"]');
    await click(root, 'input[type="checkbox"]');
    const words = root.querySelector('[data-agenda-merge-confirm]')?.textContent;
    expect(words).toContain('Merge this item into !A2?');
    expect(words).toContain('This item closes; !A2 keeps its ask. Both conversations and all cards are kept.');
    await click(root, '[data-agenda-merge-go]');
    expect(sent).toEqual([{ survivor: 'A2', absorbed: 'A5' }]);
  });

  test('says so when there is nothing to merge with, and Cancel closes the panel', async () => {
    const root = await draw(item(), mergeView([], []));
    await click(root, '[data-agenda-merge-open]');
    expect(root.querySelector('[data-agenda-merge-none]')).not.toBeNull();
    await click(root, '.fy-merge__quiet');
    expect(root.querySelector('[data-agenda-merge-picker]')).toBeNull();
  });

  test('closes the panel from the confirm step with Cancel, the only other choice', async () => {
    const root = await draw(item(), mergeView([]));
    await click(root, '[data-agenda-merge-open]');
    await click(root, '[data-agenda-merge-candidate="A2"]');
    await click(root, '.fy-merge__actions .fy-merge__quiet');
    expect(root.querySelector('[data-agenda-merge-picker]')).toBeNull();
    expect(root.querySelector('[data-agenda-merge-confirm]')).toBeNull();
  });

  test('shows the machine’s own refusal and keeps the panel open to try again', async () => {
    const root = await draw(item(), mergeView([], undefined, new Error('That conversation is closed.')));
    await click(root, '[data-agenda-merge-open]');
    await click(root, '[data-agenda-merge-candidate="A2"]');
    await click(root, '[data-agenda-merge-go]');
    await settleUntil(() => root.querySelector('[role="alert"]') !== null, 'the refusal', interact);
    expect(must(root.querySelector('[role="alert"]'), 'alert').textContent).toBe('That conversation is closed.');
    expect(root.querySelector<HTMLButtonElement>('[data-agenda-merge-go]')?.disabled).toBe(false);
  });

  test('says a failure that is not an error in plain words', async () => {
    const view2: AgendaMergeView = { candidates: [agendaItem('A2')], merge: () => Promise.reject('nope') };
    const root = await draw(item(), view2);
    await click(root, '[data-agenda-merge-open]');
    await click(root, '[data-agenda-merge-candidate="A2"]');
    await click(root, '[data-agenda-merge-go]');
    await settleUntil(() => root.querySelector('[role="alert"]') !== null, 'the refusal', interact);
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('The merge was not sent.');
  });
});
