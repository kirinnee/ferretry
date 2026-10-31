import { describe, it } from 'bun:test';
import { DEFAULT_WARDEN_JEV_ACTS } from '@ferretry/protocol';
import should from 'should';
import type { JevJudgement, JevYesNo } from '../../../src/lib/speedups/jev.ts';
import {
  JEV_FACT_NODES,
  JEV_JUDGEMENT_NODES,
  JEV_LEAVES,
  JEV_TREE,
  type JevFacts,
  type JevJudgementNode,
  type JevResponderPolicy,
  jevFactsOf,
  jevNodeQuestion,
  jevPathFacts,
  jevPathLine,
  reachableJudgements,
  treeResponse,
  walkJevTree,
} from '../../../src/lib/warden/index.ts';

/**
 * Jev's decision tree: yes/no questions, facts first, ending in one action. The owner asked for it on
 * 2026-10-31 ("is it running or dead? if its running => is it stuck? … so that the confidence level is
 * not spread among too many options") and approved this tree (!A120).
 */

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const yes = (confidence: number): JevYesNo => ({ answer: 'yes', confidence });
const no = (confidence: number): JevYesNo => ({ answer: 'no', confidence });

const facts = (overrides: Partial<JevFacts> = {}): JevFacts => ({
  running: true,
  quota_or_provider: false,
  output_changed: false,
  already_nudged: false,
  dialog_on_screen: false,
  quotaResetPassed: false,
  ...overrides,
});

const judgement = (
  answers: Partial<Record<JevJudgementNode, JevYesNo>>,
  extra: Partial<JevJudgement> = {},
): JevJudgement => ({
  answers,
  model: 'jev-latest',
  inputTokens: 400,
  latencyMs: 70,
  costUsd: 0.001,
  ...extra,
});

/** Every act allowed alone, every act offered: only the bars decide. */
const policy = (overrides: Partial<JevResponderPolicy> = {}): JevResponderPolicy => ({
  leaveThreshold: 0.85,
  acts: DEFAULT_WARDEN_JEV_ACTS,
  mayActAlone: { nudge: true, resume: true, restart: true, failover: true, stop: true, closeLeftovers: true },
  offered: ['nudge', 'resume', 'restart', 'failover', 'stop'],
  ...overrides,
});

describe('the tree itself', () => {
  it('should be one tree: every node and every leaf reached from the root, each exactly once', () => {
    // Arrange
    const nodes: string[] = [];
    const leaves: string[] = [];
    const visit = (target: string | { readonly leaf: string }): void => {
      if (typeof target !== 'string') {
        leaves.push(target.leaf);
        return;
      }
      nodes.push(target);
      const branch = JEV_TREE[target as keyof typeof JEV_TREE];
      visit(branch.yes);
      visit(branch.no);
    };

    // Act
    visit('running');

    // Assert
    should(nodes.toSorted()).deepEqual([...JEV_FACT_NODES, ...JEV_JUDGEMENT_NODES].toSorted());
    should(leaves.toSorted()).deepEqual([...JEV_LEAVES].toSorted());
  });

  it('should name every node with a question the owner can read', () => {
    for (const node of [...JEV_FACT_NODES, ...JEV_JUDGEMENT_NODES]) should(jevNodeQuestion(node)).endWith('?');
    should(jevNodeQuestion('no_such_node')).be.undefined();
  });
});

