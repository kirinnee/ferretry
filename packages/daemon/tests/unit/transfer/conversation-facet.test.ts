import { describe, expect, it } from 'bun:test';
import type { ConversationMessagePoint } from '@ferretry/protocol';
import {
  type ConversationDigest,
  ConversationDigestError,
  type ConversationDigestFailure,
} from '../../../src/lib/session/transcript/digest.ts';
import { ConversationFacetContributor } from '../../../src/lib/transfer/facets/conversation.ts';
import {
  type TransferConversationReadInput,
  type TransferConversationReader,
  TransferPrepareError,
} from '../../../src/lib/transfer/types.ts';
import { AT, request, sourceSession } from './fixtures.ts';

const point = (byteOffset: number, blockIndex = 0): ConversationMessagePoint => ({
  v: 1,
  byteOffset,
  blockIndex,
});

const rawPrefix = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const reader = (
  answer: (input: TransferConversationReadInput) => Promise<ConversationDigest | undefined>,
): TransferConversationReader => ({
  digest: answer,
});

const input = (overrides: Parameters<typeof request>[0] = {}) => ({
  request: request(overrides),
  source: sourceSession(),
});

describe('ConversationFacetContributor', () => {
  it('carries no conversation, and asks for no transcript, when the caller named no cut', async () => {
    let read = 0;
    const contributor = new ConversationFacetContributor(
      reader(async () => {
        read += 1;
        return undefined;
      }),
    );

    const contribution = await contributor.contribute(input({ cutMessagePoint: null }));

    expect(contribution).toEqual({ value: null, omissions: [], selectionEvidence: null });
    expect(read).toBe(0);
    expect(contributor.facet).toBe('conversation');
  });

  it('copies the portable messages through the cut and names every omitted record', async () => {
    const digest: ConversationDigest = {
      sessionId: 'source-a',
      through: point(512),
      messages: [
        { point: point(0), role: 'user', text: 'secret TOKEN', timestamp: AT },
        { point: point(512, 1), role: 'assistant', text: 'second' },
      ],
      omissions: [
        { point: point(128), kind: 'tool-result', reason: 'harness-specific' },
        { point: point(256, 2), kind: 'error', reason: 'unreadable' },
      ],
      selectionEvidence: { point: point(512), rawPrefix: rawPrefix(7) },
    };
    const contributor = new ConversationFacetContributor(
      reader(async () => digest),
      {
        redact: async text => text.replace('secret TOKEN', '[redacted:TOKEN]'),
      },
    );

    const contribution = await contributor.contribute(input());

    expect(contribution.value).toEqual({
      messages: [
        { point: point(0), role: 'user', text: '[redacted:TOKEN]', timestamp: AT },
        { point: point(512, 1), role: 'assistant', text: 'second' },
      ],
    });
    expect(contribution.omissions).toEqual([
      {
        facet: 'conversation',
        subject: 'tool-result at byte 128#0',
        reason: 'harness_incompatible',
        detail: 'this record is harness-private evidence and cannot be replayed by another harness',
      },
      {
        facet: 'conversation',
        subject: 'error at byte 256#2',
        reason: 'unavailable',
        detail: 'this record could not be read as a conversation message, so it is not carried',
      },
    ]);
    expect(contribution.selectionEvidence).toEqual({ rawPrefix: rawPrefix(7) });
    expect(contribution.value).not.toHaveProperty('selectionEvidence');
  });

  it('pins the digest to the source snapshot already read by preparation', async () => {
    let seen: TransferConversationReadInput | undefined;
    const contributor = new ConversationFacetContributor(
      reader(async input => {
        seen = input;
        return {
          sessionId: input.sourceSessionId,
          through: input.through,
          messages: [{ point: input.through, role: 'user', text: 'from the pinned transcript' }],
          omissions: [],
          selectionEvidence: { point: input.through, rawPrefix: rawPrefix(1) },
        };
      }),
    );
    const frozen = input();
    const transcriptProvenance = frozen.source.transcriptProvenance;
    if (transcriptProvenance === null) throw new Error('the source fixture must pin a transcript');
    const through = frozen.request.cutMessagePoint;
    if (through === null) throw new Error('the request fixture must pin a message cut');

    await contributor.contribute(frozen);

    expect(seen).toEqual({
      sourceSessionId: frozen.source.sessionId,
      sourceHarness: frozen.source.harness,
      transcriptProvenance,
      through,
    });
  });

  it('refuses a cut whose already-read source snapshot has no transcript provenance', async () => {
    let read = 0;
    const contributor = new ConversationFacetContributor(
      reader(async () => {
        read += 1;
        return undefined;
      }),
    );

    const error = (await contributor
      .contribute({ ...input(), source: sourceSession({ transcriptProvenance: null }) })
      .catch((thrown: unknown) => thrown)) as TransferPrepareError;

    expect(error).toBeInstanceOf(TransferPrepareError);
    expect(error.failure).toBe('conversation_unavailable');
    expect(read).toBe(0);
  });

  it('refuses an unlocatable transcript instead of manufacturing an empty prefix for an exact cut', async () => {
    const contributor = new ConversationFacetContributor(reader(async () => undefined));

    const error = (await contributor.contribute(input()).catch((thrown: unknown) => thrown)) as TransferPrepareError;

    expect(error).toBeInstanceOf(TransferPrepareError);
    expect(error.failure).toBe('conversation_unavailable');
    expect(error.message).toContain('source-a');
  });

  it('refuses a digest without same-read raw-prefix evidence for the requested cut', async () => {
    const digest = (selectionEvidence?: ConversationDigest['selectionEvidence']): ConversationDigest => ({
      sessionId: 'source-a',
      through: point(512),
      messages: [{ point: point(512), role: 'user', text: 'selected' }],
      omissions: [],
      ...(selectionEvidence === undefined ? {} : { selectionEvidence }),
    });

    for (const answer of [digest(), digest({ point: point(512, 1), rawPrefix: rawPrefix(2) })]) {
      const contributor = new ConversationFacetContributor(reader(async () => answer));
      const error = (await contributor.contribute(input()).catch((thrown: unknown) => thrown)) as TransferPrepareError;

      expect(error).toBeInstanceOf(TransferPrepareError);
      expect(error.failure).toBe('plan_invalid');
      expect(error.message).toContain('raw-prefix evidence');
    }
  });

  it.each<ConversationDigestFailure>(['incomplete_transcript', 'target_not_found', 'target_not_message'])(
    'carries the digest refusal %s through under its own name',
    async failure => {
      const contributor = new ConversationFacetContributor(
        reader(async () => {
          throw new ConversationDigestError(failure, `refused: ${failure}`);
        }),
      );

      const error = (await contributor.contribute(input()).catch((thrown: unknown) => thrown)) as TransferPrepareError;

      expect(error).toBeInstanceOf(TransferPrepareError);
      expect(error.failure).toBe(failure);
      expect(error.message).toBe(`refused: ${failure}`);
    },
  );

  it('rethrows a failure that is not a digest refusal rather than dressing it as one', async () => {
    const boom = new Error('the disk is on fire');
    const contributor = new ConversationFacetContributor(
      reader(async () => {
        throw boom;
      }),
    );

    expect(contributor.contribute(input())).rejects.toBe(boom);
  });
});
