import { describe, expect, test } from 'bun:test';
import type { Ack, Content, Op, TargetKind, TargetRef } from '../../../contract/act.ts';
import type { InputHolds } from '../../../contract/bound.ts';
import { createActRunner, MintedIdRegistry } from '../../../host/act.ts';
import { runInCall } from '../../../host/call-scope.ts';

const target: TargetRef = { kind: 'page' as TargetKind, key: 'p1' };
const holdsSaying = (answer: ReturnType<InputHolds['decide']>, seen: string[] = []): InputHolds => ({
  decide: (t, op, actor) => {
    seen.push(`${t.kind}:${t.key}:${op}:${actor}`);
    return answer;
  },
});

describe('kernel.act (§4.7)', () => {
  test('the hold is asked with the op and the actor stamped from the call, before fn', async () => {
    const seen: string[] = [];
    const act = createActRunner(() => holdsSaying('allow', seen), new MintedIdRegistry(() => 'x'));
    const order: string[] = [];
    const result = await runInCall({ actor: 'owner-tools' }, () =>
      act(target, 'read', async permit => {
        order.push(`fn:${permit.actor}`);
        return { kind: 'content', text: 'ok' } satisfies Content;
      }),
    );
    expect(seen).toEqual(['page:p1:read:owner-tools']);
    expect(order).toEqual(['fn:owner-tools']);
    expect(result).toEqual({ ok: true, value: { kind: 'content', text: 'ok' } });
  });

  test('outside a call the actor is ferret, the most restricted', async () => {
    const seen: string[] = [];
    const act = createActRunner(() => holdsSaying('allow', seen), new MintedIdRegistry(() => 'x'));
    await act(target, 'press', async () => ({ status: 'done' }) satisfies Ack);
    expect(seen).toEqual(['page:p1:press:ferret']);
  });

  test('a refusal stops fn from running', async () => {
    let ran = false;
    const act = createActRunner(() => holdsSaying({ refused: 'held' }), new MintedIdRegistry(() => 'x'));
    const result = await act(target, 'type', async () => {
      ran = true;
      return { status: 'done' };
    });
    expect(result).toEqual({ ok: false, error: { refused: 'held' } });
    expect(ran).toBe(false);
  });

  test('no InputHolds bound, or one that throws, fails closed', async () => {
    const missing = createActRunner(() => undefined, new MintedIdRegistry(() => 'x'));
    expect(await missing(target, 'read', async () => ({ kind: 'content' }))).toEqual({
      ok: false,
      error: { refused: 'holds_unavailable' },
    });
    const throwing = createActRunner(
      () => ({
        decide: () => {
          throw new Error('x');
        },
      }),
      new MintedIdRegistry(() => 'x'),
    );
    expect(await throwing(target, 'read', async () => ({ kind: 'content' }))).toEqual({
      ok: false,
      error: { refused: 'holds_unavailable' },
    });
  });

  test('an op not in OP_EFFECTS is refused from its runtime value', async () => {
    const act = createActRunner(() => holdsSaying('allow'), new MintedIdRegistry(() => 'x'));
    expect(await act(target, 'teleport' as Op, async () => ({ status: 'done' }) as never)).toEqual({
      ok: false,
      error: { refused: 'unknown_op' },
    });
  });

  test('a write-only result is closed to a fresh Ack: no URL, no title, only minted ids', async () => {
    const ids = new MintedIdRegistry(() => 'r');
    const minted = ids.mint('page-');
    const act = createActRunner(() => holdsSaying('allow'), ids);
    const leaky = { status: 'done', url: 'https://bank.test/?token=abc', title: 'Bank', ids: [minted] };
    const result = await act(target, 'navigate', async () => leaky as unknown as Ack);
    expect(result).toEqual({ ok: true, value: { status: 'done', ids: [minted] } });
    const forged = await act(
      target,
      'open',
      async () => ({ status: 'done', ids: ['https://evil.test/'] }) as unknown as Ack,
    );
    expect(forged).toEqual({ ok: true, value: { status: 'refused', code: 'unminted_id' } });
  });

  test('acts on one target run one after another; the hold is asked right before each', async () => {
    const log: string[] = [];
    const act = createActRunner(
      () => ({ decide: (_t, op) => (log.push(`hold:${op}`), 'allow') }),
      new MintedIdRegistry(() => 'x'),
    );
    let release = (): void => {};
    const first = act(target, 'keys', async () => {
      log.push('keys:start');
      await new Promise<void>(resolve => {
        release = resolve;
      });
      log.push('keys:end');
      return { status: 'done' };
    });
    const second = act(target, 'read', async () => (log.push('read'), { kind: 'content' }));
    await Promise.resolve();
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(log).toEqual(['hold:keys', 'keys:start', 'keys:end', 'hold:read', 'read']);
  });
});

