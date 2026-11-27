import { describe, expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fenced,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';
import { FerretFolderGuard } from '../../../../daemon/lib/worktrees/ferret-folders.ts';

function fleet() {
  const registry = new FerretRegistry([]);
  const harness = new FakeHarness();
  const runner = new FakeRunner();
  let next = 0;
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => ferretId(`fixture-${++next}`),
    newName: () => `fern-${next}`,
    save: async () => {},
    saveTokens: async () => {},
    harness: () => harness,
    harnessKeys: () => [harness.key],
    runner: () => runner,
    decide: async () => ({ allow: true }),
    folder: folder => ok(fenced(folder)),
    changed: () => {},
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
  };
  return { ports, service: new FerretsService(registry, new FerretTokenDirectory(), ports) };
}

describe('ferret folder admission shared with worktree moves', () => {
  for (const kind of ['start', 'resume'] as const)
    test(`a ${kind} admitted while the folder moves refuses without opening a pane`, async () => {
      const w = fleet();
      let id = ferretId('unused');
      if (kind === 'resume') {
        const started = await w.service.start({ folder: '/synthetic/checkout/sub', by: 'owner' }, PERSON_ORIGIN);
        if (!started.ok) throw new Error(started.error.reason);
        id = started.value;
        await w.service.stop(id, 'now');
      }
      await w.service.withWorktreeMove('/synthetic/checkout', async () => {
        const launching =
          kind === 'start'
            ? w.service.start({ folder: '/synthetic/checkout/sub', by: 'owner' }, PERSON_ORIGIN)
            : w.service.resume(id, undefined, { origin: PERSON_ORIGIN });
        expect(await launching).toMatchObject({ ok: false, error: { code: 'refused' } });
      });
    });

  for (const kind of ['start', 'resume'] as const)
    test(`a ${kind} already admitted before its registry write refuses a racing move`, async () => {
      const w = fleet();
      let id = ferretId('unused');
      if (kind === 'resume') {
        const started = await w.service.start({ folder: '/synthetic/checkout/sub', by: 'owner' }, PERSON_ORIGIN);
        if (!started.ok) throw new Error(started.error.reason);
        id = started.value;
        await w.service.stop(id, 'now');
      }
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      w.ports.decide = async () => {
        entered.resolve();
        await release.promise;
        return { allow: true };
      };
      const launching =
        kind === 'start'
          ? w.service.start({ folder: '/synthetic/checkout/sub', by: 'owner' }, PERSON_ORIGIN)
          : w.service.resume(id, undefined, { origin: PERSON_ORIGIN });
      try {
        await entered.promise;
        let moved = false;
        await expect(
          w.service.withWorktreeMove('/synthetic/checkout', async () => {
            moved = true;
          }),
        ).rejects.toThrow('starting or resuming');
        expect(moved).toBe(false);
        expect(await w.service.withWorktreeMove('/synthetic/other', async () => 'unrelated')).toBe('unrelated');
      } finally {
        release.resolve();
        await launching;
      }
    });

  test('overlapping moves and launches are excluded, while exceptions release their admissions', async () => {
    const guard = new FerretFolderGuard();
    await expect(
      guard.move('/synthetic/checkout', async () => {
        expect(
          await guard.launch(
            '/synthetic/checkout/sub',
            () => 'refused',
            async () => 'launched',
          ),
        ).toBe('refused');
        await expect(guard.move('/synthetic', async () => 'moved')).rejects.toThrow('another move');
        await expect(guard.move('/synthetic/checkout/sub', async () => 'moved')).rejects.toThrow('another move');
        throw new Error('move failed');
      }),
    ).rejects.toThrow('move failed');
    await expect(
      guard.launch(
        '/synthetic/checkout',
        () => 'refused',
        async () => {
          throw new Error('launch failed');
        },
      ),
    ).rejects.toThrow('launch failed');
    expect(await guard.move('/synthetic/checkout', async () => 'moved')).toBe('moved');
    expect(
      await guard.launch(
        '/synthetic/checkout',
        () => 'refused',
        async () => 'launched',
      ),
    ).toBe('launched');
  });
});
