import { describe, it } from 'bun:test';
import should from 'should';
import { parseSessionId } from '../../../../src/lib/index.ts';
import {
  defaultSessionMonitorSettings,
  heartbeatDue,
  parseSessionMonitorSettings,
  planWaitTick,
  tickOverdue,
  waitDeadline,
  waitExpiry,
  waitHeartbeat,
  wakeSendId,
  type ParkedSession,
  type SessionMonitorSettings,
} from '../../../../src/lib/session/monitor/index.ts';
import type { DeclaredWait } from '../../../../src/lib/session/signal/index.ts';

/**
 * The two properties a wait tick must have, proved without a clock or a filesystem.
 *
 * A PARK ALWAYS ENDS — with a declared deadline, with none, and with timestamps that will not parse
 * at all. The third is the one worth having a test for: a park whose evidence is damaged has no
 * deadline to compute, and treating that as "not elapsed yet" would leave supervision switched off
 * indefinitely on the strength of a record nobody could read.
 *
 * A HEARTBEAT IS NOT A TICK. It publishes on its own much longer interval, so proving the tick ran is
 * separate from proving the park is alive.
 */

const ID = parseSessionId('session-1');
const SINCE = '2026-08-01T12:00:00.000Z';
const SINCE_MS = Date.parse(SINCE);
const SETTINGS: SessionMonitorSettings = { ...defaultSessionMonitorSettings, backstopMs: 4 * 60 * 60_000 };

function wait(overrides: Partial<DeclaredWait> = {}): DeclaredWait {
  return { since: SINCE, ...overrides };
}

function parked(overrides: Partial<ParkedSession> = {}): ParkedSession {
  return { id: ID, status: 'waiting', waiting: wait(), ...overrides };
}

describe('the settings the monitor slice owns', () => {
  it('parses a complete settings document', () => {
    should(parseSessionMonitorSettings({ ...defaultSessionMonitorSettings })).eql(defaultSessionMonitorSettings);
  });

  it('refuses a tick interval that would never fire', () => {
    should(() => parseSessionMonitorSettings({ ...defaultSessionMonitorSettings, tickIntervalMs: 0 })).throw();
  });
});

describe('when a park ends, and on whose authority', () => {
  it('honours the deadline the teammate declared', () => {
    const until = new Date(SINCE_MS + 60_000).toISOString();
    should(waitDeadline(wait({ until }), SETTINGS)).eql({ atMs: Date.parse(until), basis: 'declared' });
  });

  it('ends an open-ended park at the backstop measured from when it was declared', () => {
    should(waitDeadline(wait(), SETTINGS)).eql({ atMs: SINCE_MS + SETTINGS.backstopMs, basis: 'backstop' });
  });

  it('establishes no deadline at all when the park will not parse', () => {
    should(waitDeadline(wait({ since: 'the other day' }), SETTINGS)).eql({ basis: 'unreadable' });
  });
});

describe('the account a wake carries', () => {
  it('names the condition the teammate gave', () => {
    const expiry = waitExpiry(wait({ condition: 'CI to go green' }), { atMs: SINCE_MS, basis: 'declared' }, SINCE_MS);
    should(expiry.reason).equal('declared wait elapsed (CI to go green)');
    should(expiry.nudge).containEql('CI to go green');
  });

  it('names the peer when the park was on a reply rather than a condition', () => {
    const expiry = waitExpiry(
      wait({ peer: 'session-2', peerName: 'loge' }),
      { atMs: SINCE_MS, basis: 'backstop' },
      SINCE_MS,
    );
    should(expiry.reason).equal('open-ended wait hit the backstop (a reply from loge)');
  });

  it('falls back to the peer id when the peer had no callsign', () => {
    const expiry = waitExpiry(wait({ peer: 'session-2' }), { atMs: SINCE_MS, basis: 'backstop' }, SINCE_MS);
    should(expiry.reason).containEql('a reply from session-2');
  });

  it('says so plainly when there was no condition to name', () => {
    const expiry = waitExpiry(wait(), { atMs: SINCE_MS, basis: 'backstop' }, SINCE_MS);
    should(expiry.reason).containEql('no condition given');
  });

  it('states that the park was unreadable rather than that it elapsed', () => {
    const expiry = waitExpiry(wait({ since: 'nonsense' }), { basis: 'unreadable' }, SINCE_MS);
    should(expiry.basis).equal('unreadable');
    should(expiry.reason).containEql('unreadable timestamps');
    // A credit is a concession against the turn ceiling, so an unreadable start earns none.
    should(expiry.elapsedSeconds).equal(0);
  });

  it('measures how long the park actually lasted', () => {
    should(waitExpiry(wait(), { atMs: SINCE_MS, basis: 'backstop' }, SINCE_MS + 90_000).elapsedSeconds).equal(90);
  });
});

