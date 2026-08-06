import type { SessionHandoverRequest, SessionTransferPlan } from '@ferretry/protocol';
import { HandoverError } from '../../../src/lib/handover/types.ts';
import type {
  HandoverAttentionRequest,
  HandoverFailure,
  HandoverBoardMembership,
  HandoverBoardObservation,
  HandoverBoardPort,
  HandoverChildGrantApproval,
  HandoverChildGrantCommand,
  HandoverCoordinatorReplacement,
  HandoverCreateCommand,
  HandoverInvitationStepCommand,
  HandoverInviteCommand,
  HandoverJournalAppend,
  HandoverPorts,
  HandoverPrepareCommand,
  HandoverPreflightVerdict,
  HandoverReceipt,
  HandoverRelinquishCommand,
  HandoverResolvedAccount,
  HandoverSessionView,
} from '../../../src/lib/handover/types.ts';

export const SOURCE_ID = 'source-1';
export const BOARD_ID = 'board-1';
export const REQUEST_ID = 'req-1';

const CLAUDE_ACCOUNT: HandoverResolvedAccount = {
  accountId: 'acct-claude',
  agent: 'claude-main',
  harness: 'claude',
  model: 'opus',
  effort: null,
  contextWindow: 200_000,
};

export const CODEX_ACCOUNT: HandoverResolvedAccount = {
  accountId: 'acct-codex',
  agent: 'codex-main',
  harness: 'codex',
  model: 'gpt',
  effort: 'high',
  contextWindow: 400_000,
};

export const CODEX_COORDINATOR: HandoverResolvedAccount = {
  ...CODEX_ACCOUNT,
  accountId: 'acct-codex-coordinator',
  agent: 'codex-coordinator',
};

export function sessionView(overrides: Partial<HandoverSessionView> = {}): HandoverSessionView {
  return {
    sessionId: SOURCE_ID,
    incarnation: `${SOURCE_ID}-1`,
    runtimeGeneration: 1,
    parentSessionId: null,
    mode: 'interactive',
    status: 'running',
    harness: 'claude',
    agent: 'claude-main',
    teammate: 'ada',
    cwd: '/work/repo',
    label: null,
    ...overrides,
  };
}

export function membership(overrides: Partial<HandoverBoardMembership> = {}): HandoverBoardMembership {
  return {
    boardId: BOARD_ID,
    creatorSessionId: SOURCE_ID,
    canonicalSessionId: SOURCE_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    coordinatorAlive: true,
    outstandingInvitation: false,
    activeRootSessionIds: [SOURCE_ID],
    ...overrides,
  };
}

export function observation(overrides: Partial<HandoverBoardObservation> = {}): HandoverBoardObservation {
  return {
    boardId: BOARD_ID,
    creatorSessionId: SOURCE_ID,
    canonicalSessionId: SOURCE_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    coordinatorSessionId: 'old-coordinator',
    coordinatorAlive: true,
    activeRootSessionIds: [SOURCE_ID],
    outstandingInvitation: false,
    invitation: null,
    ...overrides,
  };
}

export function request(overrides: Partial<SessionHandoverRequest> = {}): SessionHandoverRequest {
  return {
    agent: CODEX_ACCOUNT.agent,
    model: CODEX_ACCOUNT.model ?? undefined,
    coordinator: { agent: CODEX_COORDINATOR.agent, model: CODEX_COORDINATOR.model ?? undefined },
    reason: 'the claude account is out of quota until tomorrow',
    ...overrides,
  };
}

export function transferPlan(planId: string): SessionTransferPlan {
  return {
    v: 1,
    planId,
    preparedAt: '2026-02-01T00:00:00.000Z',
    source: {
      sessionId: SOURCE_ID,
      incarnation: `${SOURCE_ID}-1`,
      runtimeGeneration: 1,
      harness: 'claude',
      agent: 'claude-main',
      model: 'opus',
      teammate: 'ada',
      name: 'ada',
      label: null,
      transcriptProvenance: null,
      cutMessagePoint: null,
    },
    target: {
      accountId: CODEX_ACCOUNT.accountId,
      agent: CODEX_ACCOUNT.agent,
      harness: 'codex',
      model: CODEX_ACCOUNT.model,
      effort: CODEX_ACCOUNT.effort,
      contextWindow: CODEX_ACCOUNT.contextWindow,
    },
    durable: {
      cwd: '/work/repo',
      mode: 'interactive',
      parentSessionId: null,
      boardAccess: 'none',
      label: null,
      harnessFlags: [],
      remoteControl: false,
      intervalSeconds: 30,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 4000,
      resumeMenuChoice: 'full',
      maxSnapshots: 5,
      retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
    },
    facets: {
      conversation: null,
      attachments: { attachments: [] },
      references: { counts: { agent: 0, file: 0, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 } },
      workspace: { cwd: '/work/repo', head: null, status: null, repositorySnapshot: null },
      lineage: { wardenLineage: false, warden: null },
    },
    notCarried: [],
  };
}

