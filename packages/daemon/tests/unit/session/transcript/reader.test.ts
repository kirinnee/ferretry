import { describe, it } from 'bun:test';
import should from 'should';
import {
  DEFAULT_TRANSCRIPT_TAIL_BYTES,
  drainTranscriptWindow,
  IncrementalTranscriptTail,
  SessionTranscriptReader,
  type TranscriptDigestJournal,
  type TranscriptFileResolver,
  tailTranscriptEvents,
} from '../../../../src/lib/session/transcript/index.ts';
import type {
  TranscriptBatch,
  TranscriptEvent,
  TranscriptHarness,
  TranscriptSource,
  TranscriptWindow,
  TranscriptWindowStart,
  TranscriptWindowStep,
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

/**
 * A source over `read`: its window answers the whole read as one step, which is what a window over a
 * small file is, and records where each window was asked to start.
 */
const source = (
  harness: TranscriptHarness,
  read: (file: string) => Promise<TranscriptBatch>,
  starts: TranscriptWindowStart[] = [],
): TranscriptSource => ({
  harness,
  read: async file => await read(file),
  follow: () => {
    throw new Error('the reader never follows');
  },
  window: (file, options) => {
    starts.push(options.start);
    let read$ = false;
    return {
      file,
      next: async () => {
        if (read$) return { more: false };
        read$ = true;
        return { batch: await read(file), more: false };
      },
    };
  },
});

const resolving = (file: string | undefined): TranscriptFileResolver => ({ file: async () => file });

const digestJournal = (calls: string[] = []): TranscriptDigestJournal => ({
  assertReadable: async sessionId => {
    calls.push(sessionId);
  },
});

describe('SessionTranscriptReader.bound', () => {
  it('should say whether the session has a transcript it can name, a failed resolution included', async () => {
    // Arrange
    const target = { sessionId: 'session-1', harness: 'codex' as const };
    const failing: TranscriptFileResolver = {
      file: async () => {
        throw new Error('home unmounted');
      },
    };

    // Act
    const named = await new SessionTranscriptReader([], resolving('/h/rollout.jsonl')).bound(target);
    const unproven = await new SessionTranscriptReader([], resolving(undefined)).bound(target);
    const failed = await new SessionTranscriptReader([], failing).bound(target);

    // Assert
    should([named, unproven, failed]).eql([true, false, false]);
  });
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
    const actual = await subject.digest(
      { sessionId: 'session-1', harness: 'claude' },
      { v: 1, byteOffset: 12, blockIndex: 0 },
    );

    // Assert
    should(proofs).eql(['session-1']);
    should(actual.messages).eql([
      { point: { v: 1, byteOffset: 12, blockIndex: 0 }, role: 'user', text: 'restart from here' },
    ]);
  });

  it('should page portable rows, each bound to its record’s commitment, after the journal proof', async () => {
    // Arrange
    const proofs: string[] = [];
    const record = { byteOffset: 0, bytes: Buffer.from('{"m":"restart from here"}\n') };
    const subject = new SessionTranscriptReader(
      [
        source('claude', async file => ({
          ...batch(file, [
            { kind: 'message', harness: 'claude', role: 'user', text: 'restart from here', byteOffset: 0 },
          ]),
          rawRecords: [record],
        })),
      ],
      resolving('/transcript.jsonl'),
      digestJournal(proofs),
    );

    // Act
    const rows = await subject.portableRows({ sessionId: 'session-1', harness: 'claude' });

    // Assert
    should(proofs).eql(['session-1']);
    should(rows).have.length(1);
    should(rows?.[0]?.rawPrefix).have.length(32);
  });

  it('should read an already-resolved file without resolving a second time', async () => {
    // Arrange: production resolves once — the discovering resolver may persist an attribution —
    // re-reads the session's pinned facts, and only then reads transcript bytes.
    const opened: string[] = [];
    const subject = new SessionTranscriptReader(
      [
        source('claude', async file => {
          opened.push(file);
          return { ...batch(file, []), rawRecords: [] };
        }),
      ],
      {
        file: async () => {
          throw new Error('the resolved-file read must never resolve again');
        },
      },
      digestJournal(),
    );

    // Act
    const rows = await subject.portableRowsFromFile({ sessionId: 'session-1', harness: 'claude' }, '/pinned.jsonl');

    // Assert
    should(opened).eql(['/pinned.jsonl']);
    should(rows).be.empty();
  });

  it('should answer rows from its conversation index when it has one, after the journal proof', async () => {
    // Arrange: the index folds only what was appended, so a reader holding one never reads the file whole.
    const calls: string[] = [];
    const row = {
      point: { v: 1, byteOffset: 0, blockIndex: 0 },
      role: 'user',
      text: 'from the index',
      rawPrefix: new Uint8Array(32),
    } as const;
    const subject = new SessionTranscriptReader(
      [
        source('claude', async () => {
          throw new Error('a reader with an index must not read the file whole');
        }),
      ],
      resolving('/resolved.jsonl'),
      { assertReadable: async sessionId => void calls.push(`journal ${sessionId}`) },
      {
        rows: async (target, file) => {
          calls.push(`index ${target.sessionId} ${file}`);
          return [row];
        },
      },
    );

    // Act
    const resolved = await subject.portableRows({ sessionId: 'session-1', harness: 'claude' });
    const pinned = await subject.portableRowsFromFile({ sessionId: 'session-1', harness: 'claude' }, '/pinned.jsonl');

    // Assert
    should(resolved).eql([row]);
    should(pinned).eql([row]);
    should(calls).eql([
      'journal session-1',
      'index session-1 /resolved.jsonl',
      'journal session-1',
      'index session-1 /pinned.jsonl',
    ]);
  });

  it('should answer no rows for a session whose transcript cannot be named or read', async () => {
    // Arrange
    const unresolvable = new SessionTranscriptReader(
      [source('claude', async file => batch(file, []))],
      resolving(undefined),
      digestJournal(),
    );
    const unreadable = new SessionTranscriptReader(
      [
        source('claude', async () => {
          throw new Error('ENOENT');
        }),
      ],
      resolving('/transcript.jsonl'),
      digestJournal(),
    );

    // Act / Assert: missing evidence, which is a different answer from damaged evidence.
    should(await unresolvable.portableRows({ sessionId: 'session-1', harness: 'claude' })).be.undefined();
    should(
      await unreadable.portableRowsFromFile({ sessionId: 'session-1', harness: 'claude' }, '/t.jsonl'),
    ).be.undefined();
  });

  it('should refuse rows without a journal proof, and refuse a batch carrying no record bytes', async () => {
    // Arrange
    const withoutJournal = new SessionTranscriptReader(
      [source('claude', async file => batch(file, []))],
      resolving('/transcript.jsonl'),
    );
    const withoutRecords = new SessionTranscriptReader(
      [
        source('claude', async file =>
          batch(file, [{ kind: 'message', harness: 'claude', role: 'user', text: 'unbindable', byteOffset: 0 }]),
        ),
      ],
      resolving('/transcript.jsonl'),
      digestJournal(),
    );

    // Act / Assert
    await should(withoutJournal.portableRows({ sessionId: 'session-1', harness: 'claude' })).be.rejected();
    await should(withoutRecords.portableRows({ sessionId: 'session-1', harness: 'claude' })).be.rejected();
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
    await should(
      withoutJournal.digest({ sessionId: 'session-1', harness: 'claude' }, { v: 1, byteOffset: 0, blockIndex: 0 }),
    ).be.rejected();
    await should(
      withoutTranscript.digest({ sessionId: 'session-1', harness: 'claude' }, { v: 1, byteOffset: 0, blockIndex: 0 }),
    ).be.rejected();
  });
});

