import { describe, it } from 'bun:test';
import should from 'should';
import {
  ATTENTION_READ_CAP,
  type AttentionContext,
  type AttentionSection,
  attentionSections,
  renderWhole,
} from '../../../../src/lib/connector/mcp/agenda-read.ts';
import { agendaItem, NOW } from '../../../support/connector/mcp-fixtures.ts';

/** The pure half of `get_attention`: what an item says in words, and the size cap on the whole answer. */

const WHO: AttentionContext = { asker: 'Lizzette', ferret: 'Lizzette', appOnly: false, now: NOW };
const AT = '2026-11-24T11:30:00.000Z';

const base = (extra: Record<string, unknown> = {}) =>
  agendaItem({ id: 'A7', subject: 'Pick one', why: 'Which?', extra: { title: 'Pick', ...extra } });
const overview = (extra: Record<string, unknown> = {}, who: AttentionContext = WHO): string =>
  attentionSections(base(extra), who).find(section => section.id === 'overview')?.text ?? '';
const replies = (extra: Record<string, unknown> = {}): string =>
  attentionSections(base(extra), WHO).find(section => section.id === 'replies')?.text ?? '';

describe('what an owner answer says, in words', () => {
  const said = (response: Record<string, unknown>, note?: string): string =>
    replies({ ownerAnswer: { at: AT, response, request: 1, ...(note === undefined ? {} : { note }) } });

  it('says approved, rejected, a chosen option, a verdict, free words, "none of these" and a form', () => {
    should(said({ kind: 'permission', decision: 'approve' })).containEql('(30 min ago): approved');
    should(said({ kind: 'permission', decision: 'reject' })).containEql('): rejected');
    should(said({ kind: 'multiple-choice', choice: 'SQLite' })).containEql('chose "SQLite"');
    should(said({ kind: 'answer-review', verdict: 'good' })).containEql('said it is good');
    should(said({ kind: 'answer-review', verdict: 'clarify', clarification: 'Explain more' })).containEql(
      'asked for changes: Explain more',
    );
    should(said({ kind: 'open-question', answer: 'Use the file' })).containEql('): Use the file');
    should(said({ kind: 'other', answer: 'Neither, ask Sam' }, 'soon')).containEql(
      'none of the options: Neither, ask Sam — note: soon',
    );
    should(
      said({
        kind: 'form',
        answers: [
          { id: 'name', picked: 'Ada' },
          { id: 'tags', picked: ['a', 'b'] },
        ],
      }),
    ).containEql('name = Ada; tags = a, b');
  });

  it('reads what the record kept of the owner’s words on an item with no conversation', () => {
    const text = replies({
      history: [
        { at: AT, kind: 'replied', note: 'Looks fine', response: { kind: 'permission', decision: 'approve' } },
        { at: AT, kind: 'replied', note: 'Just a note' },
        { at: AT, kind: 'updated' },
      ],
    });
    should(text).containEql('What was said before:');
    should(text).containEql('[replied, 30 min ago] approved — Looks fine');
    should(text).containEql('[replied, 30 min ago] Just a note');
    should(text).not.containEql('updated');
  });

  it('says nothing for an item nobody has replied to', () => {
    should(replies()).equal('');
  });
});

describe('what state an item says it is in', () => {
  it('says resting, in discussion, working, snoozed, a notice and closed', () => {
    const state = (extra: Record<string, unknown>) => /State: (.*?)\. Kind:/u.exec(overview(extra))?.[1];
    const resting = { parked: { reason: 'replied', at: AT } };
    should(state(resting)).equal('waiting on its ferret');
    should(state({ waitingOn: 'ferret', askedAt: AT, waitingFor: 'discussion' })).equal(
      'in discussion with its ferret',
    );
    should(state({ ...resting, resting: { sub: 'working', at: AT } })).equal('the ferret is working on it');
    should(state({ parked: { reason: 'snoozed', at: AT, until: '2026-11-25T11:00:00.000Z' } })).equal(
      'snoozed until 2026-11-25T11:00:00.000Z',
    );
    should(state({ notice: true })).equal('a notice');
    // A closed item is not on the open schema; the state function still reads it, so it is added after the parse.
    const closed = Object.assign(base(), { resolvedAt: AT });
    should(attentionSections(closed, WHO)[0]?.text).containEql('State: closed.');
  });
});

