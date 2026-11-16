import { expect, test } from 'bun:test';
import { additivesFixture } from './additives-fixture.ts';
import { FerretsService } from '../../../../daemon/lib/ferrets/service.ts';
import { createRuntimesApi } from '../../../../../../plugins/runtimes/daemon/lib/service/runtimes-api.ts';
import { runtimeStartAnswer } from '../../../../../../plugins/runtimes/daemon/lib/service/runtime-start-answer.ts';
import { DAEMON_ORIGIN } from '../../../../contract/index.ts';

/**
 * The catalogue commits a runtime rename before the ferrets' records are rewritten, and a failed or interrupted rewrite
 * is swallowed. A record left on the old name must still start, through the runtime's `ids.json` former names.
 */
const rename = { from: 'work', to: 'play', fromWrapper: '/fleet/bin/work', toWrapper: '/fleet/bin/play' };

function renamedWorld(fails: boolean) {
  const state = { fails };
  const f = additivesFixture({
    session: {
      repointRuntime: async () => {
        if (state.fails) throw new Error('transient session config write failure');
        return false;
      },
    },
  });
  f.registry.put({ ...f.registry.get(f.id)!, runtime: 'work' });
  const logins = {
    list: async () => ({ logins: [{ id: 'main', harness: 'claude-code', status: { word: 'ready' } }] }),
  } as never;
  const api = createRuntimesApi({
    runtimes: () => new Map([['play', { login: 'main', profile: 'default', agent: true }]]),
    profiles: () => new Map([['default', {} as never]]),
    defaultSetting: () => undefined,
    harnesses: () => ['claude-code'],
    logins,
    now: () => 0,
    // What the catalogue's `ids.json` says after the rename: `work` is a former name of `play`.
    currentName: async former => (former === 'work' ? 'play' : undefined),
  });
  const runtimeStart = runtimeStartAnswer({ resolve: api.resolve, logins }).resolve;
  const service = new FerretsService(f.registry, f.tokens, { ...f.ports, runtimeStart });
  return { f, state, service };
}

test('a successfully repointed ferret resolves its new runtime for Restart', async () => {
  const { f, service } = renamedWorld(false);
  expect(await service.repointRuntime(rename)).toBe(1);
  expect((await service.get(f.id))?.runtime).toBe('play');
  expect((await service.startable(f.id)).ok).toBe(true);
});

test('a skipped config write leaves Resume usable after the catalogue rename committed', async () => {
  const { f, state, service } = renamedWorld(true);
  expect(await service.repointRuntime(rename)).toBe(0);
  expect((await service.get(f.id))?.runtime).toBe('work');
  state.fails = false;
  expect(await service.resume(f.id, undefined, { origin: DAEMON_ORIGIN })).toMatchObject({ ok: true });
});

test('a skipped config write leaves Restart usable', async () => {
  const { f, service } = renamedWorld(true);
  expect(await service.repointRuntime(rename)).toBe(0);
  expect((await service.startable(f.id)).ok).toBe(true);
});

test('retrying the original repoint finishes after the config recovers', async () => {
  const { f, state, service } = renamedWorld(true);
  expect(await service.repointRuntime(rename)).toBe(0);
  state.fails = false;
  expect(await service.repointRuntime(rename)).toBe(1);
  expect((await service.startable(f.id)).ok).toBe(true);
});
