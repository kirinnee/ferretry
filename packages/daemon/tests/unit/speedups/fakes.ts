import type {
  AuthorizedOutcome,
  CredentialPlacement,
  JevJudgement,
  JevQuestionSet,
  OutboundAuthorizerPort,
  OutboundHttpRequest,
  OutboundOutcome,
  OutboundTransport,
  SecretNameSource,
  SecretValueSource,
  SpeedupClockPort,
  SpeedupTestLedgerPort,
  TriageDecision,
  TriageGuardPort,
  TriageSnapshot,
} from '../../../src/lib/index.ts';

/**
 * Test doubles for every speed-up port. NONE OF THEM TOUCHES THE NETWORK: a Test button never makes
 * a real call in CI. `ScriptedTriageGuard` is the fake the Warden's own tests answer the guard with.
 */

/** A transport that records every request it was handed — credential included, which is the point. */
export class RecordingTransport implements OutboundTransport {
  readonly sent: OutboundHttpRequest[] = [];

  constructor(private readonly outcome: OutboundOutcome = { kind: 'completion', payload: { ok: true } }) {}

  async send(request: OutboundHttpRequest): Promise<OutboundOutcome> {
    this.sent.push(request);
    return this.outcome;
  }
}

/** A vault opening a fixed map, or raising whatever it was told to. */
export class FixedVault implements SecretValueSource {
  opened = 0;

  constructor(private readonly entries: Readonly<Record<string, string>> | Error = {}) {}

  async values(): Promise<ReadonlyMap<string, string>> {
    this.opened += 1;
    if (this.entries instanceof Error) throw this.entries;
    return new Map(Object.entries(this.entries));
  }
}

export interface AuthorizerCall {
  readonly secretName: string;
  readonly hosts: readonly string[];
  readonly request: OutboundHttpRequest;
  readonly placement?: CredentialPlacement;
}

/** The outbound holder, answered from a script. It never holds a value. */
export class ScriptedAuthorizer implements OutboundAuthorizerPort {
  readonly calls: AuthorizerCall[] = [];

  constructor(private readonly outcome: AuthorizedOutcome) {}

  async send(
    secretName: string,
    hosts: readonly string[],
    request: OutboundHttpRequest,
    placement?: CredentialPlacement,
  ): Promise<AuthorizedOutcome> {
    this.calls.push({ secretName, hosts, request, ...(placement === undefined ? {} : { placement }) });
    return this.outcome;
  }
}

/** A guard that answers every snapshot with one decision and remembers what it was shown. */
export class ScriptedTriageGuard implements TriageGuardPort {
  readonly seen: TriageSnapshot[] = [];

  constructor(
    private readonly decision: TriageDecision = {
      verdict: 'leave',
      confidence: 0.95,
      model: 'jev-latest',
      inputTokens: 120,
      latencyMs: 80,
    },
  ) {}

  async decide(snapshot: TriageSnapshot): Promise<TriageDecision> {
    this.seen.push(snapshot);
    return this.decision;
  }

  /** A connection Test never judges: a call here is a test that reached the wrong method. */
  async judge(set: JevQuestionSet): Promise<JevJudgement> {
    this.seen.push(set.snapshot);
    throw new Error('ScriptedTriageGuard does not judge');
  }
}

export class MemoryLedger implements SpeedupTestLedgerPort {
  writes: unknown[] = [];

  constructor(public document: unknown = undefined) {}

  async read(): Promise<unknown> {
    return this.document;
  }

  async write(document: unknown): Promise<void> {
    this.writes.push(document);
    this.document = document;
  }
}

export class FixedSecretNames implements SecretNameSource {
  constructor(private readonly entries: readonly { name: string; updatedAt: string }[] | Error = []) {}

  async list(): Promise<readonly { name: string; updatedAt: string }[]> {
    if (this.entries instanceof Error) throw this.entries;
    return this.entries;
  }
}

/** Monotonic readings consumed in order, and a fixed wall-clock instant. */
export class SteppingClock implements SpeedupClockPort {
  private readonly readings: number[];

  constructor(
    readings: readonly number[] = [1_000, 1_150],
    private readonly instant = '2026-10-16T10:00:00.000Z',
  ) {
    this.readings = [...readings];
  }

  monotonicMs(): number {
    return this.readings.shift() ?? 0;
  }

  now(): string {
    return this.instant;
  }
}
