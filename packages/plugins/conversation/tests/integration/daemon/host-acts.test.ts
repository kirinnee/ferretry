import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type { FerretId, FerretTurns } from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { ferretStanding } from '@ferretry/core-gate/contract/testing';
import type { CallStanding, RouteHandler, StatePort } from '@ferretry/kernel/contract';
import { ferret as ferretCaller, fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { CONVERSATION_STATE, ConversationPort } from '../../../contract/index.ts';
import mailboxDaemon from '@ferretry/core-mailbox/daemon';
import daemon from '../../../daemon/index.ts';
import { StateSendLedger } from '../../../daemon/delivery/adapters/index.ts';
import { StateQueueStore } from '../../../daemon/queue/adapters/index.ts';
import { writeAskedQuestion } from '../../../daemon/questions/adapters/state-asked-question.ts';
import { KeyedSerialExecutor } from '../../../daemon/seams/keyed-serial-executor.ts';
import { parseSessionId } from '../../../daemon/seams/ferret-id.ts';
import { fixtureTexts } from '../../support/fixtures.ts';
import { memoryStatePort } from '../../support/state.ts';
import { wardenStandIn } from '../../support/warden-plugin.ts';

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
  /**
   * The standing Gate stamps on a compact-at call. The test host's stand-in admission stamps no credential or actor, so the
   * two routes are wrapped to carry Gate's own (`ferretStanding`) and the mount reads who is calling as it does in production.
   */
  const caller: { standing?: CallStanding } = {};
  const implementation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
      const build = daemon.build;
      if (build === undefined) throw new Error('the conversation daemon half has no build');
      const half = build({ ...ctx, kernel: { ...ctx.kernel, state } });
      built.half = half;
      const routes = half.routes as Readonly<Record<string, RouteHandler | undefined>>;
      const stamped = Object.fromEntries(
        ['GET', 'PATCH'].map(method => {
          const key = `${method} /v1/ferrets/:ferretId/compact-at`;
          const handler = routes[key];
          if (handler === undefined) throw new Error(`the conversation daemon half serves no ${key} route`);
          const wrapped: RouteHandler = async call => await handler({ ...call, ...caller.standing } as typeof call);
          return [key, wrapped];
        }),
      );
      return { ...half, routes: { ...routes, ...stamped } } as typeof half;
    },
  } as typeof daemon;
  const host = await testHost({
    plugins: [mailboxDaemon, implementation, wardenStandIn],
    fakes: { ferrets, asks: new FakeAsks() },
    clock: fixedClock('2026-11-08T09:00:00Z'),
  });
  // The Mailbox looks at every ferret once at boot (what a restart left open moves again): let that look finish on the
  // empty queue, so the messages a test seeds next are not delivered under it.
  for (let index = 0; index < 20; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
  const api = () => host.provided(ConversationPort);
  /** The port as Ferretry's Warden holds it: the only consumer that may speak as the Warden or press a pane. */
  const warden = () => host.provided(ConversationPort, 'warden');
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
  return { host, ferrets, api, warden, state: inner, broken, built, waiting, caller };
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

describe('c58-16 the compact-at setting is read and written through Ferrets', () => {
  const PATH = '/v1/ferrets/f1/compact-at';

  test('a change is recorded by Ferrets, worded for a running ferret, and read back as the ferret’s own value', async () => {
    const { host, ferrets, api } = await world();

    expect(await api().compactAt(F1)).toEqual({
      effective: 'auto',
      restartRequired: false,
      note: 'Memory is compacted at the harness’s own trigger (Auto).',
    });
    const set = await api().setCompactAt(F1, { compactAt: 250_000 });

    expect(set).toMatchObject({ ok: true, value: { effective: 250_000, restartRequired: true } });
    expect(await ferrets.compactAt(F1)).toBe(250_000);
    expect(await api().compactAt(F1)).toMatchObject({ own: 250_000, effective: 250_000 });

    const inherited = await api().setCompactAt(F1, { compactAt: 'inherit' });
    expect(inherited).toMatchObject({ ok: true, value: { effective: 'auto' } });
    expect(await ferrets.compactAt(F1)).toBeUndefined();
    await host.stop();
  });

  test('the routes answer the same: GET reads it, PATCH sets it and says a running ferret restarts for it', async () => {
    const { host, ferrets } = await world();

    const patched = await host.request('PATCH', PATH, { as: owner(), body: { compactAt: 400_000 } });
    const read = await host.request('GET', PATH, { as: owner() });

    expect(patched.status).toBe(200);
    expect(patched.json()).toMatchObject({ effective: 400_000, restartRequired: true });
    expect(read.json()).toMatchObject({ own: 400_000, effective: 400_000 });
    expect(await ferrets.compactAt(F1)).toBe(400_000);
    await host.stop();
  });

  test('a ferret nobody knows has no setting; a value under the floor and a stopped ferret are answered in their own words', async () => {
    const { host, ferrets, api } = await world();
    ferrets.add({ id: ferretId('f2'), state: 'stopped' });

    expect(await api().compactAt(ferretId('nobody'))).toBeUndefined();
    expect(await api().setCompactAt(ferretId('nobody'), { compactAt: 200_000 })).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    expect(await api().setCompactAt(F1, { compactAt: 99_999 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_compact_at' },
    });
    expect(await ferrets.compactAt(F1)).toBeUndefined();
    const stopped = await api().setCompactAt(ferretId('f2'), { compactAt: 300_000 });
    expect(stopped).toMatchObject({ ok: true, value: { restartRequired: false } });
    expect(stopped.ok && stopped.value.note).toContain('not running');
    const route = await host.request('PATCH', '/v1/ferrets/nobody/compact-at', {
      as: owner(),
      body: { compactAt: 200_000 },
    });
    expect(route.status).toBe(404);
    await host.stop();
  });

  test('a Ferrets that cannot record one is 503 and its refusal is carried; a failure nobody worded is not made into a refusal', async () => {
    const bare = await world(ferrets => {
      (ferrets as { setCompactAt?: unknown }).setCompactAt = undefined;
    });

    expect(await bare.api().setCompactAt(F1, { compactAt: 200_000 })).toMatchObject({
      ok: false,
      error: { code: 'plugin_unavailable' },
    });
    const route = await bare.host.request('PATCH', PATH, { as: owner(), body: { compactAt: 200_000 } });
    expect(route.status).toBe(503);
    await bare.host.stop();

    const broken = await world(ferrets => {
      ferrets.setCompactAt = async () => {
        throw new TypeError('FIXTURE_SECRET the disk is gone');
      };
    });
    await expect(broken.api().setCompactAt(F1, { compactAt: 200_000 })).rejects.toThrow('FIXTURE_SECRET');
    await broken.host.stop();

    const unreadable = await world(ferrets => {
      ferrets.compactAt = async () => {
        throw new TypeError('FIXTURE_SECRET the document is gone');
      };
    });
    await expect(unreadable.api().compactAt(F1)).rejects.toThrow('FIXTURE_SECRET');
    await unreadable.host.stop();
  });

  test('a ferret outside the target’s tree is refused on GET and PATCH and the setting is never read or written; the ferret itself, its lead and a person keep their standing', async () => {
    const reads: (FerretId | undefined)[] = [];
    const writes: (FerretId | undefined)[] = [];
    const { host, ferrets, caller } = await world(f => {
      f.add({ id: ferretId('h1'), parent: F1, state: 'idle' });
      f.add({ id: ferretId('s9'), state: 'idle' });
      const read = f.compactAt.bind(f);
      const write = f.setCompactAt.bind(f);
      f.compactAt = async (ferret, by) => {
        reads.push(by);
        return await read(ferret, by);
      };
      f.setCompactAt = async (ferret, value, by) => {
        writes.push(by);
        return await write(ferret, value, by);
      };
    });
    /** A call as that ferret: Gate's standing for the mount, the test host's admission for the route's minimum. */
    const as = (id: string) => {
      caller.standing = ferretStanding(ferretId(id));
      return ferretCaller(id);
    };
    const asOwner = () => {
      caller.standing = undefined;
      return owner();
    };

    // A stranger (no lineage to f1) is refused both ways, and the value it tried to set is not recorded.
    const strangerPatch = await host.request('PATCH', PATH, { as: as('s9'), body: { compactAt: 111_000 } });
    const strangerGet = await host.request('GET', PATH, { as: as('s9') });
    expect([strangerPatch.status, strangerGet.status]).toEqual([403, 403]);
    expect(writes).toEqual([]);
    expect(await ferrets.compactAt(F1)).toBeUndefined();
    // The helper of f1 reaches only itself and ITS helpers, never its lead.
    expect((await host.request('PATCH', PATH, { as: as('h1'), body: { compactAt: 111_000 } })).status).toBe(403);
    expect(writes).toEqual([]);

    // The ferret itself, its lead (of the helper), and an owner call succeed; the owner's reaches Ferrets with no caller.
    const self = await host.request('PATCH', PATH, { as: as('f1'), body: { compactAt: 200_000 } });
    expect(self.status).toBe(200);
    expect((await host.request('GET', PATH, { as: as('f1') })).json()).toMatchObject({ own: 200_000 });
    const lead = await host.request('PATCH', '/v1/ferrets/h1/compact-at', {
      as: as('f1'),
      body: { compactAt: 300_000 },
    });
    expect(lead.status).toBe(200);
    const person = await host.request('PATCH', PATH, { as: asOwner(), body: { compactAt: 400_000 } });
    expect(person.status).toBe(200);
    expect((await host.request('GET', PATH, { as: asOwner() })).json()).toMatchObject({ own: 400_000 });
    expect(writes).toEqual([F1, F1, undefined]);
    expect(reads.at(-1)).toBeUndefined();
    await host.stop();
  });

  test('an answer is refused with the form-seam sentence, not the terminal one, when Ferrets offers no form acts', async () => {
    const { host, api } = await world();

    const refused = await api().answer(F1, { toolUseId: 't-1', labels: ['a'] });

    expect(refused).toMatchObject({ ok: false, error: { code: 'plugin_unavailable' } });
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
    const { host, warden, state } = await world();
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

    const refused = await warden().resubmitStuck?.(F1, { kind: 'warden' }, 's-stuck');

    expect(refused).toMatchObject({ ok: false, error: { code: 'plugin_unavailable' } });
    await host.stop();
  });

  test('the Warden’s re-submit for a send nobody made answers refused, and no other caller may press it', async () => {
    const { host, api, warden } = await world();

    expect(await warden().resubmitStuck?.(F1, { kind: 'warden' }, 's-none')).toEqual({ ok: true, value: 'refused' });
    expect(await api().resubmitStuck?.(F1, { kind: 'owner' }, 's-none')).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    await host.stop();
  });

  test('cancelling a send nobody made is refused, and Enter and the composer say the same', async () => {
    const { host, warden } = await world();

    expect(await warden().cancelSend(F1, 's-none')).toMatchObject({ ok: false });
    expect(await warden().enterSend(F1, 's-none')).toMatchObject({ ok: false });
    expect(await warden().composer(F1, 'clear' as never, undefined as never)).toMatchObject({ ok: false });
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
