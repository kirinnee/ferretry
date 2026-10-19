/**
 * What the owner said, read back out of a transcript that also records how each message was delivered:
 * Ferretry's and kteam's turn-file pointers, a harness's reminders and an attachment list. Every
 * transcript and document here is an invented fixture.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  handoffDocumentMessage,
  handoffPointerPath,
  handoffPointers,
  isReadableHandoff,
  recentExchanges,
  spokenMessages,
  spokenText,
  truncateText,
  withoutDeliveryWrappers,
} from '../../../src/lib/imports/conversation-text.ts';
import type { TranscriptEvent } from '../../../src/lib/transcript/index.ts';

const pointer = (path: string): string =>
  `Read the file ${path} now, then carefully follow every instruction inside it. This is your complete task for this turn.`;
const FERRETRY_TURN = '/home/owner/.ferretry/state/sessions/s-1/turns/turn-001.md';
const COORDINATOR_TURN = '/Users/owner/.coordinator/abc-123/turns/turn-001.md';
const COORDINATOR_DOCUMENT = [
  '# kteam teammate contract',
  '',
  'You are in AUTOMODE. Never ask the user a question.',
  '',
  '# Assigned task',
  '',
  'Fix the flaky upload test',
  '',
].join('\n');

const user = (text: string): TranscriptEvent => ({ harness: 'claude', role: 'user', kind: 'message', text });
const assistant = (text: string): TranscriptEvent => ({ harness: 'claude', role: 'assistant', kind: 'message', text });

describe('a hand-off pointer', () => {
  it('should name the document of a Ferretry or a kteam pointer, and nothing for prose', () => {
    // Act & Assert
    should(handoffPointerPath(pointer(FERRETRY_TURN))).equal(FERRETRY_TURN);
    should(handoffPointerPath(`  ${pointer(COORDINATOR_TURN)}\n`)).equal(COORDINATOR_TURN);
    should(handoffPointerPath(`Please: ${pointer(COORDINATOR_TURN)}`)).be.undefined();
    should(handoffPointerPath('Fix the cart')).be.undefined();
  });

  it('should collect every distinct document a transcript points at', () => {
    // Act
    const paths = handoffPointers([
      user(pointer(FERRETRY_TURN)),
      assistant(pointer(COORDINATOR_TURN)),
      user(pointer(FERRETRY_TURN)),
      user(pointer(COORDINATOR_TURN)),
      { harness: 'claude', role: 'user', kind: 'reasoning', text: 'x', format: 'thinking' },
    ]);

    // Assert
    should(paths).deepEqual([FERRETRY_TURN, COORDINATOR_TURN]);
  });

  it('should read a session folder’s documents, and only a coordinator’s turn files in a home', () => {
    // Arrange
    const scope = { roots: ['/home/owner/.ferretry/state/sessions/'], coordinatorHomes: ['/Users/owner'] };

    // Act & Assert
    should(isReadableHandoff(FERRETRY_TURN, scope)).be.true();
    should(isReadableHandoff('/home/owner/.ferretry/state/sessions/s-1/channel/queued-a.md', scope)).be.true();
    should(isReadableHandoff(COORDINATOR_TURN, scope)).be.true();
    should(isReadableHandoff('/Users/owner/.coordinator/abc/turns/turn-001.txt', scope)).be.false();
    should(isReadableHandoff('/Users/owner/.coordinator/abc/deep/turns/turn-001.md', scope)).be.false();
    should(isReadableHandoff('/Users/owner/visible/abc/turns/turn-001.md', scope)).be.false();
    should(isReadableHandoff('/Users/owner/.ssh/id_ed25519', scope)).be.false();
    should(isReadableHandoff('/Users/owner', scope)).be.false();
    should(isReadableHandoff('/Users/ownerx/.coordinator/abc/turns/turn-001.md', scope)).be.false();
    should(isReadableHandoff('/Users/owner/.coordinator/../.ssh/turns/turn-001.md', scope)).be.false();
    should(isReadableHandoff('relative/turns/turn-001.md', scope)).be.false();
    should(isReadableHandoff(FERRETRY_TURN, { roots: ['/'], coordinatorHomes: [] })).be.false();
    should(isReadableHandoff(FERRETRY_TURN, { roots: [], coordinatorHomes: [] })).be.false();
  });
});

describe('a hand-off document', () => {
  it('should give the task under kteam’s contract, and Ferretry’s message without its heading or files', () => {
    // Act & Assert
    should(handoffDocumentMessage(COORDINATOR_DOCUMENT)).equal('Fix the flaky upload test');
    should(
      handoffDocumentMessage(
        '# Assigned task\n\nLook at this\n\nAttached files — open them from these paths:\n- /a/b.png (image/png)\n',
      ),
    ).equal('Look at this');
    should(handoffDocumentMessage('Just a message\n')).equal('Just a message');
  });
});

describe('what the owner said', () => {
  const documents = new Map([[COORDINATOR_TURN, COORDINATOR_DOCUMENT]]);

  it('should drop reminders and an attachment list', () => {
    // Act & Assert
    should(
      withoutDeliveryWrappers(
        '<system-reminder>\nnote\n</system-reminder>\nShip it\n\nAttached files — open them from these paths:\n- /x.txt (text/plain)',
      ),
    ).equal('Ship it');
  });

  it('should replace a pointer with its document, and say nothing for one it could not read', () => {
    // Act & Assert
    should(spokenText(pointer(COORDINATOR_TURN), documents)).equal('Fix the flaky upload test');
    should(spokenText(pointer(FERRETRY_TURN), documents)).be.undefined();
    should(spokenText(pointer(FERRETRY_TURN))).be.undefined();
  });

  it('should say nothing for a CLI’s own block, an interruption or an empty message', () => {
    // Act & Assert
    should(spokenText('<command-name>/clear</command-name>')).be.undefined();
    should(spokenText('<system-reminder>only this</system-reminder>')).be.undefined();
    should(spokenText('[Request interrupted by user]')).be.undefined();
    should(spokenText('[Request interrupted by user for tool use]')).be.undefined();
    should(spokenText('   \n ')).be.undefined();
    should(spokenText('Fix   the\ncart')).equal('Fix the cart');
  });

  it('should list each message that said something, in order', () => {
    // Act
    const spoken = spokenMessages(
      [
        user(pointer(FERRETRY_TURN)),
        user(pointer(COORDINATOR_TURN)),
        assistant('On it.'),
        user('<environment_context>x</environment_context>'),
        user('Now ship it'),
      ],
      documents,
    );

    // Assert
    should(spoken).deepEqual(['Fix the flaky upload test', 'Now ship it']);
    should(spokenMessages([user('Hello')])).deepEqual(['Hello']);
  });
});

describe('the last exchanges', () => {
  it('should keep the last owner messages and the reply that ended each turn', () => {
    // Arrange
    const events: TranscriptEvent[] = [
      assistant('A greeting before anyone spoke.'),
      user('one'),
      assistant('reply one'),
      user('two'),
      assistant('narration'),
      { harness: 'claude', role: 'tool', kind: 'message', text: 'tool output' },
      assistant('   '),
      assistant('reply two'),
      user('three'),
      user('[Request interrupted by user]'),
      assistant('reply three'),
    ];

    // Act & Assert
    should(recentExchanges(events, new Map(), 2)).deepEqual([
      { role: 'user', text: 'two' },
      { role: 'assistant', text: 'reply two' },
      { role: 'user', text: 'three' },
      { role: 'assistant', text: 'reply three' },
    ]);
    should(recentExchanges(events, new Map(), 0)).deepEqual([]);
    should(recentExchanges([assistant('only a reply')])).deepEqual([{ role: 'assistant', text: 'only a reply' }]);
    should(recentExchanges(events)).have.length(7);
  });

  it('should cut a long message and mark the cut', () => {
    // Arrange
    const long = 'word '.repeat(100);

    // Act
    const [message] = recentExchanges([user(long)]);

    // Assert
    should(message?.text.length).be.belowOrEqual(280);
    should(message?.text.endsWith('…')).be.true();
    should(truncateText('short', 10)).equal('short');
    should(truncateText('abcdefghij', 5)).equal('abcd…');
  });
});
