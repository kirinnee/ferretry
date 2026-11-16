import { describe, it } from 'bun:test';
import should from 'should';
import type { AuthorizedOutcome, OutboundAuthorizerPort } from '../../daemon/lib/jev-ports.ts';
import { JevTriageGuard, type JevQuestionSet, type TriageSnapshot } from '../../daemon/lib/jev.ts';

/**
 * The real Jev guard over a fake outbound authorizer: what it sends (bounded, redacted by the caller, only the
 * offered answers) and how it reads what comes back. No key and no network: the authorizer answers a script.
 */

interface Sent {
  readonly secretName: string;
  readonly hosts: readonly string[];
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly timeoutMs: number;
}

const rig = (outcome: AuthorizedOutcome | ((sent: Sent) => AuthorizedOutcome), options = {}) => {
  const sent: Sent[] = [];
  const authorizer: OutboundAuthorizerPort = {
    send: async (secretName, hosts, request) => {
      const record: Sent = {
        secretName,
        hosts,
        url: request.url,
        body: JSON.parse(request.body ?? '{}') as Record<string, unknown>,
        timeoutMs: request.timeoutMs,
      };
      sent.push(record);
      return typeof outcome === 'function' ? outcome(record) : outcome;
    },
  };
  let clock = 1_000;
  const guard = new JevTriageGuard(
    authorizer,
    {
      monotonicMs: () => {
        clock += 25;
        return clock;
      },
    },
    options,
  );
  return { guard, sent };
};

const completion = (answers: Record<string, unknown>, extra: Record<string, unknown> = {}): AuthorizedOutcome => ({
  kind: 'completion',
  payload: { answers, ...extra },
});

