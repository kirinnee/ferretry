import { describe, it } from 'bun:test';
import should from 'should';
import { NUDGE_MESSAGES, TRIAGE_CRITERIA } from '../../../src/lib/speedups/jev.ts';
import type { WardenRuntimeState } from '../../../src/lib/warden/index.ts';
import { at, enabled, harness, JEV_INVESTIGATE, JEV_SKIP, NOW, session, unattended } from './sweep-harness.ts';

/**
 * Every LLM investigation records what Jev did about its flag first — checked it and handed it on, was
 * not asked and why, or was off — and every act of that investigation carries it, so the Warden page can
 * say beside each LLM verdict whether Jev ran. Owner, 2026-10-30: "can you show Jev's results alongside
 * the LLM result, so we know Jev ran?"
 */

const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const layers = (jev: boolean, caps: Partial<ReturnType<typeof enabled>['caps']> = {}) =>
  enabled({ layers: { jev, llm: true }, caps: { ...enabled().caps, ...caps } });

/** A ferret whose one command has run 20 minutes with nothing moving. */
const stuck = () =>
  session({
    id: 's1',
    status: 'running',
    state: {
      turn: 4,
      turnState: 'working',
      startedAt: iso(NOW - 86_400_000),
      lastSubprocessAt: iso(NOW - 5_000),
      subprocessSince: iso(NOW - 20 * MINUTE),
      subprocessKey: 'pid:40',
    },
  });

const report = (verdict: string, action: string): string =>
  `Verdict: ${verdict}\n\n# Warden report — s1 (teammate :s1, -)\n\n- **Anomaly kind:** unattended_question\n\n## Summary\n- **Recommended action:** ${action}\n- **Outcome:** done\n`;

