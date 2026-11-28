import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { KernelPorts } from '../../../contract/ports.ts';
import { bootHost } from '../../../host/host.ts';
import { platformRootPinner } from '../../../host/adapters/pinned/index.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

test('SEC-K1: production and test hosts enforce pin authority and the manifest’s read-only declaration', async () => {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-pin-wiring-`));
  const home = `${parent}/home`;
  const folder = `${parent}/imports`;
  await mkdir(folder);
  await writeFile(`${folder}/kept.txt`, 'original\n');
  const seen: KernelPorts[] = [];
  const plugin = implementDaemon(
    definePlugin({
      id: 'pin-fixture',
      title: 'Pin fixture',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { roots: ['imports'], spawn: ['cat', 'sh'], readOnlySpawn: ['cat', 'printf'] },
    }),
    {
      build: ({ kernel }) => {
        seen.push(kernel);
        return {};
      },
    },
  );
  const adapters = realAdapters(home, () => {}, { binary: 'fy' });
  const production = await bootHost({ home, version: '5.0.0', implementations: [plugin], adapters });
  if (production.kind !== 'running') throw new Error('fixture host refused');
  const memory = await testHost({
    plugins: [plugin],
    // The in-memory filesystem names virtual folders; its pinner holds only this throwaway real folder.
    pinner: { pin: async (_cwd, options) => await platformRootPinner().pin(folder, options) },
    spawn: (program, args, options) => adapters.spawn.run(program, args, options),
    start: (program, args, options) => adapters.spawn.start(program, args, options),
  });
  try {
    expect(seen).toHaveLength(2);
    for (const kernel of seen) {
      const root = kernel.roots.root('imports', { subfolder: folder });
      const at = root.resolve('.');
      if (!at.ok) throw new Error(at.error);
      const held = await root.pin(at.value);
      try {
        expect(await kernel.spawn.run('cat', ['kept.txt'], { cwd: held.policyCwd })).toMatchObject({
          exitCode: 0,
          stdout: 'original\n',
        });
        for (const method of ['run', 'runBytes'] as const)
          await expect(
            kernel.spawn[method]('sh', ['-c', 'printf changed > kept.txt'], { cwd: held.policyCwd }),
          ).rejects.toMatchObject({ name: 'PermissionError', code: 'pin_write_required' });
        expect(() => kernel.spawn.start('sh', ['-c', 'printf changed > kept.txt'], { cwd: held.policyCwd })).toThrow(
          'needs write authority',
        );
        expect(await readFile(`${folder}/kept.txt`, 'utf8')).toBe('original\n');
        // A read-only classification never grants a program absent from permissions.spawn.
        await expect(kernel.spawn.run('printf', ['undeclared'], { cwd: held.policyCwd })).rejects.toThrow();
      } finally {
        await held.close();
      }
    }
  } finally {
    await memory.stop();
    await production.host.stop();
    await rm(parent, { recursive: true, force: true });
  }
});
