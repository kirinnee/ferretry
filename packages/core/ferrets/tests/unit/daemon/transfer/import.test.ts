import { describe, expect, it } from 'bun:test';
import type { ConversationDigest } from '../../../src/lib/session/transcript/digest.ts';
import { ConversationDigestError } from '../../../src/lib/session/transcript/digest.ts';
import { SessionTransferImporter } from '../../../src/lib/transfer/import.ts';
import type {
  SessionTransferEnvelope,
  TransferAttachmentCopyInput,
  TransferConversationValidationInput,
  TransferConversationValidator,
  TransferImportCapabilityLeak,
} from '../../../src/lib/transfer/types.ts';
import { SESSION_TRANSFER_IMPORT_PORTS, TransferImportError } from '../../../src/lib/transfer/types.ts';
import { AT, plan } from './fixtures.ts';

interface Recorder {
  readonly calls: string[];
  readonly validations: TransferConversationValidationInput[];
  readonly applied: { readonly newSessionId: string; readonly envelope: SessionTransferEnvelope }[];
  readonly copied: TransferAttachmentCopyInput[];
  readonly briefs: { readonly newSessionId: string; readonly document: string }[];
}

const TARGET = 'target-b';

/** The default re-read answers exactly what the fixture plan froze, so the point still reads true. */
const unchanged = async (): Promise<ConversationDigest> => ({
  sessionId: 'source-a',
  through: { v: 1, byteOffset: 512, blockIndex: 0 },
  messages: [{ point: { v: 1, byteOffset: 512, blockIndex: 0 }, role: 'user', text: 'ship it', timestamp: AT }],
  omissions: [],
});

function ports(failCopyOf: readonly string[] = [], digest: TransferConversationValidator['digestPinned'] = unchanged) {
  const recorder: Recorder = { calls: [], validations: [], applied: [], copied: [], briefs: [] };
  return {
    recorder,
    ports: {
      conversation: {
        digestPinned: async (input: TransferConversationValidationInput) => {
          recorder.calls.push(`reread:${input.sourceSessionId}@${input.through.byteOffset}`);
          recorder.validations.push(input);
          return digest(input);
        },
      },
      envelope: {
        apply: async (newSessionId: string, envelope: SessionTransferEnvelope) => {
          recorder.calls.push('envelope');
          recorder.applied.push({ newSessionId, envelope });
        },
      },
      brief: {
        write: async (newSessionId: string, document: string) => {
          recorder.calls.push('brief');
          recorder.briefs.push({ newSessionId, document });
          return '/state/sessions/target-b/turns/turn-001.md';
        },
      },
      attachments: {
        copyOriginal: async (input: TransferAttachmentCopyInput) => {
          recorder.calls.push(`copy:${input.expectedManifest.id}`);
          if (failCopyOf.includes(input.expectedManifest.id)) throw new Error('the original is unreadable');
          recorder.copied.push(input);
        },
      },
    },
  };
}

const attachment = (id: string, filename: string) => ({
  id: `att_${id.repeat(64).slice(0, 64)}`,
  filename,
  mime: 'text/plain',
  size: 4,
  sha256: id.repeat(64).slice(0, 64),
  createdAt: AT,
  encrypted: null,
});

describe('SessionTransferImporter capability shape', () => {
  it('holds three target-keyed writer ports and no board, grant, lifecycle or stop port', () => {
    expect(Object.keys(SESSION_TRANSFER_IMPORT_PORTS).sort()).toEqual([
      'attachments',
      'brief',
      'conversation',
      'envelope',
    ]);
  });

  it('cannot name a forbidden capability: the leak type is uninhabited at compile time', () => {
    const leaks: TransferImportCapabilityLeak[] = [];
    expect(leaks).toEqual([]);
  });
});

