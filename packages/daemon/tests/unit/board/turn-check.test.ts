import { describe, it } from 'bun:test';
import type { BoardSkip, BoardTaskResponse, TaskRef } from '@ferretry/protocol';
import should from 'should';
import { BoardError } from '../../../src/lib/board/errors.ts';
import {
  BOARD_CHECK_INTERVAL_MS,
  BOARD_CHECK_TAIL,
  BoardTurnCheck,
  type BoardTurnCheckPorts,
  boardCheckMessage,
  boardCheckSendId,
  isOpenCard,
  mutatingWork,
} from '../../../src/lib/board/turn-check.ts';
import type { TranscriptEvent } from '../../../src/lib/transcript/types.ts';
import { card, lanes } from './support.ts';

const owner = (text: string, inputSource?: 'harness'): TranscriptEvent => ({
  kind: 'message',
  harness: 'claude',
  role: 'user',
  text,
  ...(inputSource === undefined ? {} : { inputSource }),
});
const said = (text: string): TranscriptEvent => ({ kind: 'message', harness: 'claude', role: 'assistant', text });
const call = (name: string, input: unknown): TranscriptEvent =>
  ({ kind: 'tool-call', harness: 'claude', role: 'assistant', call: { id: name, name, input } }) as TranscriptEvent;

/** A card response on the support project's board. */
const response = (overrides: Parameters<typeof card>[0] = {}): BoardTaskResponse =>
  ({ task: { ...card(overrides) }, laneSet: lanes() }) as unknown as BoardTaskResponse;

const HOUR = BOARD_CHECK_INTERVAL_MS;

/** Ports over a transcript, a focus, a skip and a card; records what was sent and journalled. */
function harness(
  options: {
    readonly events?: readonly TranscriptEvent[];
    readonly focus?: TaskRef | null;
    readonly skip?: BoardSkip | null;
    readonly card?: () => Promise<BoardTaskResponse>;
    readonly readable?: boolean;
    readonly boardOn?: boolean;
  } = {},
) {
  const sent: { sessionId: string; sendId: string; message: string }[] = [];
  const records: { sessionId: string; seen: readonly string[] }[] = [];
  const tails: number[] = [];
  let now = 10 * HOUR;
  const ports: BoardTurnCheckPorts = {
    readable: async () => options.readable ?? true,
    boardOn: async () => options.boardOn ?? true,
    tail: async (_sessionId, limit) => {
      tails.push(limit);
      return options.events ?? [owner('fix the bug'), call('Edit', { file_path: '/w/a.ts' })];
    },
    focus: {
      focusOf: async () => options.focus ?? null,
      skipOf: async () => options.skip ?? null,
    },
    card: options.card ?? (async () => response()),
    send: async (sessionId, sendId, message) => void sent.push({ sessionId, sendId, message }),
    record: async (sessionId, seen) => void records.push({ sessionId, seen }),
    now: () => now,
  };
  return { ports, sent, records, tails, advance: (ms: number) => (now += ms) };
}

