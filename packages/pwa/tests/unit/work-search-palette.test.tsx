import { afterEach, describe, expect, it } from 'bun:test';
import type { WorkHit } from '@ferretry/protocol';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import type { WorkSearchPort, WorkSearchRequest } from '../../src/lib/work-search.ts';
import { CommandPalette, type CommandPaletteProps } from '../../src/shell/command-palette.tsx';
import { interact, type Mounted, mount, pressKey } from '../support/dom.ts';

const RELAY_PROJECT = '6f1c2f0e-3a4b-4c55-9d1e-0a7b8c9d1e2f';

const alpha = daemonId('alpha');

const card = (id: string, patch: Partial<Extract<WorkHit, { kind: 'task' }>> = {}): WorkHit => ({
  kind: 'task',
  id,
  projectId: RELAY_PROJECT,
  sessionId: 's1',
  title: `Card ${id}`,
  state: 'open',
  standing: 'Doing',
  updatedAt: '2026-10-30T10:00:00.000Z',
  match: { field: 'brief', line: 'the relay handshake drops' },
  score: 3,
  ...patch,
});

const item = (id: string, patch: Partial<Extract<WorkHit, { kind: 'agenda' }>> = {}): WorkHit => ({
  kind: 'agenda',
  id,
  sessionId: 's1',
  title: `Agenda ${id}`,
  state: 'open',
  standing: 'open',
  updatedAt: '2026-10-30T10:00:00.000Z',
  match: { field: 'body', line: 'which relay should we pick' },
  score: 2,
  ...patch,
});

const HITS: readonly WorkHit[] = [
  card('F10', { title: 'Harden the relay' }),
  card('F11', { title: 'Old relay notes', state: 'closed', standing: 'Done' }),
  item('A3', { title: 'Pick a relay region' }),
  item('A4', { title: 'Relay budget', state: 'closed', standing: 'addressed' }),
];

/** A fake daemon search: filters the fixed hits by the request's kind and open flag, and records what it was asked. */
const fakePort = (hits: readonly WorkHit[] = HITS) => {
  const asked: WorkSearchRequest[] = [];
  const port: WorkSearchPort = {
    search: async request => {
      asked.push(request);
      const found = hits.filter(
        hit =>
          (request.kind === undefined || hit.kind === request.kind) && (request.open !== true || hit.state === 'open'),
      );
      return { hits: found, total: found.length, indexed: { tasks: hits.length, agenda: hits.length } };
    },
  };
  return { port, asked };
};

let live: Mounted | undefined;

afterEach(async () => {
  await live?.unmount();
  live = undefined;
});

const open = async (overrides: Partial<CommandPaletteProps> = {}): Promise<{ navigated: string[] }> => {
  const navigated: string[] = [];
  live = await mount(
    <CommandPalette
      open
      focusSignal={0}
      onClose={() => {}}
      daemon={alpha}
      sessions={[]}
      destinations={[]}
      onNavigate={href => navigated.push(href)}
      {...overrides}
    />,
  );
  return { navigated };
};

const input = (): HTMLInputElement => {
  const element = document.getElementById('fy-palette-input');
  if (!(element instanceof HTMLInputElement)) throw new Error('the palette input is not mounted');
  return element;
};

const type = async (value: string): Promise<void> => {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const settle = async (ms = 250): Promise<void> => {
  await interact(() => new Promise(resolve => setTimeout(resolve, ms)));
};

/** A press the way the palette reads one: a pointer-down and the matching pointer-up. */
const press = async (row: Element): Promise<void> => {
  await interact(() => {
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 7 });
      row.dispatchEvent(event);
    }
  });
};

const headings = (): string[] =>
  [...document.querySelectorAll('[id^="fy-palette-group-"]')].map(node => node.textContent ?? '');

const optionText = (): string[] =>
  [...document.querySelectorAll('[role="option"]')].map(node => node.textContent ?? '');

const chip = (label: string): HTMLElement => {
  const found = [...document.querySelectorAll('[aria-pressed]')].find(node => node.textContent?.trim() === label);
  if (!(found instanceof HTMLElement)) throw new Error(`no filter chip named ${label}`);
  return found;
};

