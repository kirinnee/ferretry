import { describe, it } from 'bun:test';
import { DEFAULT_WARDEN_CONFIG, DEFAULT_WARDEN_JEV_ACTS, type WardenMayActAlone } from '@ferretry/protocol';
import should from 'should';
import {
  NUDGE_MESSAGES,
  TRIAGE_CRITERIA,
  TRIAGE_VERDICTS,
  type TriageDecision,
  type TriageVerdict,
} from '../../../src/lib/speedups/jev.ts';
import {
  firstResponse,
  JEV_ACT_GRACE_FLOOR_MS,
  BACKOFF_CEILING_MS,
  JEV_ACTS_BY_KIND,
  type JevResponderPolicy,
  jevActLandingOn,
  jevActStanding,
  jevActsFor,
  jevRoute,
  jevSubject,
  recordJevAct,
  reconcileBackoff,
  recordLook,
  retractJevAction,
  type WardenAnomaly,
} from '../../../src/lib/warden/index.ts';

/**
 * Jev as the Warden's first responder — the decision table every flag goes through, and the one-try
 * rule. Every row is the owner's concept made checkable: a confident Jev acts at once, through the
 * same remedies; anything short of that — unsure, not sure enough, not allowed alone, any failure —
 * goes to an investigation when that layer is on, and to the owner when it is off.
 */

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const MINUTE = 60_000;

const POLICY: JevResponderPolicy = {
  leaveThreshold: DEFAULT_WARDEN_CONFIG.guard.threshold,
  acts: DEFAULT_WARDEN_JEV_ACTS,
  mayActAlone: DEFAULT_WARDEN_CONFIG.mayActAlone,
  offered: ['nudge', 'resume', 'restart', 'failover', 'stop'],
};

const decision = (verdict: TriageVerdict, confidence: number, extra: Partial<TriageDecision> = {}): TriageDecision => ({
  verdict,
  confidence,
  reason: TRIAGE_CRITERIA[verdict],
  model: 'jev-latest',
  inputTokens: 400,
  latencyMs: 80,
  ...(verdict === 'nudge' ? { nudge: { id: 'stuck_command', message: NUDGE_MESSAGES.stuck_command, confidence } } : {}),
  ...extra,
});

const allowing = (allowed: boolean): WardenMayActAlone => ({
  nudge: allowed,
  resume: allowed,
  restart: allowed,
  failover: allowed,
  stop: allowed,
  closeLeftovers: true,
});

/** The bar an answer is held to: the leave bar for `leave`, the act's own for an act, none otherwise. */
const barOf = (verdict: TriageVerdict, policy: JevResponderPolicy): number | undefined => {
  if (verdict === 'leave') return policy.leaveThreshold;
  if (verdict === 'unsure' || verdict === 'failover') return undefined;
  return policy.acts[verdict];
};