describe('each path to each leaf', () => {
  const cases: readonly {
    readonly name: string;
    readonly facts: Partial<JevFacts>;
    readonly answers: Partial<Record<JevJudgementNode, JevYesNo>>;
    readonly leaf: string;
    readonly verdict: string;
    readonly path: readonly string[];
  }[] = [
    {
      name: 'not running, finished on purpose → leave',
      facts: { running: false },
      answers: { finished_on_purpose: yes(0.9) },
      leaf: 'leave_finished',
      verdict: 'leave',
      path: ['running:no', 'finished_on_purpose:yes'],
    },
    {
      name: 'not running, cut off on its quota after the reset → resume',
      facts: { running: false, quota_or_provider: true, quotaResetPassed: true },
      answers: { finished_on_purpose: no(0.9) },
      leaf: 'quota_or_provider',
      verdict: 'resume',
      path: ['running:no', 'finished_on_purpose:no', 'quota_or_provider:yes'],
    },
    {
      name: 'not running, out of quota or its provider down, no reset yet → failover',
      facts: { running: false, quota_or_provider: true },
      answers: { finished_on_purpose: no(0.9) },
      leaf: 'quota_or_provider',
      verdict: 'failover',
      path: ['running:no', 'finished_on_purpose:no', 'quota_or_provider:yes'],
    },
    {
      name: 'not running, nothing outside it in the way → restart',
      facts: { running: false },
      answers: { finished_on_purpose: no(0.9) },
      leaf: 'restart_dead',
      verdict: 'restart',
      path: ['running:no', 'finished_on_purpose:no', 'quota_or_provider:no'],
    },
    {
      name: 'running, output moving, new things → leave',
      facts: { output_changed: true },
      answers: { doing_new_things: yes(0.9) },
      leaf: 'leave_progressing',
      verdict: 'leave',
      path: ['running:yes', 'output_changed:yes', 'doing_new_things:yes'],
    },
    {
      name: 'running, output moving, repeating itself, not nudged yet → nudge',
      facts: { output_changed: true },
      answers: { doing_new_things: no(0.9) },
      leaf: 'nudge_looping',
      verdict: 'nudge',
      path: ['running:yes', 'output_changed:yes', 'doing_new_things:no', 'already_nudged:no'],
    },
    {
      name: 'running, output moving, repeating itself after a nudge → stop',
      facts: { output_changed: true, already_nudged: true },
      answers: { doing_new_things: no(0.9) },
      leaf: 'stop_looping',
      verdict: 'stop',
      path: ['running:yes', 'output_changed:yes', 'doing_new_things:no', 'already_nudged:yes'],
    },
    {
      name: 'running, silent, waiting on something real, still reasonable → leave',
      facts: {},
      answers: { waiting_on_real: yes(0.9), wait_reasonable: yes(0.9) },
      leaf: 'leave_waiting',
      verdict: 'leave',
      path: ['running:yes', 'output_changed:no', 'waiting_on_real:yes', 'wait_reasonable:yes'],
    },
    {
      name: 'running, silent, waiting on something real for too long → nudge',
      facts: {},
      answers: { waiting_on_real: yes(0.9), wait_reasonable: no(0.9) },
      leaf: 'nudge_wait',
      verdict: 'nudge',
      path: ['running:yes', 'output_changed:no', 'waiting_on_real:yes', 'wait_reasonable:no'],
    },
    {
      name: 'running, silent, waiting on nothing, a dialog on screen → the owner’s nudge',
      facts: { dialog_on_screen: true },
      answers: { waiting_on_real: no(0.9) },
      leaf: 'dialog_owner',
      verdict: 'nudge',
      path: ['running:yes', 'output_changed:no', 'waiting_on_real:no', 'dialog_on_screen:yes'],
    },
    {
      name: 'running, silent, waiting on nothing, no dialog → restart',
      facts: {},
      answers: { waiting_on_real: no(0.9) },
      leaf: 'restart_stuck',
      verdict: 'restart',
      path: ['running:yes', 'output_changed:no', 'waiting_on_real:no', 'dialog_on_screen:no'],
    },
  ];

  for (const testCase of cases)
    it(`should walk ${testCase.name}`, () => {
      // Arrange / Act
      const walk = walkJevTree(facts(testCase.facts), testCase.answers);

      // Assert
      should(walk?.leaf).equal(testCase.leaf);
      should(walk?.verdict).equal(testCase.verdict);
      should(walk?.path.map(step => `${step.node}:${step.answer}`)).deepEqual(testCase.path);
      // A fact is observed, never guessed: only Jev's answers carry a confidence.
      for (const step of walk?.path ?? [])
        should(step.confidence === undefined).equal(step.kind === 'fact', `${step.node} is a ${step.kind}`);
    });

  it('should cover every leaf', () => {
    should(new Set(cases.map(testCase => testCase.leaf))).deepEqual(new Set(JEV_LEAVES));
  });

  it('should walk nowhere when an answer the path needs is missing', () => {
    should(walkJevTree(facts(), { waiting_on_real: yes(0.9) })).be.undefined();
  });
});

