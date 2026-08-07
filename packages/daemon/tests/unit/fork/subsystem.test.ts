import {
  FORK_SESSION_FAILURE_CODES,
  type ForkSessionFailure,
  type ForkSessionRequest,
  type SessionTransferPlan,
  type SessionView,
} from '@ferretry/protocol';
import { describe, expect, it } from 'bun:test';
import {
  SessionForkPhaseRegressionError,
  SessionForkReceiptInvalidError,
  SessionForkRequestConflictError,
} from '../../../src/lib/fork/failures.ts';
import type { SessionForkCommand, SessionForkKey } from '../../../src/lib/fork/identity.ts';
import {
  forkRefusal,
  forkSessionFailure,
  SessionForkFacade,
  type SessionForkOperation,
} from '../../../src/lib/fork/subsystem.ts';
import type { SessionForkResult } from '../../../src/lib/fork/types.ts';
import { SessionForkRefusal } from '../../../src/lib/runtime/mounts/session-fork.ts';
import { TransferImportError, TransferPrepareError } from '../../../src/lib/transfer/types.ts';
import { plan, report } from './fixtures.ts';

const KEY: SessionForkKey = { sourceSessionId: 'source-a', requestId: 'req-1' };

const PRIVATE_CWD = '/daemon/private/worktree';
const PRIVATE_HOME = '/daemon/private/harness-home';
const PRIVATE_FILE = `${PRIVATE_HOME}/transcript.jsonl`;
const PRIVATE_CORRELATION = 'private-correlation-proof';
const PRIVATE_DIRECTORY = '/daemon/private/state/target-1';
const PRIVATE_ACCOUNT_ID = 'private-account-record';
const PRIVATE_CONVERSATION = 'private portable conversation payload';
const PRIVATE_HARNESS_FLAG = '--config=/daemon/private/harness-config.json';
const PRIVATE_RUNTIME_DETAIL = '/daemon/private/catalogue/runtime-probe.json';
const GENERIC_FAILURE_MESSAGE = 'the fork could not be completed';

const view = (id: string): SessionView =>
  ({
    config: {
      id,
      name: 'Forked Session',
      agent: 'account-b',
      harness: 'codex',
      model: 'gpt',
      cwd: PRIVATE_CWD,
      transcript: {
        v: 1,
        home: PRIVATE_HOME,
        identity: 'correlated',
        harnessSessionId: 'harness-target-1',
        correlationToken: PRIVATE_CORRELATION,
        file: PRIVATE_FILE,
      },
    },
    state: { id, status: 'running' },
    directory: PRIVATE_DIRECTORY,
  }) as unknown as SessionView;

/** A real internal plan carrying every class of value the public facade must not spread. */
function internalPlan(): SessionTransferPlan {
  const base = plan();
  return {
    ...base,
    source: {
      ...base.source,
      transcriptProvenance: {
        v: 1,
        home: PRIVATE_HOME,
        identity: 'correlated',
        harnessSessionId: 'harness-source-1',
        correlationToken: PRIVATE_CORRELATION,
        file: PRIVATE_FILE,
      },
    },
    target: { ...base.target, accountId: PRIVATE_ACCOUNT_ID },
    durable: { ...base.durable, cwd: PRIVATE_CWD },
    facets: {
      ...base.facets,
      conversation: {
        messages: [
          {
            point: { v: 1, byteOffset: 512, blockIndex: 0 },
            role: 'user',
            text: PRIVATE_CONVERSATION,
          },
        ],
      },
      workspace: { ...base.facets.workspace, cwd: PRIVATE_CWD },
    },
    notCarried: [
      {
        facet: 'workspace',
        subject: PRIVATE_CWD,
        reason: 'not_implemented',
        detail: `conversation time was rewound; ${PRIVATE_CWD} remains at its current state`,
      },
      {
        facet: 'references',
        subject: '%terminal:build',
        reason: 'session_scoped',
        detail: 'a terminal remains owned by the source session',
      },
      {
        facet: 'runtime',
        subject: PRIVATE_HARNESS_FLAG,
        reason: 'harness_incompatible',
        detail: `source harness option ${JSON.stringify(PRIVATE_HARNESS_FLAG)} has no safe target translation`,
      },
      {
        facet: 'runtime',
        subject: PRIVATE_RUNTIME_DETAIL,
        reason: 'unavailable',
        detail: `runtime evidence under ${PRIVATE_RUNTIME_DETAIL} could not be read`,
      },
    ],
  };
}

