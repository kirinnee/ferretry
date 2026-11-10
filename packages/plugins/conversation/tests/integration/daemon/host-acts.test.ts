import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type { FerretId, FerretTurns } from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { StatePort } from '@ferretry/kernel/contract';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { CONVERSATION_STATE, ConversationPort } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { StateSendLedger } from '../../../daemon/delivery/adapters/index.ts';
import { StateQueueStore } from '../../../daemon/queue/adapters/index.ts';
import { writeAskedQuestion } from '../../../daemon/questions/adapters/state-asked-question.ts';
import { KeyedSerialExecutor } from '../../../daemon/seams/keyed-serial-executor.ts';
import { parseSessionId } from '../../../daemon/seams/ferret-id.ts';
import { fixtureTexts } from '../../support/fixtures.ts';
import { memoryStatePort } from '../../support/state.ts';

/**
 * The acts the send path's host answers beside a send — the queue, the draft, the question, the sitrep and the refusals
 * it words — through the real daemon half. Ferrets is the plain fake (no terminal): what each act does without one is
 * the point of most of these, and the terminal-backed acts are proved in `send-path.test.ts`.
 */

const F1 = ferretId('f1');
const AT = '2026-11-08T09:00:00.000Z' as Instant;
const fixture = await fixtureTexts(join(import.meta.dir, '../../fixtures/question-asked'));

/** A Ferrets whose turn documents can be made unreadable: the read a strict owner's-words question rejects on. */
class TurnsFerrets extends FakeFerrets {
  unreadableTurns = false;

  async turns(ferret: FerretId): Promise<FerretTurns | undefined> {
    if ((await this.get(ferret)) === undefined) return undefined;
    return {
      list: async () => {
        if (this.unreadableTurns) throw new Error('FIXTURE_SECRET a turn document vanished');
        return [];
      },
    };
  }
}

/** A state that fails every call while it is told to: the one way a store answers an error nobody worded. */
function breakable(state: StatePort) {
  const broken = { on: false };
  const port = new Proxy(state, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (broken.on) throw new Error('FIXTURE_SECRET the disk is gone');
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { port, broken };
}

async function world(setup: (ferrets: TurnsFerrets) => void = () => undefined) {
  const ferrets = new TurnsFerrets();
  ferrets.add({ id: F1, state: 'idle' });
  setup(ferrets);
  const inner = memoryStatePort(CONVERSATION_STATE);
  const { port: state, broken } = breakable(inner);
  const built: { half?: ReturnType<NonNullable<typeof daemon.build>> } = {};
  const implementation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
      const build = daemon.build;
      if (build === undefined) throw new Error('the conversation daemon half has no build');
      const half = build({ ...ctx, kernel: { ...ctx.kernel, state } });
      built.half = half;
      return half;
    },
  } as typeof daemon;
  const host = await testHost({
    plugins: [implementation],
    fakes: { ferrets, asks: new FakeAsks() },
    clock: fixedClock('2026-11-08T09:00:00Z'),
  });
  const api = () => host.provided(ConversationPort);
  const waiting = async (id: string, state: 'queued' | 'typing' = 'queued') =>
    await new StateQueueStore(inner).append(parseSessionId('f1'), {
      v: 1,
      kind: 'enqueued',
      at: AT,
      message: {
        v: 1,
        id,
        sender: 'human',
        text: 'wait',
        attachmentIds: [],
        enqueuedAt: AT,
        state,
        stateAt: AT,
        revision: 1,
      },
    });
  return { host, ferrets, api, state: inner, broken, built, waiting };
}

const route = (
  host: Awaited<ReturnType<typeof world>>['host'],
  method: 'PATCH' | 'DELETE',
  id: string,
  text?: string,
) =>
  host.request(method, `/v1/ferrets/f1/queue/${id}`, {
    as: owner(),
    ...(text === undefined ? {} : { body: { text } }),
  });