/** A window answering from a script of steps, then nothing new. */
const scripted = (steps: readonly TranscriptWindowStep[]): TranscriptWindow & { taken: number } => {
  const remaining = [...steps];
  return {
    file: '/t.jsonl',
    taken: 0,
    async next() {
      this.taken += 1;
      return remaining.shift() ?? { more: false };
    },
  };
};

const stepOf = (events: readonly TranscriptEvent[], more: boolean, reset = false): TranscriptWindowStep => ({
  batch: { ...batch('/t.jsonl', events), reset },
  more,
});

describe('reading a transcript from its end', () => {
  it('should ask for the tail of the file, not a read from its first byte', async () => {
    // Arrange
    const starts: TranscriptWindowStart[] = [];
    const subject = new SessionTranscriptReader(
      [source('claude', async file => batch(file, [event('tool-1')]), starts)],
      resolving('/h/big.jsonl'),
    );

    // Act
    await subject.tail({ sessionId: 'session-1', harness: 'claude' });

    // Assert — the window began at the first byte, so one small tail already covered the whole file.
    should(starts).eql([{ at: 'tail', bytes: 512 * 1024 }]);
  });

  it('should widen the tail to its bound only while a mid-file window holds too few events', async () => {
    // Arrange — a window that starts mid-file cannot number its lines, which is how "older bytes exist"
    // reads from outside.
    const midFile = (events: readonly TranscriptEvent[]): TranscriptBatch => ({
      ...batch('/h/big.jsonl', events),
      cursor: { byteOffset: 9_000_000, pendingBytes: 0 },
    });
    const sparse: TranscriptWindowStart[] = [];
    const dense: TranscriptWindowStart[] = [];
    const many = Array.from({ length: 3 }, (_, index) => event(`tool-${String(index)}`));

    // Act
    const few = await tailTranscriptEvents(
      source('claude', async () => midFile([event('only')]), sparse),
      '/h/big.jsonl',
      'session-1',
      3,
    );
    const enough = await tailTranscriptEvents(
      source('claude', async () => midFile(many), dense),
      '/h/big.jsonl',
      'session-1',
      3,
    );

    // Assert — the sparse file grew to the same bound every tail always had; the dense one never had to.
    should(sparse).eql([
      { at: 'tail', bytes: 512 * 1024 },
      { at: 'tail', bytes: 2 * 1024 * 1024 },
      { at: 'tail', bytes: DEFAULT_TRANSCRIPT_TAIL_BYTES },
    ]);
    should(few).have.length(1);
    should(dense).eql([{ at: 'tail', bytes: 512 * 1024 }]);
    should(enough).have.length(3);
  });

  it('should never widen past a bound smaller than its first window', async () => {
    // Arrange
    const starts: TranscriptWindowStart[] = [];
    const midFile = { ...batch('/h/big.jsonl', []), cursor: { byteOffset: 4_096, pendingBytes: 0 } };

    // Act
    await tailTranscriptEvents(
      source('claude', async () => midFile, starts),
      '/h/big.jsonl',
      'session-1',
      3,
      1_024,
    );

    // Assert
    should(starts).eql([{ at: 'tail', bytes: 1_024 }]);
  });

  it('should keep only the newest events across steps, and forget a file that restarted', async () => {
    // Arrange
    const many = Array.from({ length: 5 }, (_, index) => event(`tool-${String(index)}`));
    const window = scripted([stepOf(many.slice(0, 3), true), stepOf(many.slice(3), false)]);
    const restarting = scripted([stepOf(many.slice(0, 3), true), stepOf(many.slice(4), false, true)]);
    const tailOf = (held: TranscriptWindow): TranscriptSource => ({
      ...source('claude', async () => batch('/t', [])),
      window: () => held,
    });

    // Act
    const newest = await tailTranscriptEvents(tailOf(window), '/t.jsonl', 'session-1', 2);
    const restarted = await tailTranscriptEvents(tailOf(restarting), '/t.jsonl', 'session-1');

    // Assert
    should(newest.map(each => (each.kind === 'tool-call' ? each.call.id : ''))).eql(['tool-3', 'tool-4']);
    should(restarted.map(each => (each.kind === 'tool-call' ? each.call.id : ''))).eql(['tool-4']);
  });

  it('should stop a window that never reaches the end of a file growing faster than it reads', async () => {
    // Arrange
    const endless = {
      file: '/t.jsonl',
      taken: 0,
      async next(): Promise<TranscriptWindowStep> {
        this.taken += 1;
        return { more: true };
      },
    };
    const visited: TranscriptBatch[] = [];
    const finite = scripted([stepOf([event('a')], true), { more: false }]);

    // Act
    const tailed = await tailTranscriptEvents(
      { ...source('claude', async () => batch('/t', [])), window: () => endless },
      '/t.jsonl',
      'session-1',
    );
    const reachedEnd = await drainTranscriptWindow(finite, each => void visited.push(each));
    const stopped = await drainTranscriptWindow(endless, () => undefined);

    // Assert
    should(tailed).eql([]);
    should(endless.taken).equal(128);
    should(reachedEnd).be.true();
    should(visited).have.length(1);
    should(stopped).be.false();
  });

  it('should open a window on the resolved file, and nothing when it cannot name the file or speak its harness', async () => {
    // Arrange
    const starts: TranscriptWindowStart[] = [];
    const named = new SessionTranscriptReader(
      [source('claude', async file => batch(file, []), starts)],
      resolving('/h/a.jsonl'),
    );
    const unnamed = new SessionTranscriptReader(
      [source('claude', async file => batch(file, []))],
      resolving(undefined),
    );
    const failing = new SessionTranscriptReader([source('claude', async file => batch(file, []))], {
      file: async () => {
        throw new Error('home unmounted');
      },
    });
    const target = { sessionId: 'session-1', harness: 'claude' as const };

    // Act
    const window = await named.window(target, { at: 'since', instant: '2026-10-20T12:00:00.000Z' });
    const file = await named.file(target);
    const sourceless = await named.window({ ...target, harness: 'codex' }, { at: 'beginning' });
    const nameless = await unnamed.window(target, { at: 'beginning' });
    const failed = await failing.file(target);

    // Assert
    should(window?.file).equal('/h/a.jsonl');
    should(starts).eql([{ at: 'since', instant: '2026-10-20T12:00:00.000Z' }]);
    should(file).equal('/h/a.jsonl');
    should(sourceless).be.undefined();
    should(nameless).be.undefined();
    should(failed).be.undefined();
  });
});

