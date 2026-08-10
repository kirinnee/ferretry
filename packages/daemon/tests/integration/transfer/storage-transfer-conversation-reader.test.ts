import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationMessagePoint, TranscriptProvenance } from '@ferretry/protocol';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../src/adapters/index.ts';
import type { DaemonStorage } from '../../../src/adapters/storage/session-storage.ts';
import { StorageTransferConversationReader } from '../../../src/adapters/transfer/storage-transfer-conversation-reader.ts';
import { StorageTransferSourceReader } from '../../../src/adapters/transfer/storage-transfer-source-reader.ts';
import { ConversationDigestError } from '../../../src/lib/session/transcript/digest.ts';
import type { TranscriptDigestJournal } from '../../../src/lib/session/transcript/reader.ts';
import { parseSessionId } from '../../../src/lib/session-id.ts';
import type {
  TranscriptBatch,
  TranscriptEvent,
  TranscriptHarness,
  TranscriptRawRecord,
  TranscriptSource,
} from '../../../src/lib/transcript/types.ts';
import { ConversationFacetContributor } from '../../../src/lib/transfer/facets/conversation.ts';

const identityRedactor = { redact: async (text: string) => text };

/**
 * The one conversation cut, over the file a plan PINS rather than the file a session currently
 * points at.
 *
 * The parser is faked so the byte coordinates are exact and the file each read opened is
 * observable — which is the whole subject here. What is real is the source snapshot read from
 * storage, the `SessionTranscriptReader` the adapter delegates through, and `digestConversation`.
 */

const NOW = '2026-08-06T09:00:00.000Z';
const directories = new Set<string>();

afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

async function openTemporaryStorage(): Promise<DaemonStorage> {
  const home = await mkdtemp(join(tmpdir(), 'fy-transfer-conversation-'));
  directories.add(home);
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  );
  return (await factory.open()).storage;
}

const point = (byteOffset: number, blockIndex = 0): ConversationMessagePoint => ({ v: 1, byteOffset, blockIndex });

const message = (byteOffset: number, text: string, blockIndex = 0): TranscriptEvent => ({
  kind: 'message',
  harness: 'claude',
  role: 'user',
  text,
  byteOffset,
  blockIndex,
});

const batch = (
  harness: TranscriptHarness,
  file: string,
  events: readonly TranscriptEvent[],
  rawRecords?: readonly TranscriptRawRecord[],
): TranscriptBatch => ({
  harness,
  file,
  reset: false,
  cursor: { byteOffset: 0, pendingBytes: 0, nextLine: 1 },
  events,
  observedInputs: [],
  issues: [],
  ...(rawRecords === undefined ? {} : { rawRecords }),
});

/** A parser for one harness that records every file it was asked to open. */
function recordingSource(
  harness: TranscriptHarness,
  events: (file: string) => readonly TranscriptEvent[],
  opened: string[],
  rawRecords?: readonly TranscriptRawRecord[],
): TranscriptSource {
  return {
    harness,
    read: async file => {
      opened.push(`${harness}:${file}`);
      return batch(harness, file, events(file), rawRecords);
    },
    follow: () => {
      throw new Error('a transfer never follows a transcript');
    },
  };
}

const journal = (): TranscriptDigestJournal => ({ assertReadable: async () => {} });

const provenance = (file: string): TranscriptProvenance => ({
  v: 1,
  home: '/home/agent/.claude',
  harnessSessionId: 'harness-1',
  identity: 'correlated',
  file,
  resolvedAt: NOW,
});

/** The two records every cut in this file is made against. */
const conversation = [message(0, 'the first thing said'), message(120, 'the message the fork is cut at')];

/**
 * Exact source bytes for the preparation case, supplied independently of the normalized messages.
 * The first valid JSONL record is space-padded to 120 bytes including LF, so the second physical
 * record truthfully begins at the cut coordinate rather than reconstructing evidence from a row.
 */
