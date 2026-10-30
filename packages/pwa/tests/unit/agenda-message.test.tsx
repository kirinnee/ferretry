import { describe, expect, test } from 'bun:test';
import {
  agendaAnswerMessage,
  agendaBatchMessage,
  agendaDiscussMessage,
  agendaDoneMessage,
  agendaReMessage,
  type AgendaSnapshot,
  parseAgendaMessage,
} from '@ferretry/protocol';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import {
  AGENDA_KIND_LABEL,
  AgendaItemsProvider,
  AgendaMessageOr,
  isChosenAnswer,
} from '../../src/components/agenda-message.tsx';
import { ReferenceSurfaceProvider } from '../../src/components/reference-surface.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';
import { render, run, runAsync } from '../support/react.ts';

const textOf = (node: ReactTestRenderer | ReactTestInstance): string => {
  const walk = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(walk).join('');
    if (value !== null && typeof value === 'object' && 'children' in value)
      return walk((value as { children: unknown }).children);
    return '';
  };
  return walk('toJSON' in node ? node.toJSON() : node.children);
};

const byClass = (view: ReactTestRenderer, className: string): ReactTestInstance[] =>
  view.root.findAll(node => typeof node.type === 'string' && node.props.className === className);

const ASK = 'How should outdated ferrets pick up new instructions after an update?';
const named = { id: 'A45', quote: ASK };

/** A board holding A45 (open, multiple choice), A7 (resolved by a written answer) and A9 (an approval). */
const snapshot = {
  items: [
    {
      id: 'A45',
      subject: ASK,
      title: 'Restarting outdated ferrets',
      ask: { kind: 'multiple-choice', options: [{ label: 'Button only' }, { label: 'Automatic' }] },
    },
  ],
  resolved: [
    { id: 'A7', subject: 'Ship it?', response: { kind: 'open-question', answer: 'after lunch' } },
    { id: 'A9', subject: 'Run the migration?', response: { kind: 'permission', decision: 'approve' } },
    { id: 'A11', subject: 'Which?', response: { kind: 'multiple-choice', choice: 'Left' } },
  ],
} as unknown as AgendaSnapshot;

const opened: string[] = [];
const surface = {
  agendaReferenceResolver: (id: string) => ['A45', 'A7', 'A9'].includes(id),
  onAgendaOpen: (id: string) => void opened.push(id),
};

const draw = (text: string, board: AgendaSnapshot | null = snapshot, write?: (text: string) => Promise<void>) =>
  render(
    <ReferenceSurfaceProvider surface={surface}>
      <AgendaItemsProvider snapshot={board}>
        <AgendaMessageOr fallback={<p data-fallback="">{text}</p>} text={text} {...(write ? { write } : {})} />
      </AgendaItemsProvider>
    </ReferenceSurfaceProvider>,
  );