describe('the first responder’s decision table', () => {
  // Every verdict × (just under | at its bar) × may act alone (on | off) × the LLM layer (on | off).
  const rows = TRIAGE_VERDICTS.flatMap(verdict =>
    (['under', 'at'] as const).flatMap(confidence =>
      [true, false].flatMap(allowed => [true, false].map(llm => ({ verdict, confidence, allowed, llm }))),
    ),
  );

  it.each(rows)('$verdict, $confidence its bar, alone=$allowed, llm=$llm', ({ verdict, confidence, allowed, llm }) => {
    // Arrange
    const policy = { ...POLICY, mayActAlone: allowing(allowed) };
    const bar = barOf(verdict, policy) ?? policy.leaveThreshold;
    const sure = confidence === 'at' ? bar : bar - 0.01;

    // Act
    const outcome = firstResponse(decision(verdict, sure), policy);
    const route = jevRoute(outcome, llm);

    // Assert — the owner's rules, stated directly.
    const escalation = llm ? 'investigation' : 'owner';
    if (verdict === 'leave') should(route).equal(confidence === 'at' ? 'leave' : escalation);
    else if (verdict === 'unsure' || verdict === 'failover') should(route).equal(escalation);
    else should(route).equal(confidence === 'at' && allowed ? 'act' : escalation);
  });

  it.each([
    'not_set',
    'vault_damaged',
    'misconfigured',
    'rejected',
    'invalid_request',
    'too_large',
    'rate_limited',
    'overloaded',
    'provider_error',
    'timeout',
    'unreachable',
    'malformed',
  ] as const)('should hand on a %s failure, never act on it', code => {
    // Act — even a failure that somehow carried a confident act.
    const outcome = firstResponse(decision('stop', 1, { failure: { code } }), {
      ...POLICY,
      mayActAlone: allowing(true),
    });

    // Assert
    should(outcome).deepEqual({ kind: 'escalate', why: 'failed', confidence: 0, failure: code });
    should(jevRoute(outcome, true)).equal('investigation');
    should(jevRoute(outcome, false)).equal('owner');
  });

  it('should act at its own bar: a confident nudge is carried out with the message Jev chose', () => {
    // Act
    const outcome = firstResponse(decision('nudge', 0.9), POLICY);

    // Assert
    should(outcome).deepEqual({
      kind: 'act',
      act: 'nudge',
      confidence: 0.9,
      reason: TRIAGE_CRITERIA.nudge,
      message: NUDGE_MESSAGES.stuck_command,
    });
  });

  it('should ask more of a riskier act: sure enough to nudge is not sure enough to restart', () => {
    // Act
    const nudge = firstResponse(decision('nudge', 0.92), POLICY);
    const restart = firstResponse(decision('restart', 0.92), POLICY);

    // Assert
    should(nudge.kind).equal('act');
    should(restart).match({ kind: 'escalate', why: 'not_sure_enough' });
    should(restart).not.have.property('recommends');
  });

  it('should hold a confident stop for the owner by default: stop is not something the Warden may do alone', () => {
    // Act
    const outcome = firstResponse(decision('stop', 0.99), POLICY);

    // Assert
    should(outcome).deepEqual({
      kind: 'escalate',
      why: 'not_allowed',
      confidence: 0.99,
      recommends: 'stop',
      reason: TRIAGE_CRITERIA.stop,
    });
  });

  it('should never act alone at a bar of 1, however sure, but still recommend what it was sure of', () => {
    // Arrange
    const policy = { ...POLICY, acts: { ...POLICY.acts, nudge: 1 }, mayActAlone: allowing(true) };

    // Act
    const sure = firstResponse(decision('nudge', 1), policy);
    const vague = firstResponse(decision('nudge', 0.5), policy);

    // Assert
    should(sure).match({ kind: 'escalate', why: 'never_alone', recommends: 'nudge' });
    should(vague).match({ kind: 'escalate', why: 'not_sure_enough' });
    should(vague).not.have.property('recommends');
  });

  it('should never fail over alone — Jev cannot name the login — but recommend it when sure', () => {
    // Act
    const outcome = firstResponse(decision('failover', 0.99), { ...POLICY, mayActAlone: allowing(true) });

    // Assert
    should(outcome).match({ kind: 'escalate', why: 'cannot_choose_login', recommends: 'failover' });
  });

  it('should not nudge without a message Jev chose just as surely', () => {
    // Arrange
    const sure = 0.95;

    // Act
    const none = firstResponse(decision('nudge', sure, { nudge: undefined }), POLICY);
    const weak = firstResponse(
      decision('nudge', sure, { nudge: { id: 'lost_track', message: NUDGE_MESSAGES.lost_track, confidence: 0.6 } }),
      POLICY,
    );

    // Assert
    should(none).match({ kind: 'escalate', why: 'no_message' });
    should(weak).match({ kind: 'escalate', why: 'no_message' });
    should(none).not.have.property('recommends');
  });

  it('should leave at the leave bar, and hand on a leave it was not sure of', () => {
    // Act / Assert
    should(firstResponse(decision('leave', 0.85), POLICY)).match({ kind: 'leave', confidence: 0.85 });
    should(firstResponse(decision('leave', 0.84), POLICY)).match({ kind: 'escalate', why: 'not_sure_enough' });
    should(firstResponse(decision('unsure', 0.99), POLICY)).match({ kind: 'escalate', why: 'unsure' });
  });
});

