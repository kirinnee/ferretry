import { afterEach, describe, expect, it } from 'bun:test';
import { BoardNewCard, type BoardNewCardProps } from '../../../src/features/board/detail/board-new-card.tsx';
import { assignedMessage, OWNER_CARD_SOURCE, startBrief } from '../../../src/lib/board-detail.ts';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';
import { card, deferred, flush, laptop } from '../board-support.ts';
import { buttonNamed, clickNamed, fakeActions, fill, HELPER, refusal, submit, text } from './board-detail-support.tsx';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

interface Options {
  readonly projects?: BoardNewCardProps['projects'];
  readonly actions?: ReturnType<typeof fakeActions>;
  readonly startFerret?: (prompt: string) => Promise<string>;
  readonly sendMessage?: (sessionId: string, message: string) => Promise<void>;
}

const assignees = [
  { sessionId: HELPER, name: 'Helper' },
  { sessionId: 'other', name: 'Other' },
];

const open = async (options: Options = {}) => {
  const actions =
    options.actions ?? fakeActions({ create: async () => ({ ok: true, value: card('F7', { title: 'New thing' }) }) });
  const started: string[] = [];
  const sent: { sessionId: string; message: string }[] = [];
  const created: string[] = [];
  const cancelled = { count: 0 };
  view = await mount(
    <BoardNewCard
      actions={actions}
      assignees={assignees}
      connection={laptop}
      machineName="laptop"
      onCancel={() => {
        cancelled.count += 1;
      }}
      onCreated={task => void created.push(task.id)}
      ports={{
        startFerret: async (_daemon, prompt) => {
          started.push(prompt);
          return (await options.startFerret?.(prompt)) ?? 'started-1';
        },
        sendMessage: async (_daemon, sessionId, message) => {
          sent.push({ sessionId, message });
          await options.sendMessage?.(sessionId, message);
        },
      }}
      projects={options.projects ?? []}
    />,
  );
  await interact(() => flush());
  return { root: view.container, actions, started, sent, created, cancelled };
};

const field = <T extends Element>(root: ParentNode, label: string, selector: string): T =>
  must(
    [...root.querySelectorAll('label')]
      .find(entry => entry.textContent?.trim().startsWith(label))
      ?.querySelector<T>(selector),
    label,
  );
const input = (root: ParentNode, label: string) => field<HTMLInputElement>(root, label, 'input');
const select = (root: ParentNode, label: string) => field<HTMLSelectElement>(root, label, 'select');
const form = (root: ParentNode): HTMLElement => must(root.querySelector('form'), 'the form');

const write = async (root: ParentNode, title: string, ask: string): Promise<void> => {
  await fill(input(root, 'Title'), title);
  await fill(field<HTMLTextAreaElement>(root, 'What you want done', 'textarea'), ask);
};
const send = async (root: ParentNode): Promise<void> => {
  await submit(form(root));
  await interact(() => flush());
};
const alerts = (root: ParentNode): string[] =>
  [...root.querySelectorAll('[role="alert"] li, p[role="alert"]')].map(a => a.textContent ?? '');

describe('BoardNewCard — the form', () => {
  it('names the machine, focuses the title and offers each kind', async () => {
    const { root } = await open();
    expect(text(root, '.fy-board-reason__heading')).toBe('New card on laptop');
    expect(root.querySelector('form')?.getAttribute('role')).toBe('dialog');
    expect(document.activeElement).toBe(input(root, 'Title'));
    expect([...select(root, 'Kind').options].map(option => option.textContent)).toEqual([
      'Feature',
      'Bug',
      'Infra',
      'Chore',
    ]);
    expect([...select(root, 'Assign to').options].map(option => option.textContent)).toEqual([
      'Pick a ferret…',
      'Helper',
      'Other',
    ]);
  });

  it('shows a project choice only when the machine has boards, starting on the first', async () => {
    const none = await open();
    expect([...none.root.querySelectorAll('label')].some(entry => entry.textContent?.startsWith('Project'))).toBe(
      false,
    );
    await view?.unmount();
    view = null;
    const some = await open({
      projects: [
        { id: 'p1', name: 'ferretry' },
        { id: 'p2', name: 'other' },
      ],
    });
    expect(select(some.root, 'Project').value).toBe('p1');
  });

  it('says nothing is wrong until the owner has tried to send', async () => {
    const { root } = await open();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    await send(root);
    expect(alerts(root)).toEqual([
      'Give it a title.',
      'Say what you want done.',
      'Pick who does it, or start a ferret on it.',
    ]);
  });

  it('says a title is too long, and nothing about the title once it is fine', async () => {
    const { root, actions } = await open();
    await write(root, 'one two three four five six', 'do it');
    await fill(select(root, 'Assign to'), HELPER);
    await send(root);
    expect(alerts(root)).toEqual(['Keep the title to five words.']);
    expect(actions.calls).toEqual([]);
    await fill(input(root, 'Title'), 'one two three four five');
    await send(root);
    expect(alerts(root)).toEqual([]);
    expect(actions.calls).toHaveLength(1);
  });

  it('turns the assignee off when a ferret is to be started', async () => {
    const { root } = await open();
    await fill(select(root, 'Assign to'), HELPER);
    await interact(() => input(root, 'Start a ferret').click());
    expect(select(root, 'Assign to').disabled).toBe(true);
    expect(select(root, 'Assign to').value).toBe('');
    await send(root);
    expect(alerts(root)).not.toContain('Pick who does it, or start a ferret on it.');
  });
});