describe('an agenda message in the owner bubble', () => {
  test('is drawn as words, unchanged, when it is not one', () => {
    const view = draw('just a message about !A45');
    expect(view.root.findAll(node => node.props['data-fallback'] === '')).toHaveLength(1);
    expect(byClass(view, 'fy-agenda-msg')).toHaveLength(0);
  });

  test('an answer: what happened, the proved chip, the item title, and the chosen option as a pill', () => {
    const view = draw(agendaAnswerMessage(named, 'Button only'));
    expect(textOf(byClass(view, 'fy-agenda-msg-kind')[0] as ReactTestInstance)).toBe('Answered');
    expect(textOf(byClass(view, 'fy-agenda-msg-title')[0] as ReactTestInstance)).toBe('Restarting outdated ferrets');
    expect(textOf(byClass(view, 'fy-agenda-msg-option')[0] as ReactTestInstance)).toBe('Button only');
    expect(byClass(view, 'fy-agenda-msg-text')).toHaveLength(0);
    // The chip is the grammar's own reference: proved, and opened the way every other `!A` is.
    const [link] = view.root.findAllByType('a');
    expect(link?.props['data-fy-reference']).toContain('A45');
    run(() => link?.props.onClick({ preventDefault() {}, button: 0, currentTarget: null }));
    expect(opened).toContain('A45');
  });

  test('a written answer is the prominent text, with the note under it', () => {
    const view = draw(agendaAnswerMessage({ id: 'A7', quote: 'Ship it?' }, 'after lunch', 'not before'));
    expect(textOf(byClass(view, 'fy-agenda-msg-text')[0] as ReactTestInstance)).toBe('after lunch');
    expect(textOf(byClass(view, 'fy-agenda-msg-note')[0] as ReactTestInstance)).toBe('Note: not before');
    expect(byClass(view, 'fy-agenda-msg-option')).toHaveLength(0);
  });

  test('falls back to the quoted ask when the board does not hold the item, and leaves an unproved chip as text', () => {
    const view = draw(agendaAnswerMessage({ id: 'A99', quote: 'Gone?' }, 'yes'), null);
    expect(textOf(byClass(view, 'fy-agenda-msg-title')[0] as ReactTestInstance)).toBe('Gone?');
    expect(view.root.findAllByType('a')).toHaveLength(0);
    expect(textOf(byClass(view, 'fy-agenda-msg-chip')[0] as ReactTestInstance)).toBe('!A99');
  });

  test('a reply names every item, and a discussion without a note shows no empty line', () => {
    const reply = draw(agendaReMessage([named, { id: 'A7', quote: 'Ship it?' }], 'are these related?'));
    expect(textOf(byClass(reply, 'fy-agenda-msg-kind')[0] as ReactTestInstance)).toBe('Reply');
    expect(byClass(reply, 'fy-agenda-msg-chip')).toHaveLength(2);
    expect(byClass(reply, 'fy-agenda-msg-title').map(node => textOf(node))).toEqual([
      'Restarting outdated ferrets',
      'Ship it?',
    ]);
    const discuss = draw(agendaDiscussMessage(named, '', 'fy'));
    expect(textOf(byClass(discuss, 'fy-agenda-msg-kind')[0] as ReactTestInstance)).toBe('Discussing');
    expect(byClass(discuss, 'fy-agenda-msg-text')).toHaveLength(0);
  });

  test('a batch is one card per answer', () => {
    const view = draw(agendaBatchMessage([agendaAnswerMessage(named, 'Automatic'), agendaDoneMessage(named)]));
    expect(byClass(view, 'fy-agenda-msg-part')).toHaveLength(2);
    expect(view.root.findByProps({ 'data-agenda-message': 'batch' })).toBeDefined();
  });

  test('keeps the sent text one tap away, and copies it whole', async () => {
    const text = agendaAnswerMessage(named, 'Button only');
    const written: string[] = [];
    const view = draw(text, snapshot, async value => void written.push(value));
    expect(byClass(view, 'fy-agenda-msg-raw')).toHaveLength(0);
    const toggle = byClass(view, 'fy-agenda-msg-raw-toggle')[0] as ReactTestInstance;
    expect(textOf(toggle)).toBe('Show sent text');
    run(() => toggle.props.onClick());
    expect(textOf(byClass(view, 'fy-agenda-msg-raw')[0] as ReactTestInstance)).toBe(text);
    expect(textOf(toggle)).toBe('Hide sent text');
    expect(toggle.props['aria-expanded']).toBe(true);
    await runAsync(async () => view.root.findByProps({ 'aria-label': 'Copy the sent text' }).props.onClick());
    expect(written).toEqual([text]);
  });

  test('reads without a provider: every card names its item by the quoted ask', () => {
    const view = render(<AgendaMessageOr fallback={null} text={agendaDoneMessage(named)} />);
    expect(textOf(byClass(view, 'fy-agenda-msg-title')[0] as ReactTestInstance)).toBe(ASK);
    expect(textOf(byClass(view, 'fy-agenda-msg-kind')[0] as ReactTestInstance)).toBe(AGENDA_KIND_LABEL.done);
  });
});

describe('which answers are a choice', () => {
  const part = (text: string) => parseAgendaMessage(agendaAnswerMessage(named, text))?.parts[0] as never;
  test('a picked option, an approval and a plain Done are; written words and other forms are not', () => {
    const items = new Map([...snapshot.items, ...snapshot.resolved].map(item => [item.id, item] as const));
    expect(isChosenAnswer(part('Done'), undefined)).toBe(true);
    expect(isChosenAnswer(part('Approved.'), items.get('A9'))).toBe(true);
    expect(isChosenAnswer(part('Left'), items.get('A11'))).toBe(true);
    expect(isChosenAnswer(part('Right'), items.get('A11'))).toBe(false);
    expect(isChosenAnswer(part('Automatic'), items.get('A45'))).toBe(true);
    expect(isChosenAnswer(part('Something else'), items.get('A45'))).toBe(false);
    expect(isChosenAnswer(part('after lunch'), items.get('A7'))).toBe(false);
    expect(isChosenAnswer(part('words'), undefined)).toBe(false);
    const done = parseAgendaMessage(agendaDoneMessage(named))?.parts[0] as never;
    expect(isChosenAnswer(done, items.get('A45'))).toBe(false);
  });
});

describe('the transcript', () => {
  test('draws the owner message the daemon worded about an item as its card', () => {
    const entry: TranscriptEntry = {
      id: 'u1',
      kind: 'user',
      text: agendaAnswerMessage(named, 'Button only'),
      at: Date.UTC(2026, 9, 30, 10, 7),
    };
    const view = render(<TranscriptRow entry={entry} />);
    expect(byClass(view, 'fy-agenda-msg')).toHaveLength(1);
    expect(textOf(view)).not.toContain('[answer to');
  });
});
