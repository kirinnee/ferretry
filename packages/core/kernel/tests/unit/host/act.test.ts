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
    expect(await missing(target, 'read', async () => ({ kind: 'content' }))).toEqual({ ok: false, error: { refused: 'holds_unavailable' } });
    const throwing = createActRunner(() => ({ decide: () => { throw new Error('x'); } }), new MintedIdRegistry(() => 'x'));
    expect(await throwing(target, 'read', async () => ({ kind: 'content' }))).toEqual({ ok: false, error: { refused: 'holds_unavailable' } });
  });

  test('an op not in OP_EFFECTS is refused from its runtime value', async () => {
    const act = createActRunner(() => holdsSaying('allow'), new MintedIdRegistry(() => 'x'));
    expect(await act(target, 'teleport' as Op, async () => ({ status: 'done' }) as never)).toEqual({ ok: false, error: { refused: 'unknown_op' } });
  });

  test('a write-only result is closed to a fresh Ack: no URL, no title, only minted ids', async () => {
    const ids = new MintedIdRegistry(() => 'r');
    const minted = ids.mint('page-');
    const act = createActRunner(() => holdsSaying('allow'), ids);
    const leaky = { status: 'done', url: 'https://bank.test/?token=abc', title: 'Bank', ids: [minted] };
    const result = await act(target, 'navigate', async () => leaky as unknown as Ack);
    expect(result).toEqual({ ok: true, value: { status: 'done', ids: [minted] } });
    const forged = await act(target, 'open', async () => ({ status: 'done', ids: ['https://evil.test/'] }) as unknown as Ack);
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
