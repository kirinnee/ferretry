import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import type {
  ForkSessionOutcome,
  IFyApiClient,
  SessionTranscriptMessage,
  SessionTranscriptPage,
  SessionView,
} from '@ferretry/protocol';
import {
  DetailedFailure,
  forkThroughLatest,
  NothingToForkError,
  RestartDowngradeRefused,
  RestartRefused,
  restartRefusedSentence,
  restartWithResume,
} from '../../../../src/features/session-actions/session-operations.ts';
import { sessionView } from '../../../support/sessions.ts';

/** Narrows away the `undefined` a `.find()` cannot promise is absent, failing out loud if it is. */
const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
};

const row = (byteOffset: number, text: string): SessionTranscriptMessage => ({
  point: { v: 1, byteOffset, blockIndex: 0 },
  role: 'user',
  text,
  selectionBinding: `bind-${byteOffset}`,
});

const page = (messages: readonly SessionTranscriptMessage[], nextCursor: string | null): SessionTranscriptPage => ({
  v: 1,
  sessionId: 'a1',
  messages,
  nextCursor,
});

const OUTCOME: ForkSessionOutcome = {
  session: { id: 'fork-1', name: 'Fork of Hadi', agent: 'claude', harness: 'claude', model: null, status: 'running' },
  plan: {
    v: 1,
    planId: 'plan-1',
    preparedAt: '2026-10-16T10:00:00.000Z',
    source: { sessionId: 'a1', cutMessagePoint: { v: 1, byteOffset: 1 } },
    target: { agent: 'claude', harness: 'claude', model: null, effort: null, contextWindow: 200_000 },
    notCarried: [],
  },
};

interface Call {
  readonly name: 'messages' | 'fork' | 'rename' | 'migrate';
  readonly args: readonly unknown[];
}

interface Scripted {
  readonly calls: Call[];
  pages: SessionTranscriptPage[];
  outcome: ForkSessionOutcome | Error;
  renamed: SessionView;
  /** A refusal the first, unforced migrate throws. */
  refuse?: Error;
}

const scripted = (overrides: Partial<Scripted> = {}): Scripted => ({
  calls: [],
  pages: [page([row(1, 'hello')], null)],
  outcome: OUTCOME,
  renamed: sessionView('fork-1'),
  ...overrides,
});

const client = (state: Scripted) => {
  let served = 0;
  return {
    messages: async (id: string, cursor?: string, limit?: number) => {
      state.calls.push({ name: 'messages', args: [id, cursor, limit] });
      const answer = state.pages[served] ?? page([], null);
      served += 1;
      return answer;
    },
    fork: async (id: string, input: unknown, requestId?: string) => {
      state.calls.push({ name: 'fork', args: [id, input, requestId] });
      if (state.outcome instanceof Error) throw state.outcome;
      return state.outcome;
    },
    rename: async (id: string, name: string | undefined, teammate: string | undefined) => {
      state.calls.push({ name: 'rename', args: [id, name, teammate] });
      return state.renamed;
    },
    migrate: async (
      id: string,
      agent: string,
      model: string | undefined,
      allowContextDowngrade: boolean | undefined,
      requestId: string | undefined,
      forceInflight: boolean | undefined,
    ) => {
      state.calls.push({ name: 'migrate', args: [id, agent, model, allowContextDowngrade, requestId, forceInflight] });
      if (state.refuse !== undefined && forceInflight !== true) throw state.refuse;
      return state.renamed;
    },
  };
};

const view = sessionView('a1', { config: { agent: 'nero' } });

