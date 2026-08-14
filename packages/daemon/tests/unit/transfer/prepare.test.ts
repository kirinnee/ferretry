import { describe, expect, it } from 'bun:test';
import type {
  AttachmentFacet,
  ConversationFacet,
  LineageFacet,
  ReferenceFacet,
  TransferOmission,
  WorkspaceFacet,
} from '@ferretry/protocol';
import { deriveTransferPlanId, SessionTransferPreparer } from '../../../src/lib/transfer/prepare.ts';
import {
  SESSION_TRANSFER_PREPARE_PORTS,
  type TransferContributorSet,
  type TransferConversationContribution,
  type TransferFacetContribution,
  type TransferFacetContributor,
  type TransferFacetInput,
  TransferPrepareError,
  type TransferSelectionBindingEvidence,
  type TransferSelectionBindingVerifier,
  type TransferSourceSession,
} from '../../../src/lib/transfer/types.ts';
import { request, sourceSession, target } from './fixtures.ts';

const NO_REFERENCES: ReferenceFacet = {
  counts: { agent: 0, file: 0, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 },
};

const WORKSPACE: WorkspaceFacet = { cwd: '/work/repo', head: null, status: null, repositorySnapshot: null };

const CONVERSATION: ConversationFacet = {
  messages: [{ point: { v: 1, byteOffset: 512, blockIndex: 0 }, role: 'user', text: 'ship it' }],
};

const RAW_PREFIX = Uint8Array.from({ length: 32 }, (_, index) => index);

function stub<F>(
  facet: TransferOmission['facet'],
  value: F,
  omissions: readonly TransferOmission[] = [],
): TransferFacetContributor<F> {
  return { facet, contribute: async () => ({ value, omissions }) };
}

function omission(facet: TransferOmission['facet'], subject: string): TransferOmission {
  return { facet, subject, reason: 'unavailable', detail: 'stubbed' };
}

interface Harness {
  readonly contributors: TransferContributorSet;
  /** What the references contributor was handed, so contributor ORDER can be asserted. */
  readonly seen: { conversation: ConversationFacet | null | undefined };
}

function contributors(overrides: Partial<TransferContributorSet> = {}): Harness {
  const seen: { conversation: ConversationFacet | null | undefined } = { conversation: undefined };
  const references: TransferFacetContributor<ReferenceFacet, TransferFacetInput> = {
    facet: 'references',
    contribute: async (input: TransferFacetInput): Promise<TransferFacetContribution<ReferenceFacet>> => {
      seen.conversation = input.conversation;
      return { value: NO_REFERENCES, omissions: [omission('references', 'r')] };
    },
  };
  return {
    seen,
    contributors: {
      conversation: {
        facet: 'conversation',
        contribute: async input =>
          ({
            value: CONVERSATION,
            omissions: [omission('conversation', 'c')],
            selectionEvidence:
              input.request.cutMessagePoint === null ? null : { rawPrefix: Uint8Array.from(RAW_PREFIX) },
          }) satisfies TransferConversationContribution,
      },
      attachments: stub<AttachmentFacet>('attachments', { attachments: [] }, [omission('attachments', 'a')]),
      references,
      workspace: stub<WorkspaceFacet>('workspace', WORKSPACE, [omission('workspace', 'w')]),
      lineage: stub<LineageFacet>('lineage', { wardenLineage: false, warden: null }, [omission('lineage', 'l')]),
      ...overrides,
    },
  };
}

function preparer(
  source: TransferSourceSession | undefined,
  overrides: Partial<TransferContributorSet> = {},
  selectionOverride?: TransferSelectionBindingVerifier,
) {
  const harness = contributors(overrides);
  const selectionSeen: Array<{ readonly evidence: TransferSelectionBindingEvidence; readonly binding: string }> = [];
  const selection: TransferSelectionBindingVerifier =
    selectionOverride ??
    ({
      verifySelection: async (evidence, binding) => {
        selectionSeen.push({ evidence, binding });
        return true;
      },
    } satisfies TransferSelectionBindingVerifier);
  return {
    ...harness,
    selectionSeen,
    preparer: new SessionTransferPreparer({
      source: { read: async () => source },
      selection,
      contributors: harness.contributors,
    }),
  };
}

