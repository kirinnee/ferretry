import { describe, it } from 'bun:test';
import should from 'should';
import { FyTransportError } from '../../src/adapters/fy-api-client.ts';
import { FY_REQUEST_ID_HEADER } from '../../src/lib/client.ts';
import { BASE_URL, connectClient, headersOf, jsonBodyOf } from './client-harness.ts';
import { captureError, jsonResponse, QueuedHttpTransport } from './fakes.ts';

const SESSION_ID = 'session-1';
const AT = '2026-08-06T07:00:00.000Z';

/** A handover transfer plan (no conversation), shared by the receipt fixtures below. */
const plan = {
  v: 1 as const,
  planId: 'transfer-plan-1',
  preparedAt: AT,
  source: {
    sessionId: 'session-1',
    incarnation: 'session-1-1',
    runtimeGeneration: 1,
    harness: 'claude' as const,
    agent: 'claude-auto',
    model: 'opus',
    teammate: 'molli',
    name: 'Recovery',
    label: null,
    transcriptProvenance: null,
    cutMessagePoint: null,
  },
  target: {
    accountId: 'account-2',
    agent: 'codex-auto',
    harness: 'codex' as const,
    model: 'gpt-5',
    effort: 'high',
    contextWindow: 200_000,
  },
  durable: {
    cwd: '/work/repo',
    mode: 'auto' as const,
    parentSessionId: null,
    boardAccess: 'none' as const,
    label: null,
    harnessFlags: [] as readonly string[],
    remoteControl: true,
    intervalSeconds: 5,
    timeoutSeconds: 600,
    nudgeAfterSeconds: 60,
    killAfterSeconds: 120,
    directSendMaxChars: 4_096,
    resumeMenuChoice: 'summary' as const,
    maxSnapshots: 10,
    retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
  },
  facets: {
    conversation: null,
    attachments: { attachments: [] },
    references: { counts: { agent: 0, file: 0, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 } },
    workspace: { cwd: '/work/repo', head: null, status: null, repositorySnapshot: null },
    lineage: { wardenLineage: false, warden: null },
  },
  notCarried: [] as readonly unknown[],
};

const resolvedReplacement = {
  accountId: 'account-2',
  agent: 'codex-auto',
  harness: 'codex' as const,
  model: 'gpt-5',
  effort: 'high',
  contextWindow: 200_000,
};
const resolvedCoordinator = {
  accountId: 'account-3',
  agent: 'codex-auto',
  harness: 'codex' as const,
  model: 'gpt-5',
  effort: null,
  contextWindow: 200_000,
};

const BOARD_LADDER = [
  'requested',
  'replacement_creating',
  'replacement_created',
  'invited',
  'approved',
  'accepted',
  'replacement_started',
  'verified',
  'coordinator_creating',
  'coordinator_created',
  'coordinator_granted',
  'coordinator_started',
  'coordinator_replaced',
  'draining',
  'relinquished',
  'predecessor_stopped',
  'completed',
] as const;

/** A completed board-root receipt, valid against SessionHandoverReceiptSchema so response parsing is real. */
const HANDOVER_RECEIPT = {
  requestId: 'req-1',
  fingerprint: 'sha256:abc',
  reason: 'predecessor wedged on an unanswerable question',
  sourceSessionId: 'session-1',
  sourceHarness: 'claude' as const,
  sourceAgent: 'claude-auto',
  sourceTeammate: 'molli',
  resolvedTarget: { replacement: resolvedReplacement, coordinator: resolvedCoordinator },
  planId: 'transfer-plan-1',
  plan,
  replacementSessionId: 'session-2',
  coordinatorSessionId: 'session-3',
  board: {
    boardId: 'board-1',
    creatorSessionId: 'root-0',
    canonicalSessionId: 'root-0',
    createdAt: AT,
    invitationRequestId: 'inv-1',
    grantId: 'grant-1',
  },
  phase: 'completed',
  phaseHistory: BOARD_LADDER.map(phase => ({ phase, at: AT })),
  createdAt: AT,
  updatedAt: AT,
};

