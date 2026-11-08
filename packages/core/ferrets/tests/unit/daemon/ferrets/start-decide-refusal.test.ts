import { describe, expect, test } from 'bun:test';
import type { HookDecision } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import type { TestHost } from '@ferretry/kernel/testing';
import { NamesFile, StartDecide, type StartDecideInput, StartRefusalCodeSchema } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { host } from './route-fixture.ts';

/**
 * A `start.decide` taker may refuse a start with a code from Ferrets' CLOSED list (`unservable_model`: the model cannot
 * give what the start asked for, e.g. fast mode). It is answered before the first write, the name goes back, and the
 * route answers today's `409 unservable_model`. A code outside the list is a plain `refused`.
 */

/** A fake taker with the id of a harness plugin; `answer` decides, `seen` records every input it was asked. */
const taker = (answer: (input: StartDecideInput) => unknown, seen: StartDecideInput[] = []) =>
  implementDaemon(
    definePlugin({
      id: 'codex',
      title: 'Codex (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: StartDecide }] },
    }),
    {
      build: () => ({
        hooks: {
          'start.decide': (input: StartDecideInput) => {
            seen.push(input);
            return answer(input) as HookDecision;
          },
        },
      }),
    },
  );

let sequence = 0;
const start = async (h: TestHost, body: Record<string, unknown>) => {
  sequence += 1;
  return await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': `decide-${sequence}` },
    body: { folder: '/work/a', ...body },
  });
};
const fastNeedsOpus = (input: StartDecideInput): unknown =>
  input.fast === true && input.model !== 'opus-5'
    ? { allow: false, reason: `${input.model} has no fast mode`, code: 'unservable_model' }
    : { allow: true };
const fresh = async (answer: (input: StartDecideInput) => unknown, seen?: StartDecideInput[]) =>
  await host([], { harness: new FakeHarness(), runner: new FakeRunner(), plugins: [taker(answer, seen)] });
const written = (h: TestHost): string[] => [...h.state('ferrets').files.keys()].sort();

describe('a start.decide refusal carrying a code', () => {
  test('(no guarantees row) a fast start on a model without fast mode is refused 409 unservable_model and writes nothing', async () => {
    const runner = new FakeRunner();
    const h = await host([], { harness: new FakeHarness(), runner, plugins: [taker(fastNeedsOpus)] });
    const before = written(h);
    const refused = await start(h, { name: 'wren', model: 'claude-haiku-5-5', fast: true });
    expect(refused.status).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('unservable_model');
    expect(refused.body).toContain('claude-haiku-5-5 has no fast mode');
    // The name ledger is the one file a start touches before it asks (the claim); the refusal empties it again.
    expect(written(h).filter(file => file !== 'names.json')).toEqual(before);
    expect(JSON.parse(h.state('ferrets').raw(NamesFile) ?? '{"claims":[]}')).toMatchObject({ claims: [] });
    expect((await h.request('GET', '/v1/ferrets')).json<unknown[]>()).toEqual([]);
    expect(runner.starts).toBe(0);
  });

  test('(no guarantees row) the refused start gives its name back, so the same name starts at once', async () => {
    const h = await fresh(fastNeedsOpus);
    expect((await start(h, { name: 'wren', model: 'claude-haiku-5-5', fast: true })).status).toBe(409);
    const claims = JSON.parse(h.state('ferrets').raw(NamesFile) ?? '{"claims":[]}') as { claims: unknown[] };
    expect(claims.claims).toEqual([]);
    expect((await start(h, { name: 'wren', model: 'opus-5', fast: true })).status).toBeLessThan(300);
  });

  test('(no guarantees row) a fast start on a model that has fast mode is not refused', async () => {
    const h = await fresh(fastNeedsOpus);
    const answer = await start(h, { model: 'opus-5', fast: true });
    expect(answer.status).toBe(201);
  });

  test('(no guarantees row) a code outside the closed list reads as a plain refused, never passed through', async () => {
    const h = await fresh(() => ({ allow: false, reason: 'no thanks', code: 'teapot' }));
    const refused = await start(h, {});
    expect(refused.status).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('refused');
  });

  test('(no guarantees row) a code that is not a string is dropped by the host and reads as refused', async () => {
    const h = await fresh(() => ({ allow: false, reason: 'no thanks', code: { unservable_model: true } }));
    const refused = await start(h, {});
    expect(refused.json<{ code: string }>().code).toBe('refused');
  });

  test('(no guarantees row) the closed list declares unservable_model and nothing else', () => {
    expect(StartRefusalCodeSchema.options).toEqual(['unservable_model']);
    expect(StartRefusalCodeSchema.safeParse('teapot').success).toBe(false);
  });

  test('(no guarantees row) model and fast reach the taker only when the start set them', async () => {
    const seen: StartDecideInput[] = [];
    const h = await fresh(() => ({ allow: true }), seen);
    await start(h, {});
    await start(h, { model: 'opus-5' });
    await start(h, { fast: false });
    await start(h, { model: 'opus-5', fast: true });
    const [plain, named, slow, both] = seen;
    expect(plain).not.toHaveProperty('model');
    expect(plain).not.toHaveProperty('fast');
    expect(named).toMatchObject({ model: 'opus-5' });
    expect(named).not.toHaveProperty('fast');
    expect(slow).toMatchObject({ fast: false });
    expect(slow).not.toHaveProperty('model');
    expect(both).toMatchObject({ model: 'opus-5', fast: true });
  });
});
