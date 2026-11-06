import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredRenderMeta } from '@ferretry/protocol';
import should from 'should';
import { FileRenderRepository, rendersDirectory } from '../../../src/adapters/renders/index.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';
import { createFoundationPaths, type FoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { RenderService } from '../../../src/lib/renders/index.ts';
import { SVG } from '../../support/renders.ts';

const meta = (id: string, overrides: Partial<StoredRenderMeta> = {}): StoredRenderMeta => ({
  v: 1,
  id,
  kind: 'svg',
  alt: 'A circle',
  bytes: SVG.length,
  sha256: 'a'.repeat(64),
  createdAt: '2026-11-05T10:00:00.000Z',
  author: { sessionId: 's1' },
  ...overrides,
});

async function fixture(): Promise<{
  readonly home: string;
  readonly paths: FoundationPaths;
  readonly repository: FileRenderRepository;
  readonly files: StateFileSystem;
}> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-renders-'));
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  await mkdir(paths.state, { recursive: true });
  let id = 0;
  const files = new StateFileSystem(paths, () => `unique-${++id}`);
  return { home, paths, files, repository: new FileRenderRepository(paths, files) };
}

describe('FileRenderRepository', () => {
  it('should find nothing in a state home that never saved a picture', async () => {
    const subject = await fixture();
    try {
      should(await subject.repository.listMetas()).deepEqual([]);
      should(await subject.repository.readPayload('abcdef')).be.undefined();
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should write the payload and the meta under a shard of the id and read them back', async () => {
    const subject = await fixture();
    try {
      await subject.repository.write(meta('abcdef'), SVG);

      should(await readdir(join(rendersDirectory(subject.paths), 'ab'))).containDeep(['abcdef.json', 'abcdef.payload']);
      should(await readFile(join(rendersDirectory(subject.paths), 'ab', 'abcdef.payload'), 'utf8')).equal(SVG);
      should(await subject.repository.readPayload('abcdef')).equal(SVG);
      should(await subject.repository.listMetas()).deepEqual([meta('abcdef')]);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should skip a meta that is damaged, foreign, or sitting under another id’s name', async () => {
    const subject = await fixture();
    try {
      await subject.repository.write(meta('abcdef'), SVG);
      const shard = join(rendersDirectory(subject.paths), 'ab');
      await writeFile(join(shard, 'abzzzz.json'), '{not json');
      await writeFile(join(shard, 'abcdeg.json'), JSON.stringify(meta('abcdef')));
      await writeFile(join(shard, 'ab.json'), JSON.stringify(meta('abcdef')));
      await writeFile(join(shard, 'abcdeh.json'), JSON.stringify({ ...meta('abcdeh'), kind: 'mermaid' }));
      await mkdir(join(rendersDirectory(subject.paths), 'zz'), { recursive: true });
      await writeFile(join(rendersDirectory(subject.paths), 'zz', 'abcdef.json'), JSON.stringify(meta('abcdef')));
      await writeFile(join(rendersDirectory(subject.paths), 'stray.json'), JSON.stringify(meta('abcdef')));

      should(await subject.repository.listMetas()).deepEqual([meta('abcdef')]);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should not follow a symlink planted where a meta belongs', async () => {
    const subject = await fixture();
    try {
      const shard = join(rendersDirectory(subject.paths), 'ab');
      await mkdir(shard, { recursive: true });
      const outside = join(subject.home, 'elsewhere.json');
      await writeFile(outside, JSON.stringify(meta('abcdef')));
      await symlink(outside, join(shard, 'abcdef.json'));

      should(await subject.repository.listMetas()).deepEqual([]);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should refuse to turn anything that is not an id into a path', async () => {
    const subject = await fixture();
    try {
      for (const id of ['../../etc/passwd', 'a/b', 'ABCDEF', 'abc', '']) {
        await should(subject.repository.readPayload(id)).be.rejectedWith(/not a render id/u);
        await should(subject.repository.write(meta('abcdef', { id }), SVG)).be.rejected();
      }
      should(await readdir(subject.home)).not.containEql('etc');
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should carry a render through a service restart: save, rebuild, read', async () => {
    const subject = await fixture();
    try {
      const clock = { now: () => '2026-11-05T10:00:00.000Z' };
      const saved = await new RenderService(subject.repository, clock, new KeyedSerialExecutor()).save(
        { kind: 'svg', alt: 'A circle', payload: SVG },
        's1',
      );

      const restarted = new RenderService(
        new FileRenderRepository(subject.paths, subject.files),
        clock,
        new KeyedSerialExecutor(),
      );
      const found = await restarted.body(saved.id);

      should(found.payload).equal(SVG);
      should(found.meta.id).equal(saved.id);
      should((await restarted.save({ kind: 'svg', alt: 'A circle', payload: SVG })).created).be.false();
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });
});
