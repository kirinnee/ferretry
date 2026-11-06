import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaGate, AgendaItem } from '@ferretry/protocol';
import { Markdown } from '../../../src/components/markdown.tsx';
import { AgendaItemView } from '../../../src/features/agenda/agenda-item-view.tsx';
import type { HistoryEvent } from '../../../src/lib/agenda-history.ts';
import type { InboxAction } from '../../../src/lib/agenda-inbox.ts';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const tryGate: AgendaGate = {
  cardId: 'F12',
  laneId: 'tested',
  laneName: 'Ready to try',
  entry: 3,
  projectId: 'p1',
  cardTitle: 'Badge colour',
  options: [
    { id: 'done', label: 'Done', outcome: 'close' },
    { id: 'not-good', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
};
const planGate: AgendaGate = {
  ...tryGate,
  laneId: 'plan',
  laneName: 'Plan',
  options: [{ id: 'ok', label: 'OK to build', outcome: 'next' }],
};

const PREVIEW = '**Try it on the preview:** https://abc123.ferretry.pages.dev/inbox';
const STEPS = `${PREVIEW}\n\n1. Open the Inbox\n2. Tap Good\n\nShipped in Ferretry v1.2.3 (https://github.com/kirinnee/ferretry/pull/9).`;

/** The agenda the daemon opened for a card: raised by the daemon, named `card-agenda:`, asking only the card ask. */
const cardAgenda = (gate: AgendaGate, howToTest?: string): AgendaItem =>
  agendaItem('A404', {
    title: 'Badge colour',
    kind: 'reply',
    ask: { kind: 'open-question' },
    subject: gate.options.length > 1 ? 'Try it: Badge colour' : 'OK to build? Badge colour',
    raisedBy: 'daemon',
    source: 'task',
    sourceRef: 'card-agenda:F12',
    task: { id: 'F12' },
    stage: gate.options.length > 1 ? 'test' : 'plan',
    gateAttached: gate,
    cardAsks: [{ gate, at: '2026-08-01T11:00:00.000Z', ...(howToTest === undefined ? {} : { howToTest }) }],
  } as unknown as Partial<AgendaItem>);

/** `typedAnswer`: the host draws the box under the card and takes the typed words (the Inbox); the chat's agenda does not. */
const draw = async (
  item: AgendaItem,
  howToTestFor?: (id: string) => string | null,
  typedAnswer = true,
  history: readonly HistoryEvent[] = [],
): Promise<InboxAction[]> => {
  const acted: InboxAction[] = [];
  view = await mount(
    <AgendaItemView
      busy={false}
      error={null}
      ferret="Zoe"
      history={history}
      item={item}
      itemKey="laptop/sess-1/A404"
      now={NOW}
      onAct={action => acted.push(action)}
      onClose={() => undefined}
      position={{ index: 0, total: 1 }}
      renderProse={text => <Markdown text={text} />}
      swipeable={false}
      {...(typedAnswer ? { typedAnswer } : {})}
      {...(howToTestFor === undefined ? {} : { howToTestFor })}
    />,
  );
  return acted;
};

const root = (): HTMLElement => must(view?.container, 'the view');
const needs = (): HTMLElement => must(root().querySelector<HTMLElement>('[data-agenda-part="needs"]'), 'needs');

describe('a card’s own agenda asks ONE thing, inside “What I need from you”', () => {
  test('shows how to try it, one Good tap and the words line — and no second box to answer in', async () => {
    await draw(cardAgenda(tryGate, STEPS));
    const part = needs();
    // The ask is the item's own: its verb, the card named once on a plain line, and the daemon's repeat of it gone.
    expect(part.querySelector('[data-agenda-card-ask-title]')?.textContent).toBe('Try it');
    expect(part.querySelector('[data-agenda-card-ask-ref]')?.textContent).toBe('For &F12 Badge colour');
    expect(root().textContent).not.toMatch(/your answer for the card|Card &F12|card ask/iu);
    expect(part.textContent).not.toContain('Type your answer below.');
    expect(part.querySelector('[data-agenda-question-line]')).toBeNull();
    const own = must(part.querySelector('[data-agenda-own-ask="F12"]'), 'the one ask');
    expect(own.closest('[data-agenda-need]')).not.toBeNull();
    const tryIt = must(own.querySelector('[data-agenda-try-it]'), 'how to try it');
    expect(tryIt.textContent?.indexOf('Try it on the preview')).toBeLessThan(
      tryIt.textContent?.indexOf('Open the Inbox') ?? 0,
    );
    expect(tryIt.textContent).toContain('Shipped in Ferretry v1.2.3');
    expect(tryIt.querySelector('a')?.getAttribute('href') ?? tryIt.textContent).toContain(
      'https://abc123.ferretry.pages.dev/inbox',
    );
    const taps = [...own.querySelectorAll('[data-agenda-answer-option]')].map(node => node.textContent);
    expect(taps).toEqual(['Good']);
    expect(own.querySelector('[data-agenda-option="Not good"]')).toBeNull();
    expect(own.querySelector('[data-agenda-typed-lead]')?.textContent).toContain('Not good? Type what is wrong');
  });

  test('moves the card on Good, answering the lane’s own pass option', async () => {
    const acted = await draw(cardAgenda(tryGate, STEPS));
    await interact(() =>
      must(needs().querySelector<HTMLElement>('[data-agenda-answer-option="Done"]'), 'Good').click(),
    );
    expect(acted).toEqual([
      expect.objectContaining({ kind: 'respond', label: 'Done', gate: true, cardAsk: 'gate:F12:tested:3' }),
    ]);
  });

  test('says nothing back about “works now”: no second prompt beside Good, and Good is the one tap', async () => {
    const said = (text: string): HistoryEvent => ({
      kind: 'owner',
      key: 'o1',
      at: Date.parse('2026-08-01T11:30:00.000Z'),
      text,
    });
    const acted = await draw(cardAgenda(tryGate, STEPS), undefined, true, [said('works now')]);
    const own = must(needs().querySelector<HTMLElement>('[data-agenda-own-ask="F12"]'), 'the one ask');
    expect(needs().querySelector('[data-agenda-reply-offer]')).toBeNull();
    expect(needs().textContent).not.toMatch(/You wrote|If that is your answer/u);
    expect(acted).toEqual([]);
    await interact(() => must(own.querySelector<HTMLElement>('[data-agenda-answer-option="Done"]'), 'Good').click());
    expect(acted).toEqual([
      expect.objectContaining({ kind: 'respond', label: 'Done', gate: true, cardAsk: 'gate:F12:tested:3' }),
    ]);
  });

  test('reads an approval as an approval: the lane’s own option, and words that ask for changes first', async () => {
    const acted = await draw(cardAgenda(planGate));
    const own = must(needs().querySelector<HTMLElement>('[data-agenda-own-ask="F12"]'), 'the one ask');
    expect(own.querySelector('[data-agenda-try-it]')).toBeNull();
    expect(root().textContent).not.toContain('Try it');
    expect(needs().querySelector('[data-agenda-card-ask-title]')?.textContent).toBe('Approve');
    expect([...own.querySelectorAll('[data-agenda-answer-option]')].map(node => node.textContent)).toEqual([
      'OK to build',
    ]);
    expect(own.querySelector('[data-agenda-typed-lead]')?.textContent).toContain('Want something changed first?');
    await interact(() => must(own.querySelector<HTMLElement>('[data-agenda-answer-option]'), 'OK').click());
    expect(acted).toEqual([expect.objectContaining({ label: 'OK to build', gate: true, cardAsk: 'gate:F12:plan:3' })]);
  });

  test('falls back to the board’s steps when the daemon wrote none', async () => {
    await draw(cardAgenda(tryGate), id => (id === 'F12' ? '1. Open the badge' : null));
    expect(needs().querySelector('[data-agenda-try-it]')?.textContent).toContain('Open the badge');
  });

  test('draws no steps when nothing has any, but still draws the one ask', async () => {
    await draw(cardAgenda(tryGate));
    expect(needs().querySelector('[data-agenda-try-it]')).toBeNull();
    expect(needs().querySelector('[data-agenda-own-ask]')).not.toBeNull();
  });

  test('where the host takes no typed words (the chat’s agenda) keeps the ask’s own buttons: Done and Not good', async () => {
    const acted = await draw(cardAgenda(tryGate, STEPS), undefined, false);
    const part = needs();
    expect(part.querySelector('[data-agenda-own-ask]')).toBeNull();
    expect(part.querySelector('[data-agenda-typed-lead]')).toBeNull();
    const block = must(part.querySelector<HTMLElement>('[data-agenda-card-ask="gate:F12:tested:3"]'), 'the card ask');
    expect(block.querySelector('[data-agenda-card-ask-title]')?.textContent).toBe('Try it');
    expect(root().textContent).not.toMatch(/your answer for the card|Card &F12|card ask/iu);
    const labels = [...block.querySelectorAll('button')].map(button => button.textContent ?? '');
    expect(labels.some(label => label.includes('Done'))).toBe(true);
    expect(labels.some(label => label.includes('Not good'))).toBe(true);
    await interact(() =>
      must(
        [...block.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Done')),
        'Done',
      ).click(),
    );
    expect(acted).toEqual([expect.objectContaining({ kind: 'respond', label: 'Done', gate: true })]);
  });

  // &B165: the exception #1494 kept (a ferret's thread with a card ask drew "Card &F12: your answer for the card") is gone.
  test('keeps a ferret’s own question as the one ask: the try-it on the card waits as one line, no card heading (&B165)', async () => {
    const acted = await draw(
      agendaItem('A5', {
        title: 'Badge colour',
        kind: 'reply',
        ask: { kind: 'open-question' },
        subject: 'Which shade of blue do you prefer?',
        raisedBy: 'agent',
        gateAttached: tryGate,
        cardAsks: [{ gate: tryGate, at: '2026-08-01T11:00:00.000Z', howToTest: STEPS }],
      } as unknown as Partial<AgendaItem>),
    );
    const part = needs();
    expect(part.querySelector('[data-agenda-question-line]')?.textContent).toContain('Which shade of blue');
    expect(root().textContent).not.toMatch(/your answer for the card|Card &F12|card ask/iu);
    // The question is answered in words: no try-it block, no Done / Not good — only the one line that names what comes next.
    expect(part.querySelector('[data-agenda-card-ask]')).toBeNull();
    expect(part.querySelector('[data-agenda-own-ask]')).toBeNull();
    expect(part.querySelectorAll('[data-agenda-option], [data-agenda-answer-option]')).toHaveLength(0);
    expect(part.querySelector('[data-agenda-card-ask-later]')?.textContent).toContain('&F12 Badge colour');
    expect(acted).toEqual([]);
  });

  // &B165 round 3: the question is said once. The sticky title above IS the question when the item has no title of its own.
  test('does not say the question twice: the title is the question, so the block leaves it out; a long ask stays whole', async () => {
    await draw(
      agendaItem('A6', {
        kind: 'reply',
        ask: { kind: 'open-question' },
        subject: 'Should a capacity request wait for the owner?',
        raisedBy: 'agent',
        cardAsks: [{ gate: tryGate, at: '2026-08-01T11:00:00.000Z', howToTest: STEPS }],
      } as unknown as Partial<AgendaItem>),
    );
    expect(needs().querySelector('[data-agenda-question-line]')).toBeNull();
    await view?.unmount();
    view = null;
    const long =
      `${'Should a capacity request wait for the owner when the machine is busy with other work? '.repeat(2)}`.trim();
    await draw(
      agendaItem('A7', {
        kind: 'reply',
        ask: { kind: 'open-question' },
        subject: long,
        raisedBy: 'agent',
        cardAsks: [{ gate: tryGate, at: '2026-08-01T11:00:00.000Z', howToTest: STEPS }],
      } as unknown as Partial<AgendaItem>),
    );
    expect(needs().querySelector('[data-agenda-question-line]')?.textContent).toContain('machine is busy');
  });
});