describe('BoardNewCard — creating', () => {
  it('creates the card for the chosen ferret with the owner as its source, and hands it back', async () => {
    const { root, actions, created, started, sent } = await open({
      projects: [
        { id: 'p1', name: 'ferretry' },
        { id: 'p2', name: 'other' },
      ],
    });
    await write(root, '  Add dark mode ', ' Make it dark. ');
    await fill(select(root, 'Kind'), 'bug');
    await fill(select(root, 'Project'), 'p2');
    await fill(select(root, 'Assign to'), HELPER);
    await send(root);
    expect(actions.calls).toEqual([
      `create:${JSON.stringify([
        {
          kind: 'bug',
          title: 'Add dark mode',
          ask: { text: 'Make it dark.', source: OWNER_CARD_SOURCE },
          assignee: HELPER,
          projectId: 'p2',
        },
      ])}`,
    ]);
    expect(created).toEqual(['F7']);
    expect(started).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('leaves the project to the daemon when the machine lists none', async () => {
    const { root, actions } = await open();
    await write(root, 'Thing', 'do it');
    await fill(select(root, 'Assign to'), HELPER);
    await send(root);
    expect(actions.calls[0]).not.toContain('projectId');
  });

  it('says it is creating while the daemon works, and ignores a second send', async () => {
    const pending = deferred<unknown>();
    const actions = fakeActions({ create: () => pending.promise });
    const { root } = await open({ actions });
    await write(root, 'Thing', 'do it');
    await fill(select(root, 'Assign to'), HELPER);
    await send(root);
    expect(buttonNamed(root, 'Creating…').disabled).toBe(true);
    await send(root);
    expect(actions.calls).toHaveLength(1);
    pending.resolve({ ok: true, value: card('F7') });
    await interact(() => flush());
  });

  it('keeps the form and says why when the daemon refuses', async () => {
    const actions = fakeActions({ create: async () => refusal('the board is closed') });
    const { root, created } = await open({ actions });
    await write(root, 'Thing', 'do it');
    await fill(select(root, 'Assign to'), HELPER);
    await send(root);
    expect(alerts(root)).toEqual(['the board is closed']);
    expect(created).toEqual([]);
    expect(buttonNamed(root, 'Create card').disabled).toBe(false);
    expect(input(root, 'Title').value).toBe('Thing');
  });
});

describe('BoardNewCard — starting a ferret', () => {
  const ready = async (options: Options = {}) => {
    const opened = await open(options);
    await write(opened.root, 'Add dark mode', 'Make it dark.');
    await interact(() => input(opened.root, 'Start a ferret').click());
    return opened;
  };

  it('starts the ferret with the brief, opens the card for it, and tells it which card is its own', async () => {
    const { root, actions, started, sent, created } = await ready({ startFerret: async () => 'fresh-7' });
    await send(root);
    expect(started).toEqual([startBrief({ title: 'Add dark mode', ask: 'Make it dark.' })]);
    expect(actions.calls[0]).toContain('"assignee":"fresh-7"');
    expect(sent).toEqual([{ sessionId: 'fresh-7', message: assignedMessage(card('F7', { title: 'New thing' })) }]);
    expect(created).toEqual(['F7']);
  });

  it('opens no card when the ferret would not start', async () => {
    const { root, actions, created } = await ready({
      startFerret: async () => {
        throw new Error('no capacity');
      },
    });
    await send(root);
    expect(alerts(root)).toEqual(['The ferret did not start: no capacity']);
    expect(actions.calls).toEqual([]);
    expect(created).toEqual([]);
    expect(buttonNamed(root, 'Create card').disabled).toBe(false);
  });

  it('names a start failure that is not an error', async () => {
    const { root } = await ready({ startFerret: () => Promise.reject('boom') });
    await send(root);
    expect(alerts(root)).toEqual(['The ferret did not start: boom']);
  });

  it('says the ferret is already running when the card is refused', async () => {
    const actions = fakeActions({ create: async () => refusal('the board is closed') });
    const { root, sent, created } = await ready({ actions });
    await send(root);
    expect(alerts(root)).toEqual(['the board is closed The ferret is already running; assign it from the chat.']);
    expect(sent).toEqual([]);
    expect(created).toEqual([]);
  });

  it('still hands the card back when the new ferret cannot be told about it', async () => {
    const { root, created } = await ready({
      sendMessage: async () => {
        throw new Error('it already exited');
      },
    });
    await send(root);
    expect(alerts(root)).toEqual(['&F7 was created, but the ferret was not told: it already exited']);
    expect(created).toEqual(['F7']);
  });

  it('names a tell failure that is not an error', async () => {
    const { root } = await ready({ sendMessage: () => Promise.reject('closed') });
    await send(root);
    expect(alerts(root)).toEqual(['&F7 was created, but the ferret was not told: closed']);
  });
});

describe('BoardNewCard — leaving', () => {
  it('cancels from the Cancel button', async () => {
    const { root, cancelled } = await open();
    await clickNamed(root, 'Cancel');
    expect(cancelled.count).toBe(1);
  });

  it('cancels on Escape from any field, and ignores other keys', async () => {
    const { root, cancelled } = await open();
    await interact(() => pressKey(input(root, 'Title'), 'a'));
    expect(cancelled.count).toBe(0);
    await interact(() => pressKey(input(root, 'Title'), 'Escape'));
    expect(cancelled.count).toBe(1);
  });
});