const firstRawRecordBody = Buffer.from('{"fixture":"source-a-first"}', 'utf8');
const conversationRawRecords: readonly TranscriptRawRecord[] = [
  {
    byteOffset: 0,
    bytes: Buffer.concat([
      firstRawRecordBody,
      Buffer.alloc(119 - firstRawRecordBody.byteLength, 0x20),
      Buffer.from('\n', 'utf8'),
    ]),
  },
  { byteOffset: 120, bytes: Buffer.from('{"fixture":"source-a-cut"}\n', 'utf8') },
];

describe('StorageTransferConversationReader', () => {
  it('should keep preparation on source snapshot A after current configuration changes to B', async () => {
    // Arrange: source preparation reads A once.
    const storage = await openTemporaryStorage();
    const id = parseSessionId('20260806-prepare');
    const configA = {
      id,
      incarnation: 'i1',
      runtimeGeneration: 1,
      name: 'source',
      boardAccess: 'none',
      agent: 'claude-auto-loge',
      harness: 'claude',
      modelHint: 'sonnet',
      mode: 'auto',
      remoteControl: false,
      harnessFlags: [],
      cwd: '/work/repo',
      createdAt: NOW,
      updatedAt: NOW,
      turn: 2,
      intervalSeconds: 60,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 0,
      resumeMenuChoice: 'full',
      maxSnapshots: 5,
      transcript: provenance('/home/agent/.claude/projects/source.jsonl'),
      retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
    } as const;
    await storage.writeConfig(id, configA);
    const source = await new StorageTransferSourceReader(storage).read(id);
    if (source === undefined) throw new Error('the source fixture must be readable');

    // The live configuration then moves to B before the conversation contributor runs.
    await storage.writeConfig(id, {
      ...configA,
      harness: 'codex',
      agent: 'codex-auto',
      transcript: provenance('/home/agent/.codex/sessions/replacement.jsonl'),
    });
    const opened: string[] = [];
    const reader = new StorageTransferConversationReader(
      [
        recordingSource('claude', () => conversation, opened, conversationRawRecords),
        recordingSource('codex', () => [], opened),
      ],
      journal(),
    );

    // Act: the contributor can pass only the already-read source snapshot to the digest adapter.
    const contribution = await new ConversationFacetContributor(reader, identityRedactor).contribute({
      request: {
        sourceSessionId: id,
        requestId: 'request-a',
        target: {
          accountId: 'target-account',
          agent: 'claude-auto-opus',
          harness: 'claude',
          model: 'opus',
          effort: 'high',
          contextWindow: 200_000,
        },
        cutMessagePoint: point(120),
        selectionBinding: 's1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        preparedAt: NOW,
      },
      source,
    });

    // Assert: B is never opened; the carried messages and the later plan source both describe A.
    should(opened).eql(['claude:/home/agent/.claude/projects/source.jsonl']);
    should(source.harness).equal('claude');
    should(source.transcriptProvenance?.file).equal('/home/agent/.claude/projects/source.jsonl');
    should(contribution.value?.messages.map(carried => carried.text)).eql([
      'the first thing said',
      'the message the fork is cut at',
    ]);
    await storage.close();
  });

  it('should validate an import against the plan-pinned provenance, never the current one', async () => {
    // Arrange
    const opened: string[] = [];
    const reader = new StorageTransferConversationReader(
      [
        recordingSource('claude', () => conversation, opened),
        recordingSource('codex', () => [message(0, 'somebody else conversation')], opened),
      ],
      journal(),
    );

    // Act
    const digest = await reader.digestPinned({
      sourceSessionId: '20260806-repinned',
      sourceHarness: 'claude',
      transcriptProvenance: provenance('/home/agent/.claude/projects/source.jsonl'),
      through: point(120),
    });

    // Assert: only the plan's file was opened, and only its parser answered.
    should(opened).eql(['claude:/home/agent/.claude/projects/source.jsonl']);
    should(digest?.messages).have.length(2);
    should(digest?.through).eql(point(120));
  });

  it('should still validate a pinned cut after the source has been appended to', async () => {
    // Arrange: the source kept talking; the frozen prefix must read exactly as it did.
    const opened: string[] = [];
    const reader = new StorageTransferConversationReader(
      [
        recordingSource(
          'claude',
          () => [...conversation, message(300, 'said after the plan was made'), message(420, 'and again')],
          opened,
        ),
      ],
      journal(),
    );

    // Act
    const digest = await reader.digestPinned({
      sourceSessionId: 'anything',
      sourceHarness: 'claude',
      transcriptProvenance: provenance('/pinned.jsonl'),
      through: point(120),
    });

    // Assert: growth past the cut is invisible to the validation.
    should(digest?.messages.map(carried => carried.point)).eql([point(0), point(120)]);
  });

  it('should refuse a pinned cut whose message is no longer at that coordinate', async () => {
    // Arrange: the transcript was rewritten, so the frozen offset addresses nothing.
    const reader = new StorageTransferConversationReader(
      [recordingSource('claude', () => [message(0, 'the only record left')], [])],
      journal(),
    );

    // Act
    const failure = await reader
      .digestPinned({
        sourceSessionId: 'anything',
        sourceHarness: 'claude',
        transcriptProvenance: provenance('/pinned.jsonl'),
        through: point(120),
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Assert
    should(failure).be.instanceof(ConversationDigestError);
    should(failure).have.property('failure', 'target_not_found');
  });

  it('should answer nothing when the pinned provenance names no file at all', async () => {
    // Arrange: an undiscovered transcript is a session with no cuttable conversation, not a failure.
    const opened: string[] = [];
    const reader = new StorageTransferConversationReader(
      [recordingSource('claude', () => conversation, opened)],
      journal(),
    );

    // Act
    const digest = await reader.digestPinned({
      sourceSessionId: 'anything',
      sourceHarness: 'claude',
      transcriptProvenance: { v: 1, home: '/home/agent/.claude', identity: 'undiscovered' },
      through: point(120),
    });

    // Assert
    should(digest).be.undefined();
    should(opened).be.empty();
  });

  it('should answer nothing when preparation pins an undiscovered transcript', async () => {
    // Arrange
    const opened: string[] = [];
    const reader = new StorageTransferConversationReader(
      [recordingSource('claude', () => conversation, opened)],
      journal(),
    );

    // Act
    const digest = await reader.digest({
      sourceSessionId: 'source-with-undiscovered-transcript',
      sourceHarness: 'claude',
      transcriptProvenance: { v: 1, home: '/home/agent/.claude', identity: 'undiscovered' },
      through: point(0),
    });

    // Assert
    should(digest).be.undefined();
    should(opened).be.empty();
  });

  it('should refuse rather than guess when no parser speaks the pinned harness', async () => {
    // Arrange: a build with no codex parser must not answer a codex cut from the claude one.
    const reader = new StorageTransferConversationReader(
      [recordingSource('claude', () => conversation, [])],
      journal(),
    );

    // Act
    const failure = await reader
      .digestPinned({
        sourceSessionId: 'anything',
        sourceHarness: 'codex',
        transcriptProvenance: provenance('/pinned.jsonl'),
        through: point(120),
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Assert
    should(failure).have.property('failure', 'incomplete_transcript');
  });

  it('should not make a cut a session has no daemon journal to prove', async () => {
    // Arrange: the digest primitive owns that rule; the adapter must not route around it.
    const reader = new StorageTransferConversationReader([recordingSource('claude', () => conversation, [])], {
      assertReadable: async sessionId => {
        throw new ConversationDigestError('incomplete_transcript', `${sessionId} has no readable journal`);
      },
    });

    // Act
    const failure = await reader
      .digestPinned({
        sourceSessionId: 'unjournaled',
        sourceHarness: 'claude',
        transcriptProvenance: provenance('/pinned.jsonl'),
        through: point(120),
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Assert
    should(failure).have.property('failure', 'incomplete_transcript');
  });
});
