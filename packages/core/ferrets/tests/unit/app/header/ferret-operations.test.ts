import { describe, expect, it } from 'bun:test';
import {
  DetailedFailure,
  renameFerret,
  RestartDowngradeRefused,
  RestartRefused,
  RestartUnresumable,
  restartOnEarlierConversation,
  restartRefusedSentence,
  restartWithResume,
  resumeFerret,
  setFerretPinned,
  stopFerret,
} from '../../../../app/features/header/ferret-operations.ts';
import type { FerretsClient } from '../../../../app/lib/client.ts';
import { ferretSummary } from './support.ts';

/** What the shell's client throws for a refusal; a body rides along only if the shell keeps one. */
class Refused extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

interface Call {
  readonly route: string;
  readonly params: unknown;
  readonly body: unknown;
  readonly headers: unknown;
}

/** Answers each call with the next scripted outcome (an Error is thrown) and records what was asked. */
const sequence = (...outcomes: Array<Error | 'ok'>) => {
  const calls: Call[] = [];
  const client: FerretsClient = {
    call: async <Answer = unknown>(
      route: string,
      init?: { params?: Record<string, string>; body?: unknown; headers?: unknown },
    ): Promise<Answer> => {
      calls.push({ route, params: init?.params, body: init?.body, headers: init?.headers });
      const next = outcomes[calls.length - 1] ?? 'ok';
      if (next instanceof Error) throw next;
      return ferretSummary('done') as Answer;
    },
  };
  return { calls, client };
};

const ferret = ferretSummary('a1', { runtime: 'nero' });
const MOVE = 'POST /v1/ferrets/:ferretId/move';

describe('the lifecycle acts', () => {
  it('stop, resume, pin, unpin and rename call the ferret routes by key', async () => {
    const { calls, client } = sequence();
    await stopFerret(client, 'a1');
    await resumeFerret(client, 'a1');
    await setFerretPinned(client, 'a1', true);
    await setFerretPinned(client, 'a1', false);
    const renamed = await renameFerret(client, 'a1', { title: 'New task' });
    expect(calls.map(call => call.route)).toEqual([
      'POST /v1/ferrets/:ferretId/stop',
      'POST /v1/ferrets/:ferretId/resume',
      'POST /v1/ferrets/:ferretId/pin',
      'POST /v1/ferrets/:ferretId/unpin',
      'POST /v1/ferrets/:ferretId/rename',
    ]);
    expect(calls.every(call => (call.params as { ferretId: string }).ferretId === 'a1')).toBe(true);
    expect(calls[4]?.body).toEqual({ title: 'New task' });
    expect(String(renamed.id)).toBe('done');
  });

  it('lets a refusal through unchanged, for the panel to say in words', async () => {
    const refusal = new Refused('only the owner may stop a ferret', 403, 'forbidden');
    const { client } = sequence(refusal);
    expect(await stopFerret(client, 'a1').catch((reason: unknown) => reason)).toBe(refusal);
  });
});

describe('restartWithResume', () => {
  it('moves the ferret onto its own runtime, with no context downgrade and nothing forced', async () => {
    const { calls, client } = sequence();
    const result = await restartWithResume(client, ferret, 'req-2');
    expect(String(result.id)).toBe('done');
    expect(calls).toEqual([
      {
        route: MOVE,
        params: { ferretId: 'a1' },
        body: { agent: 'nero', allowContextDowngrade: false, forceInflight: false },
        headers: { 'x-fy-request-id': 'req-2' },
      },
    ]);
  });

  it('refuses without calling the daemon when the ferret has no runtime to restart on', async () => {
    const { calls, client } = sequence();
    const bare = ferretSummary('a1', { runtime: undefined });
    await expect(restartWithResume(client, bare, 'req-0')).rejects.toThrow('no runtime recorded');
    expect(calls).toEqual([]);
  });
});

describe('restartWithResume — a refusal because ps failed', () => {
  const raw =
    'refused: the process table could not be read: ps exited 1: ps: etimes: keyword not found\nin-flight inventory — status running';

  it('says plainly that nothing was restarted and keeps the daemon’s words as the detail', async () => {
    const { client } = sequence(new Refused(raw, 409, 'move_refused'));
    const thrown = await restartWithResume(client, ferret, 'req-3').catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(DetailedFailure);
    expect((thrown as DetailedFailure).message).toBe(
      "Couldn't check the agent's processes on this machine (ps failed). Nothing was restarted.",
    );
    expect((thrown as DetailedFailure).detail).toBe(raw);
  });

  it('leaves a refusal with nothing to point at, and every other failure, exactly as the daemon said it', async () => {
    const bare = new Refused('refused: in-flight work is destructive_to_interrupt', 409, 'move_refused');
    const other = new Refused(raw, 409, 'session_move_failed');
    const plain = new Error('socket closed');
    for (const error of [bare, other, plain])
      expect(await restartWithResume(sequence(error).client, ferret, 'req-4').catch((reason: unknown) => reason)).toBe(
        error,
      );
  });
});