describe('the queue, through the port and its routes', () => {
  test('a waiting message is edited and taken back, and each is announced as a change of the queue', async () => {
    const { host, api, waiting } = await world();
    await waiting('q-1');
    await waiting('q-2');

    const edited = await api().editQueued(F1, 'q-1', { text: 'new words' });
    const cancelled = await api().cancelQueued(F1, 'q-2');

    expect(edited).toMatchObject({ ok: true, value: { id: 'q-1', text: 'new words', revision: 2 } });
    expect(cancelled).toMatchObject({ ok: true, value: { id: 'q-2', state: 'cancelled' } });
    await host.stop();
  });

  test('a message that is not there, or no longer waits, is refused with the reason a caller can branch on', async () => {
    const { host, api, waiting } = await world();
    await waiting('q-typing', 'typing');

    expect(await api().editQueued(F1, 'q-none', { text: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await api().editQueued(F1, 'q-typing', { text: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'not_waiting' },
    });
    expect(await api().cancelQueued(F1, 'q-none')).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await api().cancelQueued(F1, 'q-typing')).toMatchObject({ ok: false, error: { code: 'not_waiting' } });
    await host.stop();
  });

  test('a store that fails with something nobody worded is not made into a refusal', async () => {
    const { host, api, broken, waiting } = await world();
    await waiting('q-1');
    broken.on = true;

    await expect(api().editQueued(F1, 'q-1', { text: 'x' })).rejects.toThrow('FIXTURE_SECRET');
    await expect(api().cancelQueued(F1, 'q-1')).rejects.toThrow('FIXTURE_SECRET');
    broken.on = false;
    await host.stop();
  });

  test('the routes edit and cancel a waiting message, and answer 404 and 409 for the two refusals', async () => {
    const { host, waiting } = await world();
    await waiting('q-1');
    await waiting('q-2');
    await waiting('q-typing', 'typing');

    expect((await route(host, 'PATCH', 'q-1', 'new words')).json()).toMatchObject({ id: 'q-1', text: 'new words' });
    expect((await route(host, 'DELETE', 'q-2')).json()).toMatchObject({ id: 'q-2', state: 'cancelled' });
    expect((await route(host, 'PATCH', 'q-none', 'x')).status).toBe(404);
    expect((await route(host, 'DELETE', 'q-none')).status).toBe(404);
    expect((await route(host, 'PATCH', 'q-typing', 'x')).status).toBe(409);
    expect((await route(host, 'DELETE', 'q-typing')).status).toBe(409);
    await host.stop();
  });

  test('a store that fails on an edit through the route is the route’s own error, not a refusal', async () => {
    const { host, broken, waiting } = await world();
    await waiting('q-1');
    broken.on = true;

    const answer = await route(host, 'PATCH', 'q-1', 'x');

    broken.on = false;
    expect(answer.status).toBe(500);
    expect(JSON.stringify(answer.json())).not.toContain('FIXTURE_SECRET');
    await host.stop();
  });
});

describe('what needs the ferret’s terminal and has none says so', () => {
  test('a retry, a compact-at change and an answer are refused with the sentence for a terminal that is not connected', async () => {
    const { host, api } = await world();

    for (const refused of [
      await api().retrySend(F1, 's-1'),
      await api().setCompactAt(F1, {} as never),
      await api().answer(F1, { toolUseId: 't-1', labels: ['a'] }),
    ])
      expect(refused).toMatchObject({ ok: false, error: { code: 'conversation_terminal_unavailable' } });
    expect(await api().compactAt(F1)).toBeUndefined();
    await host.stop();
  });

  test('a send to a ferret that is still starting has no pane yet: Ferrets offers no way to reach it', async () => {
    const { host, api } = await world(f => f.add({ id: F1, state: 'starting' }));

    const sent = await api().send(F1, { kind: 'owner' }, { message: 'FIXTURE hello', sendId: 's-starting' });

    expect(sent).toMatchObject({ ok: false, error: { code: 'plugin_unavailable' } });
    await host.stop();
  });

  test('a stop of a ferret that is not running is refused in the words of the interrupt, and a named question is not abandoned', async () => {
    const { host, api } = await world(f => f.add({ id: F1, state: 'idle' }));

    expect(await api().interrupt(F1, {} as never)).toMatchObject({ ok: false });
    expect(await api().interrupt(F1, { toolUseId: 't-1' } as never)).toMatchObject({
      ok: false,
      error: { code: 'question_abandon_unsupported' },
    });
    await host.stop();
  });

  test('the Warden’s re-submit for a send whose pane cannot be read is refused in the seam’s words, not thrown', async () => {
    const { host, api, state } = await world();
    await new StateSendLedger(state, { now: () => AT }).accept(parseSessionId('f1'), {
      sendId: 's-stuck',
      acceptedAt: AT,
      acceptedTurn: 0,
      path: 'direct',
      message: 'FIXTURE stuck',
      matchText: 'FIXTURE stuck',
      fate: 'accepted',
      attempt: 1,
      attemptAt: AT,
      senderKind: 'human',
    });

    const refused = await api().resubmitStuck?.(F1, { kind: 'warden' }, 's-stuck');

    expect(refused).toMatchObject({ ok: false, error: { code: 'plugin_unavailable' } });
    await host.stop();
  });

  test('the Warden’s re-submit for a send nobody made answers refused, and no other caller may press it', async () => {
    const { host, api } = await world();

    expect(await api().resubmitStuck?.(F1, { kind: 'warden' }, 's-none')).toEqual({ ok: true, value: 'refused' });
    expect(await api().resubmitStuck?.(F1, { kind: 'owner' }, 's-none')).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    await host.stop();
  });

  test('cancelling a send nobody made is refused, and Enter and the composer say the same', async () => {
    const { host, api } = await world();

    expect(await api().cancelSend(F1, 's-none')).toMatchObject({ ok: false });
    expect(await api().enterSend(F1, 's-none')).toMatchObject({ ok: false });
    expect(await api().composer(F1, 'clear' as never, undefined as never)).toMatchObject({ ok: false });
    await host.stop();
  });
});

describe('the owner’s words, the draft, the question and the sitrep', () => {
  test('a strict read of the owner’s words that cannot be read is said as unreadable, in no secret’s words', async () => {
    const { host, api, ferrets } = await world();
    ferrets.unreadableTurns = true;

    const words = await api().ownerWords(F1, { strict: true });

    expect(words).toMatchObject({ ok: false, error: { code: 'unreadable' } });
    await host.stop();
  });

  test('a draft is edited, and an edit for a ferret nobody knows is refused', async () => {
    const { host, api } = await world();
    const draft = await api().draft(F1);

    const edited = await api().editDraft(F1, undefined, {
      generation: draft.generation,
      epoch: draft.epoch,
      base: draft.rev,
      text: ['hello'],
    });
    const refused = await api().editDraft(ferretId('nobody'), 'chat', {
      generation: draft.generation,
      epoch: draft.epoch,
      base: draft.rev,
      text: ['hello'],
    });

    expect(edited.ok).toBe(true);
    expect(refused).toMatchObject({ ok: false, error: { code: 'draft_refused' } });
    await host.stop();
  });

  test('the sitrep names the messages waiting to be typed and the question the ferret waits on', async () => {
    const { host, built, state, waiting } = await world();
    const lines = async (): Promise<readonly { text: string }[]> => {
      const hook = built.half?.hooks['sitrep.lines'];
      const source = (await hook?.()) as readonly { item: { lines(ferret: string): Promise<unknown> } }[];
      return (await source[0]?.item.lines('f1')) as readonly { text: string }[];
    };
    expect(await lines()).toEqual([]);

    await waiting('q-1');
    expect((await lines()).map(line => line.text)).toEqual(['1 message is waiting to be typed']);
    await waiting('q-2');
    await writeAskedQuestion(
      state,
      new KeyedSerialExecutor(),
      F1,
      fixture('claude-2.1.281-pretooluse.json'),
      AT,
      '/home/user/.claude/projects/-work-repro/48fa096f-185c-42e1-b456-33dd3c77c5ce.jsonl',
    );

    const text = (await lines()).map(line => line.text);
    expect(text[0]).toBe('2 messages are waiting to be typed');
    expect(text[1]).toStartWith('Waiting on your answer: ');
    await host.stop();
  });
});