const request = (overrides: Partial<ForkSessionRequest> = {}): ForkSessionRequest => ({
  through: { v: 1, byteOffset: 512, blockIndex: 0 },
  selectionBinding: 'selection-binding-1',
  agent: 'account-b',
  ...overrides,
});

/** What a resolver states, in the shape the facade recognises without importing an adapter. */
class FakeResolutionError extends Error {
  constructor(
    readonly failure: string,
    message = `the resolver refused with ${failure}`,
  ) {
    super(message);
    this.name = 'SessionForkTargetResolutionError';
  }
}

interface Harness {
  readonly facade: SessionForkFacade;
  readonly calls: Array<{ readonly key: SessionForkKey; readonly command: SessionForkCommand }>;
}

function harness(behaviour: (() => never) | undefined = undefined): Harness {
  const calls: Array<{ readonly key: SessionForkKey; readonly command: SessionForkCommand }> = [];
  const operation: SessionForkOperation = {
    fork: async (key, command): Promise<SessionForkResult> => {
      calls.push({ key, command });
      behaviour?.();
      return { targetSessionId: 'target-1', session: view('target-1'), plan: internalPlan(), report: report() };
    },
  };
  return { facade: new SessionForkFacade(operation), calls };
}

/** The refusal a facade produced, so a test can read the arm it chose. */
async function refusalFor(behaviour: () => never): Promise<SessionForkRefusal> {
  const thrown = await harness(behaviour)
    .facade.fork(KEY.sourceSessionId, request(), KEY.requestId)
    .catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(SessionForkRefusal);
  return thrown as SessionForkRefusal;
}

/**
 * One producer for every arm the wire declares.
 *
 * The MAPPED type is the exhaustiveness proof: a code the protocol adds and this table has not
 * answered for is a compile error, and so is an entry for a code the protocol no longer has. A
 * `satisfies` list would have stayed green for the missing one — which is the direction that
 * matters, because a missing arm falls silently through to `session_fork_failed` and tells a caller
 * "the daemon broke" about a refusal it could have acted on.
 */
const PRODUCERS: { readonly [K in ForkSessionFailure]: () => unknown } = {
  invalid_session_id: () => new SessionForkRefusal('invalid_session_id', 'not a usable id'),
  source_not_found: () => new TransferPrepareError('source_not_found', 'no such session'),
  selection_stale: () => new TransferPrepareError('selection_stale', 'private transcript comparison detail'),
  incomplete_transcript: () => new TransferPrepareError('incomplete_transcript', 'the transcript has a hole'),
  target_not_found: () => new TransferPrepareError('target_not_found', 'no message at that point'),
  target_not_message: () => new TransferPrepareError('target_not_message', 'that point is a tool call'),
  conversation_unavailable: () => new TransferPrepareError('conversation_unavailable', 'no provenance'),
  lineage_untraceable: () => new TransferPrepareError('lineage_untraceable', 'the warden descent is unknown'),
  plan_invalid: () => new TransferPrepareError('plan_invalid', 'the daemon built an invalid plan'),
  edge_invalid: () => new TransferImportError('edge_invalid', 'the target id is not fresh'),
  cut_not_carried: () => new TransferImportError('cut_not_carried', 'the last message is not the cut'),
  cut_unreadable: () => new TransferImportError('cut_unreadable', 'the transcript cannot be read'),
  cut_rewritten: () => new TransferImportError('cut_rewritten', 'the source moved under the plan'),
  unknown_agent: () => new FakeResolutionError('unknown_agent'),
  agent_unavailable: () => new FakeResolutionError('agent_unavailable'),
  request_id_reused: () => new SessionForkRequestConflictError(KEY),
  session_fork_failed: () => new Error('the disk is on fire'),
};

