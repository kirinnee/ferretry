import { describe, it } from 'bun:test';
import should from 'should';
import {
  ConversationDigestError,
  ConversationIndex,
  type ConversationIndexFiles,
  type ConversationIndexLimits,
  extendSessionTranscriptRawPrefix,
  type PortableConversationRow,
  sessionTranscriptRawPrefixStart,
} from '../../../../src/lib/session/transcript/index.ts';
import type {
  TranscriptBatch,
  TranscriptEvent,
  TranscriptHarness,
  TranscriptIssue,
  TranscriptRawRecord,
  TranscriptSource,
  TranscriptWindow,
  TranscriptWindowOptions,
  TranscriptWindowStep,
} from '../../../../src/lib/transcript/types.ts';

const FILE = '/durable/transcript.jsonl';
const target = (sessionId = 'session-1', harness: TranscriptHarness = 'claude') => ({ sessionId, harness });

/** Consecutive physical records from `start`, each one message, with the events the parser would report. */
interface Chunk {
  readonly records: readonly TranscriptRawRecord[];
  readonly events: readonly TranscriptEvent[];
  readonly end: number;
}

const chunk = (start: number, labels: readonly string[], timestamp?: string): Chunk => {
  const records: TranscriptRawRecord[] = [];
  const events: TranscriptEvent[] = [];
  let at = start;
  for (const label of labels) {
    const bytes = Buffer.from(`{"m":"${label}"}\n`, 'utf8');
    records.push({ byteOffset: at, bytes });
    events.push({
      kind: 'message',
      harness: 'claude',
      role: 'user',
      text: label,
      byteOffset: at,
      ...(timestamp === undefined ? {} : { timestamp }),
    });
    at += bytes.byteLength;
  }
  return { records, events, end: at };
};

interface BatchOptions {
  readonly identity?: string;
  readonly pendingBytes?: number;
  readonly reset?: boolean;
  readonly issues?: readonly TranscriptIssue[];
}

const batchOf = (from: Chunk, options: BatchOptions = {}): TranscriptBatch => ({
  harness: 'claude',
  file: FILE,
  reset: options.reset ?? false,
  cursor: { identity: options.identity ?? 'id-1', byteOffset: from.end, pendingBytes: options.pendingBytes ?? 0 },
  events: from.events,
  observedInputs: [],
  issues: options.issues ?? [],
  rawRecords: from.records,
});

const issue = (code: TranscriptIssue['code']): TranscriptIssue => ({
  harness: 'claude',
  code,
  message: `${code} was reported`,
  recoverable: true,
});

const foldChain = (...records: readonly TranscriptRawRecord[]): Uint8Array =>
  records.reduce(
    (previous, entry) => extendSessionTranscriptRawPrefix(previous, entry.bytes),
    sessionTranscriptRawPrefixStart(),
  );

const sameBytes = (left: Uint8Array | undefined, right: Uint8Array): boolean =>
  left !== undefined && Buffer.from(left).equals(Buffer.from(right));

const texts = (rows: readonly PortableConversationRow[] | undefined): readonly string[] =>
  (rows ?? []).map(row => row.text);

type Step = TranscriptWindowStep | Error;

interface ScriptedWindow extends TranscriptWindow {
  /** How many times the index asked this window for a step. */
  nexts: number;
}

/** Answers its steps in order, then `{ more: false }` for ever; an `Error` step throws. */
const scripted = (...steps: readonly Step[]): ScriptedWindow => {
  const window: ScriptedWindow = {
    file: FILE,
    nexts: 0,
    async next() {
      const step = steps[window.nexts];
      window.nexts += 1;
      if (step instanceof Error) throw step;
      return step ?? { more: false };
    },
  };
  return window;
};

interface Opened {
  readonly file: string;
  readonly options: TranscriptWindowOptions;
}

const sourceFrom = (
  harness: TranscriptHarness,
  open: (options: TranscriptWindowOptions, count: number) => TranscriptWindow,
): { readonly source: TranscriptSource; readonly opened: Opened[] } => {
  const opened: Opened[] = [];
  const source: TranscriptSource = {
    harness,
    read: async () => {
      throw new Error('the index never reads whole');
    },
    follow: () => {
      throw new Error('the index never follows');
    },
    window: (file, options) => {
      opened.push({ file, options });
      return open(options, opened.length);
    },
  };
  return { source, opened };
};

