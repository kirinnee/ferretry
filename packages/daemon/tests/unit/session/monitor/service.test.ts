import { describe, it } from 'bun:test';
import should from 'should';
import { type ClockPort, parseSessionId, type SessionId } from '../../../../src/lib/index.ts';
import {
  defaultSessionMonitorSettings,
  type MonitorMonotonicClock,
  type MonitorNudge,
  type MonitorQuestions,
  type MonitorWaits,
  type ParkedSession,
  SessionMonitorService,
  type WaitExpiry,
  type WaitHeartbeat,
  type WaitHeartbeatSink,
} from '../../../../src/lib/session/monitor/index.ts';
import type { DeclaredWait } from '../../../../src/lib/session/signal/index.ts';

/**
 * What one tick of the declared-wait watcher actually does, and what it refuses to claim.
 *
 * The orderings are most of what is under test, and none of them is visible in the state document
 * afterwards — only in the sequence of calls the ports saw. A wake clears the record BEFORE the
 * teammate is told, a park the lock found already replaced is not announced as woken, and a tick that
 * threw does not stamp itself as having run.
 */

const ONE = parseSessionId('session-1');
const TWO = parseSessionId('session-2');
const SINCE = '2026-08-01T12:00:00.000Z';
const SINCE_MS = Date.parse(SINCE);
const SETTINGS = { ...defaultSessionMonitorSettings };

function wait(overrides: Partial<DeclaredWait> = {}): DeclaredWait {
  return { since: SINCE, ...overrides };
}

function parked(id: SessionId, overrides: Partial<ParkedSession> = {}): ParkedSession {
  return { id, status: 'waiting', waiting: wait(), ...overrides };
}

class FakeWaits implements MonitorWaits {
  readonly expired: { id: SessionId; nowMs: number; expiry: WaitExpiry }[] = [];
  readonly holds: SessionId[] = [];
  rosterError: Error | undefined;
  /** What `expire` reports having cleared. `undefined` models a park replaced under the lock. */
  cleared: DeclaredWait | undefined = wait();
  held = true;

  constructor(private roster: readonly ParkedSession[]) {}

  async parked(): Promise<readonly ParkedSession[]> {
    if (this.rosterError !== undefined) throw this.rosterError;
    return this.roster;
  }

  async expire(id: SessionId, nowMs: number, expiry: WaitExpiry): Promise<DeclaredWait | undefined> {
    this.expired.push({ id, nowMs, expiry });
    return this.cleared;
  }

  async hold(id: SessionId): Promise<boolean> {
    this.holds.push(id);
    return this.held;
  }

  set(roster: readonly ParkedSession[]): void {
    this.roster = roster;
  }
}

class FakeHeartbeats implements WaitHeartbeatSink {
  readonly published: { id: SessionId; beat: WaitHeartbeat }[] = [];
  error: Error | undefined;

  async publish(id: SessionId, beat: WaitHeartbeat): Promise<void> {
    if (this.error !== undefined) throw this.error;
    this.published.push({ id, beat });
  }
}

class FakeNudge implements MonitorNudge {
  readonly delivered: { id: SessionId; sendId: string; message: string }[] = [];

  async deliver(id: SessionId, sendId: string, message: string): Promise<void> {
    this.delivered.push({ id, sendId, message });
  }
}

class FakeQuestions implements MonitorQuestions {
  calls = 0;
  failures = new Map<string, string>();
  error: unknown;

  async reconcile(): Promise<ReadonlyMap<string, string>> {
    this.calls += 1;
    if (this.error !== undefined) throw this.error;
    return this.failures;
  }
}

class StepClock implements MonitorMonotonicClock, ClockPort {
  constructor(private elapsed = 0) {}

  elapsedMs(): number {
    return this.elapsed;
  }

  advance(by: number): void {
    this.elapsed += by;
  }

  now(): string {
    return new Date(SINCE_MS + this.elapsed).toISOString();
  }
}

