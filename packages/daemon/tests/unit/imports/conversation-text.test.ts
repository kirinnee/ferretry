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
  isWrapperTitle,
  recentExchanges,
  spokenMessages,
  spokenText,
  titleWords,
  truncateText,
  withoutDeliveryWrappers,
  wrapperOnlyWords,
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

  it("should never read the harness's own events as the owner's words", () => {
    // Arrange — Claude Code's wording for a subagent's message, which no tag rule catches.
    const harness: TranscriptEvent = {
      ...user('Another Claude session sent a message:\n<agent-message from="a1">\nDone.\n</agent-message>'),
      inputSource: 'harness',
    };

    // Act & Assert
    should(spokenMessages([harness, user('Now ship it')])).deepEqual(['Now ship it']);
    should(recentExchanges([user('one'), assistant('reply one'), harness, assistant('reply two')])).deepEqual([
      { role: 'user', text: 'one' },
      { role: 'assistant', text: 'reply two' },
    ]);
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

describe('a title generated from a wrapper', () => {
  const documents = new Map([[COORDINATOR_TURN, COORDINATOR_DOCUMENT]]);

  it('should compare titles on lower-case words, dropping short words and a plural s', () => {
    // Act & Assert
    should(titleWords('Turn-001.md instructions for a Ferretry file')).deepEqual([
      'turn',
      '001',
      'instruction',
      'for',
      'ferretry',
      'file',
    ]);
    should(titleWords('')).deepEqual([]);
  });

  it('should collect the words only a pointer, its path and its document’s contract used', () => {
    // Act
    const words = wrapperOnlyWords(
      [user(pointer(COORDINATOR_TURN)), user('Fix the cart'), assistant('turn')],
      documents,
    );

    // Assert
    should([...words]).containDeep([
      'read',
      'file',
      'coordinator',
      'turn',
      '001',
      'instruction',
      'automode',
      'contract',
    ]);
    should(words.has('fix')).be.false();
    should(words.has('flaky')).be.false();
    should(wrapperOnlyWords([user('Fix the turn instructions file')]).size).equal(0);
  });

  it('should count an unread pointer and a harness block as wrappers too', () => {
    // Act
    const words = wrapperOnlyWords([
      user(pointer(FERRETRY_TURN)),
      user('# AGENTS.md instructions for /work/api\n\n<INSTRUCTIONS>\n- Use direnv\n</INSTRUCTIONS>'),
      user('Ship it'),
    ]);

    // Assert
    should([...words]).containDeep(['ferretry', 'session', 'turn', '001', 'agent', 'direnv']);
    should(words.has('ship')).be.false();
  });

  it('should call a title the wrapper’s only when most of its words are the wrapper’s', () => {
    // Arrange
    const words = wrapperOnlyWords([user(pointer(FERRETRY_TURN)), user('Fix the flaky upload test')]);

    // Act & Assert
    should(isWrapperTitle('Ferretry session turn-001 file', words)).be.true();
    should(isWrapperTitle('Turn-001.md instructions', words)).be.true();
    should(isWrapperTitle('Flaky upload test fix', words)).be.false();
    should(isWrapperTitle('Upload test: turn file', words)).be.false();
    should(isWrapperTitle('Ferretry session turn-001 file', new Set())).be.false();
    should(isWrapperTitle('', words)).be.false();
  });
});

describe('a harness’s injected blocks', () => {
  it('should drop Codex’s AGENTS.md and environment blocks and Claude Code’s command wrappers, closed ones only', () => {
    // Act & Assert
    should(
      withoutDeliveryWrappers(
        '# AGENTS.md instructions for /work/api\n\n<INSTRUCTIONS>\n- Use direnv\n</INSTRUCTIONS>\n\n<environment_context>\n  <cwd>/work/api</cwd>\n</environment_context>\n\nAdd retries',
      ),
    ).equal('Add retries');
    should(spokenText('<user_instructions>\nBe terse.\n</user_instructions>')).be.undefined();
    should(
      spokenText(
        '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
      ),
    ).be.undefined();
    should(spokenText('<local-command-stdout>Set model to Opus</local-command-stdout>')).be.undefined();
    should(spokenText('# AGENTS.md instructions for my repo: what should they say?')).equal(
      '# AGENTS.md instructions for my repo: what should they say?',
    );
  });
});