describe('kernel.act: observed and the fresh read before decide (lead H, I)', () => {
  test('Y an allowed act that completes reaches observed once with its target, op and actor', async () => {
    const observed: string[] = [];
    const holds: InputHolds = {
      decide: () => 'allow',
      observed: (t, op, actor) => observed.push(`${t.key}:${op}:${actor}`),
    };
    const act = createActRunner(() => holds, new MintedIdRegistry(() => 'x'));
    await runInCall({ actor: 'owner-tools' }, () =>
      act(target, 'fill', async () => ({ status: 'done' }) satisfies Ack),
    );
    expect(observed).toEqual(['p1:fill:owner-tools']);
  });

  test('Y a refused act, a throwing fn and a refused Ack never reach observed; a throwing observer is swallowed', async () => {
    const observed: string[] = [];
    let answer: ReturnType<InputHolds['decide']> = { refused: 'held' };
    const holds: InputHolds = {
      decide: () => answer,
      observed: (_t, op) => {
        observed.push(op);
        throw new Error('observer broke');
      },
    };
    const act = createActRunner(() => holds, new MintedIdRegistry(() => 'x'));
    expect(await act(target, 'press', async () => ({ status: 'done' }))).toEqual({
      ok: false,
      error: { refused: 'held' },
    });
    answer = 'allow';
    await expect(
      act(target, 'press', async () => {
        throw new Error('the page went away');
      }),
    ).rejects.toThrow('the page went away');
    await act(target, 'press', async () => ({ status: 'refused', code: 'target_gone' }));
    expect(observed).toEqual([]);
    expect(await act(target, 'press', async () => ({ status: 'done' }))).toEqual({
      ok: true,
      value: { status: 'done' },
    });
    expect(observed).toEqual(['press']);
  });

  test('Z decide sees the document a queued act changed: prepare is awaited inside the queue, right before decide', async () => {
    let document = 'login-page';
    let fresh = '';
    const decided: string[] = [];
    const holds: InputHolds = {
      prepare: async () => {
        await Promise.resolve();
        fresh = document;
      },
      decide: (_t, op) => {
        decided.push(`${op}@${fresh}`);
        return 'allow';
      },
    };
    const act = createActRunner(() => holds, new MintedIdRegistry(() => 'x'));
    const navigate = act(target, 'navigate', async () => {
      await Promise.resolve();
      document = 'inbox';
      return { status: 'done' };
    });
    const read = act(target, 'read', async () => ({ kind: 'content' }) satisfies Content);
    await Promise.all([navigate, read]);
    expect(decided).toEqual(['navigate@login-page', 'read@inbox']);
  });

  test('Z a prepare that throws fails closed before fn', async () => {
    let ran = false;
    const holds: InputHolds = {
      prepare: async () => {
        throw new Error('document unreadable');
      },
      decide: () => 'allow',
    };
    const act = createActRunner(() => holds, new MintedIdRegistry(() => 'x'));
    expect(
      await act(target, 'read', async () => {
        ran = true;
        return { kind: 'content' };
      }),
    ).toEqual({
      ok: false,
      error: { refused: 'holds_unavailable' },
    });
    expect(ran).toBe(false);
  });

  test('a write-only act answers a strict Ack: a password-field bit or any other key is dropped', async () => {
    const act = createActRunner(() => ({ decide: () => 'allow' }), new MintedIdRegistry(() => 'x'));
    const result = await act(target, 'type', async () => ({ status: 'done', passwordField: true }) as unknown as Ack);
    expect(result).toEqual({ ok: true, value: { status: 'done' } });
    expect(Object.keys(result.ok ? result.value : {})).toEqual(['status']);
  });
});