describe('the facts, from what the daemon already observes', () => {
  const view = (state: Record<string, unknown> = {}, hasLiveMonitor = true) => ({
    hasLiveMonitor,
    state: { status: 'running' as const, ...state },
  });
  const of = (input: { readonly view?: ReturnType<typeof view>; readonly kind?: string; actions?: unknown[] }) =>
    jevFactsOf({
      anomaly: { kind: (input.kind ?? 'sus_thinking') as 'sus_thinking', sessionId: 's1' },
      view: input.view ?? view(),
      actions: (input.actions ?? []) as never,
      windowMs: 15 * MINUTE,
      nowMs: NOW,
    });

  it('should say the program is running only with a live monitor and a turn the harness did not cut off', () => {
    should(of({}).running).be.true();
    should(of({ view: view({}, false) }).running).be.false();
    should(of({ view: view({ status: 'completed' }) }).running).be.false();
    should(of({ view: view({ status: 'rate_limited' }) }).running).be.false();
    should(of({ view: view({ status: 'interrupted' }) }).running).be.false();
  });

  it('should read quota and provider trouble from the status, the quota and the flag', () => {
    should(of({}).quota_or_provider).be.false();
    should(of({ view: view({ status: 'rate_limited' }) }).quota_or_provider).be.true();
    should(of({ kind: 'provider_unavailable' }).quota_or_provider).be.true();
    should(of({ view: view({ quota: { resetAt: NOW - MINUTE } }) })).match({
      quota_or_provider: true,
      quotaResetPassed: true,
    });
    should(of({ view: view({ quota: { resetAt: NOW + MINUTE } }) }).quotaResetPassed).be.false();
  });

  it('should count output as changed only within the window', () => {
    should(of({ view: view({ lastTranscriptAt: iso(NOW - 5 * MINUTE) }) }).output_changed).be.true();
    should(of({ view: view({ lastMeaningfulPaneAt: iso(NOW - 14 * MINUTE) }) }).output_changed).be.true();
    should(of({ view: view({ lastTranscriptAt: iso(NOW - 16 * MINUTE) }) }).output_changed).be.false();
    should(of({}).output_changed).be.false();
  });

  it('should find a nudge that took on this ferret for this flag within a day, by anyone', () => {
    const nudge = { at: iso(NOW - 60 * MINUTE), sessionId: 's1', action: 'nudge', outcome: 'done' };
    should(of({ actions: [{ ...nudge, anomalyKind: 'sus_thinking' }] }).already_nudged).be.true();
    should(of({ actions: [{ ...nudge, anomalyKind: 'agent_frozen' }] }).already_nudged).be.false();
    should(of({ actions: [{ ...nudge, anomalyKind: 'sus_thinking', outcome: 'held' }] }).already_nudged).be.false();
    should(of({ actions: [{ ...nudge, anomalyKind: 'sus_thinking', sessionId: 's2' }] }).already_nudged).be.false();
    should(
      of({ actions: [{ ...nudge, anomalyKind: 'sus_thinking', at: iso(NOW - 25 * 60 * MINUTE) }] }).already_nudged,
    ).be.false();
  });

  it('should see a dialog when the ferret is parked on a question or a permission prompt', () => {
    should(of({ view: view({ turnState: 'needs-input' }) }).dialog_on_screen).be.true();
    should(of({ view: view({ status: 'awaiting_question' }) }).dialog_on_screen).be.true();
    should(of({ view: view({ turnState: 'working' }) }).dialog_on_screen).be.false();
  });
});