describe('what Jev did before an investigation', () => {
  it('should record the check Jev handed on, without its text, and forget it once the investigation has it', async () => {
    // Arrange
    const subject = harness({ config: layers(true), fleet: [unattended('s1')], guard: [JEV_INVESTIGATE] });

    // Act
    await subject.service.run({ force: false });
    const status = await subject.service.status();

    // Assert
    const jev = { verdict: 'handed_on', why: 'unsure', at: at(0), confidence: 0.9, costUsd: 0.001 };
    should(subject.state().investigations?.[0]).match({ targetId: 's1', origin: 'jev', jev });
    should(subject.state().investigations?.[0]?.jev).not.have.property('reason');
    should(status.investigations[0]).match({ targetSession: 's1', jev });
    should(subject.state().jevBefore ?? {}).deepEqual({});
  });

  it('should carry it onto the act the investigation’s verdict leads to', async () => {
    // Arrange: an investigation of s1, started after Jev was 21% sure, has left a NUDGE report.
    const jev = {
      verdict: 'handed_on' as const,
      why: 'unsure' as const,
      at: at(-31),
      confidence: 0.21,
      costUsd: 0.004,
    };
    const state: Partial<WardenRuntimeState> = {
      assignments: {
        s1: {
          wardenId: 'w0',
          spawnedAt: at(-30),
          capability: 'c',
          kinds: ['unattended_question'],
          reportPath: '/r.md',
        },
      },
      investigations: [
        {
          id: 'w0',
          scope: 'session',
          origin: 'jev',
          targetId: 's1',
          anomalyKind: 'unattended_question',
          startedAt: at(-30),
          reportPath: '/r.md',
          jev,
        },
      ],
    };
    const subject = harness({
      config: layers(true),
      fleet: [session({ id: 's1', status: 'running' })],
      reports: { '/r.md': report('NUDGE', 'NUDGE — it went quiet') },
      state,
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().actions?.[0]).match({ action: 'nudge', actor: 'llm', reportPath: '/r.md', jev });
  });

  it('should say the Jev layer was off', async () => {
    // Arrange
    const subject = harness({ config: layers(false), fleet: [unattended('s1')] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().investigations?.[0]?.jev).deepEqual({ verdict: 'off' });
  });

  it('should say Jev was not asked on a forced run, and when the owner asked', async () => {
    // Arrange
    const forced = harness({ config: layers(true), fleet: [unattended('s1')] });
    const asked = harness({ config: layers(true), fleet: [session({ id: 's1' })] });
    await asked.service.requestInvestigation('s1');

    // Act
    await forced.service.run({ force: true });
    await asked.service.run({ force: false });

    // Assert
    should(forced.guarded).be.empty();
    should(forced.state().investigations?.[0]?.jev).deepEqual({ verdict: 'not_asked', why: 'forced' });
    should(asked.state().investigations?.[0]?.jev).deepEqual({ verdict: 'not_asked', why: 'owner_request' });
  });

  it('should say Jev never judges a flag of this kind, on the fleet triage that looks at it', async () => {
    // Arrange: a ferret with no live monitor is a `dead_monitor`, which Jev is never asked about.
    const subject = harness({ config: layers(true), fleet: [session({ id: 's1', hasLiveMonitor: false })] });

    // Act
    await subject.service.run({ force: false });
    const status = await subject.service.status();

    // Assert
    should(subject.guarded).be.empty();
    should(subject.state().investigations?.[0]).match({
      scope: 'fleet',
      jev: { verdict: 'not_asked', why: 'not_judgeable' },
    });
    should(status.investigations[0]?.jev).deepEqual({ verdict: 'not_asked', why: 'not_judgeable' });
    should(subject.state().jevBefore).deepEqual({});
  });

  it('should give a fleet triage no single answer when Jev said different things about its flags', async () => {
    // Arrange: two dead monitors, one of which Jev was told about by an older sweep in other words.
    const subject = harness({
      config: layers(true),
      fleet: [session({ id: 's1', hasLiveMonitor: false }), session({ id: 's2', hasLiveMonitor: false })],
      // s2 was already handed on by that sweep, so this one does not look at it again.
      state: {
        passedOn: ['dead_monitor\u0000s2\u0000running'],
        jevBefore: { 's2|dead_monitor': { verdict: 'not_asked', why: 'backoff' } },
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().investigations?.[0]?.scope).equal('fleet');
    should(subject.state().investigations?.[0]).not.have.property('jev');
  });

  it('should say Jev was skipped because its cap was spent', async () => {
    // Arrange
    const subject = harness({
      config: layers(true, { jevUsdPerDay: 0.01 }),
      fleet: [unattended('s1')],
      state: { triageDay: { day: iso(NOW).slice(0, 10), flags: 0, jevDecisions: 0, jevSkips: 0, jevUsd: 0.02 } },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().investigations?.[0]?.jev).deepEqual({
      verdict: 'skipped',
      why: 'jev_cap',
      at: at(0),
      confidence: 0,
      costUsd: 0,
    });
  });

  it('should say Jev was not asked while it backed off, or when the snapshot could not be masked', async () => {
    // Arrange
    const backingOff = harness({
      config: layers(true),
      fleet: [unattended('s1')],
      state: { guard: { backoffUntil: at(5) } },
    });
    const unmasked = harness({
      config: layers(true),
      fleet: [unattended('s1')],
      redact: () => {
        throw new Error('vault damaged');
      },
    });

    // Act
    await backingOff.service.run({ force: false });
    await unmasked.service.run({ force: false });

    // Assert
    should(backingOff.state().investigations?.[0]?.jev).deepEqual({ verdict: 'not_asked', why: 'backoff' });
    should(unmasked.state().investigations?.[0]?.jev).deepEqual({ verdict: 'not_asked', why: 'unredacted' });
  });

  it('should say a failed call, and an act of Jev’s that did not settle the flag', async () => {
    // Arrange
    const failed = harness({ config: layers(true), fleet: [unattended('s1')], guard: [new Error('socket hang up')] });
    const nudge = {
      ...JEV_SKIP,
      verdict: 'nudge' as const,
      confidence: 0.93,
      reason: TRIAGE_CRITERIA.nudge,
      nudge: { id: 'stuck_command' as const, message: NUDGE_MESSAGES.stuck_command, confidence: 0.93 },
    };
    const refused = harness({ config: layers(true), fleet: [stuck()], guard: [nudge], remedyFails: 'nudge' });

    // Act
    await failed.service.run({ force: false });
    await refused.service.run({ force: false });

    // Assert
    should(failed.state().investigations?.[0]?.jev).match({ verdict: 'handed_on', why: 'failed', confidence: 0 });
    should(refused.state().investigations?.[0]?.jev).match({
      verdict: 'handed_on',
      why: 'act_failed',
      act: 'nudge',
      confidence: 0.93,
    });
  });

  it('should keep Jev’s act as why it was not asked again when the same trouble is handed on later', async () => {
    // Arrange: Jev nudged s1; the nudge had its time, and the same stuck command still stands.
    let now = NOW;
    const stuckAt = () =>
      session({
        id: 's1',
        status: 'running',
        state: {
          turn: 4,
          turnState: 'working',
          startedAt: iso(now - 86_400_000),
          lastSubprocessAt: iso(now - 5_000),
          subprocessSince: iso(now - 20 * MINUTE),
          subprocessKey: 'pid:40',
        },
      });
    const nudge = {
      ...JEV_SKIP,
      verdict: 'nudge' as const,
      confidence: 0.93,
      reason: TRIAGE_CRITERIA.nudge,
      nudge: { id: 'stuck_command' as const, message: NUDGE_MESSAGES.stuck_command, confidence: 0.93 },
    };
    const subject = harness({ config: layers(true), fleet: [stuckAt()], guard: [nudge], now: () => now });
    await subject.service.run({ force: false });

    // Act
    now += 35 * MINUTE;
    subject.setFleet([stuckAt()]);
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().investigations?.[0]?.jev).match({
      verdict: 'not_asked',
      why: 'already_acted',
      act: 'nudge',
    });
  });

  it("should still say Jev already acted when its act was made before Jev's word was kept", async () => {
    // Arrange: as above, with the record of the act lost — an act from before this daemon kept it.
    let now = NOW;
    const stuckAt = () =>
      session({
        id: 's1',
        status: 'running',
        state: {
          turn: 4,
          turnState: 'working',
          startedAt: iso(now - 86_400_000),
          lastSubprocessAt: iso(now - 5_000),
          subprocessSince: iso(now - 20 * MINUTE),
          subprocessKey: 'pid:40',
        },
      });
    const nudge = {
      ...JEV_SKIP,
      verdict: 'nudge' as const,
      confidence: 0.93,
      reason: TRIAGE_CRITERIA.nudge,
      nudge: { id: 'stuck_command' as const, message: NUDGE_MESSAGES.stuck_command, confidence: 0.93 },
    };
    const subject = harness({ config: layers(true), fleet: [stuckAt()], guard: [nudge], now: () => now });
    await subject.service.run({ force: false });
    subject.setState({ ...subject.state(), jevBefore: {} });

    // Act
    now += 35 * MINUTE;
    subject.setFleet([stuckAt()]);
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().investigations?.[0]?.jev).deepEqual({ verdict: 'not_asked', why: 'already_acted' });
  });

  it('should say there is no record for an investigation queued before Jev’s checks were kept', async () => {
    // Arrange: a flag queued by an older daemon, with Jev on now.
    const subject = harness({
      config: layers(true),
      fleet: [unattended('s1')],
      state: {
        assignedQueue: [{ kind: 'unattended_question', sessionId: 's1', status: 'awaiting_user', detail: 'x' }],
        queueMeta: { s1: { queuedAt: at(-5), origin: 'jev' } },
      },
    });

    // Act
    const status = await subject.service.status();

    // Assert
    should(status.investigations[0]).match({ state: 'queued', jev: { verdict: 'not_asked', why: 'no_record' } });
  });

  it('should forget what Jev said about a flag that went away', async () => {
    // Arrange: investigations are capped, so the flag Jev handed on waits in the queue.
    const subject = harness({
      config: layers(true, { investigationUsdPerDay: 0.01 }),
      fleet: [unattended('s1')],
      guard: [JEV_INVESTIGATE],
      state: {
        investigations: [
          { id: 'w9', scope: 'session', origin: 'sweep', startedAt: at(-60), reportPath: '/old.md', costUsd: 1 },
        ],
      },
    });
    await subject.service.run({ force: false });
    const waiting = { ...subject.state().jevBefore };

    // Act
    subject.setFleet([]);
    await subject.service.run({ force: false });

    // Assert
    should(Object.keys(waiting)).deepEqual(['s1|unattended_question']);
    should(subject.state().jevBefore).deepEqual({});
  });
});