describe('deriveTransferPlanId', () => {
  it('is a pure function of the source and the request id, so a replay addresses the same plan', () => {
    expect(deriveTransferPlanId('source-a', 'req-1')).toBe(deriveTransferPlanId('source-a', 'req-1'));
    expect(deriveTransferPlanId('source-a', 'req-1')).not.toBe(deriveTransferPlanId('source-a', 'req-2'));
    expect(deriveTransferPlanId('source-a', 'req-1')).not.toBe(deriveTransferPlanId('source-b', 'req-1'));
  });

  it('does not collide by concatenation: two different splits of one string are two different plans', () => {
    expect(deriveTransferPlanId('ab', 'c')).not.toBe(deriveTransferPlanId('a', 'bc'));
  });
});

describe('SessionTransferPreparer', () => {
  it('holds readers and contributors only — no writer, no lifecycle, no board', () => {
    expect(Object.keys(SESSION_TRANSFER_PREPARE_PORTS).sort()).toEqual(['contributors', 'selection', 'source']);
  });

  it('refuses a source that does not exist rather than preparing an empty transfer', async () => {
    const { preparer: subject } = preparer(undefined);

    const error = (await subject.prepare(request()).catch((thrown: unknown) => thrown)) as TransferPrepareError;

    expect(error).toBeInstanceOf(TransferPrepareError);
    expect(error.failure).toBe('source_not_found');
  });

  it('refuses a cut against a source whose transcript this daemon cannot name', async () => {
    const { preparer: subject } = preparer(sourceSession({ transcriptProvenance: null }));

    const error = (await subject.prepare(request()).catch((thrown: unknown) => thrown)) as TransferPrepareError;

    expect(error.failure).toBe('conversation_unavailable');
  });

  it('refuses stale selection evidence before any non-conversation facet is read', async () => {
    const shouldNotRun = <F>(facet: TransferOmission['facet']): TransferFacetContributor<F> => ({
      facet,
      contribute: async () => {
        throw new Error(`stale selection reached ${facet}`);
      },
    });
    const { preparer: subject } = preparer(
      sourceSession(),
      {
        attachments: shouldNotRun<AttachmentFacet>('attachments'),
        references: shouldNotRun<ReferenceFacet>('references'),
        workspace: shouldNotRun<WorkspaceFacet>('workspace'),
        lineage: shouldNotRun<LineageFacet>('lineage'),
      },
      { verifySelection: async () => false },
    );

    const error = (await subject.prepare(request()).catch((thrown: unknown) => thrown)) as TransferPrepareError;

    expect(error.failure).toBe('selection_stale');
  });

  it('verifies the contributor commitment from the same conversation read, not projected messages', async () => {
    const source = sourceSession();
    const transcriptProvenance = source.transcriptProvenance;
    if (transcriptProvenance === null) throw new Error('the source fixture must pin transcript provenance');
    const { preparer: subject, selectionSeen } = preparer(source);

    await subject.prepare(request());

    expect(selectionSeen).toHaveLength(1);
    expect(selectionSeen[0]).toEqual({
      binding: 'selection-binding-1',
      evidence: {
        sourceSessionId: 'source-a',
        sourceIncarnation: source.incarnation,
        transcriptProvenance,
        through: { v: 1, byteOffset: 512, blockIndex: 0 },
        rawPrefix: RAW_PREFIX,
      },
    });
    expect(selectionSeen[0]?.evidence).not.toHaveProperty('messages');
  });

  it('prepares a transfer with no conversation from a source with no transcript at all', async () => {
    const { preparer: subject } = preparer(sourceSession({ transcriptProvenance: null }), {
      conversation: {
        facet: 'conversation',
        contribute: async () => ({ value: null, omissions: [], selectionEvidence: null }),
      },
    });

    const plan = await subject.prepare(request({ cutMessagePoint: null, selectionBinding: null }));

    expect(plan.facets.conversation).toBeNull();
    expect(plan.source.cutMessagePoint).toBeNull();
    expect(plan.source.transcriptProvenance).toBeNull();
  });

  it('refuses selection evidence on a transfer whose cut is null', async () => {
    const { preparer: subject } = preparer(sourceSession({ transcriptProvenance: null }), {
      conversation: {
        facet: 'conversation',
        contribute: async () => ({ value: null, omissions: [], selectionEvidence: { rawPrefix: RAW_PREFIX } }),
      },
    });

    const error = (await subject
      .prepare(request({ cutMessagePoint: null, selectionBinding: null }))
      .catch((thrown: unknown) => thrown)) as TransferPrepareError;

    expect(error.failure).toBe('plan_invalid');
  });

  it('produces a top-level, board-free session and carries the durable daemon-side configuration', async () => {
    const { preparer: subject } = preparer(sourceSession());

    const plan = await subject.prepare(request());

    expect(plan.durable.parentSessionId).toBeNull();
    expect(plan.durable.boardAccess).toBe('none');
    expect(plan.durable.cwd).toBe('/work/repo');
    expect(plan.durable.mode).toBe('auto');
    expect(plan.durable.remoteControl).toBe(true);
    expect(plan.durable.resumeMenuChoice).toBe('full');
    expect(plan.durable.maxSnapshots).toBe(5);
    expect(plan.durable.retry).toEqual({
      transientAttempts: 2,
      stalledAttempts: 1,
      waitForQuotaReset: true,
      allowAccountFailover: false,
    });
    expect(plan.target).toEqual(target());
    expect(plan.planId).toBe(deriveTransferPlanId('source-a', 'req-1'));
    expect(plan.source.runtimeGeneration).toBe(3);
  });

  it('keeps the source label in the inventory but forces the target label for warden descent', async () => {
    const { preparer: subject } = preparer(sourceSession({ label: 'teammate' }), {
      lineage: stub<LineageFacet>('lineage', { wardenLineage: true, warden: 'warden-7' }),
    });

    const plan = await subject.prepare(request());

    expect(plan.source.label).toBe('teammate');
    expect(plan.durable.label).toBe('fleet-warden');
  });

  it('carries harness flags verbatim within one family', async () => {
    const { preparer: subject } = preparer(sourceSession());

    const plan = await subject.prepare(request());

    expect(plan.durable.harnessFlags).toEqual(['--flag-a', '--flag-b']);
    expect(plan.notCarried.filter(entry => entry.facet === 'runtime')).toEqual([]);
  });

  it('drops every harness flag across families and names each one', async () => {
    const { preparer: subject } = preparer(sourceSession());

    const plan = await subject.prepare(request({ target: target({ harness: 'codex' }) }));

    expect(plan.durable.harnessFlags).toEqual([]);
    const flags = plan.notCarried.filter(entry => entry.facet === 'runtime');
    expect(flags.map(entry => entry.subject)).toEqual(['--flag-a', '--flag-b']);
    expect(flags.every(entry => entry.reason === 'harness_incompatible')).toBe(true);
    expect(flags[0]?.detail).toContain('codex');
  });

  it('hands the decided conversation to the reference inventory, so counts describe what actually crosses', async () => {
    const { preparer: subject, seen } = preparer(sourceSession());

    await subject.prepare(request());

    expect(seen.conversation).toEqual(CONVERSATION);
  });

  it('collects every refusal into one ordered list', async () => {
    const { preparer: subject } = preparer(sourceSession());

    const plan = await subject.prepare(request({ target: target({ harness: 'codex' }) }));

    expect(plan.notCarried.map(entry => entry.facet)).toEqual([
      'conversation',
      'attachments',
      'references',
      'workspace',
      'lineage',
      'runtime',
      'runtime',
    ]);
  });

  it('refuses a payload a contributor made incoherent, before any session exists to receive it', async () => {
    const { preparer: subject } = preparer(sourceSession(), {
      conversation: {
        facet: 'conversation',
        contribute: async () => ({ value: null, omissions: [], selectionEvidence: null }),
      },
    });

    const error = (await subject.prepare(request()).catch((thrown: unknown) => thrown)) as TransferPrepareError;

    expect(error).toBeInstanceOf(TransferPrepareError);
    expect(error.failure).toBe('plan_invalid');
    expect(error.message).toContain('no carried cut or raw-prefix evidence');
  });
});
