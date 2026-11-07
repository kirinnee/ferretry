import { describe, it } from 'bun:test';
import type { Redaction, RedactionScope } from '@ferretry/kernel/contract';
import should from 'should';
import { StorageTransferConversationReader } from '../../../../daemon/adapters/transfer/storage-transfer-conversation-reader.ts';
import { StorageTransferSourceReader } from '../../../../daemon/adapters/transfer/storage-transfer-source-reader.ts';
import type { TranscriptProvenance } from '../../../../daemon/lib/protocol/session.ts';
import type { ConversationMessagePoint } from '../../../../daemon/lib/protocol/session-transfer-edge.ts';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';
import { ConversationFacetContributor } from '../../../../daemon/lib/transfer/facets/conversation.ts';
import {
  type ConversationDigest,
  ConversationDigestError,
  isConversationDigestError,
  type PinnedTranscriptDigests,
} from '../../../../daemon/lib/transfer/ports.ts';
import type { Harness } from '../../../../daemon/lib/protocol/session-base.ts';
import { SessionConfigFiles } from '../../../../daemon/lib/state.ts';
import { memoryStorage } from '../../../support/daemon/storage.ts';

/**
 * The one conversation cut, over the file a plan PINS rather than the file a session currently points at.
 *
 * The transcript reader, its journal proof and the harness parsers are the conversation owner's
 * (`PinnedTranscriptDigests`, an injected port), so what is observable here is exactly this adapter's own decisions:
 * which file and harness it asks the owner about (the snapshot it was handed, never the live configuration), that an
 * undiscovered transcript is asked about nothing, that only the import re-read scrubs, and that the owner's refusals
 * reach the caller unchanged. The real source snapshot is still read from storage.
 */

const NOW = '2026-08-06T09:00:00.000Z';

const point = (byteOffset: number, blockIndex = 0): ConversationMessagePoint => ({ v: 1, byteOffset, blockIndex });

const provenance = (file: string): TranscriptProvenance => ({
  v: 1,
  home: '/home/agent/.claude',
  harnessSessionId: 'harness-1',
  identity: 'correlated',
  file,
  resolvedAt: NOW,
});

const scopeOf = (text: (value: string) => string): RedactionScope => ({
  text,
  cells: grid => grid,
  lines: lines => lines,
});
const identityRedactor: Redaction = { read: async work => await work(scopeOf(value => value)) };

/** The two records every cut in this file is made against. */
const messages = [
  { point: point(0), role: 'user', text: 'the first thing said' },
  { point: point(120), role: 'user', text: 'the message the fork is cut at' },
] as const;

/** The owner's digest of a cut: the messages through the coordinate, with the cut's raw-prefix evidence. */
const digestThrough = (sessionId: string, through: ConversationMessagePoint): ConversationDigest => ({
  sessionId,
  through,
  messages: messages.filter(carried => carried.point.byteOffset <= through.byteOffset),
  omissions: [],
  selectionEvidence: { point: through, rawPrefix: new Uint8Array(32).fill(7) },
});

interface Asked {
  readonly harness: Harness;
  readonly sessionId: string;
  readonly file: string;
  readonly through: ConversationMessagePoint;
}

/** An owner that records every question and answers from `answer`. */
function owner(
  asked: Asked[],
  answer: (question: Asked) => ConversationDigest | undefined = question =>
    digestThrough(question.sessionId, question.through),
): PinnedTranscriptDigests {
  return {
    digest: async (target, file, through) => {
      const question = { harness: target.harness, sessionId: target.sessionId, file, through };
      asked.push(question);
      return answer(question);
    },
  };
}