describe('the heartbeat a live park publishes', () => {
  it('carries the deadline it will be woken at, so a stale file is visibly a missed wake', () => {
    const until = new Date(SINCE_MS + 600_000).toISOString();
    const beat = waitHeartbeat(
      wait({ until, condition: 'the deploy' }),
      { atMs: SINCE_MS + 600_000, basis: 'declared' },
      SINCE_MS + 60_000,
    );
    should(beat).eql({
      at: new Date(SINCE_MS + 60_000).toISOString(),
      since: SINCE,
      until,
      condition: 'the deploy',
      elapsedSeconds: 60,
      expiresAt: until,
      remainingSeconds: 540,
    });
  });

  it('publishes no deadline when none could be established', () => {
    const beat = waitHeartbeat(wait(), { basis: 'unreadable' }, SINCE_MS);
    should(beat.expiresAt).be.undefined();
    should(beat.remainingSeconds).be.undefined();
  });

  it('never reports negative time remaining', () => {
    const beat = waitHeartbeat(wait(), { atMs: SINCE_MS, basis: 'declared' }, SINCE_MS + 5_000);
    should(beat.remainingSeconds).equal(0);
  });
});

describe('whether this tick republishes a heartbeat', () => {
  it('publishes for a park it has never published for', () => {
    should(heartbeatDue(undefined, SINCE_MS, SETTINGS)).be.true();
  });

  it('waits out the interval', () => {
    should(heartbeatDue(SINCE_MS, SINCE_MS + 1_000, SETTINGS)).be.false();
    should(heartbeatDue(SINCE_MS, SINCE_MS + SETTINGS.heartbeatIntervalMs, SETTINGS)).be.true();
  });

  it('republishes when the mark is in the future, rather than going silent for the size of the step', () => {
    should(heartbeatDue(SINCE_MS + 60_000, SINCE_MS, SETTINGS)).be.true();
  });
});

describe('what one tick does about one parked session', () => {
  it('ends a park whose declared deadline has passed, and does nothing else', () => {
    const until = new Date(SINCE_MS + 60_000).toISOString();
    const plan = planWaitTick(parked({ waiting: wait({ until }) }), undefined, SINCE_MS + 60_000, SETTINGS);
    should(plan.expiry?.basis).equal('declared');
    should(plan.hold).be.false();
    should(plan.heartbeat).be.undefined();
  });

  it('ends a park whose timestamps are damaged, rather than holding it open forever', () => {
    const plan = planWaitTick(parked({ waiting: wait({ since: 'whenever' }) }), undefined, SINCE_MS, SETTINGS);
    should(plan.expiry?.basis).equal('unreadable');
  });

  it('holds a status that has drifted away from the park still on the document', () => {
    const plan = planWaitTick(parked({ status: 'running' }), SINCE_MS, SINCE_MS + 1_000, SETTINGS);
    should(plan.hold).be.true();
    should(plan.heartbeat).be.undefined();
  });

  it('never writes over a verdict another path already reached', () => {
    should(planWaitTick(parked({ status: 'stopped' }), SINCE_MS, SINCE_MS + 1_000, SETTINGS).hold).be.false();
  });

  it('leaves an already-waiting status alone and publishes the due heartbeat', () => {
    const plan = planWaitTick(parked(), undefined, SINCE_MS + 1_000, SETTINGS);
    should(plan.hold).be.false();
    should(plan.heartbeat?.elapsedSeconds).equal(1);
  });
});

describe('the loop reporting on itself', () => {
  it('is not overdue while it is merely a little late', () => {
    should(tickOverdue(SETTINGS.tickIntervalMs + SETTINGS.tickGraceMs, SETTINGS)).be.false();
  });

  it('is overdue once it has missed a whole interval plus its grace', () => {
    should(tickOverdue(SETTINGS.tickIntervalMs + SETTINGS.tickGraceMs + 1, SETTINGS)).be.true();
  });
});

describe('the key a wake nudge is sent under', () => {
  it('is derived from the park, so a retried wake is the same send', () => {
    should(wakeSendId(ID, wait())).equal(`wake:${ID}:${SINCE}`);
  });
});