function build(roster: readonly ParkedSession[], nowMs = SINCE_MS + 1_000) {
  const waits = new FakeWaits(roster);
  const heartbeats = new FakeHeartbeats();
  const nudge = new FakeNudge();
  const questions = new FakeQuestions();
  const clock = new StepClock();
  const wall = { nowMs: () => nowMs };
  const service = new SessionMonitorService(
    { waits, heartbeats, nudge, questions, clock, wallClock: { nowMs: () => wall.nowMs() }, monotonic: clock },
    SETTINGS,
  );
  return { service, waits, heartbeats, nudge, questions, clock, wall };
}

describe('one tick over the parks this daemon holds', () => {
  it('publishes a heartbeat for a live park, and only once per interval', async () => {
    const { service, heartbeats, wall } = build([parked(ONE)]);
    await service.tick();
    await service.tick();
    should(heartbeats.published.length).equal(1);
    wall.nowMs = () => SINCE_MS + 1_000 + SETTINGS.heartbeatIntervalMs;
    await service.tick();
    should(heartbeats.published.length).equal(2);
  });

  it('holds a status that drifted away from the park still on the document', async () => {
    const { service, waits } = build([parked(ONE, { status: 'running' })]);
    const report = await service.tick();
    should(waits.holds).eql([ONE]);
    should(report.held).eql([ONE]);
  });

  it('reports nothing held when the record no longer justified one', async () => {
    const { service, waits } = build([parked(ONE, { status: 'running' })]);
    waits.held = false;
    should((await service.tick()).held).be.empty();
  });

  it('clears an elapsed park and only then tells the teammate', async () => {
    const { service, waits, nudge, heartbeats } = build([parked(ONE)], SINCE_MS + SETTINGS.backstopMs);
    const report = await service.tick();
    should(report.expired).eql([ONE]);
    should(waits.expired[0]?.expiry.basis).equal('backstop');
    should(nudge.delivered).have.length(1);
    should(nudge.delivered[0]?.sendId).equal(`wake:${ONE}:${SINCE}`);
    should(nudge.delivered[0]?.message).containEql('Re-check the condition');
    // Nothing about a park that has just ended is republished as still alive.
    should(heartbeats.published).be.empty();
  });

  it('announces no wake when the lock found the park already replaced', async () => {
    const { service, waits, nudge } = build([parked(ONE)], SINCE_MS + SETTINGS.backstopMs);
    waits.cleared = undefined;
    const report = await service.tick();
    should(waits.expired).have.length(1);
    should(report.expired).be.empty();
    should(nudge.delivered).be.empty();
  });

  it('records a failure against the session it happened to, and services the rest', async () => {
    const { service, heartbeats } = build([parked(ONE), parked(TWO)]);
    heartbeats.error = new Error('checks directory is not writable');
    const report = await service.tick();
    should([...report.failures.keys()]).eql([ONE, TWO]);
    should(report.failures.get(ONE)).equal('checks directory is not writable');
    should(report.parked).equal(2);
  });

  it('counts the parks it saw and numbers its own ticks', async () => {
    const { service, clock } = build([parked(ONE), parked(TWO)]);
    service.arm();
    clock.advance(15_000);
    const first = await service.tick();
    should(first.tick).equal(1);
    should(first.sinceLastTickMs).equal(15_000);
    clock.advance(15_000);
    should((await service.tick()).tick).equal(2);
  });

  it('reports no gap before its first tick, because there is nothing to measure from', async () => {
    const { service } = build([]);
    should((await service.tick()).sinceLastTickMs).be.undefined();
  });

  it('reconciles structured-question evidence on every tick even when nothing is parked', async () => {
    const { service, questions } = build([]);

    await service.tick();
    await service.tick();

    should(questions.calls).equal(2);
  });

  it('merges per-session question failures without overwriting an earlier wait failure', async () => {
    const { service, heartbeats, questions } = build([parked(ONE), parked(TWO)]);
    heartbeats.error = new Error('heartbeat failed');
    questions.failures = new Map([
      [ONE, 'question failure hidden by the earlier failure'],
      ['session-3', 'answer ledger unreadable'],
    ]);

    const report = await service.tick();

    should(report.failures.get(ONE)).equal('heartbeat failed');
    should(report.failures.get('session-3')).equal('answer ledger unreadable');
  });

  it('treats a whole-planner question failure as a failed tick without fabricating a session id', async () => {
    const { service, questions } = build([]);
    service.arm();
    questions.error = new Error('question planner unavailable');

    await should(service.tick()).be.rejectedWith(/question planner unavailable/u);

    should(service.health()).match({ ticks: 0, consecutiveFailures: 1, lastFailure: 'question planner unavailable' });
  });
});