describe('forkThroughLatest', () => {
  it('forks through the last message of a single page, with no rename when no teammate is given', async () => {
    const state = scripted();
    const fake = client(state);
    const outcome = await forkThroughLatest(fake, view, undefined, 'req-1');
    expect(outcome).toEqual(OUTCOME);
    expect(state.calls).toEqual([
      { name: 'messages', args: ['a1', undefined, 1000] },
      {
        name: 'fork',
        args: [
          'a1',
          { through: { v: 1, byteOffset: 1, blockIndex: 0 }, selectionBinding: 'bind-1', agent: 'nero' },
          'req-1',
        ],
      },
    ]);
  });

  it('walks forward with the cursor the daemon hands back, keeping only the latest row across pages', async () => {
    const state = scripted({
      pages: [page([row(1, 'a'), row(2, 'b')], 'cursor-1'), page([row(3, 'c')], null)],
    });
    const fake = client(state);
    await forkThroughLatest(fake, view, undefined, 'req-1');
    expect(state.calls.filter(call => call.name === 'messages').map(call => call.args)).toEqual([
      ['a1', undefined, 1000],
      ['a1', 'cursor-1', 1000],
    ]);
    const forkCall = state.calls.find(call => call.name === 'fork');
    expect((must(forkCall, 'fork call').args[1] as { through: { byteOffset: number } }).through.byteOffset).toBe(3);
  });

  it('keeps the previous page’s last row when a later page answers empty, rather than losing it', async () => {
    const state = scripted({
      pages: [page([row(1, 'a')], 'cursor-1'), page([], null)],
    });
    const fake = client(state);
    await forkThroughLatest(fake, view, undefined, 'req-1');
    const forkCall = state.calls.find(call => call.name === 'fork');
    expect((must(forkCall, 'fork call').args[1] as { through: { byteOffset: number } }).through.byteOffset).toBe(1);
  });

  it('stops after 50 pages even when the daemon never says it has reached the end', async () => {
    const pages: SessionTranscriptPage[] = [];
    for (let index = 0; index < 60; index += 1) pages.push(page([row(index, `m${index}`)], 'more'));
    const state = scripted({ pages });
    const fake = client(state);
    await forkThroughLatest(fake, view, undefined, 'req-1');
    expect(state.calls.filter(call => call.name === 'messages')).toHaveLength(50);
    const forkCall = state.calls.find(call => call.name === 'fork');
    expect((must(forkCall, 'fork call').args[1] as { through: { byteOffset: number } }).through.byteOffset).toBe(49);
  });

  it('throws NothingToForkError, and never calls fork, when there is no message on any page', async () => {
    const state = scripted({ pages: [page([], null)] });
    const fake = client(state);
    await expect(forkThroughLatest(fake, view, undefined, 'req-1')).rejects.toBeInstanceOf(NothingToForkError);
    await expect(forkThroughLatest(fake, view, undefined, 'req-1')).rejects.toThrow(
      'there is no message to fork from yet — send this ferret something first',
    );
    expect(state.calls.some(call => call.name === 'fork')).toBe(false);
  });

  it('renames the fork when a teammate name is given, trimmed and lower-cased', async () => {
    const state = scripted();
    const fake = client(state);
    const outcome = await forkThroughLatest(fake, view, '  NERO-2  ', 'req-1');
    expect(state.calls.at(-1)).toEqual({ name: 'rename', args: [outcome.session.id, undefined, 'nero-2'] });
  });

  it('does not rename when the teammate name is empty or only whitespace', async () => {
    const state = scripted();
    const fake = client(state);
    await forkThroughLatest(fake, view, '   ', 'req-1');
    expect(state.calls.some(call => call.name === 'rename')).toBe(false);
  });

  it('propagates a refusal from the fork route itself', async () => {
    const state = scripted({ outcome: new Error('nothing to transfer') });
    const fake = client(state);
    await expect(forkThroughLatest(fake, view, undefined, 'req-1')).rejects.toThrow('nothing to transfer');
  });
});

describe('restartWithResume', () => {
  it('migrates the ferret on its own login, with no model change and no context downgrade', async () => {
    const state = scripted();
    const fake = client(state);
    const result = await restartWithResume(fake, view, 'req-2');
    expect(result).toEqual(state.renamed);
    expect(state.calls).toEqual([{ name: 'migrate', args: ['a1', 'nero', undefined, false, 'req-2', undefined] }]);
  });
});