describe('what Jev is asked', () => {
  it('should never ask a fact: the daemon answers every fact before Jev is called', () => {
    // Arrange: every combination of facts.
    const combos: JevFacts[] = [];
    for (let mask = 0; mask < 2 ** JEV_FACT_NODES.length; mask += 1)
      combos.push(facts(Object.fromEntries(JEV_FACT_NODES.map((node, index) => [node, (mask & (1 << index)) !== 0]))));

    // Act / Assert
    for (const combo of combos) {
      const plan = reachableJudgements(combo);
      should(plan.judgements.length).be.within(1, 2);
      for (const node of plan.judgements) should(JEV_JUDGEMENT_NODES as readonly string[]).containEql(node);
    }
  });

  it('should ask only the judgements the facts leave open, in one plan', () => {
    should(reachableJudgements(facts({ running: false }))).deepEqual({ judgements: ['finished_on_purpose'] });
    should(reachableJudgements(facts({ output_changed: true }))).deepEqual({
      judgements: ['doing_new_things'],
      nudgeMessages: ['poll_loop', 'lost_track', 'retry_error'],
    });
    // Once nudged, the looping branch ends in a stop: no message to choose.
    should(reachableJudgements(facts({ output_changed: true, already_nudged: true }))).deepEqual({
      judgements: ['doing_new_things'],
    });
    should(reachableJudgements(facts())).deepEqual({
      judgements: ['waiting_on_real', 'wait_reasonable'],
      nudgeMessages: ['stuck_command', 'wait_overdue', 'peer_gone', 'poll_loop'],
    });
  });
});