describe('what an item’s other parts say', () => {
  it('reads its own questions, with their options, recommendation and reason', () => {
    const text = overview({
      questions: [
        {
          question: 'Which store?',
          options: [{ label: 'Postgres' }, { label: 'SQLite', description: 'a file' }],
          recommended: 'SQLite',
          why: 'No server',
        },
        { question: 'Anything else?' },
      ],
    });
    should(text).containEql(
      'Question 1: Which store?\n- Postgres\n- SQLite — a file\n  Recommended: SQLite\n  Why: No server',
    );
    should(text).containEql('Question 2: Anything else?');
  });

  it('reads its terms and the how-to-test of a card ask', () => {
    const text = overview({
      terms: [{ term: 'Grant', meaning: 'A permission the owner gave' }],
      cardAsks: [
        {
          gate: {
            cardId: 'F1',
            laneId: 'test',
            laneName: 'Testing',
            entry: 3,
            projectId: 'p',
            cardTitle: 'Badge colour',
            options: [{ id: 'done', label: 'Done', outcome: 'next' }],
          },
          at: AT,
          howToTest: 'Open the app\nLook at the badge',
        },
        {
          gate: {
            cardId: 'F2',
            laneId: 'test',
            laneName: 'Testing',
            entry: 4,
            projectId: 'p',
            options: [{ id: 'done', label: 'Done', outcome: 'next' }],
          },
          at: AT,
          howToTest: 'Press go',
        },
        {
          gate: {
            cardId: 'F3',
            laneId: 'test',
            laneName: 'Testing',
            entry: 5,
            projectId: 'p',
            options: [{ id: 'done', label: 'Done', outcome: 'next' }],
          },
          at: AT,
        },
      ],
    });
    should(text).containEql('Terms:\n- Grant: A permission the owner gave');
    should(text).containEql('How to test (Badge colour, Testing):\nOpen the app\nLook at the badge');
    should(text).containEql('How to test (F2, Testing):\nPress go');
    should(text).not.containEql('F3');
  });
});

describe('section selectors stay unique', () => {
  it('suffixes the item’s own context when a tab already took "Context" and "Context (item)"', () => {
    const item = base({
      context: 'The item context.',
      tabs: [
        { id: 'context', name: 'Context', body: 'Tab one.' },
        { id: 'context-item', name: 'Context (item)', body: 'Tab two.' },
      ],
    });
    const sections = attentionSections(item, WHO);
    const names = sections.map(section => section.name);
    should(new Set(names.map(name => name.toLowerCase())).size).equal(names.length);
    should(new Set(sections.map(section => section.id)).size).equal(sections.length);
    should(sections.find(section => section.text === 'The item context.')?.name).equal('Context (item 2)');
  });
});

const section = (name: string, text: string): AttentionSection => ({ id: name.toLowerCase(), name, text });

describe('renderWhole always fits the cap', () => {
  it('returns a small item untouched', () => {
    const out = renderWhole('!A1 — T — from X', [section('One', 'a'), section('Two', 'b')]);
    should(out.cut).eql([]);
    should(out.text).equal('!A1 — T — from X\nSections: One; Two.\n\n## One\na\n\n## Two\nb');
  });

  it('fits six long tabs whose names are long, the case that once came out at 24 024 characters', () => {
    const sections = Array.from({ length: 6 }, (_, index) =>
      section(`${String(index)} ${'a-long-redacted-tab-name '.repeat(3).trim()}`, `${'x'.repeat(60)}\n`.repeat(2000)),
    );
    const out = renderWhole(`!A1 — ${'T'.repeat(120)} — from Lizzette`, sections);
    should(out.text.length).be.belowOrEqual(ATTENTION_READ_CAP);
    should(out.cut.length).equal(6);
    for (const each of sections) should(out.text).containEql(`tab "${each.name}" to read it whole`);
  });

  it('fits when only the shrinking loop can find the room (a few lines of huge width)', () => {
    const sections = Array.from({ length: 9 }, (_, index) => section(`Tab ${String(index)}`, 'y'.repeat(30_000)));
    const out = renderWhole('!A1 — T — from X', sections);
    should(out.text.length).be.belowOrEqual(ATTENTION_READ_CAP);
    should(out.text).containEql('Clipped to fit one answer.');
  });

  it('fits even when the names alone cannot (hundreds of sections with very long names): a hard cut', () => {
    const sections = Array.from({ length: 200 }, (_, index) =>
      section(`${String(index)} ${'N'.repeat(200)}`, 'text'.repeat(500)),
    );
    const out = renderWhole('!A1 — T — from X', sections);
    should(out.text.length).equal(ATTENTION_READ_CAP);
    should(out.cut.length).equal(200);
  });

  it('fits when every section is wide enough to need its width halved, and many lines are cut at line ends', () => {
    const wide = Array.from({ length: 700 }, () => 'z'.repeat(999)).join('\n');
    const sections = Array.from({ length: 4 }, (_, index) => section(`Wide ${String(index)}`, wide));
    const out = renderWhole('!A1 — T — from X', sections);
    should(out.text.length).be.belowOrEqual(ATTENTION_READ_CAP);
  });
});