describe('forkSessionFailure', () => {
  it('answers every arm the wire declares, and nothing else', () => {
    for (const code of FORK_SESSION_FAILURE_CODES) expect(forkSessionFailure(PRODUCERS[code]())).toBe(code);
    expect(Object.keys(PRODUCERS).sort()).toEqual([...FORK_SESSION_FAILURE_CODES].sort());
  });

  it('maps the fork core refusals that have no arm of their own onto the retryable failure', () => {
    // Neither is a caller error and neither destroyed anything, so both are `session_fork_failed`:
    // presenting the same request id again re-drives the same fork.
    expect(forkSessionFailure(new SessionForkReceiptInvalidError(KEY, 'a doctored document'))).toBe(
      'session_fork_failed',
    );
    expect(forkSessionFailure(new SessionForkPhaseRegressionError('completed', 'imported'))).toBe(
      'session_fork_failed',
    );
  });

  it('refuses to read an arm the resolver did not claim', () => {
    // A third arm invented by an adapter is NOT mapped to a code it never stated.
    expect(forkSessionFailure(new FakeResolutionError('agent_on_fire'))).toBe('session_fork_failed');
    expect(forkSessionFailure({ failure: 'unknown_agent' })).toBe('session_fork_failed');
    expect(forkSessionFailure('unknown_agent')).toBe('session_fork_failed');
    expect(forkSessionFailure(undefined)).toBe('session_fork_failed');
  });
});

describe('forkRefusal', () => {
  it('passes a stated refusal through rather than restating it', () => {
    const stated = new SessionForkRefusal('cut_rewritten', 'the source moved');
    expect(forkRefusal(stated)).toBe(stated);
  });

  it('keeps audited caller-actionable prose and supplies a generic message when there is none', () => {
    expect(forkRefusal(new TransferPrepareError('source_not_found', 'session s9 does not exist')).message).toBe(
      'session s9 does not exist',
    );
    expect(forkRefusal(new Error('')).message).toBe(GENERIC_FAILURE_MESSAGE);
    expect(forkRefusal(42).message).toBe('the fork could not be completed');
  });

  it('never publishes producer prose for a 500 failure', () => {
    const privatePath = '/daemon/private/state/target-1/transfer-plan.json';

    for (const error of [
      new Error(`could not open ${privatePath}`),
      new TransferPrepareError('plan_invalid', `invalid plan at ${privatePath}`),
      new TransferImportError('edge_invalid', `invalid edge at ${privatePath}`),
      new TransferImportError('cut_not_carried', `missing cut in ${privatePath}`),
      new SessionForkRefusal('session_fork_failed', `binder failed under ${privatePath}`),
    ]) {
      const refusal = forkRefusal(error);
      expect(refusal.message).toBe(GENERIC_FAILURE_MESSAGE);
      expect(refusal.message).not.toContain(privatePath);
    }
  });

  it('never publishes an upstream resolver error path', () => {
    const privatePath = '/daemon/private/fleet/manifest.json';

    for (const failure of ['unknown_agent', 'agent_unavailable'] as const) {
      const refusal = forkRefusal(new FakeResolutionError(failure, `account lookup failed at ${privatePath}`));
      expect(refusal.message).toBe(GENERIC_FAILURE_MESSAGE);
      expect(refusal.message).not.toContain(privatePath);
    }
  });
});

