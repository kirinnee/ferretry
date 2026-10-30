import { describe, it } from 'bun:test';
import { type BoardTaskEvent, parseFerretryNotice, type PrLink } from '@ferretry/protocol';
import should from 'should';
import {
  FOCUS_HISTORY_LINES,
  focusCardBrief,
  type WardenFocusCard,
  wardenResumeMessage,
} from '../../../src/lib/warden/index.ts';
import { lanes, PROJECT } from '../board/support.ts';
import { cardView } from './board-fixtures.ts';

const pr = (overrides: Partial<PrLink> = {}): PrLink => ({
  url: 'https://github.com/kirinnee/ferretry/pull/42',
  number: 42,
  repo: 'kirinnee/ferretry',
  state: 'open',
  draft: false,
  checks: 'passing',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: '2026-10-30T10:00:00.000Z',
  ...overrides,
});

const note = (seq: number, text: string): BoardTaskEvent => ({
  seq,
  at: `2026-10-30T10:0${seq}:00.000Z`,
  actor: { kind: 'ferret', sessionId: 'worker' },
  type: 'note',
  text,
});

const focus = (task = cardView({ title: 'Ship the thing' })): WardenFocusCard => ({ task, laneSet: lanes(PROJECT) });

describe('focusCardBrief', () => {
  it('should name the card and its lane, and quote the ask verbatim with where it came from', () => {
    // Act
    const text = focusCardBrief(focus());

    // Assert
    should(text.split('\n').slice(0, 5)).eql([
      'Your card: &F1 — Ship the thing',
      'Lane: Implement',
      '',
      'The ask, verbatim (owner):',
      'build the board',
    ]);
    should(text).endWith(
      'Carry on with &F1: move it as you work (`fy task move F1 <lane>`), and note why if you stop.',
    );
  });

  it('should quote every clarification verbatim', () => {
    // Arrange
    const task = cardView({
      clarifications: [
        { text: 'and in dark mode', source: 'chat://2', at: '2026-10-30T10:00:00.000Z', by: { kind: 'owner' } },
        { text: 'not on Sundays', source: 'chat://3', at: '2026-10-30T10:00:00.000Z', by: { kind: 'owner' } },
      ],
    });

    // Act
    const text = focusCardBrief(focus(task));

    // Assert
    should(text).containEql('Clarified, verbatim (chat://2):\nand in dark mode');
    should(text).containEql('Clarified, verbatim (chat://3):\nnot on Sundays');
  });

  it('should list every link, a draft PR as a draft', () => {
    // Arrange
    const task = cardView({
      links: {
        prs: [pr(), pr({ url: 'https://github.com/kirinnee/ferretry/pull/43', number: 43, draft: true })],
        branch: 'feat/board',
        commits: ['abc1234'],
        docs: ['docs/board.md'],
      },
    });

    // Act
    const text = focusCardBrief(focus(task));

    // Assert
    should(text).containEql(
      [
        'Links:',
        '- PR #42 https://github.com/kirinnee/ferretry/pull/42 (open)',
        '- PR #43 https://github.com/kirinnee/ferretry/pull/43 (draft)',
        '- branch feat/board',
        '- commit abc1234',
        '- doc docs/board.md',
      ].join('\n'),
    );
  });

  it('should leave the links out when there are none', () => {
    // Act + Assert
    should(focusCardBrief(focus())).not.containEql('Links:');
  });

  it(`should show the newest ${FOCUS_HISTORY_LINES} history lines, in the words fy task show uses`, () => {
    // Arrange
    const base = cardView();
    const history = [...base.history, ...[2, 3, 4, 5, 6, 7].map(seq => note(seq, `step ${seq}`))];

    // Act
    const text = focusCardBrief(focus({ ...base, history }));

    // Assert
    const shown = text.split('\n').filter(line => line.startsWith('- 2026'));
    should(shown).eql([
      '- 2026-10-30T10:03:00.000Z  note: step 3',
      '- 2026-10-30T10:04:00.000Z  note: step 4',
      '- 2026-10-30T10:05:00.000Z  note: step 5',
      '- 2026-10-30T10:06:00.000Z  note: step 6',
      '- 2026-10-30T10:07:00.000Z  note: step 7',
    ]);
  });

  it('should name lanes by id when the board’s lanes are unknown', () => {
    // Act
    const text = focusCardBrief({ task: cardView(), laneSet: null });

    // Assert
    should(text).containEql('Lane: implement');
    should(text).containEql('created in implement');
  });

  it('should name a ferret in its history by its session id', () => {
    // Arrange
    const base = cardView();
    const assigned: BoardTaskEvent = {
      seq: 2,
      at: '2026-10-30T10:02:00.000Z',
      actor: { kind: 'ferret', sessionId: 'lead' },
      type: 'assigned',
      from: 'lead',
      to: 'worker',
    };

    // Act
    const text = focusCardBrief(focus({ ...base, history: [...base.history, assigned] }));

    // Assert
    should(text).containEql('- 2026-10-30T10:02:00.000Z  assigned lead → worker');
  });
});

describe('wardenResumeMessage', () => {
  it('should say the Warden resumed the ferret, why, and hand it the card', () => {
    // Act
    const text = parseFerretryNotice(
      wardenResumeMessage('resume', 'its turn died but the work should continue.', focus()),
    );

    // Assert
    should(text).startWith('The Warden resumed you: its turn died but the work should continue.\n\n');
    should(text).containEql('This notice is from Ferretry, not from the owner.');
    should(text).containEql('continue from where you stopped, on the card below.\n\nYour card: &F1 — Ship the thing');
  });

  it('should say a restart kept the conversation', () => {
    // Act
    const text = parseFerretryNotice(wardenResumeMessage('restart', 'its process is frozen', focus()));

    // Assert
    should(text).startWith('The Warden restarted you with your conversation intact: its process is frozen.');
  });
});