/** A receipt at an arbitrary phase, for the pure tests that need one without walking the ladder. */
export function receiptAt(phase: HandoverReceipt['phase'], overrides: Partial<HandoverReceipt> = {}): HandoverReceipt {
  const at = '2026-02-01T00:00:00.000Z';
  return {
    requestId: REQUEST_ID,
    fingerprint: 'fp',
    sourceSessionId: SOURCE_ID,
    sourceHarness: 'claude',
    sourceAgent: 'claude-main',
    sourceTeammate: 'ada',
    reason: 'the claude account is out of quota until tomorrow',
    resolvedTarget: { replacement: CODEX_ACCOUNT, coordinator: CODEX_COORDINATOR },
    planId: planIdFor(SOURCE_ID, REQUEST_ID),
    plan: transferPlan(planIdFor(SOURCE_ID, REQUEST_ID)),
    replacementSessionId: 'replacement-1',
    board: {
      boardId: BOARD_ID,
      creatorSessionId: SOURCE_ID,
      canonicalSessionId: SOURCE_ID,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    phase,
    phaseHistory: [
      { phase: 'requested', at },
      { phase, at },
    ],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

// ─── recording fakes ────────────────────────────────────────────────────────────────────────────

class FakeReceiptStore {
  readonly writes: HandoverReceipt[] = [];
  private receipts = new Map<string, HandoverReceipt>();
  /** Set to make the very next write throw, which is how a crash mid-step is simulated. */
  failNextWrite: string | null = null;

  async read(sourceSessionId: string): Promise<HandoverReceipt | null> {
    return this.receipts.get(sourceSessionId) ?? null;
  }

  /** Fires just after a write lands, so a test can move the world in an exact durable window. */
  afterWrite: ((receipt: HandoverReceipt) => void) | null = null;

  async write(receipt: HandoverReceipt): Promise<void> {
    if (this.failNextWrite !== null) {
      const reason = this.failNextWrite;
      this.failNextWrite = null;
      throw new Error(reason);
    }
    this.writes.push(receipt);
    this.receipts.set(receipt.sourceSessionId, receipt);
    this.afterWrite?.(receipt);
  }

  async pendingSourceSessionIds(): Promise<readonly string[]> {
    return [...this.receipts.values()].map(receipt => receipt.sourceSessionId);
  }

  /** Plants a receipt without recording it as a write, so a test starts mid-ladder. */
  plant(receipt: HandoverReceipt): void {
    this.receipts.set(receipt.sourceSessionId, receipt);
  }

  current(sourceSessionId = SOURCE_ID): HandoverReceipt {
    const receipt = this.receipts.get(sourceSessionId);
    if (receipt === undefined) throw new Error(`no receipt for ${sourceSessionId}`);
    return receipt;
  }

  phases(): readonly string[] {
    return this.writes.map(receipt => receipt.phase);
  }
}

class FakeSessions {
  readonly created: HandoverCreateCommand[] = [];
  readonly started: string[] = [];
  readonly stopped: { readonly sessionId: string; readonly reason: string }[] = [];
  private readonly records = new Map<string, HandoverSessionView>();
  /** Steps that should throw once, keyed `create:<id>` / `start:<id>` / `stop:<id>`. */
  readonly failures = new Set<string>();

  constructor(...views: readonly HandoverSessionView[]) {
    for (const view of views) this.records.set(view.sessionId, view);
  }

  async read(sessionId: string): Promise<HandoverSessionView | null> {
    return this.records.get(sessionId) ?? null;
  }

  async create(input: HandoverCreateCommand): Promise<void> {
    this.consume(`create:${input.sessionId}`);
    this.created.push(input);
    this.records.set(
      input.sessionId,
      sessionView({
        sessionId: input.sessionId,
        parentSessionId: input.parentSessionId,
        status: 'created',
        harness: input.account.harness,
        agent: input.account.agent,
        cwd: input.cwd,
        teammate: null,
      }),
    );
  }

  async start(sessionId: string): Promise<void> {
    this.consume(`start:${sessionId}`);
    this.started.push(sessionId);
    const record = this.records.get(sessionId);
    // A start does NOT resurrect a record that has already died; the daemon reads the status back and
    // that read is what the coordinator liveness proof depends on.
    if (record !== undefined && record.status !== 'failed' && record.status !== 'stopped') {
      this.records.set(sessionId, { ...record, status: 'running' });
    }
  }

  async stop(sessionId: string, reason: string): Promise<void> {
    this.consume(`stop:${sessionId}`);
    this.stopped.push({ sessionId, reason });
    const record = this.records.get(sessionId);
    if (record !== undefined) this.records.set(sessionId, { ...record, status: 'stopped' });
  }

  /** Rewrites a record so a test can express "the replacement died" or "it is somebody else's child". */
  set(view: HandoverSessionView): void {
    this.records.set(view.sessionId, view);
  }

  forget(sessionId: string): void {
    this.records.delete(sessionId);
  }

  private consume(key: string): void {
    if (!this.failures.has(key)) return;
    this.failures.delete(key);
    throw new Error(`${key} failed`);
  }
}

class FakeBoard implements HandoverBoardPort {
  readonly calls: { readonly step: string; readonly requestId: string }[] = [];
  readonly failures = new Set<string>();

  async requestInvitation(input: HandoverInviteCommand): Promise<{ readonly invitationRequestId: string }> {
    this.record('requestInvitation', input.requestId);
    return { invitationRequestId: `invitation-of-${input.targetSessionId}` };
  }

  async approveInvitation(input: HandoverInvitationStepCommand): Promise<void> {
    this.record('approveInvitation', input.requestId);
  }

  async acceptInvitation(input: HandoverInvitationStepCommand): Promise<{ readonly grantId: string }> {
    this.record('acceptInvitation', input.requestId);
    return { grantId: `grant-of-${input.targetSessionId}` };
  }

  async requestChildGrant(input: HandoverChildGrantCommand): Promise<{ readonly grantRequestId: string }> {
    this.record('requestChildGrant', input.requestId);
    return { grantRequestId: `child-request-of-${input.targetSessionId}` };
  }

  async approveChildGrant(input: HandoverChildGrantApproval): Promise<{ readonly grantId: string }> {
    this.record('approveChildGrant', input.requestId);
    return { grantId: `child-grant-${input.grantRequestId}` };
  }

  async replaceCoordinator(input: HandoverCoordinatorReplacement): Promise<void> {
    this.record('replaceCoordinator', input.requestId);
  }

  async relinquish(input: HandoverRelinquishCommand): Promise<void> {
    this.record('relinquish', input.requestId);
  }

  steps(): readonly string[] {
    return this.calls.map(call => call.step);
  }

  private record(step: string, requestId: string): void {
    if (this.failures.has(step)) {
      this.failures.delete(step);
      throw new Error(`${step} failed`);
    }
    this.calls.push({ step, requestId });
  }
}

class FakeBoardReader {
  membershipAnswer: HandoverBoardMembership | null = membership();
  observationAnswer: HandoverBoardObservation | null = observation();
  readonly observed: { readonly boardId: string; readonly invitationRequestId: string | undefined }[] = [];

  async membership(): Promise<HandoverBoardMembership | null> {
    return this.membershipAnswer;
  }

  async observe(boardId: string, invitationRequestId: string | undefined): Promise<HandoverBoardObservation | null> {
    this.observed.push({ boardId, invitationRequestId });
    return this.observationAnswer;
  }
}

class FakeAccounts {
  readonly resolved: string[] = [];
  failure: string | null = null;

  async resolve(agent: string): Promise<HandoverResolvedAccount> {
    if (this.failure !== null) throw new Error(this.failure);
    this.resolved.push(agent);
    if (agent === CODEX_COORDINATOR.agent) return CODEX_COORDINATOR;
    if (agent === CLAUDE_ACCOUNT.agent) return CLAUDE_ACCOUNT;
    return CODEX_ACCOUNT;
  }
}

class FakePreparer {
  readonly calls: HandoverPrepareCommand[] = [];
  /** Overrides the plan id the seam answers with, which is how plan drift is expressed. */
  planId: string | null = null;

  async prepare(input: HandoverPrepareCommand): Promise<SessionTransferPlan> {
    this.calls.push(input);
    return transferPlan(this.planId ?? planIdFor(input.sourceSessionId, input.requestId));
  }
}

class FakeImporter {
  readonly imported: { readonly planId: string; readonly sessionId: string }[] = [];
  failure: string | null = null;
  /** A NAMED, non-retryable condition, which settles the receipt rather than parking it. */
  named: HandoverFailure | null = null;

  async importPlan(plan: SessionTransferPlan, newSessionId: string): Promise<void> {
    if (this.named !== null) throw new HandoverError(this.named, `the import refused: ${this.named}`);
    if (this.failure !== null) throw new Error(this.failure);
    this.imported.push({ planId: plan.planId, sessionId: newSessionId });
  }
}

class FakePreflight {
  verdict: HandoverPreflightVerdict = { proceed: true, reason: 'no in-flight work', reportPath: null };
  readonly subjects: string[] = [];
  /** Set to make the gate THROW, which is what a real inspection of a dead pane can do. */
  failure: string | null = null;

  /** Fires after the verdict is decided, so a test can move the world in that exact window. */
  afterEvaluate: (() => void) | null = null;

  async evaluate(sessionId: string): Promise<HandoverPreflightVerdict> {
    this.subjects.push(sessionId);
    this.afterEvaluate?.();
    if (this.failure !== null) throw new Error(this.failure);
    return this.verdict;
  }
}

class FakeAttention {
  readonly raised: HandoverAttentionRequest[] = [];
  failure: string | null = null;

  async raise(input: HandoverAttentionRequest): Promise<void> {
    if (this.failure !== null) {
      this.failure = null;
      throw new Error('attention ledger unavailable');
    }
    this.raised.push(input);
  }
}

class FakeJournal {
  readonly appends: HandoverJournalAppend[] = [];
  failAfter = Number.POSITIVE_INFINITY;

  async appendOnce(input: HandoverJournalAppend): Promise<void> {
    if (this.appends.filter(entry => entry.operationId !== input.operationId).length >= this.failAfter) {
      throw new Error('journal unavailable');
    }
    // At most once per operation id: a replayed completion must not write the event twice.
    if (this.appends.some(entry => entry.operationId === input.operationId)) return;
    this.appends.push(input);
  }
}

class FakeIdentity {
  private next = 0;
  constructor(private readonly ids: readonly string[] = ['replacement-1', 'coordinator-1']) {}

  sessionId(): string {
    const id = this.ids[this.next];
    this.next += 1;
    if (id === undefined) throw new Error('the identity fake ran out of ids');
    return id;
  }
}

class FakeClock {
  private ticks = 0;
  constructor(private readonly base = Date.parse('2026-02-01T00:00:00.000Z')) {}

  now(): string {
    const at = new Date(this.base + this.ticks * 1000).toISOString();
    this.ticks += 1;
    return at;
  }

  /** Jumps the clock forward, which is how the verification deadline is crossed in a test. */
  advanceMinutes(minutes: number): void {
    this.ticks += minutes * 60;
  }
}

export interface HandoverHarness {
  readonly ports: HandoverPorts;
  readonly receipts: FakeReceiptStore;
  readonly sessions: FakeSessions;
  readonly board: FakeBoard;
  readonly boardReader: FakeBoardReader;
  readonly accounts: FakeAccounts;
  readonly preparer: FakePreparer;
  readonly importer: FakeImporter;
  readonly preflight: FakePreflight;
  readonly attention: FakeAttention;
  readonly journal: FakeJournal;
  readonly clock: FakeClock;
}

export function harness(source: HandoverSessionView = sessionView()): HandoverHarness {
  const receipts = new FakeReceiptStore();
  const sessions = new FakeSessions(source);
  const board = new FakeBoard();
  const boardReader = new FakeBoardReader();
  const accounts = new FakeAccounts();
  const preparer = new FakePreparer();
  const importer = new FakeImporter();
  const preflight = new FakePreflight();
  const attention = new FakeAttention();
  const journal = new FakeJournal();
  const clock = new FakeClock();
  const ports: HandoverPorts = {
    receipts,
    sessions,
    board,
    boardReader,
    accounts,
    preparer,
    importer,
    preflight,
    attention,
    journal,
    identity: new FakeIdentity(),
    clock,
  };
  return {
    ports,
    receipts,
    sessions,
    board,
    boardReader,
    accounts,
    preparer,
    importer,
    preflight,
    attention,
    journal,
    clock,
  };
}

/** The plan id the policy derives, restated here so a fixture can agree with it without importing it. */
export function planIdFor(sourceSessionId: string, requestId: string): string {
  return new Bun.CryptoHasher('sha256').update(JSON.stringify(['transfer', sourceSessionId, requestId])).digest('hex');
}