const HANDOVER_REQUEST = {
  agent: 'codex-auto',
  model: 'gpt-5',
  coordinator: { agent: 'codex-auto', model: 'gpt-5' },
  reason: 'predecessor wedged on an unanswerable question',
};

describe('FyApiClient handover methods', () => {
  it('posts the handover request to the exact route with the caller id and parses the receipt', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse(HANDOVER_RECEIPT));
    const client = await connectClient(transport);

    // Act
    const actual = await client.handover(SESSION_ID, HANDOVER_REQUEST, 'caller-request-id');

    // Assert — exact route, POST verb, caller-supplied id, request body, receipt parsing.
    should(actual).deepEqual(HANDOVER_RECEIPT);
    should(transport.calls).have.length(1);
    should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/sessions/${SESSION_ID}/handover`);
    should(transport.calls[0]?.init.method).equal('POST');
    should(headersOf(transport).get(FY_REQUEST_ID_HEADER)).equal('caller-request-id');
    should(jsonBodyOf(transport)).deepEqual(HANDOVER_REQUEST);
    should(headersOf(transport).get('content-type')).equal('application/json');
  });

  it('keeps the generated handover request id stable across transport retries', async () => {
    // Arrange
    const cause = new Error('connection refused');
    const transport = new QueuedHttpTransport({ throws: cause }, { throws: cause }, { throws: cause });
    let generated = 0;
    const client = await connectClient(transport, {
      requestId: () => {
        generated += 1;
        return 'stable-handover-id';
      },
    });

    // Act
    const error = await captureError(() => client.handover(SESSION_ID, HANDOVER_REQUEST));

    // Assert — one generated id is reused across all three retry attempts.
    should(error instanceof FyTransportError).be.true();
    should(transport.calls).have.length(3);
    should(generated).equal(1);
    should(transport.calls.map((_, index) => headersOf(transport, index).get(FY_REQUEST_ID_HEADER))).deepEqual([
      'stable-handover-id',
      'stable-handover-id',
      'stable-handover-id',
    ]);
  });

  it('gets the handover receipt from the exact route with no body', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse(HANDOVER_RECEIPT));
    const client = await connectClient(transport);

    // Act
    const actual = await client.handoverReceipt(SESSION_ID);

    // Assert — GET, exact route, no body, receipt parsed.
    should(actual).deepEqual(HANDOVER_RECEIPT);
    should(transport.calls).have.length(1);
    should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/sessions/${SESSION_ID}/handover`);
    should(transport.calls[0]?.init.method ?? 'GET').equal('GET');
    should(transport.calls[0]?.init.body).be.undefined();
  });

  it('posts cancel to the exact route with an empty body and the caller id', async () => {
    // Arrange — a cancelled boardless handover lands abandoned with the cancellation cause and cancel id.
    const cancelledReceipt = {
      ...HANDOVER_RECEIPT,
      board: null,
      coordinatorSessionId: undefined,
      resolvedTarget: { replacement: resolvedReplacement, coordinator: null },
      phase: 'abandoned',
      phaseHistory: [
        { phase: 'requested', at: AT },
        { phase: 'replacement_creating', at: AT },
        { phase: 'replacement_created', at: AT },
        { phase: 'abandoned', at: AT },
      ],
      refusal: { failure: 'cancelled', message: 'operator cancelled before acceptance' },
      cancelRequestId: 'cancel-op-1',
    };
    const transport = new QueuedHttpTransport(jsonResponse(cancelledReceipt));
    const client = await connectClient(transport);

    // Act
    const actual = await client.cancelHandover(SESSION_ID, 'cancel-request-id');

    // Assert — POST, exact cancel route, empty body, caller id, receipt parsed.
    should(actual.phase).equal('abandoned');
    should(actual.refusal).deepEqual({ failure: 'cancelled', message: 'operator cancelled before acceptance' });
    should(transport.calls).have.length(1);
    should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/sessions/${SESSION_ID}/handover/cancel`);
    should(transport.calls[0]?.init.method).equal('POST');
    should(headersOf(transport).get(FY_REQUEST_ID_HEADER)).equal('cancel-request-id');
    should(jsonBodyOf(transport)).deepEqual({});
  });
});
