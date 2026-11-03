import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { AgendaLineage } from '../../../src/features/agenda/agenda-merge-control.tsx';
import { agendaProse } from '../../../src/features/agenda/agenda-prose.tsx';
import type { AgendaMergeView } from '../../../src/features/agenda/use-item-lifecycle.ts';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { settleUntil } from '../../support/settle.ts';

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

const draw = async (current: AgendaItem, merge: AgendaMergeView | undefined): Promise<HTMLElement> => {
  view = await mount(<AgendaLineage item={current} merge={merge} renderProse={agendaProse()} />);
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

  test('says where a split came from and where it went', async () => {
    const root = await draw(item({ splitFrom: 'A3', splitInto: ['A7', 'A8'] } as never), undefined);
    expect(root.querySelector('[data-agenda-lineage-line="split-from"]')?.textContent).toContain('Split from !A3');
    expect(root.querySelector('[data-agenda-lineage-line="split-into"]')?.textContent).toContain('Split into !A7, !A8');
    expect(root.textContent).not.toContain('Split off');
  });
});

describe('Merge with…', () => {
  test('is hidden when the host offers no merge', async () => {
    expect((await draw(item(), undefined)).querySelector('[data-agenda-merge-open]')).toBeNull();
  });

  test('lists the open agendas, then says what will happen before sending anything', async () => {
    const sent: Sent[] = [];
    const root = await draw(item(), mergeView(sent));
    await click(root, '[data-agenda-merge-open]');
    expect(must(root.querySelector('[data-agenda-merge-candidate="A2"]'), 'candidate').textContent).toBe(
      '!A2 Pick the queue',
    );

    await click(root, '[data-agenda-merge-candidate="A2"]');
    const confirm = must(root.querySelector('[data-agenda-merge-confirm]'), 'confirm step');
    expect(confirm.textContent).toContain('Merge !A2 into !A5?');
    expect(confirm.textContent).toContain('!A2 closes as merged into !A5');
    expect(confirm.textContent).toContain('Both conversations and all cards are kept');
    expect(sent).toEqual([]);

    await click(root, '[data-agenda-merge-go]');
    expect(sent).toEqual([{ survivor: 'A5', absorbed: 'A2' }]);
    expect(root.querySelector('[data-agenda-merge-confirm]')).toBeNull();
    expect(root.querySelector('[data-agenda-merge-open]')).not.toBeNull();
  });

  test('can keep the other agenda instead', async () => {
    const sent: Sent[] = [];
    const root = await draw(item(), mergeView(sent));
    await click(root, '[data-agenda-merge-open]');
    await click(root, '[data-agenda-merge-candidate="A2"]');
    await click(root, 'input[type="checkbox"]');
    expect(root.querySelector('[data-agenda-merge-confirm]')?.textContent).toContain('Merge !A5 into !A2?');
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

  test('goes back from the confirm step to the list, and Cancel closes it', async () => {
    const root = await draw(item(), mergeView([]));
    await click(root, '[data-agenda-merge-open]');
    await click(root, '[data-agenda-merge-candidate="A2"]');
    const quiet = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.fy-merge__actions .fy-merge__quiet')];
    await interact(() => must(quiet()[0], 'back').click());
    expect(root.querySelector('[data-agenda-merge-picker]')).not.toBeNull();
    await click(root, '[data-agenda-merge-candidate="A2"]');
    await interact(() => must(quiet()[1], 'cancel').click());
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