describe('the heartbeat marks the loop keeps in memory', () => {
  it('are pruned to the roster, so a long-lived daemon does not accumulate them', async () => {
    const { service, waits, heartbeats } = build([parked(ONE)]);
    await service.tick();
    should(heartbeats.published).have.length(1);
    // The park ends by some other route — a peer reply, `signal working` — and the session comes back
    // parked later. Its mark must have gone with it, or the new park stays silent for an interval.
    waits.set([]);
    await service.tick();
    waits.set([parked(ONE)]);
    await service.tick();
    should(heartbeats.published).have.length(2);
  });
});

describe('the loop reporting on itself, which is how a missed tick is seen at all', () => {
  it('is overdue before it is armed, rather than looking like a loop that found nothing', () => {
    const { service } = build([]);
    const health = service.health();
    should(health.armed).be.false();
    should(health.overdue).be.true();
    should(health.ticks).equal(0);
    should(health.lastTickAt).be.undefined();
  });

  it('is healthy while it keeps ticking', async () => {
    const { service, clock } = build([parked(ONE)]);
    service.arm();
    await service.tick();
    const health = service.health();
    should(health.armed).be.true();
    should(health.overdue).be.false();
    should(health.parked).equal(1);
    should(health.lastTickAt).equal(clock.now());
  });

  it('goes overdue when the ticks stop, without anything having to notice', async () => {
    const { service, clock } = build([parked(ONE)]);
    service.arm();
    await service.tick();
    clock.advance(SETTINGS.tickIntervalMs + SETTINGS.tickGraceMs + 1);
    should(service.health().overdue).be.true();
    should(service.health().sinceLastTickMs).equal(SETTINGS.tickIntervalMs + SETTINGS.tickGraceMs + 1);
  });

  it('does not stamp a tick that failed as one that ran', async () => {
    const { service, waits, clock } = build([parked(ONE)]);
    service.arm();
    await service.tick();
    const stamped = service.health().lastTickAt;
    waits.rosterError = new Error('the session index is unreadable');
    clock.advance(60_000);
    await service.tick().should.be.rejectedWith('the session index is unreadable');
    const health = service.health();
    should(health.lastTickAt).equal(stamped);
    should(health.consecutiveFailures).equal(1);
    should(health.lastFailure).equal('the session index is unreadable');
    should(health.overdue).be.true();
  });

  it('clears the failure streak once a tick completes again', async () => {
    const { service, waits } = build([]);
    waits.rosterError = new Error('transient');
    await service.tick().should.be.rejected();
    waits.rosterError = undefined;
    await service.tick();
    should(service.health().consecutiveFailures).equal(0);
    should(service.health().lastFailure).be.undefined();
  });

  it('reports a disarmed loop as disarmed and forgets the heartbeat marks it held', async () => {
    const { service, heartbeats } = build([parked(ONE)]);
    service.arm();
    await service.tick();
    service.disarm();
    should(service.armed).be.false();
    should(service.health().overdue).be.true();
    await service.tick();
    should(heartbeats.published).have.length(2);
  });

  it('reports a non-Error failure as its own text', async () => {
    const { service, waits } = build([]);
    waits.rosterError = 'the index vanished' as unknown as Error;
    await service.tick().should.be.rejected();
    should(service.health().lastFailure).equal('the index vanished');
  });
});