describe('restartWithResume — a refusal because ps failed', () => {
  const refusal = (message: string, code = 'migration_refused'): FyHttpError => new FyHttpError(message, 409, code);
  const failing = (error: Error): Pick<IFyApiClient, 'migrate'> => ({
    migrate: async () => {
      throw error;
    },
  });
  const raw =
    'refused: the process table could not be read: ps exited 1: ps: etimes: keyword not found\nin-flight inventory — status running';

  it('says plainly that nothing was restarted and keeps the daemon’s words as the detail', async () => {
    const thrown = await restartWithResume(failing(refusal(raw)), view, 'req-3').catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(DetailedFailure);
    expect((thrown as DetailedFailure).message).toBe(
      "Couldn't check the agent's processes on this machine (ps failed). Nothing was restarted.",
    );
    expect((thrown as DetailedFailure).detail).toBe(raw);
  });

  it('leaves a refusal about real in-flight work, and every other failure, exactly as the daemon said it', async () => {
    const inflight = refusal('refused: in-flight work is destructive_to_interrupt');
    const other = refusal(raw, 'session_migrate_failed');
    const plain = new Error('socket closed');
    for (const error of [inflight, other, plain])
      expect(await restartWithResume(failing(error), view, 'req-4').catch((reason: unknown) => reason)).toBe(error);
  });
});

describe('restartWithResume — a refusal that names what is running', () => {
  const body = (blockedBy: 'unknown' | 'destructive' | 'unreadable', blocks = true) => ({
    error: 'refused: raw daemon words',
    code: 'migration_refused',
    inflight: {
      status: 'running',
      turn: 13,
      blockedBy,
      restartsWithCli: 1,
      items: [
        { kind: 'process', verdict: 'unknown', title: 'A program Ferretry doesn’t recognise is running', blocks },
      ],
    },
  });
  const paused = (payload: unknown) => new FyHttpError('refused: raw daemon words', 409, 'migration_refused', payload);

  it('throws RestartRefused carrying the refusal, in a sentence that says nothing was restarted', async () => {
    const state = scripted({ refuse: paused(body('unknown')) });
    const thrown = await restartWithResume(client(state), view, 'req-5').catch((reason: unknown) => reason);
    expect(thrown).toBeInstanceOf(RestartRefused);
    expect((thrown as RestartRefused).refusal.blockedBy).toBe('unknown');
    expect((thrown as RestartRefused).message).toBe(
      'Restart paused — Ferretry can’t tell if what the agent is running is safe to stop. Nothing was restarted.',
    );
    expect(state.calls).toHaveLength(1);
  });

  it('says each cause in its own plain words', () => {
    const refusal = (blockedBy: 'unknown' | 'destructive' | 'unreadable') =>
      restartRefusedSentence({ status: 'running', turn: 1, blockedBy, items: [], restartsWithCli: 0 });
    expect(refusal('destructive')).toContain('could be left half-done if it is stopped');
    expect(refusal('unreadable')).toContain('couldn’t check what the agent is running');
  });

  it('restarts anyway by asking again with forceInflight, under a fresh request id', async () => {
    const state = scripted({ refuse: paused(body('destructive')) });
    const thrown = (await restartWithResume(client(state), view, 'req-6').catch(
      (reason: unknown) => reason,
    )) as RestartRefused;
    const result = await thrown.restartAnyway();
    expect(result).toEqual(state.renamed);
    const [first, second] = state.calls;
    expect(first?.args.at(-1)).toBeUndefined();
    expect(second?.args.at(-1)).toBe(true);
    expect(String(second?.args[4])).toStartWith('req-6-anyway-');
    expect(second?.args[4]).not.toBe(first?.args[4]);
  });

  it('keeps the older paths for a refusal with nothing to point at', async () => {
    const noBlockers = paused(body('unknown', false));
    const noInflight = paused({ error: 'refused: raw daemon words', code: 'migration_refused' });
    for (const error of [noBlockers, noInflight]) {
      const state = scripted({ refuse: error });
      expect(await restartWithResume(client(state), view, 'req-7').catch((reason: unknown) => reason)).toBe(error);
    }
  });
});

