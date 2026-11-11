import { describe, expect, test } from 'bun:test';
import type { FerretId, FencedPath, StartRequest } from '../../../../contract/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

const HOME = '/state/ferretry';

/** The service with only the seams a start reads BEFORE the state-home check; nothing past it may be reached. */
const service = (holding?: FerretsPorts['stateHomeHolding'], folders: string[] = []) =>
  new FerretsService(new FerretRegistry([]), new FerretTokenDirectory(), {
    ready: async () => undefined,
    newId: () => 'f1' as FerretId,
    newName: () => 'fern',
    folder: (path: string) => {
      folders.push(path);
      return { ok: true, value: path as FencedPath };
    },
    harnessKeys: () => [],
    ...(holding === undefined ? {} : { stateHomeHolding: holding }),
  } as unknown as FerretsPorts);

const ask = (by: StartRequest['by'], extra: Partial<StartRequest> = {}): StartRequest => ({
  folder: '/work/project',
  by,
  ...extra,
});

describe('S47 a start by a ferret is judged on the folder it will really work in', () => {
  test('a work folder inside the state home is refused state_home, though the anchor folder is fine', async () => {
    const asked: string[] = [];
    const answer = await service(async path => {
      asked.push(path);
      return path.startsWith(HOME) ? HOME : undefined;
    }).start(ask('ferret', { workFolder: `${HOME}/credentials` }));
    expect(answer).toMatchObject({ ok: false, error: { code: 'state_home' } });
    expect(asked).toEqual([`${HOME}/credentials`]);
  });

  test('a fence that cannot be built is state_home_unresolved', async () => {
    const answer = await service(async () => {
      throw new Error('home.json cannot be identified');
    }).start(ask('ferret'));
    expect(answer).toMatchObject({ ok: false, error: { code: 'state_home_unresolved' } });
  });

  test('no fence bound refuses a ferret start (fail closed), never lets it through', async () => {
    const answer = await service().start(ask('ferret'));
    expect(answer).toMatchObject({ ok: false, error: { code: 'state_home_unresolved' } });
  });

  test('a start by a person or a plugin is not asked: the fence is an agent rule', async () => {
    const asked: string[] = [];
    const guarded = service(async path => {
      asked.push(path);
      return HOME;
    });
    // These starts get past the fence; the stub service has no harness, so they stop at `harness_unavailable`.
    for (const by of ['owner', 'pack', 'board', 'warden'] as const)
      expect(await guarded.start(ask(by))).toMatchObject({ ok: false, error: { code: 'harness_unavailable' } });
    expect(asked).toEqual([]);
  });
});