describe('the finder over the daemon work search', () => {
  it('shows a card and an agenda item found by words in their text', async () => {
    const { port } = fakePort();
    await open({ workSearch: port });
    await type('relay handshake');
    await settle();

    expect(headings()).toEqual(expect.arrayContaining(['Cards', 'Agenda']));
    const rows = optionText();
    expect(rows.some(row => row.includes('Harden the relay') && row.includes('the relay handshake drops'))).toBe(true);
    expect(rows.some(row => row.includes('Pick a relay region') && row.includes('which relay should we pick'))).toBe(
      true,
    );
  });

  it('writes each id the reference way, and leaves the kind to the group heading instead of a pill on every row', async () => {
    const { port } = fakePort();
    await open({ workSearch: port });
    await type('relay');
    await settle();

    const rows = optionText();
    const cardRow = rows.find(row => row.includes('Harden the relay'));
    const agendaRow = rows.find(row => row.includes('Pick a relay region'));
    expect(cardRow).toContain('&F10');
    expect(agendaRow).toContain('!A3');
    for (const row of rows) {
      expect(row).not.toMatch(/(^|\s)(Card|Agenda)(?=[&!])/u);
      expect(row.startsWith('Card')).toBe(false);
      expect(row.startsWith('Agenda')).toBe(false);
    }
  });

  it("names a card's project under it, says Unfiled for the unfiled board, and never shows an id", async () => {
    const stranger = '11111111-2222-4333-8444-555555555555';
    const { port } = fakePort([
      card('F10', { title: 'Harden the relay', projectId: RELAY_PROJECT }),
      card('F11', { title: 'Loose relay idea', projectId: 'unfiled' }),
      card('F12', { title: 'Orphan relay card', projectId: stranger }),
    ]);
    await open({ workSearch: port, workProjectNames: new Map([[RELAY_PROJECT, 'Relay']]) });
    await type('relay');
    await settle();

    const rows = optionText();
    const named = rows.find(row => row.includes('Harden the relay'));
    const unfiled = rows.find(row => row.includes('Loose relay idea'));
    const unknown = rows.find(row => row.includes('Orphan relay card'));
    expect(named).toContain('Relay');
    expect(unfiled).toContain('Unfiled');
    expect(unknown).toBeDefined();
    for (const row of rows) {
      expect(row).not.toContain(RELAY_PROJECT);
      expect(row).not.toContain(stranger);
      expect(row).not.toContain('unfiled');
    }
  });

  it('opens a card on the board and an agenda item in its session', async () => {
    const { port } = fakePort();
    const { navigated } = await open({ workSearch: port });
    await type('relay');
    await settle();

    const options = [...document.querySelectorAll('[role="option"]')];
    const cardRow = options.find(row => row.textContent?.includes('Harden the relay'));
    const agendaRow = options.find(row => row.textContent?.includes('Pick a relay region'));
    if (cardRow === undefined || agendaRow === undefined) throw new Error('rows are missing');
    await press(cardRow);
    await press(agendaRow);

    expect(navigated[0]).toContain('F10');
    expect(navigated[1]).toContain('s1');
    expect(navigated[1]).toContain('A3');
  });

  it('narrows to cards or agenda with the filter chips, and asks the daemon for just that kind', async () => {
    const { port, asked } = fakePort();
    await open({ workSearch: port });
    await type('relay');
    await settle();
    expect(headings()).toEqual(expect.arrayContaining(['Cards', 'Agenda']));

    await interact(() => chip('Cards').click());
    await settle();
    expect(headings()).toContain('Cards');
    expect(headings()).not.toContain('Agenda');
    expect(asked.at(-1)?.kind).toBe('task');

    await interact(() => chip('Agenda').click());
    await settle();
    expect(headings()).toContain('Agenda');
    expect(headings()).not.toContain('Cards');
    expect(asked.at(-1)?.kind).toBe('agenda');
  });

  it('keeps closed work visible by default and drops it under Open', async () => {
    const { port } = fakePort();
    await open({ workSearch: port });
    await type('relay');
    await settle();
    expect(optionText().some(row => row.includes('Old relay notes'))).toBe(true);
    expect(optionText().some(row => row.includes('Relay budget'))).toBe(true);

    await interact(() => chip('Open').click());
    await settle();
    expect(optionText().some(row => row.includes('Old relay notes'))).toBe(false);
    expect(optionText().some(row => row.includes('Relay budget'))).toBe(false);
  });

  it('moves the active option across both groups with the arrow keys', async () => {
    const { port } = fakePort();
    await open({ workSearch: port });
    await type('relay');
    await settle();

    const ids = [...document.querySelectorAll('[role="option"]')].map(node => node.id);
    expect(ids.length).toBe(4);
    for (const expected of ids) {
      expect(input().getAttribute('aria-activedescendant')).toBe(expected);
      await interact(() => pressKey(input(), 'ArrowDown'));
    }
  });

  it('shows no Cards or Agenda group, and no filter chips, on a machine that cannot search', async () => {
    await open();
    await type('relay');
    await settle();

    expect(headings()).not.toContain('Cards');
    expect(headings()).not.toContain('Agenda');
    expect(document.querySelector('[aria-pressed]')).toBeNull();
  });

  it('does not ask the daemon until something is typed', async () => {
    const { port, asked } = fakePort();
    await open({ workSearch: port });
    await settle();
    expect(asked).toEqual([]);
    expect(document.querySelector('[aria-pressed]')).toBeNull();
  });
});