/** Hands out the given windows in the order they are opened; opening one that was not scripted fails. */
const sourceOf = (harness: TranscriptHarness, ...windows: readonly TranscriptWindow[]) =>
  sourceFrom(harness, (_options, count) => {
    const window = windows[count - 1];
    if (window === undefined) throw new Error(`window ${count} was not scripted`);
    return window;
  });

type FileInfo = { readonly identity: string; readonly size: number } | undefined;

interface FakeFiles extends ConversationIndexFiles {
  info: (file: string) => Promise<FileInfo>;
  readRange: (file: string, byteOffset: number, byteLength: number) => Promise<Uint8Array>;
  /** The file as it is now: these records at these offsets, this long, under this identity. */
  serve(from: Chunk, identity?: string): void;
  /** Answers each `info` call from the list in order, and the last one for every call after. */
  sequence(...infos: readonly FileInfo[]): void;
  rangeCalls: number;
}

const fakeFiles = (): FakeFiles => {
  const known = new Map<number, Uint8Array>();
  let current: FileInfo = { identity: 'id-1', size: 0 };
  const files: FakeFiles = {
    rangeCalls: 0,
    info: async () => current,
    readRange: async (_file, byteOffset, byteLength) => {
      files.rangeCalls += 1;
      return (known.get(byteOffset) ?? new Uint8Array()).slice(0, byteLength);
    },
    serve(from, identity = 'id-1') {
      for (const entry of from.records) known.set(entry.byteOffset, entry.bytes);
      current = { identity, size: from.end };
    },
    sequence(...infos) {
      let calls = 0;
      files.info = async () => {
        const answer = infos[Math.min(calls, infos.length - 1)];
        calls += 1;
        return answer;
      };
    },
  };
  return files;
};

const fakePacing = (step = 1) => {
  let clock = 0;
  const pacing = {
    yields: 0,
    now: () => {
      clock += step;
      return clock;
    },
    yieldToLoop: async () => {
      pacing.yields += 1;
    },
  };
  return pacing;
};

const scenario = (windows: readonly TranscriptWindow[], limits?: ConversationIndexLimits) => {
  const { source, opened } = sourceOf('claude', ...windows);
  const files = fakeFiles();
  const pacing = fakePacing();
  return { index: new ConversationIndex([source], files, pacing, limits), files, pacing, opened };
};

const settle = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => undefined,
    error => error,
  );