describe('StorageTransferConversationReader', () => {
  it('should keep preparation on source snapshot A after current configuration changes to B', async () => {
    // Arrange: source preparation reads A once.
    const { storage, folder } = await memoryStorage();
    const id = parseSessionId('20260806-prepare');
    const configA = {
      format: 1,
      id,
      incarnation: 'i1',
      runtimeGeneration: 1,
      name: 'source',
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
    folder.plant(SessionConfigFiles, JSON.stringify(configA), id);
    const source = await new StorageTransferSourceReader(storage).read(id);
    if (source === undefined) throw new Error('the source fixture must be readable');

    // The live configuration then moves to B before the conversation contributor runs.
    folder.plant(
      SessionConfigFiles,
      JSON.stringify({
        ...configA,
        harness: 'codex',
        agent: 'codex-auto',
        transcript: provenance('/home/agent/.codex/sessions/replacement.jsonl'),
      }),
      id,
    );
    const asked: Asked[] = [];
    const reader = new StorageTransferConversationReader(owner(asked), identityRedactor);

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

    // Assert: B is never asked about; the carried messages and the later plan source both describe A.
    should(asked).eql([
      { harness: 'claude', sessionId: id, file: '/home/agent/.claude/projects/source.jsonl', through: point(120) },
    ]);
    should(source.harness).equal('claude');
    should(source.transcriptProvenance?.file).equal('/home/agent/.claude/projects/source.jsonl');
    should(contribution.value?.messages.map(carried => carried.text)).eql([
      'the first thing said',
      'the message the fork is cut at',
    ]);
  });

  it('should validate an import against the plan-pinned provenance, never the current one, and scrub it', async () => {
    // Arrange
    const asked: Asked[] = [];
    const reader = new StorageTransferConversationReader(owner(asked), {
      read: async work => await work(scopeOf(text => text.replace('the message the fork is cut at', '[redacted:cut]'))),
    });

    // Act
    const digest = await reader.digestPinned({
      sourceSessionId: '20260806-repinned',
      sourceHarness: 'claude',
      transcriptProvenance: provenance('/home/agent/.claude/projects/source.jsonl'),
      through: point(120),
    });

    // Assert: only the plan's file and harness were asked about, and the re-read text is scrubbed.
    should(asked).eql([
      {
        harness: 'claude',
        sessionId: '20260806-repinned',
        file: '/home/agent/.claude/projects/source.jsonl',
        through: point(120),
      },
    ]);
    should(digest?.messages).have.length(2);
    should(digest?.through).eql(point(120));
    should(digest?.messages.at(-1)?.text).equal('[redacted:cut]');
  });

  it('should leave scrubbing of the preparation cut to the facet, which scrubs it once', async () => {
    // Arrange: the preparation read must not scrub (the contributor does, before the plan is built).
    const asked: Asked[] = [];
    let opens = 0;
    const reader = new StorageTransferConversationReader(owner(asked), {
      read: async work => {
        opens += 1;
        return await work(scopeOf(() => '[scrubbed]'));
      },
    });

    // Act
    const digest = await reader.digest({
      sourceSessionId: 'source',
      sourceHarness: 'claude',
      transcriptProvenance: provenance('/pinned.jsonl'),
      through: point(120),
    });

    // Assert
    should(opens).equal(0);
    should(digest?.messages.map(carried => carried.text)).eql([
      'the first thing said',
      'the message the fork is cut at',
    ]);
  });

  it('should hand the owner the frozen coordinate unchanged, whatever was appended to the source since', async () => {
    // Arrange: the source kept talking; the frozen prefix must be asked for exactly as it was pinned.
    const asked: Asked[] = [];
    const reader = new StorageTransferConversationReader(owner(asked), identityRedactor);

    // Act
    const digest = await reader.digestPinned({
      sourceSessionId: 'anything',
      sourceHarness: 'claude',
      transcriptProvenance: provenance('/pinned.jsonl'),
      through: point(120),
    });

    // Assert: the point the plan pinned is the one handed on, and growth past it is the owner's to ignore.
    should(asked.map(question => question.through)).eql([point(120)]);
    should(digest?.messages.map(carried => carried.point)).eql([point(0), point(120)]);
  });

  it('should let the owner refuse a pinned cut whose message is no longer at that coordinate', async () => {
    // Arrange: the transcript was rewritten, so the frozen offset addresses nothing.
    const reader = new StorageTransferConversationReader(
      owner([], () => {
        throw new ConversationDigestError('target_not_found', 'no message at that coordinate');
      }),
      identityRedactor,
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

    // Assert: the refusal reaches the caller unchanged, so the seam can map it.
    should(isConversationDigestError(failure)).be.true();
    should(failure).have.property('failure', 'target_not_found');
  });

  it('should answer nothing, and ask the owner nothing, when the pinned provenance names no file at all', async () => {
    // Arrange: an undiscovered transcript is a session with no cuttable conversation, not a failure.
    const asked: Asked[] = [];
    const reader = new StorageTransferConversationReader(owner(asked), identityRedactor);
    const undiscovered: TranscriptProvenance = { v: 1, home: '/home/agent/.claude', identity: 'undiscovered' };

    // Act
    const pinned = await reader.digestPinned({
      sourceSessionId: 'anything',
      sourceHarness: 'claude',
      transcriptProvenance: undiscovered,
      through: point(120),
    });
    const prepared = await reader.digest({
      sourceSessionId: 'source-with-undiscovered-transcript',
      sourceHarness: 'claude',
      transcriptProvenance: undiscovered,
      through: point(0),
    });

    // Assert
    should(pinned).be.undefined();
    should(prepared).be.undefined();
    should(asked).be.empty();
  });

  it('should pass on the owner answering that no transcript can be named', async () => {
    // Arrange: the owner has no transcript for the pinned file.
    const reader = new StorageTransferConversationReader(
      owner([], () => undefined),
      identityRedactor,
    );

    // Act
    const digest = await reader.digestPinned({
      sourceSessionId: 'anything',
      sourceHarness: 'codex',
      transcriptProvenance: provenance('/pinned.jsonl'),
      through: point(120),
    });

    // Assert
    should(digest).be.undefined();
  });
});