describe('acting on the tree', () => {
  it('should act when every Jev answer on the path clears the act’s bar, at the weakest one', () => {
    // Arrange
    const answer = judgement(
      { waiting_on_real: yes(0.97), wait_reasonable: no(0.92) },
      { nudge: { id: 'stuck_command', message: 'check it', confidence: 0.95 } },
    );

    // Act
    const response = treeResponse(facts(), answer, policy());

    // Assert
    should(response.outcome).match({ kind: 'act', act: 'nudge', confidence: 0.92, message: 'check it' });
    should(response.node).be.undefined();
    should(response.leaf).equal('nudge_wait');
  });

  it('should escalate a low answer by NAMING its node — the first one on the path below the bar', () => {
    // Arrange: sure it waits on something, not sure the wait is unreasonable.
    const answer = judgement({ waiting_on_real: yes(0.97), wait_reasonable: no(0.61) });

    // Act
    const response = treeResponse(facts(), answer, policy());

    // Assert
    should(response.outcome).match({ kind: 'escalate', why: 'not_sure_enough', confidence: 0.61 });
    should(response.node).equal('wait_reasonable');
    should(response.path?.map(step => step.node)).deepEqual([
      'running',
      'output_changed',
      'waiting_on_real',
      'wait_reasonable',
    ]);
  });

  it('should hold every answer on the path to the bar of the leaf it reaches', () => {
    // 0.94 clears the nudge bar (0.9) and the leave bar (0.85) but not the restart bar (0.95).
    should(treeResponse(facts(), judgement({ waiting_on_real: no(0.94) }), policy()).outcome).match({
      kind: 'escalate',
      why: 'not_sure_enough',
    });
    should(treeResponse(facts(), judgement({ waiting_on_real: no(0.96) }), policy()).outcome).match({
      kind: 'act',
      act: 'restart',
    });
    should(
      treeResponse(facts(), judgement({ waiting_on_real: yes(0.86), wait_reasonable: yes(0.86) }), policy()).outcome,
    ).match({ kind: 'leave', confidence: 0.86 });
  });

  it('should keep every gate of the first responder: offered acts, may-act-alone, never-alone, the message', () => {
    const restart = judgement({ waiting_on_real: no(0.99) });
    should(treeResponse(facts(), restart, policy({ offered: ['nudge'] })).outcome).match({ why: 'not_offered' });
    should(
      treeResponse(facts(), restart, policy({ mayActAlone: { ...policy().mayActAlone, restart: false } })).outcome,
    ).match({ kind: 'escalate', why: 'not_allowed', recommends: 'restart' });
    should(treeResponse(facts(), restart, policy({ acts: { ...DEFAULT_WARDEN_JEV_ACTS, restart: 1 } })).outcome).match({
      kind: 'escalate',
      why: 'never_alone',
      recommends: 'restart',
    });
    // A nudge with no message Jev chose as surely is no nudge.
    should(
      treeResponse(facts(), judgement({ waiting_on_real: yes(0.99), wait_reasonable: no(0.99) }), policy()).outcome,
    ).match({ kind: 'escalate', why: 'no_message' });
    // A failover still cannot name the login.
    should(
      treeResponse(
        facts({ running: false, quota_or_provider: true }),
        judgement({ finished_on_purpose: no(0.99) }),
        policy(),
      ).outcome,
    ).match({ kind: 'escalate', why: 'cannot_choose_login', recommends: 'failover' });
  });

  it('should never answer a dialog alone: it is the owner’s, recommended as a nudge', () => {
    // Arrange
    const answer = judgement(
      { waiting_on_real: no(0.99) },
      { nudge: { id: 'lost_track', message: 'carry on', confidence: 0.99 } },
    );

    // Act
    const response = treeResponse(facts({ dialog_on_screen: true }), answer, policy());

    // Assert
    should(response.outcome).match({ kind: 'escalate', why: 'never_alone', recommends: 'nudge' });
    should(response.decision.nudge).be.undefined();
  });

  it('should not even recommend answering a dialog on a flag that offers no nudge', () => {
    // Arrange: an unanswered question offers Jev no act at all.
    const answer = judgement({ waiting_on_real: no(0.99) });

    // Act
    const response = treeResponse(facts({ dialog_on_screen: true }), answer, policy({ offered: [] }));

    // Assert
    should(response.outcome).match({ kind: 'escalate', why: 'not_offered', confidence: 0.99 });
    should(response.outcome).not.have.property('recommends');
  });

  it('should hand on a failure, and a reply that left a question on the path unanswered', () => {
    should(treeResponse(facts(), judgement({}, { failure: { code: 'timeout' } }), policy()).outcome).match({
      kind: 'escalate',
      why: 'failed',
      confidence: 0,
    });
    const half = treeResponse(facts(), judgement({ waiting_on_real: yes(0.99) }), policy());
    should(half.outcome).match({ kind: 'escalate', why: 'failed' });
    should(half.decision.failure).deepEqual({ code: 'malformed' });
    should(half.path).be.undefined();
  });

  it('should carry the call’s cost onto the decision the counters take', () => {
    should(treeResponse(facts(), judgement({ waiting_on_real: no(0.5) }), policy()).decision).match({
      costUsd: 0.001,
      inputTokens: 400,
      verdict: 'restart',
      confidence: 0.5,
    });
  });
});

describe('the path, as the owner reads it', () => {
  it('should say each question, its answer, and how sure Jev was of its own', () => {
    // Arrange
    const walk = walkJevTree(facts(), { waiting_on_real: yes(0.9), wait_reasonable: no(0.6) });

    // Act / Assert
    should(jevPathLine(walk?.path ?? [])).equal(
      'Is the agent program running: yes → Has its output changed lately: no → Is it waiting on something real — a build, tests, a reply, the owner: yes (90% sure) → Is the wait still reasonable: no (60% sure)',
    );
    should(jevPathFacts(walk?.path ?? [])).equal(
      'Is the agent program running: yes; Has its output changed lately: no',
    );
  });
});