describe('ConversationIndex', () => {
  describe('folding', () => {
    it('should answer nothing for a harness no source speaks', async () => {
      // Arrange
      const { index, opened } = scenario([]);

      // Act
      const actual = await index.rows(target('session-1', 'codex'), FILE);

      // Assert
      should(actual).be.undefined();
      should(opened).be.empty();
    });

    it('should fold every step until the window says there is no more, from the beginning', async () => {
      // Arrange
      const first = chunk(0, ['a', 'b']);
      const second = chunk(first.end, ['c']);
      const window = scripted({ batch: batchOf(first), more: true }, { batch: batchOf(second), more: false });
      const { index, files, opened } = scenario([window]);
      files.serve(second);

      // Act
      const actual = await index.rows(target(), FILE);

      // Assert
      should(texts(actual)).eql(['a', 'b', 'c']);
      should(window.nexts).equal(2);
      should(opened).have.length(1);
      should(opened[0]?.file).equal(FILE);
      should(opened[0]?.options).eql({ sessionId: 'session-1', start: { at: 'beginning' } });
      const all = [...first.records, ...second.records];
      for (const [position, row] of (actual ?? []).entries())
        should(sameBytes(row.rawPrefix, foldChain(...all.slice(0, position + 1)))).be.true();
    });

    it('should serve the same rows without opening a window again when nothing was appended', async () => {
      // Arrange
      const first = chunk(0, ['a', 'b']);
      const window = scripted({ batch: batchOf(first), more: false });
      const { index, files, opened } = scenario([window]);
      files.serve(first);

      // Act
      const before = await index.rows(target(), FILE);
      const after = await index.rows(target(), FILE);

      // Assert
      should(after).eql(before);
      should(texts(after)).eql(['a', 'b']);
      should(opened).have.length(1);
      should(window.nexts).equal(2);
      should(files.rangeCalls).equal(1);
    });

    it('should extend the held rows with a batch appended to the held window', async () => {
      // Arrange
      const first = chunk(0, ['a']);
      const second = chunk(first.end, ['b', 'c']);
      const window = scripted({ batch: batchOf(first), more: false }, { batch: batchOf(second), more: false });
      const { index, files, opened } = scenario([window]);
      files.serve(first);

      // Act
      const before = await index.rows(target(), FILE);
      files.serve(second);
      const after = await index.rows(target(), FILE);

      // Assert
      should(texts(before)).eql(['a']);
      should(texts(after)).eql(['a', 'b', 'c']);
      should(opened).have.length(1);
      should(sameBytes(after?.[2]?.rawPrefix, foldChain(...first.records, ...second.records))).be.true();
    });

    it('should keep the rows when a step answers with no batch', async () => {
      // Arrange
      const first = chunk(0, ['a']);
      const window = scripted({ batch: batchOf(first), more: true }, { more: false });
      const { index, files } = scenario([window]);
      files.serve(first);

      // Act
      const actual = await index.rows(target(), FILE);

      // Assert
      should(texts(actual)).eql(['a']);
      should(window.nexts).equal(2);
    });

    it('should hand out snapshots that a caller cannot use to change the next answer', async () => {
      // Arrange
      const first = chunk(0, ['a', 'b']);
      const { index, files } = scenario([scripted({ batch: batchOf(first), more: false })]);
      files.serve(first);

      // Act
      const taken = (await index.rows(target(), FILE)) as PortableConversationRow[];
      taken.pop();
      taken.length = 0;
      const next = await index.rows(target(), FILE);

      // Assert
      should(texts(next)).eql(['a', 'b']);
      should(next).not.equal(taken);
    });

    it('should hand the loop back while folding when the clock runs past the budget', async () => {
      // Arrange
      const first = chunk(0, ['a', 'b', 'c']);
      const { source } = sourceOf('claude', scripted({ batch: batchOf(first), more: false }));
      const files = fakeFiles();
      files.serve(first);
      const pacing = fakePacing(13);
      const index = new ConversationIndex([source], files, pacing);

      // Act
      const actual = await index.rows(target(), FILE);

      // Assert
      should(texts(actual)).eql(['a', 'b', 'c']);
      should(pacing.yields).be.greaterThan(0);
    });

    it('should stop after the most steps one read may take and serve what it folded', async () => {
      // Arrange: a file that grows as fast as it is read, so the window never says it is done.
      let at = 0;
      let steps = 0;
      const endless: ScriptedWindow = {
        file: FILE,
        nexts: 0,
        async next() {
          endless.nexts += 1;
          steps += 1;
          const piece = chunk(at, [`row-${steps}`]);
          at = piece.end;
          return { batch: batchOf(piece), more: true };
        },
      };
      const { index, files } = scenario([endless], { maxSteps: 3 });
      files.serve({ records: [], events: [], end: 10_000 });

      // Act
      const actual = await index.rows(target(), FILE);

      // Assert
      should(endless.nexts).equal(3);
      should(texts(actual)).eql(['row-1', 'row-2', 'row-3']);
    });

    it('should restart from zero when a batch says the file was replaced mid-read', async () => {
      // Arrange
      const first = chunk(0, ['old-a', 'old-b']);
      const replaced = chunk(0, ['new']);
      const window = scripted(
        { batch: batchOf(first), more: true },
        { batch: batchOf(replaced, { reset: true, pendingBytes: 4 }), more: false },
      );
      const { index, files } = scenario([window]);
      files.serve(replaced);

      // Act
      const actual = await index.rows(target(), FILE);

      // Assert
      should(texts(actual)).eql(['new']);
      should(sameBytes(actual?.[0]?.rawPrefix, foldChain(...replaced.records))).be.true();
      should(index.heldBytes()).equal(2 * 3 + 192 + 4);
    });

    it('should share one refresh between reads of one session that start together', async () => {
      // Arrange
      const first = chunk(0, ['a', 'b']);
      const gate = Promise.withResolvers<void>();
      const window: ScriptedWindow = {
        file: FILE,
        nexts: 0,
        async next() {
          window.nexts += 1;
          await gate.promise;
          return { batch: batchOf(first), more: false };
        },
      };
      const { index, files, opened } = scenario([window]);
      files.serve(first);

      // Act
      const one = index.rows(target(), FILE);
      const two = index.rows(target(), FILE);
      gate.resolve();
      const [left, right] = await Promise.all([one, two]);

      // Assert
      should(texts(left)).eql(['a', 'b']);
      should(right).eql(left);
      should(opened).have.length(1);
      should(window.nexts).equal(1);
    });

    it('should start a fresh entry when the same session names another file', async () => {
      // Arrange
      const first = chunk(0, ['a']);
      const other = chunk(0, ['elsewhere']);
      const { index, files, opened } = scenario([
        scripted({ batch: batchOf(first), more: false }),
        scripted({ batch: batchOf(other), more: false }),
      ]);
      files.serve(first);

      // Act
      const before = await index.rows(target(), FILE);
      files.serve(other);
      const after = await index.rows(target(), '/durable/other.jsonl');

      // Assert
      should(texts(before)).eql(['a']);
      should(texts(after)).eql(['elsewhere']);
      should(opened.map(entry => entry.file)).eql([FILE, '/durable/other.jsonl']);
    });

    it('should start a fresh entry when the same session id arrives under another harness', async () => {
      // Arrange
      const first = chunk(0, ['claude-row']);
      const other = chunk(0, ['codex-row']);
      const claude = sourceOf('claude', scripted({ batch: batchOf(first), more: false }));
      const codex = sourceOf('codex', scripted({ batch: batchOf(other), more: false }));
      const files = fakeFiles();
      files.serve(first);
      const index = new ConversationIndex([claude.source, codex.source], files, fakePacing());

      // Act
      const before = await index.rows(target('session-1', 'claude'), FILE);
      files.serve(other);
      const after = await index.rows(target('session-1', 'codex'), FILE);

      // Assert
      should(texts(before)).eql(['claude-row']);
      should(texts(after)).eql(['codex-row']);
      should(claude.opened).have.length(1);
      should(codex.opened).have.length(1);
    });
  });

  describe('issues', () => {
    it('should not refuse the issues a window reports while it steps', async () => {
      // Arrange
      const first = chunk(0, ['a']);
      const batch = batchOf(first, { issues: [issue('incomplete-line'), issue('source-truncated')] });
      const { index, files } = scenario([scripted({ batch, more: false })]);
      files.serve(first);

      // Act
      const actual = await index.rows(target(), FILE);

      // Assert
      should(texts(actual)).eql(['a']);
    });

    it('should refuse any other incomplete issue with a conversation digest error', async () => {
      // Arrange
      const first = chunk(0, ['a']);
      const batch = batchOf(first, { issues: [issue('invalid-json')] });
      const { index, files } = scenario([scripted({ batch, more: false })]);
      files.serve(first);

      // Act
      const failure = await settle(index.rows(target(), FILE));

      // Assert
      should(failure).be.instanceOf(ConversationDigestError);
      should((failure as ConversationDigestError).failure).equal('incomplete_transcript');
    });

    it('should throw the remembered refusal again without opening a window while the file is unchanged', async () => {
      // Arrange
      const first = chunk(0, ['a']);
      const bad = batchOf(first, { issues: [issue('invalid-json')] });
      const { index, files, opened } = scenario([scripted({ batch: bad, more: false })]);
      files.serve(first);

      // Act
      const once = await settle(index.rows(target(), FILE));
      const again = await settle(index.rows(target(), FILE));

      // Assert
      should(once).be.instanceOf(ConversationDigestError);
      should(again).equal(once);
      should(opened).have.length(1);
    });

    it('should fold again from a fresh window once the refused file changed size', async () => {
      // Arrange
      const first = chunk(0, ['a']);
      const grown = chunk(0, ['a', 'b']);
      const bad = batchOf(first, { issues: [issue('invalid-json')] });
      const { index, files, opened } = scenario([
        scripted({ batch: bad, more: false }),
        scripted({ batch: batchOf(grown), more: false }),
      ]);
      files.serve(first);
      await settle(index.rows(target(), FILE));

      // Act
      files.serve(grown);
      const actual = await index.rows(target(), FILE);

      // Assert
      should(texts(actual)).eql(['a', 'b']);
      should(opened).have.length(2);
    });

    it('should fold again from a fresh window once the refused file changed identity', async () => {
      // Arrange
      const first = chunk(0, ['a']);
      const bad = batchOf(first, { issues: [issue('invalid-json')] });
      const { index, files, opened } = scenario([
        scripted({ batch: bad, more: false }),
        scripted({ batch: batchOf(first, { identity: 'id-2' }), more: false }),
      ]);
      files.serve(first);
      await settle(index.rows(target(), FILE));

      // Act
      files.serve(first, 'id-2');
      const actual = await index.rows(target(), FILE);

      // Assert
      should(texts(actual)).eql(['a']);
      should(opened).have.length(2);
    });

    it('should rethrow what is not a digest error and start the next read from a fresh window', async () => {
      // Arrange
      const first = chunk(0, ['a']);
      const again = chunk(first.end, ['b']);
      const boom = new Error('disk fell over');
      const { index, files, opened } = scenario([
        scripted({ batch: batchOf(first), more: false }, boom),
        scripted({ batch: batchOf(first), more: false }),
      ]);
      files.serve(first);
      await index.rows(target(), FILE);
      files.serve(again);

      // Act
      const failure = await settle(index.rows(target(), FILE));
      files.serve(first);
      const actual = await index.rows(target(), FILE);

      // Assert
      should(failure).equal(boom);
      should(opened).have.length(2);
      should(texts(actual)).eql(['a']);
    });
  });

  describe('the file facts', () => {
    it('should refuse when the file metadata cannot be read', async () => {
      // Arrange
      const { index, files, opened } = scenario([]);
      files.info = async () => {
        throw new Error('EIO');
      };

      // Act
      const failure = await settle(index.rows(target(), FILE));

      // Assert
      should(failure).be.instanceOf(ConversationDigestError);
      should((failure as ConversationDigestError).failure).equal('incomplete_transcript');
      should((failure as ConversationDigestError).message).containEql('metadata could not be read');
      should(opened).be.empty();
    });

    it('should refuse when the file is not there', async () => {
      // Arrange
      const { index, files } = scenario([]);
      files.sequence(undefined);

      // Act
      const failure = await settle(index.rows(target(), FILE));

      // Assert
      should(failure).be.instanceOf(ConversationDigestError);
      should((failure as ConversationDigestError).message).containEql('is not available');
    });
  });

  describe('proving a held fold against the file', () => {
    const first = chunk(0, ['a', 'b']);
    const appended = chunk(first.end, ['c']);
    const replaced = chunk(0, ['x']);

    interface Discard {
      readonly name: string;
      readonly identity?: string;
      readonly change: (files: FakeFiles) => void;
    }

    const discards: readonly Discard[] = [
      {
        name: 'the identity changed',
        identity: 'id-2',
        change: files => files.serve(replaced, 'id-2'),
      },
      {
        name: 'the file is now shorter than what was folded',
        change: files => {
          files.serve(replaced);
          files.sequence({ identity: 'id-1', size: first.end - 1 });
        },
      },
      {
        name: 'the last folded record holds other bytes',
        change: files => {
          files.serve(first);
          files.readRange = async (_file, _offset, length) => new Uint8Array(length).fill(1);
        },
      },
      {
        name: 'the last folded record reads back short',
        change: files => {
          files.serve(first);
          files.readRange = async (_file, _offset, length) => new Uint8Array(length - 1);
        },
      },
      {
        name: 'the last folded record cannot be read',
        change: files => {
          files.serve(first);
          files.readRange = async () => {
            throw new Error('EIO');
          };
        },
      },
    ];

    for (const discard of discards)
      it(`should discard the held fold and open a fresh window when ${discard.name}`, async () => {
        // Arrange
        const { index, files, opened } = scenario([
          scripted({ batch: batchOf(first), more: false }),
          scripted({ batch: batchOf(replaced, { identity: discard.identity ?? 'id-1' }), more: false }),
        ]);
        files.serve(first);
        await index.rows(target(), FILE);

        // Act
        discard.change(files);
        const actual = await index.rows(target(), FILE);

        // Assert
        should(texts(actual)).eql(['x']);
        should(opened).have.length(2);
      });

    it('should keep the held fold when the last record reads back as the same bytes', async () => {
      // Arrange
      const window = scripted({ batch: batchOf(first), more: false }, { batch: batchOf(appended), more: false });
      const { index, files, opened } = scenario([window]);
      files.serve(first);
      await index.rows(target(), FILE);

      // Act
      files.serve(appended);
      const actual = await index.rows(target(), FILE);

      // Assert
      should(texts(actual)).eql(['a', 'b', 'c']);
      should(opened).have.length(1);
      should(files.rangeCalls).equal(1);
    });

    it('should keep a held fold that has no last record to read back', async () => {
      // Arrange: a first step that carried nothing yet.
      const window = scripted({ batch: batchOf({ records: [], events: [], end: 0 }), more: false });
      const { index, files, opened } = scenario([window]);

      // Act
      const before = await index.rows(target(), FILE);
      const after = await index.rows(target(), FILE);

      // Assert
      should(before).be.empty();
      should(after).be.empty();
      should(opened).have.length(1);
      should(files.rangeCalls).equal(0);
    });
  });

  describe('a file that changes while it is read', () => {
    const first = chunk(0, ['a']);

    it('should retry once with a fresh window when the identity changed under the read', async () => {
      // Arrange
      const { index, files, opened } = scenario([
        scripted({ batch: batchOf(first, { identity: 'id-1' }), more: false }),
        scripted({ batch: batchOf(first, { identity: 'id-2' }), more: false }),
      ]);
      files.serve(first);
      files.sequence(
        { identity: 'id-1', size: first.end },
        { identity: 'id-2', size: first.end },
        { identity: 'id-2', size: first.end },
        { identity: 'id-2', size: first.end },
      );

      // Act
      const actual = await index.rows(target(), FILE);

      // Assert
      should(texts(actual)).eql(['a']);
      should(opened).have.length(2);
    });

    it('should refuse when the file changes again during the retry', async () => {
      // Arrange
      const { index, files, opened } = scenario([
        scripted({ batch: batchOf(first, { identity: 'id-1' }), more: false }),
        scripted({ batch: batchOf(first, { identity: 'id-2' }), more: false }),
      ]);
      files.sequence(
        { identity: 'id-1', size: first.end },
        { identity: 'id-2', size: first.end },
        { identity: 'id-2', size: first.end },
        { identity: 'id-3', size: first.end },
      );

      // Act
      const failure = await settle(index.rows(target(), FILE));

      // Assert
      should(failure).be.instanceOf(ConversationDigestError);
      should((failure as ConversationDigestError).failure).equal('incomplete_transcript');
      should((failure as ConversationDigestError).message).containEql('changed while it was being read');
      should(opened).have.length(2);
    });

    it('should not trust a fold the file has since shrunk below', async () => {
      // Arrange
      const { index, files } = scenario([
        scripted({ batch: batchOf(first), more: false }),
        scripted({ batch: batchOf(first), more: false }),
      ]);
      files.sequence(
        { identity: 'id-1', size: first.end },
        { identity: 'id-1', size: first.end - 1 },
        { identity: 'id-1', size: first.end },
        { identity: 'id-1', size: first.end },
      );

      // Act
      const actual = await index.rows(target(), FILE);

      // Assert
      should(texts(actual)).eql(['a']);
    });
  });

  describe('the byte bound', () => {
    const rowCost = (label: string): number => 2 * label.length + 192;
    const sessionWindows = (windows: Readonly<Record<string, readonly ScriptedWindow[]>>) => {
      const used = new Map<string, number>();
      return sourceFrom('claude', options => {
        const id = options.sessionId ?? '';
        const position = used.get(id) ?? 0;
        used.set(id, position + 1);
        const window = windows[id]?.[position];
        if (window === undefined) throw new Error(`no window for ${id} #${position}`);
        return window;
      });
    };
    const oneRow = (label: string, options?: BatchOptions) =>
      scripted({ batch: batchOf(chunk(0, [label]), options), more: false });

    it('should evict the least recently read session and fold it again on its next read', async () => {
      // Arrange
      const { source, opened } = sessionWindows({ A: [oneRow('a'), oneRow('a')], B: [oneRow('b')] });
      const files = fakeFiles();
      files.serve({ records: [], events: [], end: 1000 });
      const index = new ConversationIndex([source], files, fakePacing(), { maxBytes: rowCost('a') + rowCost('b') - 1 });

      // Act
      await index.rows(target('A'), FILE);
      await index.rows(target('B'), FILE);
      const heldAfterB = index.heldBytes();
      const again = await index.rows(target('A'), FILE);

      // Assert
      should(heldAfterB).equal(rowCost('b'));
      should(texts(again)).eql(['a']);
      should(opened.map(entry => entry.options.sessionId)).eql(['A', 'B', 'A']);
    });

    it('should never evict the session just read, however large it is', async () => {
      // Arrange
      const { source, opened } = sessionWindows({
        A: [scripted({ batch: batchOf(chunk(0, ['a', 'b', 'c'])), more: false })],
      });
      const files = fakeFiles();
      files.serve(chunk(0, ['a', 'b', 'c']));
      const index = new ConversationIndex([source], files, fakePacing(), { maxBytes: 1 });

      // Act
      await index.rows(target('A'), FILE);
      const again = await index.rows(target('A'), FILE);

      // Assert
      should(texts(again)).eql(['a', 'b', 'c']);
      should(opened).have.length(1);
      should(index.heldBytes()).be.greaterThan(1);
    });

    it('should not evict a session that is still being read, and evict it later once it is not', async () => {
      // Arrange
      const gate = Promise.withResolvers<void>();
      const slow: ScriptedWindow = {
        file: FILE,
        nexts: 0,
        async next() {
          slow.nexts += 1;
          await gate.promise;
          return { batch: batchOf(chunk(0, ['a'])), more: false };
        },
      };
      const { source, opened } = sessionWindows({ A: [slow], B: [oneRow('b'), oneRow('b')] });
      const files = fakeFiles();
      files.serve({ records: [], events: [], end: 1000 });
      const index = new ConversationIndex([source], files, fakePacing(), { maxBytes: 1 });

      // Act
      const pending = index.rows(target('A'), FILE);
      const b = await index.rows(target('B'), FILE);
      gate.resolve();
      const a = await pending;
      await index.rows(target('B'), FILE);

      // Assert
      should(texts(b)).eql(['b']);
      should(texts(a)).eql(['a']);
      should(opened.map(entry => entry.options.sessionId)).eql(['A', 'B', 'B']);
    });

    it('should count the rows and the unterminated tail the window is holding', async () => {
      // Arrange
      const stamp = '2026-01-01T00:00:00Z';
      const first = chunk(0, ['a'], stamp);
      const { index, files } = scenario([scripted({ batch: batchOf(first, { pendingBytes: 5 }), more: false })]);
      files.serve(first);

      // Act
      const before = index.heldBytes();
      await index.rows(target(), FILE);
      const after = index.heldBytes();

      // Assert
      should(before).equal(0);
      should(after).equal(2 * 1 + 2 * stamp.length + 192 + 5);
    });

    it('should not count a session whose last fold was refused', async () => {
      // Arrange
      const first = chunk(0, ['a']);
      const bad = batchOf(first, { issues: [issue('invalid-json')] });
      const { index, files } = scenario([scripted({ batch: bad, more: false })]);
      files.serve(first);

      // Act
      await settle(index.rows(target(), FILE));

      // Assert
      should(index.heldBytes()).equal(0);
    });
  });
});