describe('restartWithResume — a refusal that names what is running', () => {
  const body = (blockedBy: 'unknown' | 'destructive' | 'unreadable', blocks = true) => ({
    error: 'refused: raw daemon words',
    code: 'move_refused',
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
  const paused = (payload: unknown) => new Refused('refused: raw daemon words', 409, 'move_refused', payload);

  it('throws RestartRefused carrying the refusal, in a sentence that says nothing was restarted', async () => {
    const { calls, client } = sequence(paused(body('unknown')));
    const thrown = await restartWithResume(client, ferret, 'req-5').catch((reason: unknown) => reason);
    expect(thrown).toBeInstanceOf(RestartRefused);
    expect((thrown as RestartRefused).refusal.blockedBy).toBe('unknown');
    expect((thrown as RestartRefused).message).toBe(
      'Restart paused — Ferretry can’t tell if what the agent is running is safe to stop. Nothing was restarted.',
    );
    expect(calls).toHaveLength(1);
  });

  it('says each cause in its own plain words', () => {
    const refusal = (blockedBy: 'unknown' | 'destructive' | 'unreadable') =>
      restartRefusedSentence({ status: 'running', turn: 1, blockedBy, items: [], restartsWithCli: 0 });
    expect(refusal('destructive')).toContain('could be left half-done if it is stopped');
    expect(refusal('unreadable')).toContain('couldn’t check what the agent is running');
  });

  it('restarts anyway by asking again with forceInflight, under a fresh request id', async () => {
    const { calls, client } = sequence(paused(body('destructive')), 'ok');
    const thrown = (await restartWithResume(client, ferret, 'req-6').catch(
      (reason: unknown) => reason,
    )) as RestartRefused;
    const result = await thrown.restartAnyway();
    expect(String(result.id)).toBe('done');
    const [first, second] = calls;
    expect((first?.body as { forceInflight: boolean } | undefined)?.forceInflight).toBe(false);
    expect((second?.body as { forceInflight: boolean } | undefined)?.forceInflight).toBe(true);
    const id = (second?.headers as { 'x-fy-request-id': string } | undefined)?.['x-fy-request-id'];
    expect(id).toStartWith('req-6-anyway-');
    expect(id).not.toBe((first?.headers as { 'x-fy-request-id': string } | undefined)?.['x-fy-request-id']);
  });

  it('keeps the plain path for a refusal with nothing to point at', async () => {
    const noBlockers = paused(body('unknown', false));
    const noInflight = paused({ error: 'refused: raw daemon words', code: 'move_refused' });
    for (const error of [noBlockers, noInflight])
      expect(await restartWithResume(sequence(error).client, ferret, 'req-7').catch((reason: unknown) => reason)).toBe(
        error,
      );
  });
});

describe('restartWithResume — a refusal because the window would shrink', () => {
  const downgrade = { model: 'claude-opus-5-5', targetWindow: 200_000, currentWindow: 1_000_000 };
  const smaller = (payload: unknown, message = 'refused: raw words') =>
    new Refused(message, 409, 'context_downgrade_refused', payload);
  const inflight = new Refused('refused: raw words', 409, 'move_refused', {
    error: 'refused: raw words',
    code: 'move_refused',
    inflight: {
      status: 'running',
      turn: 1,
      blockedBy: 'unknown',
      restartsWithCli: 0,
      items: [{ kind: 'process', verdict: 'unknown', title: 'A program', blocks: true }],
    },
  });
  const consent = (call: Call | undefined): readonly [unknown, unknown] => {
    const body = call?.body as { allowContextDowngrade: boolean; forceInflight: boolean };
    return [body.allowContextDowngrade, body.forceInflight];
  };

  it('throws RestartDowngradeRefused with the numbers, in plain words and without the API field', async () => {
    const { client } = sequence(smaller({ error: 'x', code: 'context_downgrade_refused', downgrade }));
    const thrown = await restartWithResume(client, ferret, 'req-8').catch((reason: unknown) => reason);
    expect(thrown).toBeInstanceOf(RestartDowngradeRefused);
    expect((thrown as RestartDowngradeRefused).downgrade).toEqual(downgrade);
    const message = (thrown as RestartDowngradeRefused).message;
    expect(message).toContain('200,000 tokens instead of 1,000,000');
    expect(message).toContain('Nothing was restarted.');
    expect(message).not.toContain('allowContextDowngrade');
  });

  it('restarts with the smaller window by asking again with the consent, under a fresh request id', async () => {
    const { calls, client } = sequence(smaller({ downgrade }), 'ok');
    const thrown = (await restartWithResume(client, ferret, 'req-9').catch(
      (reason: unknown) => reason,
    )) as RestartDowngradeRefused;
    expect(String((await thrown.restartAnyway()).id)).toBe('done');
    expect(consent(calls[0])).toEqual([false, false]);
    expect(consent(calls[1])).toEqual([true, false]);
    expect((calls[1]?.headers as { 'x-fy-request-id': string } | undefined)?.['x-fy-request-id']).toStartWith(
      'req-9-anyway-',
    );
  });

  it('keeps an earlier confirmation when the other refusal follows, in either order', async () => {
    const first = sequence(inflight, smaller({ downgrade }), 'ok');
    const paused = (await restartWithResume(first.client, ferret, 'req-10').catch(
      (reason: unknown) => reason,
    )) as RestartRefused;
    const next = (await paused.restartAnyway().catch((reason: unknown) => reason)) as RestartDowngradeRefused;
    expect(next).toBeInstanceOf(RestartDowngradeRefused);
    await next.restartAnyway();
    expect(first.calls.map(consent)).toEqual([
      [false, false],
      [false, true],
      [true, true],
    ]);

    const second = sequence(smaller({ downgrade }), inflight, 'ok');
    const pausedFirst = (await restartWithResume(second.client, ferret, 'req-11').catch(
      (reason: unknown) => reason,
    )) as RestartDowngradeRefused;
    const then = (await pausedFirst.restartAnyway().catch((reason: unknown) => reason)) as RestartRefused;
    expect(then).toBeInstanceOf(RestartRefused);
    await then.restartAnyway();
    expect(second.calls.map(consent)).toEqual([
      [false, false],
      [true, false],
      [true, true],
    ]);
  });

  it('recovers the numbers from the sentence when the body did not come, or says it without them', async () => {
    const old = smaller(
      undefined,
      'claude-default serves claude-opus-5-5 with a 200000-token window and this session is running in 1000000; the conversation would be truncated.',
    );
    const unparsed = smaller(undefined, 'something about a smaller window');
    const withNumbers = (await restartWithResume(sequence(old).client, ferret, 'req-12').catch(
      (reason: unknown) => reason,
    )) as RestartDowngradeRefused;
    expect(withNumbers.downgrade).toEqual(downgrade);
    const without = (await restartWithResume(sequence(unparsed).client, ferret, 'req-13').catch(
      (reason: unknown) => reason,
    )) as RestartDowngradeRefused;
    expect(without.downgrade).toBeNull();
    expect(without.message).toBe(
      'Restart paused — Restarting would give this conversation a smaller window, so part of it would be cut off. Nothing was restarted.',
    );
  });
});

describe('restartWithResume — a refusal because the conversation cannot be resumed', () => {
  const unresumable = new Refused(
    'This ferret has no recorded conversation, so there is nothing Ferretry can resume. Nothing was restarted.',
    409,
    'conversation_unresumable',
    { error: 'x', code: 'conversation_unresumable' },
  );

  it('never starts fresh on its own: it pauses with the daemon’s reason, and Start fresh asks again', async () => {
    const { calls, client } = sequence(unresumable, 'ok');
    const thrown = (await restartWithResume(client, ferret, 'req-20').catch(
      (reason: unknown) => reason,
    )) as RestartUnresumable;
    expect(thrown).toBeInstanceOf(RestartUnresumable);
    expect(thrown.reason).toContain('nothing Ferretry can resume');
    expect((calls[0]?.body as { conversation?: string } | undefined)?.conversation).toBeUndefined();
    expect(String((await thrown.restartAnyway()).id)).toBe('done');
    expect((calls[1]?.body as { conversation?: string } | undefined)?.conversation).toBe('fresh');
    expect((calls[1]?.headers as { 'x-fy-request-id': string } | undefined)?.['x-fy-request-id']).toStartWith(
      'req-20-anyway-',
    );
  });

  it('goes back to the earlier conversation by asking for it explicitly', async () => {
    const { calls, client } = sequence('ok');
    const result = await restartOnEarlierConversation(client, ferret, 'req-21');
    expect(String(result.id)).toBe('done');
    expect(calls[0]?.body).toEqual({
      agent: 'nero',
      allowContextDowngrade: false,
      forceInflight: false,
      conversation: 'previous',
    });
  });
});