describe('what Jev is offered', () => {
  it('should offer no act on a question waiting for the owner, nor on a flag about several ferrets', () => {
    // Act / Assert
    should(jevActsFor({ kind: 'unattended_question' })).deepEqual([]);
    should(jevActsFor({ kind: 'sus_subprocess', affectedSessionIds: ['a', 'b'] })).deepEqual([]);
    should(jevActsFor({ kind: 'dead_monitor', fleetKey: 'daemon:no-monitor-subsystem' })).deepEqual([]);
    should(jevActsFor({ kind: 'owner_request' })).deepEqual([]);
  });

  it('should offer the acts that fit a stuck ferret, and resume only to one whose quota came back', () => {
    // Act / Assert
    should(jevActsFor({ kind: 'sus_subprocess' })).deepEqual(['nudge', 'restart', 'stop']);
    should(jevActsFor({ kind: 'quota_reset_passed' })).deepEqual(['resume']);
    should(Object.values(JEV_ACTS_BY_KIND).flat().includes('resume')).be.true();
  });
});

describe('Jev’s one try', () => {
  const flag = (subject: string | undefined, kind: WardenAnomaly['kind'] = 'sus_subprocess'): WardenAnomaly => ({
    kind,
    sessionId: 's1',
    status: 'running',
    detail: 'stuck',
    since: '2026-10-29T11:00:00.000Z',
    ...(subject === undefined ? {} : { subject }),
  });
  const BASE = 30 * MINUTE;

  it('should give an act its rung to land, then hand the same subject on instead of trying again', () => {
    // Arrange
    const store = recordJevAct({}, flag('pid:40'), NOW, 'nudge', BASE);

    // Act
    const landing = jevActStanding(store, flag('pid:40'), NOW + 29 * MINUTE);
    const after = jevActStanding(store, flag('pid:40'), NOW + 30 * MINUTE);

    // Assert
    should(landing).deepEqual({ standing: 'landing', action: 'nudge' });
    should(after).deepEqual({ standing: 'escalate', action: 'nudge' });
  });

  it('should hand on a NEW subject of the same trouble within a day — an act changes the subject itself', () => {
    // Arrange
    const store = recordJevAct({}, flag('turn:4'), NOW, 'nudge', BASE);

    // Act
    const soon = jevActStanding(store, flag('turn:5'), NOW + 2 * 60 * MINUTE);
    const nextDay = jevActStanding(store, flag('turn:9'), NOW + BACKOFF_CEILING_MS);
    const sameNextDay = jevActStanding(store, flag('turn:4'), NOW + BACKOFF_CEILING_MS);

    // Assert
    should(soon).deepEqual({ standing: 'escalate', action: 'nudge' });
    should(nextDay).be.undefined();
    should(sameNextDay).deepEqual({ standing: 'escalate', action: 'nudge' });
  });

  it('should hold every other kind of flag on the same ferret while an act lands, and no other ferret', () => {
    // Arrange
    const store = recordJevAct({}, flag('pid:40'), NOW, 'nudge', BASE);

    // Act / Assert
    should(jevActLandingOn(store, 's1', NOW + MINUTE)).be.true();
    should(jevActLandingOn(store, 's2', NOW + MINUTE)).be.false();
    should(jevActStanding(store, flag('turn:4', 'sus_thinking'), NOW + MINUTE)).deepEqual({ standing: 'landing' });
    should(jevActStanding(store, flag('turn:4', 'sus_thinking'), NOW + BASE)).be.undefined();
  });

  it('should give an act at least ten minutes even when the owner set no cooldown, and the rung it holds otherwise', () => {
    // Arrange
    const quick = recordJevAct({}, flag('pid:40'), NOW, 'restart', 0);
    const looked = recordLook({}, { sessionId: 's1', kind: 'sus_subprocess', subject: 'pid:40' }, NOW, false);
    const second = recordJevAct(looked, flag('pid:40'), NOW, 'nudge', BASE);

    // Act / Assert
    should(jevActStanding(quick, flag('pid:40'), NOW + JEV_ACT_GRACE_FLOOR_MS - 1)?.standing).equal('landing');
    should(jevActStanding(quick, flag('pid:40'), NOW + JEV_ACT_GRACE_FLOOR_MS)?.standing).equal('escalate');
    // A second look at the subject holds it for 2 h, so the act lands for the same 2 h — the hold and
    // the landing end together.
    should(jevActStanding(second, flag('pid:40'), NOW + 119 * MINUTE)?.standing).equal('landing');
    should(jevActStanding(second, flag('pid:40'), NOW + 120 * MINUTE)?.standing).equal('escalate');
  });

  it('should count the act as a look and keep it through later looks, on any subject', () => {
    // Arrange
    const acted = recordJevAct({}, flag('pid:40'), NOW, 'nudge', BASE);

    // Act
    const looked = recordLook(
      acted,
      { sessionId: 's1', kind: 'sus_subprocess', subject: 'pid:40' },
      NOW + MINUTE,
      false,
    );
    const moved = recordLook(
      acted,
      { sessionId: 's1', kind: 'sus_subprocess', subject: 'pid:99' },
      NOW + MINUTE,
      false,
    );

    // Assert
    should(acted['s1|sus_subprocess']).match({ count: 1, subject: 'pid:40' });
    should(looked['s1|sus_subprocess']?.count).equal(2);
    should(looked['s1|sus_subprocess']?.jevActed).match({ action: 'nudge', subject: 'pid:40' });
    should(moved['s1|sus_subprocess']?.jevActed).match({ action: 'nudge', subject: 'pid:40' });
  });

  it('should remember an act for as long as its ferret lives, past the usual two days', () => {
    // Arrange
    const acted = recordJevAct({}, flag('pid:40'), NOW, 'nudge', BASE);
    const plain = recordLook({}, { sessionId: 's1', kind: 'sus_thinking', subject: 'turn:4' }, NOW, false);
    const later = NOW + 3 * BACKOFF_CEILING_MS;

    // Act
    const kept = reconcileBackoff({ ...acted, ...plain }, new Set(['s1']), later);
    const gone = reconcileBackoff(acted, new Set(), later);

    // Assert
    should(Object.keys(kept)).deepEqual(['s1|sus_subprocess']);
    should(gone).deepEqual({});
  });

  it('should count against the status and episode when a flag has no subject of its own', () => {
    // Arrange
    const store = recordJevAct({}, flag(undefined), NOW, 'nudge', 0);

    // Act / Assert
    should(jevSubject(flag(undefined))).equal('running@2026-10-29T11:00:00.000Z');
    should(jevActStanding(store, flag(undefined), NOW + MINUTE)?.standing).equal('landing');
  });
});

describe('taking an act back out of the savings', () => {
  it('should take back an act counted today, and nothing from another day or an empty count', () => {
    // Arrange
    const today = { day: '2026-10-29', flags: 2, jevDecisions: 2, jevSkips: 0, jevActions: 1, jevUsd: 0.01 };

    // Act / Assert
    should(retractJevAction(today, NOW).jevActions).equal(0);
    should(retractJevAction(today, NOW - BACKOFF_CEILING_MS)).equal(today);
    should(retractJevAction(today, undefined)).equal(today);
    should(retractJevAction({ ...today, jevActions: 0 }, NOW).jevActions).equal(0);
  });
});

describe('an act that was not offered', () => {
  it('should never be carried out, however sure Jev was and whatever the owner allows', () => {
    // Arrange
    const policy = { ...POLICY, mayActAlone: allowing(true), offered: [] };

    // Act
    const outcome = firstResponse(decision('restart', 1), policy);

    // Assert
    should(outcome).match({ kind: 'escalate', why: 'not_offered', confidence: 1 });
    should(outcome).not.have.property('recommends');
    should(firstResponse(decision('leave', 0.9), policy).kind).equal('leave');
  });
});