describe('SessionForkFacade', () => {
  it('refuses a path id no store could safely turn into a directory, before reaching the service', async () => {
    const fork = harness();

    const thrown = (await fork.facade
      .fork('../../etc/passwd', request(), 'req-1')
      .catch((error: unknown) => error)) as SessionForkRefusal;

    expect(thrown).toBeInstanceOf(SessionForkRefusal);
    expect(thrown.failure).toBe('invalid_session_id');
    expect(fork.calls).toEqual([]);
  });

  it('keys the fork on the source and the header request id together', async () => {
    const fork = harness();
    await fork.facade.fork('source-a', request(), 'req-1');

    expect(fork.calls[0]?.key).toEqual({ sourceSessionId: 'source-a', requestId: 'req-1' });
  });

  it('collapses an unstated model and effort to null exactly once', async () => {
    const fork = harness();
    await fork.facade.fork('source-a', request(), 'req-1');

    expect(fork.calls[0]?.command).toEqual({
      through: { v: 1, byteOffset: 512, blockIndex: 0 },
      selectionBinding: 'selection-binding-1',
      agent: 'account-b',
      model: null,
      effort: null,
    });
  });

  it('carries a stated model and effort through untouched', async () => {
    const fork = harness();
    await fork.facade.fork('source-a', request({ model: 'gpt', effort: 'high' }), 'req-1');

    expect(fork.calls[0]?.command.model).toBe('gpt');
    expect(fork.calls[0]?.command.effort).toBe('high');
  });

  it('answers with only the public session and plan projections', async () => {
    const outcome = await harness().facade.fork('source-a', request(), 'req-1');

    expect(Object.keys(outcome).sort()).toEqual(['plan', 'session']);
    expect(outcome.session).toEqual({
      id: 'target-1',
      name: 'Forked Session',
      agent: 'account-b',
      harness: 'codex',
      model: 'gpt',
      status: 'running',
    });
    expect(outcome.plan).toEqual({
      v: 1,
      planId: plan().planId,
      preparedAt: plan().preparedAt,
      source: {
        sessionId: 'source-a',
        cutMessagePoint: { v: 1, byteOffset: 512, blockIndex: 0 },
      },
      target: {
        agent: 'account-b',
        harness: 'codex',
        model: 'gpt',
        effort: 'high',
        contextWindow: 200_000,
      },
      notCarried: [
        {
          facet: 'workspace',
          subject: 'working tree',
          reason: 'not_implemented',
          detail: 'conversation time was rewound; the working tree remains at its current state',
        },
        {
          facet: 'references',
          subject: '%terminal:build',
          reason: 'session_scoped',
          detail: 'a terminal remains owned by the source session',
        },
        {
          facet: 'runtime',
          subject: 'source harness startup option',
          reason: 'harness_incompatible',
          detail:
            'a source-harness startup option was not carried because the target harness cannot safely interpret it',
        },
        {
          facet: 'runtime',
          subject: 'source harness startup option',
          reason: 'unavailable',
          detail:
            'a source-harness startup option was not carried because the target harness cannot safely interpret it',
        },
      ],
    });
  });

  it('does not serialize any daemon-local key or hidden value from the internal result', async () => {
    const encoded = JSON.stringify(await harness().facade.fork('source-a', request(), 'req-1'));

    for (const key of [
      'cwd',
      'directory',
      'accountId',
      'transcript',
      'transcriptProvenance',
      'correlationToken',
      'home',
      'file',
      'facets',
      'durable',
      'report',
    ])
      expect(encoded).not.toContain(`"${key}"`);
    for (const privateValue of [
      PRIVATE_CWD,
      PRIVATE_HOME,
      PRIVATE_FILE,
      PRIVATE_CORRELATION,
      PRIVATE_DIRECTORY,
      PRIVATE_ACCOUNT_ID,
      PRIVATE_CONVERSATION,
      PRIVATE_HARNESS_FLAG,
      PRIVATE_RUNTIME_DETAIL,
      report().briefPath,
    ])
      expect(encoded).not.toContain(privateValue);
  });

  it('restates every failure the fork can raise as a refusal the route can answer', async () => {
    for (const code of FORK_SESSION_FAILURE_CODES) {
      const refusal = await refusalFor(() => {
        throw PRODUCERS[code]();
      });
      expect(refusal.failure).toBe(code);
    }
  });
});