describe('mutatingWork', () => {
  it.each([
    ['an Edit', call('Edit', { file_path: '/w/a.ts' }), ['Edit']],
    ['a Write', call('Write', { file_path: '/w/b.ts', content: 'x' }), ['Write']],
    ['a MultiEdit', call('MultiEdit', { file_path: '/w/a.ts' }), ['MultiEdit']],
    ['a notebook edit', call('NotebookEdit', { notebook_path: '/w/n.ipynb' }), ['NotebookEdit']],
    ["Codex's patch", call('apply_patch', { input: '*** Begin Patch' }), ['apply_patch']],
    ['a git commit', call('Bash', { command: 'git commit --only a.ts -m "fix: it"' }), ['git commit']],
    ['a git -C push', call('Bash', { command: 'git -C /w push origin HEAD' }), ['git push']],
    ['an argv push', call('local_shell', { command: ['git', 'push'] }), ['git push']],
    ['a cmd PR', call('exec_command', { cmd: 'gh pr create --fill' }), ['gh pr create']],
    ['a sub-ferret', call('Bash', { command: 'cd /w && direnv exec . zz new --name "X" "brief"' }), ['zz new']],
  ])('should see %s as mutating', (_name, event, expected) => {
    // Act + Assert
    should(mutatingWork([owner('go'), event], 'zz')).eql(expected);
  });

  it('should name each kind of work once, in the order first seen', () => {
    // Arrange
    const events = [
      owner('go'),
      call('Edit', {}),
      call('Bash', { command: 'git commit -m x && git push' }),
      call('Edit', {}),
    ];

    // Act + Assert
    should(mutatingWork(events, 'zz')).eql(['Edit', 'git commit', 'git push']);
  });

  it.each([
    ['a read', call('Read', { file_path: '/w/a.ts' })],
    ['a search for the words', call('Grep', { pattern: 'git commit' })],
    ['a status', call('Bash', { command: 'git status && git log --oneline' })],
    ['a board read', call('Bash', { command: 'zz task show F1 && zz newsletter' })],
    ['another binary', call('Bash', { command: 'fy new "x"' })],
    ['a command that is not text', call('Bash', { command: 42 })],
    ['an input that is not an object', call('Bash', 'git push')],
    ['an argv with a number', call('local_shell', { command: ['git', 1] })],
  ])('should not see %s as mutating', (_name, event) => {
    // Act + Assert
    should(mutatingWork([owner('look'), event, said('Here is what I found.')], 'zz')).eql([]);
  });

  it('should read only the last turn: from the last user-channel message, past what the harness wrote', () => {
    // Arrange
    const events = [
      owner('fix it'),
      call('Edit', {}),
      said('Fixed.'),
      owner('what changed?'),
      owner('background task finished', 'harness'),
      call('Read', {}),
      said('This.'),
    ];

    // Act + Assert
    should(mutatingWork(events, 'zz')).eql([]);
  });

  it('should read the whole tail when it holds no opener', () => {
    // Act + Assert
    should(mutatingWork([call('Write', {}), said('done')], 'zz')).eql(['Write']);
  });

  it('should never check a turn the nudge itself started, nor one an older tagged nudge started', () => {
    // Arrange
    const events = [owner(boardCheckMessage('zz')), call('Edit', {})];
    const older = [owner('[board] You changed code this turn without a card. Create one…'), call('Edit', {})];

    // Act + Assert
    should(mutatingWork(events, 'zz')).eql([]);
    should(mutatingWork(older, 'zz')).eql([]);
  });
});

describe('the board check words', () => {
  it('should name the create and skip verbs with the binary name, as a plain sentence with no tag', () => {
    // Act
    const message = boardCheckMessage('zz');

    // Assert
    should(message).equal(
      'You changed code this turn without a card. Create one (zz task create …) or record why not: zz task skip "<why>"',
    );
  });

  it('should key a send by session and hour, so a replayed turn end is one send', () => {
    // Act + Assert
    should(boardCheckSendId('s-1', 3 * HOUR + 5)).equal(boardCheckSendId('s-1', 3 * HOUR + HOUR - 1));
    should(boardCheckSendId('s-1', 3 * HOUR)).not.equal(boardCheckSendId('s-1', 4 * HOUR));
    should(boardCheckSendId('s-1', 0)).equal('board-check-s-1-0');
  });
});

describe('isOpenCard', () => {
  it('should count a card in any lane that is not closed, and not dropped', () => {
    // Act + Assert
    should(isOpenCard(response())).be.true();
    should(isOpenCard(response({ laneId: 'closed' }))).be.false();
    should(
      isOpenCard(response({ dropped: { reason: 'superseded', at: '2026-10-30T10:00:00.000Z' } } as never)),
    ).be.false();
  });

  it('should not count a card whose lane its board does not hold, or a board with no lanes', () => {
    // Act + Assert
    should(isOpenCard(response({ laneId: 'gone' } as never))).be.false();
    should(isOpenCard({ ...response(), laneSet: null })).be.false();
  });
});

