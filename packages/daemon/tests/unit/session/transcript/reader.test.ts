import { describe, it } from 'bun:test';
import should from 'should';
import {
  SessionTranscriptReader,
  type TranscriptDigestJournal,
  type TranscriptFileResolver,
} from '../../../../src/lib/session/transcript/index.ts';
import type {
  TranscriptBatch,
  TranscriptEvent,
  TranscriptHarness,
  TranscriptSource,
} from '../../../../src/lib/transcript/types.ts';

const event = (id: string): TranscriptEvent => ({
  kind: 'tool-call',
  harness: 'claude',
  role: 'assistant',
  call: { id, name: 'Bash', input: { command: 'ls' } },
});

const batch = (file: string, events: readonly TranscriptEvent[]): TranscriptBatch => ({
  harness: 'claude',
  file,
  reset: false,
  cursor: { byteOffset: 0, pendingBytes: 0, nextLine: 1 },
  events,
  observedInputs: [],
  issues: [],
});

const source = (harness: TranscriptHarness, read: (file: string) => Promise<TranscriptBatch>): TranscriptSource => ({
  harness,
  read: async file => await read(file),
  follow: () => {
    throw new Error('the reader never follows');
  },
});

const resolving = (file: string | undefined): TranscriptFileResolver => ({ file: async () => file });

const digestJournal = (calls: string[] = []): TranscriptDigestJournal => ({
  assertReadable: async sessionId => {
    calls.push(sessionId);
  },
});

describe('SessionTranscriptReader', () => {
  it('should read the file the resolver names, through the source for that harness', async () => {
    // Arrange
    const opened: string[] = [];
    const subject = new SessionTranscriptReader(
      [
        source('codex', async () => {
          throw new Error('the codex source must not serve a claude session');
        }),
        source('claude', async file => {
          opened.push(file);
          return batch(file, [event('tool-1')]);
        }),
      ],
      resolving('/home/agent/.claude/projects/-work-repo/minted.jsonl'),
    );

    // Act
    const events = await subject.tail({ sessionId: 'session-1', harness: 'claude' });

    // Assert
    should(opened).eql(['/home/agent/.claude/projects/-work-repo/minted.jsonl']);
    should(events).have.length(1);
  });

  it('should keep only the last window of a long transcript', async () => {
    // Arrange
    const events = Array.from({ length: 10 }, (_value, index) => event(`tool-${index}`));
    const subject = new SessionTranscriptReader(
      [source('claude', async file => batch(file, events))],
      resolving('/transcript.jsonl'),
    );

    // Act
    const tail = await subject.tail({ sessionId: 'session-1', harness: 'claude' }, 3);

    // Assert
    should(tail.map(entry => (entry.kind === 'tool-call' ? entry.call.id : ''))).eql(['tool-7', 'tool-8', 'tool-9']);
  });

  it('should read nothing for a session whose transcript cannot be named', async () => {
    // Arrange: the honest projection of "the daemon cannot prove which file is yours".
    const subject = new SessionTranscriptReader(
      [
        source('claude', async () => {
          throw new Error('nothing may be opened without a resolved file');
        }),
      ],
      resolving(undefined),
    );

    // Act
    const events = await subject.tail({ sessionId: 'session-1', harness: 'claude' });

    // Assert
    should(events).be.empty();
  });

  it('should read nothing when no source speaks the session’s harness', async () => {
    // Arrange
    const subject = new SessionTranscriptReader([source('claude', async file => batch(file, []))], resolving('/x'));

    // Act
    const events = await subject.tail({ sessionId: 'session-1', harness: 'codex' });

    // Assert
    should(events).be.empty();
  });

  it('should read nothing when the resolution or the read itself fails', async () => {
    // Arrange: the file was deleted between resolution and open — evidence missing, not an error.
    const failingResolver = new SessionTranscriptReader([source('claude', async file => batch(file, []))], {
      file: async () => {
        throw new Error('the state home is gone');
      },
    });
    const failingRead = new SessionTranscriptReader(
      [
        source('claude', async () => {
          throw new Error('ENOENT');
        }),
      ],
      resolving('/transcript.jsonl'),
    );

    // Act
    const resolved = await failingResolver.tail({ sessionId: 'session-1', harness: 'claude' });
    const read = await failingRead.tail({ sessionId: 'session-1', harness: 'claude' });

    // Assert
    should(resolved).be.empty();
    should(read).be.empty();
  });

  it('should require the daemon journal proof before returning a restartable digest', async () => {
    // Arrange
    const proofs: string[] = [];
    const subject = new SessionTranscriptReader(
      [
        source('claude', async file =>
          batch(file, [
            {
              kind: 'message',
              harness: 'claude',
              role: 'user',
              text: 'restart from here',
              byteOffset: 12,
            },
          ]),
        ),
      ],
      resolving('/transcript.jsonl'),
      digestJournal(proofs),
    );

    // Act
    const actual = await subject.digest({ sessionId: 'session-1', harness: 'claude' }, { byteOffset: 12 });

    // Assert
    should(proofs).eql(['session-1']);
    should(actual.messages).eql([{ point: { byteOffset: 12 }, role: 'user', text: 'restart from here' }]);
  });

  it('should refuse a digest when no daemon journal proof or transcript can be read', async () => {
    // Arrange
    const withoutJournal = new SessionTranscriptReader(
      [source('claude', async file => batch(file, []))],
      resolving('/transcript.jsonl'),
    );
    const withoutTranscript = new SessionTranscriptReader(
      [source('claude', async file => batch(file, []))],
      resolving(undefined),
      digestJournal(),
    );

    // Act / Assert
    await should(withoutJournal.digest({ sessionId: 'session-1', harness: 'claude' }, { byteOffset: 0 })).be.rejected();
    await should(
      withoutTranscript.digest({ sessionId: 'session-1', harness: 'claude' }, { byteOffset: 0 }),
    ).be.rejected();
  });
});