describe('IncrementalTranscriptTail', () => {
  const ids = (events: readonly TranscriptEvent[]) =>
    events.map(each => (each.kind === 'tool-call' ? each.call.id : ''));
  /** A step of a window that began mid-file and has read to `offset`, carrying `pending` bytes. */
  const midStep = (
    events: readonly TranscriptEvent[],
    offset: number,
    options: { more?: boolean; reset?: boolean; pending?: number } = {},
  ): TranscriptWindowStep => ({
    batch: {
      ...batch('/t.jsonl', events),
      reset: options.reset === true,
      cursor: { byteOffset: offset, pendingBytes: options.pending ?? 0 },
    },
    more: options.more === true,
  });
  /** A source whose every window answers from one shared script, counting the windows it opened. */
  const scriptedSource = (steps: TranscriptWindowStep[]) => {
    const opened: TranscriptWindowStart[] = [];
    const subject: TranscriptSource = {
      ...source('claude', async () => batch('/t', [])),
      window: (file, options) => {
        opened.push(options.start);
        return {
          file,
          next: async () => {
            const step = steps.shift();
            if (step instanceof Error) throw step;
            return step ?? { more: false };
          },
        };
      },
    };
    return { subject, opened };
  };
  const three = [event('a'), event('b'), event('c')];

  it('should slide the held window over what was appended, opening no other', async () => {
    // Arrange — the first window began mid-file and found the limit.
    const steps = [midStep(three, 1_000), midStep([event('d')], 1_200, { pending: 30 })];
    const { subject, opened } = scriptedSource(steps);
    const tail = new IncrementalTranscriptTail(subject, '/t.jsonl', 'session-1', 3);

    // Act
    const first = await tail.read();
    const slid = await tail.read();
    const unchanged = await tail.read();

    // Assert
    should(ids(first)).eql(['a', 'b', 'c']);
    should(ids(slid)).eql(['b', 'c', 'd']);
    should(ids(unchanged)).eql(['b', 'c', 'd']);
    should(opened).have.length(1);
  });

  it('should read afresh a window that began at the first byte, or that held fewer events than its limit', async () => {
    // Arrange
    const fromStart = scriptedSource([{ batch: batch('/t.jsonl', three), more: false }]);
    const sparse = scriptedSource(Array.from({ length: 6 }, () => midStep([event('a')], 1_000)));
    const smallTail = new IncrementalTranscriptTail(fromStart.subject, '/t.jsonl', 'session-1', 3);
    const sparseTail = new IncrementalTranscriptTail(sparse.subject, '/t.jsonl', 'session-1', 3);

    // Act
    await smallTail.read();
    await smallTail.read();
    await sparseTail.read();
    await sparseTail.read();

    // Assert — every read opened a fresh tail (the sparse one through all three of its windows).
    should(fromStart.opened).have.length(2);
    should(sparse.opened).have.length(6);
  });

  it('should read afresh after the file restarted, a step failed, or a window could not reach the end', async () => {
    // Arrange
    const restarted = scriptedSource([midStep(three, 1_000), midStep([event('z')], 50, { reset: true })]);
    const failing = scriptedSource([midStep(three, 1_000), new Error('EIO') as never]);
    const unfinished = scriptedSource([
      midStep(three, 1_000),
      ...Array.from({ length: 64 }, () => midStep([event('d')], 1_100, { more: true })),
    ]);
    const tails = [restarted, failing, unfinished].map(
      each => new IncrementalTranscriptTail(each.subject, '/t.jsonl', 'session-1', 3),
    );

    // Act
    for (const tail of tails) await tail.read();
    for (const tail of tails) await tail.read();

    // Assert
    should([restarted, failing, unfinished].map(each => each.opened.length)).eql([2, 2, 2]);
  });

  it('should read afresh a first window that stopped before the end, rather than slide it', async () => {
    // Arrange
    const steps = Array.from({ length: 64 }, () => midStep(three, 1_000, { more: true }));
    const { subject, opened } = scriptedSource(steps);
    const tail = new IncrementalTranscriptTail(subject, '/t.jsonl', 'session-1', 3);
    await tail.read();

    // Act
    await tail.read();

    // Assert
    should(opened).have.length(2);
  });

  it('should read afresh once the held window would span more than the widest fresh tail', async () => {
    // Arrange — a 600 KiB bound: the 512 KiB window may slide 88 KiB, no further.
    const bound = 600 * 1024;
    const { subject, opened } = scriptedSource([
      midStep(three, 1_000_000),
      midStep([event('d')], 1_000_000 + 80 * 1024),
      midStep([event('e')], 1_000_000 + 100 * 1024),
      midStep(three, 1_000_000 + 100 * 1024),
    ]);
    const tail = new IncrementalTranscriptTail(subject, '/t.jsonl', 'session-1', 3, bound);

    // Act
    await tail.read();
    const within = await tail.read();
    const beyond = await tail.read();

    // Assert
    should(ids(within)).eql(['b', 'c', 'd']);
    should(ids(beyond)).eql(['a', 'b', 'c']);
    should(opened).eql([
      { at: 'tail', bytes: 512 * 1024 },
      { at: 'tail', bytes: 512 * 1024 },
    ]);
  });
});