describe('BoardTurnCheck', () => {
  it('should nudge a turn that edited with no card, once, and journal what it saw', async () => {
    // Arrange
    const h = harness();

    // Act
    const actual = await new BoardTurnCheck(h.ports, 'zz').check('s-1');

    // Assert
    should(actual).be.true();
    should(h.tails).eql([BOARD_CHECK_TAIL]);
    should(h.sent).eql([
      { sessionId: 's-1', sendId: boardCheckSendId('s-1', 10 * HOUR), message: boardCheckMessage('zz') },
    ]);
    should(h.records).eql([{ sessionId: 's-1', seen: ['Edit'] }]);
  });

  it('should nudge at most once an hour per session, and again after the hour', async () => {
    // Arrange
    const h = harness();
    const check = new BoardTurnCheck(h.ports, 'zz');

    // Act
    const first = await check.check('s-1');
    h.advance(HOUR - 1);
    const soon = await check.check('s-1');
    const other = await check.check('s-2');
    h.advance(1);
    const later = await check.check('s-1');

    // Assert
    should([first, soon, other, later]).eql([true, false, true, true]);
    should(h.sent.map(send => send.sessionId)).eql(['s-1', 's-2', 's-1']);
  });

  it('should say nothing for a read-only turn, or a session it cannot read', async () => {
    // Arrange
    const reading = harness({ events: [owner('why?'), call('Read', {}), said('Because.')] });
    const unreadable = harness({ readable: false });

    // Act + Assert
    should(await new BoardTurnCheck(reading.ports, 'zz').check('s-1')).be.false();
    should(await new BoardTurnCheck(unreadable.ports, 'zz').check('s-1')).be.false();
    should(unreadable.tails).eql([]);
    should([...reading.sent, ...unreadable.sent]).eql([]);
  });

  it('should say nothing on a board that is off, however much the turn changed', async () => {
    // Arrange
    const h = harness({ boardOn: false });

    // Act + Assert
    should(await new BoardTurnCheck(h.ports, 'zz').check('s-1')).be.false();
    should(h.sent).eql([]);
    should(h.records).eql([]);
  });

  it('should say nothing while a skip stands', async () => {
    // Arrange
    const h = harness({ skip: { reason: 'the owner said not to track this', at: '2026-10-30T10:00:00.000Z' } });

    // Act + Assert
    should(await new BoardTurnCheck(h.ports, 'zz').check('s-1')).be.false();
    should(h.sent).eql([]);
  });

  it('should say nothing when the focus card is open, and nudge when it is closed or gone', async () => {
    // Arrange
    const open = harness({ focus: { id: 'F1' } });
    const closed = harness({ focus: { id: 'F1' }, card: async () => response({ laneId: 'closed' }) });
    const gone = harness({
      focus: { id: 'F9' },
      card: async () => {
        throw new BoardError('not-found', 'there is no card on this machine');
      },
    });

    // Act + Assert
    should(await new BoardTurnCheck(open.ports, 'zz').check('s-1')).be.false();
    should(await new BoardTurnCheck(closed.ports, 'zz').check('s-1')).be.true();
    should(await new BoardTurnCheck(gone.ports, 'zz').check('s-1')).be.true();
  });

  it('should throw, and send nothing, when the card cannot be read for any other reason', async () => {
    // Arrange
    const h = harness({
      focus: { id: 'F1' },
      card: async () => {
        throw new Error('board directory is unreadable');
      },
    });

    // Act + Assert
    await should(new BoardTurnCheck(h.ports, 'zz').check('s-1')).be.rejectedWith(/unreadable/u);
    should(h.sent).eql([]);
  });
});