describe('SessionTransferImporter', () => {
  it.each([['source-a'], ['   ']])('refuses a non-fresh target key %j before any read or write', async newSessionId => {
    const { recorder, ports: writers } = ports();

    const error = (await new SessionTransferImporter(writers, 'fork')
      .importPlan(plan(), newSessionId)
      .catch((thrown: unknown) => thrown)) as TransferImportError;

    expect(error).toBeInstanceOf(TransferImportError);
    expect(error.failure).toBe('edge_invalid');
    expect(recorder.calls).toEqual([]);
  });

  it('writes the lineage edge into the new session with the exact cut and the plan it replays', async () => {
    const { recorder, ports: writers } = ports();

    await new SessionTransferImporter(writers, 'fork').importPlan(plan(), TARGET);

    expect(recorder.applied).toHaveLength(1);
    expect(recorder.applied[0]?.envelope.transferredFrom).toEqual({
      v: 1,
      kind: 'fork',
      sourceSessionId: 'source-a',
      sourceIncarnation: 'inc-1',
      sourceHarness: 'claude',
      cutMessagePoint: { v: 1, byteOffset: 512, blockIndex: 0 },
      planId: 'plan-1',
      at: AT,
    });
  });

  it('never copies the source transcript provenance into the new session', async () => {
    const { recorder, ports: writers } = ports();

    await new SessionTransferImporter(writers, 'fork').importPlan(plan(), TARGET);

    const envelope = recorder.applied[0]?.envelope;
    expect(Object.keys(envelope ?? {}).sort()).toEqual(['durable', 'lineage', 'transferredFrom']);
    expect(JSON.stringify(envelope)).not.toContain('correlationToken');
    expect(JSON.stringify(envelope)).not.toContain('harness-1');
  });

  it('carries the warden shield through to the new session', async () => {
    const { recorder, ports: writers } = ports();
    const shielded = plan({
      facets: { ...plan().facets, lineage: { wardenLineage: true, warden: 'warden-7' } },
    });

    await new SessionTransferImporter(writers, 'fork').importPlan(shielded, TARGET);

    expect(recorder.applied[0]?.envelope.lineage).toEqual({ wardenLineage: true, warden: 'warden-7' });
  });

  it('writes a handover edge with no cut, because a handover carries no conversation', async () => {
    const { recorder, ports: writers } = ports();
    const handover = plan({
      source: { ...plan().source, cutMessagePoint: null },
      facets: { ...plan().facets, conversation: null },
    });

    await new SessionTransferImporter(writers, 'handover').importPlan(handover, TARGET);

    expect(recorder.applied[0]?.envelope.transferredFrom.kind).toBe('handover');
    expect(recorder.applied[0]?.envelope.transferredFrom.cutMessagePoint).toBeNull();
  });

  it('refuses to write a fork edge that names no cut', async () => {
    const { ports: writers } = ports();
    const cutless = plan({
      source: { ...plan().source, cutMessagePoint: null },
      facets: { ...plan().facets, conversation: null },
    });

    const error = (await new SessionTransferImporter(writers, 'fork')
      .importPlan(cutless, TARGET)
      .catch((thrown: unknown) => thrown)) as TransferImportError;

    expect(error).toBeInstanceOf(TransferImportError);
    expect(error.failure).toBe('edge_invalid');
  });

  it('refuses a plan whose carried conversation does not end at the point it was cut at', async () => {
    const { recorder, ports: writers } = ports();
    const drifted = plan({
      facets: {
        ...plan().facets,
        conversation: {
          messages: [{ point: { v: 1, byteOffset: 8, blockIndex: 0 }, role: 'user', text: 'older' }],
        },
      },
    });

    const error = (await new SessionTransferImporter(writers, 'fork')
      .importPlan(drifted, TARGET)
      .catch((thrown: unknown) => thrown)) as TransferImportError;

    expect(error).toBeInstanceOf(TransferImportError);
    expect(error.failure).toBe('cut_not_carried');
    expect(recorder.calls).toEqual([]);
  });

  it('refuses a cut whose frozen conversation is empty instead of writing an unvalidated edge', async () => {
    const { recorder, ports: writers } = ports();
    const empty = plan({ facets: { ...plan().facets, conversation: { messages: [] } } });

    const error = (await new SessionTransferImporter(writers, 'fork')
      .importPlan(empty, TARGET)
      .catch((thrown: unknown) => thrown)) as TransferImportError;

    expect(error.failure).toBe('cut_not_carried');
    expect(recorder.calls).toEqual([]);
  });

  it('re-reads the pinned point before it writes anything, and proceeds when it still reads true', async () => {
    const { recorder, ports: writers } = ports();
    const frozen = plan();

    await new SessionTransferImporter(writers, 'fork').importPlan(frozen, TARGET);

    expect(recorder.calls[0]).toBe('reread:source-a@512');
    expect(recorder.validations).toHaveLength(1);
    expect(recorder.validations[0]?.sourceSessionId).toBe(frozen.source.sessionId);
    expect(recorder.validations[0]?.sourceHarness).toBe(frozen.source.harness);
    expect(recorder.validations[0]?.transcriptProvenance).toEqual(frozen.source.transcriptProvenance ?? undefined);
    expect(recorder.validations[0]?.through).toEqual(frozen.source.cutMessagePoint ?? undefined);
    expect(recorder.applied).toHaveLength(1);
  });

  it('never re-reads for a transfer that carries no conversation', async () => {
    const { recorder, ports: writers } = ports();
    const handover = plan({
      source: { ...plan().source, cutMessagePoint: null },
      facets: { ...plan().facets, conversation: null },
    });

    await new SessionTransferImporter(writers, 'handover').importPlan(handover, TARGET);

    expect(recorder.calls).toEqual(['envelope', 'brief']);
  });

  it('refuses, before writing, when the point no longer reads as a message', async () => {
    const { recorder, ports: writers } = ports([], async () => {
      throw new ConversationDigestError('target_not_message', 'that offset is a tool result now');
    });

    const error = (await new SessionTransferImporter(writers, 'fork')
      .importPlan(plan(), TARGET)
      .catch((thrown: unknown) => thrown)) as TransferImportError;

    expect(error).toBeInstanceOf(TransferImportError);
    expect(error.failure).toBe('cut_unreadable');
    expect(error.message).toContain('target_not_message');
    expect(recorder.applied).toEqual([]);
    expect(recorder.briefs).toEqual([]);
  });

  it('refuses when the transcript it was cut from cannot be read at all any more', async () => {
    const { recorder, ports: writers } = ports([], async () => undefined);

    const error = (await new SessionTransferImporter(writers, 'fork')
      .importPlan(plan(), TARGET)
      .catch((thrown: unknown) => thrown)) as TransferImportError;

    expect(error.failure).toBe('cut_unreadable');
    expect(recorder.applied).toEqual([]);
  });

  it('rethrows a re-read failure that is not a digest refusal', async () => {
    const boom = new Error('the disk is on fire');
    const { ports: writers } = ports([], async () => {
      throw boom;
    });

    expect(new SessionTransferImporter(writers, 'fork').importPlan(plan(), TARGET)).rejects.toBe(boom);
  });

  it.each([
    ['a different source', { sessionId: 'source-z', through: { v: 1 as const, byteOffset: 512, blockIndex: 0 } }],
    ['a different point', { sessionId: 'source-a', through: { v: 1 as const, byteOffset: 513, blockIndex: 0 } }],
  ])('refuses a digest answered from %s', async (_name, identity) => {
    const { recorder, ports: writers } = ports([], async () => ({
      ...identity,
      messages: [{ point: { v: 1, byteOffset: 512, blockIndex: 0 }, role: 'user', text: 'ship it' }],
      omissions: [],
    }));

    const error = (await new SessionTransferImporter(writers, 'fork')
      .importPlan(plan(), TARGET)
      .catch((thrown: unknown) => thrown)) as TransferImportError;

    expect(error.failure).toBe('cut_rewritten');
    expect(error.message).toContain('different source or point');
    expect(recorder.applied).toEqual([]);
  });

  it.each([
    [
      'the text changed under a stable offset',
      [
        {
          point: { v: 1 as const, byteOffset: 512, blockIndex: 0 },
          role: 'user' as const,
          text: 'something else',
        },
      ],
      'does not say what it said',
    ],
    [
      'the prefix grew, so records were inserted before the cut',
      [
        { point: { v: 1 as const, byteOffset: 8, blockIndex: 0 }, role: 'user' as const, text: 'inserted' },
        {
          point: { v: 1 as const, byteOffset: 512, blockIndex: 0 },
          role: 'user' as const,
          text: 'ship it',
        },
      ],
      'now reads as 2',
    ],
    [
      'the message moved to a different position in the file',
      [{ point: { v: 1 as const, byteOffset: 512, blockIndex: 1 }, role: 'user' as const, text: 'ship it' }],
      'has moved to a different position',
    ],
    [
      'the record at that point is a different speaker',
      [
        {
          point: { v: 1 as const, byteOffset: 512, blockIndex: 0 },
          role: 'assistant' as const,
          text: 'ship it',
        },
      ],
      'no longer a user message',
    ],
  ])('refuses a rewritten transcript: %s', async (_name, messages, expected) => {
    const { recorder, ports: writers } = ports([], async () => ({
      sessionId: 'source-a',
      through: { v: 1, byteOffset: 512, blockIndex: 0 },
      messages,
      omissions: [],
    }));

    const error = (await new SessionTransferImporter(writers, 'fork')
      .importPlan(plan(), TARGET)
      .catch((thrown: unknown) => thrown)) as TransferImportError;

    expect(error).toBeInstanceOf(TransferImportError);
    expect(error.failure).toBe('cut_rewritten');
    expect(error.message).toContain(expected);
    expect(recorder.applied).toEqual([]);
  });

  /**
   * The timestamp CROSSES, because `renderTransferBrief` renders it beside every quoted message. So
   * a prefix whose stamps have moved produces a different first-turn document from the one the
   * frozen plan describes — exactly the substitution re-reading before the first write exists to
   * catch — and it is refused rather than rendered.
   */
  it.each([
    [
      'the clock on the frozen message moved',
      [
        {
          point: { v: 1 as const, byteOffset: 512, blockIndex: 0 },
          role: 'user' as const,
          text: 'ship it',
          timestamp: '2026-08-06T09:00:00.000Z',
        },
      ],
    ],
    [
      'the frozen message lost the stamp the brief would have rendered',
      [{ point: { v: 1 as const, byteOffset: 512, blockIndex: 0 }, role: 'user' as const, text: 'ship it' }],
    ],
  ])('refuses a re-stamped transcript before any target write: %s', async (_name, messages) => {
    const { recorder, ports: writers } = ports([], async () => ({
      sessionId: 'source-a',
      through: { v: 1, byteOffset: 512, blockIndex: 0 },
      messages,
      omissions: [],
    }));

    const error = (await new SessionTransferImporter(writers, 'fork')
      .importPlan(plan(), TARGET)
      .catch((thrown: unknown) => thrown)) as TransferImportError;

    expect(error).toBeInstanceOf(TransferImportError);
    expect(error.failure).toBe('cut_rewritten');
    expect(error.message).toContain('no longer timestamped');
    // Nothing reached the target: no envelope, no attachment copy, no brief.
    expect(recorder.applied).toEqual([]);
    expect(recorder.calls).toEqual(['reread:source-a@512']);
  });

  it('refuses a message that gains a stamp the frozen plan never carried', async () => {
    const { recorder, ports: writers } = ports([], async () => ({
      sessionId: 'source-a',
      through: { v: 1, byteOffset: 512, blockIndex: 0 },
      messages: [{ point: { v: 1, byteOffset: 512, blockIndex: 0 }, role: 'user', text: 'ship it', timestamp: AT }],
      omissions: [],
    }));
    const unstamped = plan({
      facets: {
        ...plan().facets,
        conversation: {
          messages: [{ point: { v: 1, byteOffset: 512, blockIndex: 0 }, role: 'user', text: 'ship it' }],
        },
      },
    });

    const error = (await new SessionTransferImporter(writers, 'fork')
      .importPlan(unstamped, TARGET)
      .catch((thrown: unknown) => thrown)) as TransferImportError;

    expect(error.failure).toBe('cut_rewritten');
    expect(error.message).toContain('(unstamped)');
    expect(recorder.applied).toEqual([]);
  });

  it('applies the frozen plan, not the re-read, when both describe the same conversation', async () => {
    const { recorder, ports: writers } = ports([], async () => ({
      sessionId: 'source-a',
      through: { v: 1, byteOffset: 512, blockIndex: 0 },
      /**
       * The same messages, byte for byte and stamp for stamp. What differs is the digest's OWN
       * omission list — a fact about the read rather than content that crosses, and `plan.notCarried`
       * is the single owner of what was not carried.
       */
      messages: [{ point: { v: 1, byteOffset: 512, blockIndex: 0 }, role: 'user', text: 'ship it', timestamp: AT }],
      omissions: [
        {
          point: { v: 1, byteOffset: 4, blockIndex: 0 },
          kind: 'tool-result' as const,
          reason: 'harness-specific' as const,
        },
      ],
    }));

    const outcome = await new SessionTransferImporter(writers, 'fork').importPlan(plan(), TARGET);

    expect(recorder.briefs[0]?.document).toContain('> ship it');
    expect(Object.keys(outcome).sort()).toEqual(['briefPath', 'copiedAttachmentIds']);
  });

  it('copies each planned attachment out of the source by id, and writes the brief last', async () => {
    const { recorder, ports: writers } = ports();
    const withFiles = plan({
      facets: {
        ...plan().facets,
        attachments: { attachments: [attachment('a', 'one.txt'), attachment('b', 'two.txt')] },
      },
    });

    const outcome = await new SessionTransferImporter(writers, 'fork').importPlan(withFiles, TARGET);

    expect(recorder.calls).toEqual([
      'reread:source-a@512',
      'envelope',
      `copy:${attachment('a', '').id}`,
      `copy:${attachment('b', '').id}`,
      'brief',
    ]);
    expect(recorder.applied[0]?.newSessionId).toBe(TARGET);
    expect(recorder.copied).toEqual([
      {
        fromSessionId: 'source-a',
        newSessionId: TARGET,
        expectedManifest: attachment('a', 'one.txt'),
      },
      {
        fromSessionId: 'source-a',
        newSessionId: TARGET,
        expectedManifest: attachment('b', 'two.txt'),
      },
    ]);
    expect(recorder.briefs[0]?.newSessionId).toBe(TARGET);
    expect(outcome.copiedAttachmentIds).toEqual([attachment('a', '').id, attachment('b', '').id]);
    expect(outcome.briefPath).toBe('/state/sessions/target-b/turns/turn-001.md');
  });

  it('fails import when a planned attachment cannot be copied instead of inventing a new omission', async () => {
    const { recorder, ports: writers } = ports([attachment('b', '').id]);
    const withFiles = plan({
      facets: {
        ...plan().facets,
        attachments: { attachments: [attachment('a', 'one.txt'), attachment('b', 'two.txt')] },
      },
      notCarried: [{ facet: 'workspace', subject: '/work/repo', reason: 'not_implemented', detail: 'rewound' }],
    });

    await expect(new SessionTransferImporter(writers, 'fork').importPlan(withFiles, TARGET)).rejects.toThrow(
      'the original is unreadable',
    );

    expect(recorder.copied.map(copy => copy.expectedManifest.id)).toEqual([attachment('a', '').id]);
    expect(recorder.briefs).toEqual([]);
  });

  it('re-drives the same plan after a transient copy failure and a torn brief with identical brief bytes', async () => {
    const { recorder, ports: base } = ports();
    const first = attachment('a', 'one.txt');
    const second = attachment('b', 'two.txt');
    const frozen = plan({
      facets: { ...plan().facets, attachments: { attachments: [first, second] } },
      notCarried: [{ facet: 'workspace', subject: '/work/repo', reason: 'not_implemented', detail: 'rewound' }],
    });
    let copyFailed = false;
    let briefTore = false;
    const attemptedBriefs: string[] = [];
    const replayable = {
      ...base,
      attachments: {
        copyOriginal: async (input: TransferAttachmentCopyInput) => {
          if (input.expectedManifest.id === second.id && !copyFailed) {
            copyFailed = true;
            throw new Error('temporary source read failure');
          }
          await base.attachments.copyOriginal(input);
        },
      },
      brief: {
        write: async (newSessionId: string, document: string) => {
          attemptedBriefs.push(document);
          if (!briefTore) {
            briefTore = true;
            throw new Error('brief write tore before rename');
          }
          return await base.brief.write(newSessionId, document);
        },
      },
    };
    const subject = new SessionTransferImporter(replayable, 'fork');

    await expect(subject.importPlan(frozen, TARGET)).rejects.toThrow('temporary source read failure');
    expect(attemptedBriefs).toEqual([]);
    await expect(subject.importPlan(frozen, TARGET)).rejects.toThrow('brief write tore before rename');
    const outcome = await subject.importPlan(frozen, TARGET);

    expect(attemptedBriefs).toHaveLength(2);
    expect(attemptedBriefs[1]).toBe(attemptedBriefs[0]);
    expect(attemptedBriefs[1]).toContain('**workspace** `/work/repo`');
    expect(attemptedBriefs[1]).not.toContain('temporary source read failure');
    expect(Object.keys(outcome).sort()).toEqual(['briefPath', 'copiedAttachmentIds']);
    expect(outcome.copiedAttachmentIds).toEqual([first.id, second.id]);
    expect(recorder.applied.every(write => write.newSessionId === TARGET)).toBe(true);
  });

  it('propagates a non-Error copy failure rather than converting it into an omission', async () => {
    const { ports: writers } = ports();
    const rejecting = {
      ...writers,
      attachments: {
        copyOriginal: async () => {
          throw 'disk gone';
        },
      },
    };
    const withFiles = plan({
      facets: { ...plan().facets, attachments: { attachments: [attachment('a', 'one.txt')] } },
    });

    await expect(new SessionTransferImporter(rejecting, 'fork').importPlan(withFiles, TARGET)).rejects.toBe(
      'disk gone',
    );
  });
});
