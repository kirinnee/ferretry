import { describe, it } from 'bun:test';
import should from 'should';
import { JEV_FACT_NODES } from '../../../src/lib/warden/index.ts';
import { enabled, harness, JEV_INVESTIGATE, NOW, no, session, triageable, unattended, yes } from './sweep-harness.ts';

/**
 * The sweep asks Jev the decision tree's questions (`jev-tree.ts`): the daemon answers every fact itself,
 * Jev is sent only the yes/no judgements the facts left open — one call per flag, inside the daily and
 * hourly caps — and what Jev was not sure of reaches the owner as that one question.
 */

const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const layers = (llm: boolean, caps: Partial<ReturnType<typeof enabled>['caps']> = {}) =>
  enabled({ layers: { jev: true, llm }, caps: { ...enabled().caps, ...caps } });

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

describe('what the sweep asks Jev', () => {
  it('should never send a fact node: the daemon answered it, and shows Jev the answer', async () => {
    // Arrange
    const subject = harness({ config: layers(true), fleet: [stuck()], guard: [JEV_INVESTIGATE] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.judged).have.length(1);
    const ids = subject.judged[0]?.questions.map(question => question.id) ?? [];
    should(ids).deepEqual(['waiting_on_real', 'wait_reasonable']);
    for (const fact of JEV_FACT_NODES) should(ids).not.containEql(fact);
    should(subject.judged[0]?.snapshot.facts).match({
      programRunning: true,
      outputChangedLately: false,
      dialogOnScreen: false,
      subprocessRunningMinutes: 20,
    });
    // No list of acts to choose from, and the messages are those of the one nudge the path can reach.
    should(subject.judged[0]?.snapshot.acts ?? []).be.empty();
    should(subject.judged[0]?.nudgeMessages).deepEqual(['stuck_command', 'wait_overdue', 'peer_gone', 'poll_loop']);
  });

  it('should ask a ferret parked on its quota only whether it finished on purpose, with no message', async () => {
    // Arrange
    const subject = harness({ config: layers(true), fleet: [triageable('q1')], guard: [JEV_INVESTIGATE] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.judged.map(set => set.questions.map(question => question.id))).deepEqual([['finished_on_purpose']]);
    should(subject.judged[0]).not.have.property('nudgeMessages');
  });

  it('should offer no message for a flag that offers no nudge', async () => {
    // Arrange: an unanswered question offers Jev no act at all.
    const subject = harness({ config: layers(true), fleet: [unattended('s1')], guard: [JEV_INVESTIGATE] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.judged[0]?.questions.map(question => question.id)).deepEqual(['waiting_on_real', 'wait_reasonable']);
    should(subject.judged[0]).not.have.property('nudgeMessages');
  });
});

describe('the caps, with the tree', () => {
  it('should make one call per flag, and none once the day’s cap is spent', async () => {
    // Arrange: the first call spends the whole day.
    const subject = harness({
      config: layers(true, { jevUsdPerDay: 0.01 }),
      fleet: [unattended('s1'), unattended('s2')],
      guard: [{ ...JEV_INVESTIGATE, costUsd: 0.02 }],
    });

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert
    should(subject.judged).have.length(1);
    should(subject.state().triageDay?.jevUsd).equal(0.02);
  });

  it('should make no call at all while this hour’s share of the cap is spent', async () => {
    // Arrange
    const subject = harness({
      config: layers(false, { jevUsdPerDay: 1 }),
      fleet: [stuck()],
      state: {
        triageDay: {
          day: iso(NOW).slice(0, 10),
          flags: 0,
          jevDecisions: 0,
          jevSkips: 0,
          jevUsd: 0.3,
          jevHour: iso(NOW).slice(0, 13),
          jevHourUsd: 0.3,
        },
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.judged).be.empty();
    should(subject.jevChecks).match([{ verdict: 'skipped', why: 'jev_paced' }]);
  });
});

describe('a question Jev was not sure of', () => {
  it('should reach the owner as that question, with the path, when no investigation follows', async () => {
    // Arrange: sure it waits on the command, not sure the wait has gone on too long.
    const subject = harness({
      config: layers(false),
      fleet: [stuck()],
      guard: [{ answers: { waiting_on_real: yes(0.96), wait_reasonable: no(0.58) } }],
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.remedies).be.empty();
    should(subject.jevChecks[0]).match({ verdict: 'handed_on', why: 'not_sure_enough', node: 'wait_reasonable' });
    should(subject.state().jevHandoffs?.['s1|sus_subprocess']).match({
      why: 'not_sure_enough',
      node: 'wait_reasonable',
      confidence: 0.58,
    });
    const card = subject.raises.at(-1)?.request;
    should(card?.why).equal(
      'Jev could not answer “Is the wait still reasonable?” surely enough (58% sure, below your bar).',
    );
    should(JSON.stringify(card)).containEql(
      'What the daemon saw: Is the agent program running: yes; Has its output changed lately: no.',
    );
  });

  it('should carry the node and path onto the investigation that follows', async () => {
    // Arrange
    const subject = harness({
      config: layers(true),
      fleet: [stuck()],
      guard: [{ answers: { waiting_on_real: no(0.7) } }],
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().investigations?.[0]?.jev).match({
      verdict: 'handed_on',
      why: 'not_sure_enough',
      node: 'waiting_on_real',
      path: [
        { node: 'running', answer: 'yes' },
        { node: 'output_changed', answer: 'no' },
        { node: 'waiting_on_real', answer: 'no', confidence: 0.7 },
        { node: 'dialog_on_screen', answer: 'no' },
      ],
    });
  });
});