const snapshot = (overrides: Partial<TriageSnapshot> = {}): TriageSnapshot => ({
  anomaly: 'unattended_question',
  summary: 's'.repeat(900),
  facts: {
    idleMinutes: 20,
    note: 'n'.repeat(500),
    ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${String(i)}`, i])),
  },
  recentTurns: Array.from({ length: 20 }, (_, index) => `turn ${String(index)} ${'t'.repeat(2_000)}`),
  paneTail: 'p'.repeat(5_000),
  ...overrides,
});

describe('what the Jev guard sends', () => {
  it('should send a bounded state and offer leave, the acts that fit, and unsure, naming the nudge messages', async () => {
    const { guard, sent } = rig(completion({ triage: { choice: 'leave', confidence: 0.9 } }));

    await guard.decide(snapshot({ acts: ['nudge', 'stop'] }));

    const [request] = sent;
    should(request?.secretName).equal('JEV_API_KEY');
    should(request?.url).match(/\/v1\/systemone$/u);
    const questions = request?.body.questions as Record<string, { criteria: Record<string, string> }>;
    should(Object.keys(questions.triage?.criteria ?? {})).eql(['leave', 'nudge', 'stop', 'unsure']);
    should(Object.keys(questions)).eql(['triage', 'nudge']);
    const state = request?.body.state as {
      summary: string;
      facts: Record<string, unknown>;
      recentTurns: string[];
      paneTail: string;
    };
    should(state.summary).have.length(500);
    should(Object.keys(state.facts)).have.length(32);
    should(String(state.facts.note)).have.length(200);
    should(state.recentTurns).have.length(12);
    should(state.recentTurns[0]).have.length(1_500);
    should(state.paneTail).have.length(4_000);
  });

  it('should ask no nudge question when no nudge is on offer, and leave out an absent pane tail', async () => {
    const { guard, sent } = rig(completion({ triage: { choice: 'leave', confidence: 0.9 } }));

    await guard.decide({ anomaly: 'a', summary: 's', facts: {}, recentTurns: [] });

    should(Object.keys(sent[0]?.body.questions as object)).eql(['triage']);
    should(sent[0]?.body.state).not.have.property('paneTail');
  });
});

describe('how the Jev guard reads a choice', () => {
  const decide = async (outcome: AuthorizedOutcome, acts: TriageSnapshot['acts'] = ['nudge'], options = {}) =>
    await rig(outcome, options).guard.decide(snapshot({ acts }));

  it('should read an offered answer with its confidence, reason, model, tokens, latency and price', async () => {
    const decision = await decide(
      completion(
        { triage: { choice: 'leave', confidence: 0.8 } },
        { model: 'jev-2', usage: { input_tokens: 2_000_000 } },
      ),
      undefined,
      { usdPerMillionInputTokens: 0.5 },
    );
    should(decision).match({
      verdict: 'leave',
      confidence: 0.8,
      model: 'jev-2',
      inputTokens: 2_000_000,
      latencyMs: 25,
      costUsd: 1,
    });
    should(decision.reason).be.a.String();
  });

  it('should take the chosen option’s probability when no confidence came, and give up when neither did', async () => {
    const byProbability = await decide(
      completion({ triage: { choice: 'leave', probabilities: { leave: 0.7 } } }, { usage: { input_tokens: -1 } }),
    );
    should(byProbability).match({ verdict: 'leave', confidence: 0.7, inputTokens: 0 });
    const neither = await decide(completion({ triage: { choice: 'leave', confidence: 7 } }));
    should(neither).match({ verdict: 'unsure', confidence: 0, failure: { code: 'malformed' } });
  });

  it('should read the nudge message Jev chose, and none for an id it never offered', async () => {
    const chosen = await decide(
      completion({
        triage: { choice: 'nudge', confidence: 0.9 },
        nudge: { choice: 'lost_track', confidence: 0.6 },
      }),
    );
    should(chosen.nudge).match({ id: 'lost_track', confidence: 0.6 });
    const unknown = await decide(
      completion({ triage: { choice: 'nudge', confidence: 0.9 }, nudge: { choice: 'invented', confidence: 0.6 } }),
    );
    should(unknown.nudge).be.undefined();
    const none = await decide(
      completion({ triage: { choice: 'nudge', confidence: 0.9 }, nudge: { choice: 'none', confidence: 0.6 } }),
    );
    should(none.nudge).be.undefined();
  });

  it('should read an act it did not offer as unsure at no confidence', async () => {
    const decision = await decide(completion({ triage: { choice: 'stop', confidence: 0.99 } }), ['nudge']);
    should(decision).match({ verdict: 'unsure', confidence: 0 });
    should(decision).not.have.property('reason');
  });

  it('should call a reply that is not an answer malformed', async () => {
    for (const payload of [null, 'text', { answers: 'no' }, { answers: {} }, { answers: { triage: { choice: 3 } } }]) {
      should(await decide({ kind: 'completion', payload })).match({ failure: { code: 'malformed' } });
    }
  });
});

describe('how the Jev guard reads a failure', () => {
  const failure = async (outcome: AuthorizedOutcome) => (await rig(outcome).guard.decide(snapshot())).failure;

  it('should name the failure by the provider’s status, with its retry-after', async () => {
    should(await failure({ kind: 'status', status: 401 })).eql({ code: 'rejected' });
    should(await failure({ kind: 'status', status: 403 })).eql({ code: 'rejected' });
    should(await failure({ kind: 'status', status: 413 })).eql({ code: 'too_large' });
    should(await failure({ kind: 'status', status: 429, retryAfterSeconds: 1.5 })).eql({
      code: 'rate_limited',
      retryAfterMs: 1_500,
    });
    should(await failure({ kind: 'status', status: 529 })).eql({ code: 'overloaded' });
    should(await failure({ kind: 'status', status: 503 })).eql({ code: 'provider_error' });
    should(await failure({ kind: 'status', status: 400, retryAfterSeconds: -1 })).eql({ code: 'invalid_request' });
    should(await failure({ kind: 'status', status: 400, retryAfterSeconds: Number.NaN })).eql({
      code: 'invalid_request',
    });
  });

  it('should name the failure by what the outbound call came to', async () => {
    const codes: [AuthorizedOutcome, string][] = [
      [{ kind: 'secret_missing' }, 'not_set'],
      [{ kind: 'vault_damaged' }, 'vault_damaged'],
      [{ kind: 'refused' }, 'misconfigured'],
      [{ kind: 'timeout' }, 'timeout'],
      [{ kind: 'unreachable' }, 'unreachable'],
      [{ kind: 'oversized' }, 'malformed'],
      [{ kind: 'unreadable' }, 'malformed'],
    ];
    for (const [outcome, code] of codes) should(await failure(outcome)).eql({ code });
  });
});

describe('the Jev guard judging yes/no questions', () => {
  const set = (overrides: Partial<JevQuestionSet> = {}): JevQuestionSet => ({
    snapshot: snapshot(),
    questions: [
      { id: 'waiting_on_real', question: 'Is it waiting on a real thing?', yes: 'it waits', no: 'it does not' },
      { id: 'wait_reasonable', question: 'Is the wait reasonable?', yes: 'reasonable', no: 'not' },
    ],
    ...overrides,
  });
  const yes = (confidence: number) => ({ choice: 'yes', confidence });
  const no = (confidence: number) => ({ choice: 'no', confidence });

  it('should ask each question on its own, and the nudge message only when messages are on offer', async () => {
    const { guard, sent } = rig(completion({ waiting_on_real: yes(0.9), wait_reasonable: no(0.8) }));

    await guard.judge(set({ nudgeMessages: ['stuck_command', 'lost_track'] }));
    await guard.judge(set());

    const withMessages = sent[0]?.body.questions as Record<string, { criteria: Record<string, string> }>;
    should(Object.keys(withMessages)).eql(['waiting_on_real', 'wait_reasonable', 'nudge_message']);
    should(Object.keys(withMessages.nudge_message?.criteria ?? {})).eql(['stuck_command', 'lost_track', 'none']);
    should(Object.keys(sent[1]?.body.questions as object)).eql(['waiting_on_real', 'wait_reasonable']);
  });

  it('should read every answer with its confidence, the nudge chosen from those offered, and the price', async () => {
    const { guard } = rig(
      completion(
        {
          waiting_on_real: yes(0.9),
          wait_reasonable: no(0.8),
          nudge_message: { choice: 'stuck_command', confidence: 0.7 },
        },
        { model: 'jev-2', usage: { input_tokens: 1_000_000 } },
      ),
      { usdPerMillionInputTokens: 2 },
    );

    const judgement = await guard.judge(set({ nudgeMessages: ['stuck_command'] }));

    should(judgement.answers).eql({
      waiting_on_real: { answer: 'yes', confidence: 0.9 },
      wait_reasonable: { answer: 'no', confidence: 0.8 },
    });
    should(judgement).match({ model: 'jev-2', inputTokens: 1_000_000, costUsd: 2, latencyMs: 25 });
    should(judgement.nudge).match({ id: 'stuck_command', confidence: 0.7 });
  });

  it('should ignore a nudge message that was not offered', async () => {
    const { guard } = rig(
      completion({
        waiting_on_real: yes(0.9),
        wait_reasonable: no(0.8),
        nudge_message: { choice: 'lost_track', confidence: 0.7 },
      }),
    );
    const judgement = await guard.judge(set({ nudgeMessages: ['stuck_command'] }));
    should(judgement.nudge).be.undefined();
    should(judgement.model).equal('jev-latest');
  });

  it('should treat a half-answered or oddly answered set as no answer', async () => {
    for (const answers of [
      { waiting_on_real: yes(0.9) },
      { waiting_on_real: yes(0.9), wait_reasonable: { choice: 'maybe', confidence: 0.5 } },
      { waiting_on_real: yes(0.9), wait_reasonable: { choice: 'no' } },
    ]) {
      const judgement = await rig(completion(answers)).guard.judge(set());
      should(judgement).match({ answers: {}, failure: { code: 'malformed' } });
    }
    should((await rig({ kind: 'completion', payload: 7 }).guard.judge(set())).failure).eql({ code: 'malformed' });
  });

  it('should name a judging failure the way a choice failure is named', async () => {
    should((await rig({ kind: 'status', status: 429, retryAfterSeconds: 2 }).guard.judge(set())).failure).eql({
      code: 'rate_limited',
      retryAfterMs: 2_000,
    });
    should((await rig({ kind: 'timeout' }).guard.judge(set())).failure).eql({ code: 'timeout' });
  });
});

describe('the Jev guard’s own settings', () => {
  it('should send to the endpoint, model, hosts and timeout it was configured with', async () => {
    const { guard, sent } = rig(completion({ triage: { choice: 'leave', confidence: 0.9 } }), {
      endpoint: 'https://jev.example.test/v1/x',
      model: 'jev-custom',
      hosts: ['jev.example.test'],
      timeoutMs: 500,
    });

    await guard.decide(snapshot());

    should(sent[0]).match({ url: 'https://jev.example.test/v1/x', hosts: ['jev.example.test'], timeoutMs: 500 });
    should(sent[0]?.body.model).equal('jev-custom');
  });
});