describe('restartWithResume — a refusal because the window would shrink', () => {
  const downgrade = { model: 'claude-opus-5-5', targetWindow: 200_000, currentWindow: 1_000_000 };
  const smaller = (payload: unknown, message = 'refused: raw words') =>
    new FyHttpError(message, 409, 'context_downgrade_refused', payload);
  const inflight = new FyHttpError('refused: raw words', 409, 'migration_refused', {
    error: 'refused: raw words',
    code: 'migration_refused',
    inflight: {
      status: 'running',
      turn: 1,
      blockedBy: 'unknown',
      restartsWithCli: 0,
      items: [{ kind: 'process', verdict: 'unknown', title: 'A program', blocks: true }],
    },
  });

  /** Answers each migrate with the next scripted outcome, and records what it was asked. */
  const sequence = (...outcomes: Array<Error | 'ok'>) => {
    const asked: Array<readonly unknown[]> = [];
    const migrate = async (...args: unknown[]) => {
      asked.push(args);
      const next = outcomes[asked.length - 1];
      if (next instanceof Error) throw next;
      return sessionView('done');
    };
    return { asked, client: { migrate } as unknown as Pick<IFyApiClient, 'migrate'> };
  };

  it('throws RestartDowngradeRefused with the numbers, in plain words and without the API field', async () => {
    const { client: fake } = sequence(smaller({ error: 'x', code: 'context_downgrade_refused', downgrade }));
    const thrown = await restartWithResume(fake, view, 'req-8').catch((reason: unknown) => reason);
    expect(thrown).toBeInstanceOf(RestartDowngradeRefused);
    expect((thrown as RestartDowngradeRefused).downgrade).toEqual(downgrade);
    const message = (thrown as RestartDowngradeRefused).message;
    expect(message).toContain('200,000 tokens instead of 1,000,000');
    expect(message).toContain('Nothing was restarted.');
    expect(message).not.toContain('allowContextDowngrade');
  });

  it('restarts with the smaller window by asking again with the consent, under a fresh request id', async () => {
    const { asked, client: fake } = sequence(smaller({ downgrade }), 'ok');
    const thrown = (await restartWithResume(fake, view, 'req-9').catch(
      (reason: unknown) => reason,
    )) as RestartDowngradeRefused;
    expect((await thrown.restartAnyway()).config.id).toBe('done');
    expect(asked[0]?.[3]).toBe(false);
    expect(asked[1]?.[3]).toBe(true);
    expect(String(asked[1]?.[4])).toStartWith('req-9-anyway-');
    expect(asked[1]?.[5]).toBeUndefined();
  });

  it('keeps an earlier confirmation when the other refusal follows, in either order', async () => {
    const first = sequence(inflight, smaller({ downgrade }), 'ok');
    const paused = (await restartWithResume(first.client, view, 'req-10').catch(
      (reason: unknown) => reason,
    )) as RestartRefused;
    const next = (await paused.restartAnyway().catch((reason: unknown) => reason)) as RestartDowngradeRefused;
    expect(next).toBeInstanceOf(RestartDowngradeRefused);
    await next.restartAnyway();
    expect(first.asked.map(args => [args[3], args[5]])).toEqual([
      [false, undefined],
      [false, true],
      [true, true],
    ]);

    const second = sequence(smaller({ downgrade }), inflight, 'ok');
    const pausedFirst = (await restartWithResume(second.client, view, 'req-11').catch(
      (reason: unknown) => reason,
    )) as RestartDowngradeRefused;
    const then = (await pausedFirst.restartAnyway().catch((reason: unknown) => reason)) as RestartRefused;
    expect(then).toBeInstanceOf(RestartRefused);
    await then.restartAnyway();
    expect(second.asked.map(args => [args[3], args[5]])).toEqual([
      [false, undefined],
      [true, undefined],
      [true, true],
    ]);
  });

  it('recovers the numbers from an older daemon’s sentence, or says it without them', async () => {
    const old = smaller(
      undefined,
      'claude-default serves claude-opus-5-5 with a 200000-token window and this session is running in 1000000; the conversation would be truncated. Send allowContextDowngrade to accept that.',
    );
    const unparsed = smaller(undefined, 'something about allowContextDowngrade');
    const withNumbers = (await restartWithResume(sequence(old).client, view, 'req-12').catch(
      (reason: unknown) => reason,
    )) as RestartDowngradeRefused;
    expect(withNumbers.downgrade).toEqual(downgrade);
    const without = (await restartWithResume(sequence(unparsed).client, view, 'req-13').catch(
      (reason: unknown) => reason,
    )) as RestartDowngradeRefused;
    expect(without.downgrade).toBeNull();
    expect(without.message).toBe(
      'Restart paused — Restarting would give this conversation a smaller window, so part of it would be cut off. Nothing was restarted.',
    );
  });
});
