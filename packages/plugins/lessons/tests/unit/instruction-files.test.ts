/**
 * Finding 3: a Repo lesson applies at the git root above the filing ferret's folder, as today
 * (`NodeLessonFiles.projectRoot` walks up to the nearest `.git`), and a path no ferret's folder holds is a refusal with
 * a sentence (`LessonsError`), never a plain error the dispatcher turns into a 500.
 */
import { describe, expect, it } from 'bun:test';
import { err, ok } from '@ferretry/std';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { FencedPath, RootHandle, RootsPort } from '@ferretry/kernel/contract';
import { WorkRootLessonFiles } from '../../daemon/adapters/instruction-files.ts';
import { GLOBAL_LESSONS_FILE, LessonsError } from '../../daemon/lib/index.ts';

/** A `work` root per ferret over one in-memory disk, fenced to the ferret's folder as the kernel fences it. */
function disk(paths: readonly string[]) {
  const files = new Map<string, string>(paths.map(path => [path, '']));
  const roots: Pick<RootsPort, 'root'> = {
    root: (_name, scope) => {
      const handle: RootHandle = {
        name: 'work',
        internal: false,
        resolve: path => {
          const folder = scope?.ferret === undefined ? undefined : folders.get(scope.ferret);
          if (folder === undefined) return err('unknown_ferret');
          return path === folder || path.startsWith(`${folder}/`) ? ok(path as FencedPath) : err('outside');
        },
        stat: async path =>
          files.has(path) || [...files.keys()].some(file => file.startsWith(`${path}/`))
            ? { kind: 'file', size: 0, modified: '2026-11-07T00:00:00.000Z' as never, mode: 0o600, links: 1 }
            : undefined,
        readText: async path => files.get(path) ?? '',
        readBytes: async () => new Uint8Array(),
        writeText: async (path, text) => {
          files.set(path, text);
        },
        list: async () => [],
        remove: async path => {
          files.delete(path);
        },
        readTail: () => Promise.reject(new Error('the fixture has no readTail')),
        writeBytes: () => Promise.reject(new Error('the fixture has no writeBytes')),
        copyTree: () => Promise.reject(new Error('the fixture has no copyTree')),
        copyShared: () => Promise.reject(new Error('the fixture has no copyShared')),
        linkCredential: () => Promise.reject(new Error('the fixture has no linkCredential')),
        ensurePrivateDirectory: () => Promise.reject(new Error('the fixture has no ensurePrivateDirectory')),
        entries: () => Promise.reject(new Error('the fixture has no entries')),
        lstat: () => Promise.reject(new Error('the fixture has no lstat')),
        makeDirectory: () => Promise.reject(new Error('the fixture has no makeDirectory')),
        realPath: () => Promise.reject(new Error('the fixture has no realPath')),
        pin: () => Promise.reject(new Error('the fixture has no pin')),
        publish: () => Promise.reject(new Error('the fixture has no publish')),
        readDurable: () => Promise.reject(new Error('the fixture has no readDurable')),
        syncDirectory: () => Promise.reject(new Error('the fixture has no syncDirectory')),
        fileIdentity: () => Promise.reject(new Error('the fixture has no fileIdentity')),
        linkTo: () => Promise.reject(new Error('the fixture has no linkTo')),
        setMode: () => Promise.reject(new Error('the fixture has no setMode')),
        rename: () => Promise.reject(new Error('the fixture has no rename')),
        unlink: () => Promise.reject(new Error('the fixture has no unlink')),
        checkPrivateChain: () => Promise.reject(new Error('the fixture has no chain check')),
      };
      return handle;
    },
  };
  return { files, roots };
}

/** Each ferret’s folder, as `WorkFolders` answers it. */
const folders = new Map<string, string>();

function world(standing: Readonly<Record<string, string>>, paths: readonly string[]) {
  const ferrets = new FakeFerrets();
  folders.clear();
  for (const [id, folder] of Object.entries(standing)) {
    ferrets.add({ id: ferretId(id), folder });
    folders.set(id, folder);
  }
  const { files, roots } = disk(paths);
  const global = { text: undefined as string | undefined };
  const store = {
    readGlobal: async () => global.text,
    writeGlobal: async (text: string) => {
      global.text = text;
    },
  };
  return { files, global, lessons: new WorkRootLessonFiles(ferrets, roots, store) };
}

describe('the project a Repo lesson applies to (finding 3)', () => {
  it('walks up from a ferret in repo/packages/daemon to the git root another ferret’s folder reaches', async () => {
    const { lessons } = world({ helper: '/repo/packages/daemon', lead: '/repo' }, ['/repo/.git/HEAD']);
    expect(await lessons.projectRoot('/repo/packages/daemon')).toBe('/repo');
  });

  it('finds the git root inside the filing ferret’s own folder, as before', async () => {
    const { lessons } = world({ helper: '/repo' }, ['/repo/.git/HEAD']);
    expect(await lessons.projectRoot('/repo/src')).toBe('/repo');
  });

  it('answers the filing folder when no .git is in sight (the declared gap above every ferret’s folder)', async () => {
    const { lessons } = world({ helper: '/repo/packages/daemon' }, ['/repo/.git/HEAD']);
    expect(await lessons.projectRoot('/repo/packages/daemon')).toBe('/repo/packages/daemon');
  });

  it('writes the root CLAUDE.md through the reaching ferret’s root, not a new file in the subfolder', async () => {
    const { lessons, files } = world({ helper: '/repo/packages/daemon', lead: '/repo' }, [
      '/repo/.git/HEAD',
      '/repo/CLAUDE.md',
    ]);
    const root = await lessons.projectRoot('/repo/packages/daemon');
    expect(await lessons.read(lessons.join(root, 'CLAUDE.md'))).toBe('');
    await lessons.write(lessons.join(root, 'CLAUDE.md'), '## Lessons\n\n- Use bun.\n');
    expect(files.get('/repo/CLAUDE.md')).toBe('## Lessons\n\n- Use bun.\n');
    expect(files.has('/repo/packages/daemon/AGENTS.md')).toBe(false);
  });

  it('refuses a path no ferret’s folder holds with a LessonsError sentence, never a plain error (no 500)', async () => {
    const { lessons } = world({ helper: '/elsewhere' }, []);
    const write = lessons.write('/repo/AGENTS.md', 'x');
    await expect(write).rejects.toBeInstanceOf(LessonsError);
    await expect(write).rejects.toMatchObject({ reason: 'not-found' });
    await expect(lessons.read('/repo/AGENTS.md')).rejects.toMatchObject({ reason: 'not-found' });
  });

  it('a root that refuses a link leading outside the folder is a LessonsError sentence, in read, exists and write (no 500)', async () => {
    const refusing = {
      name: 'work',
      resolve: (path: string) => ok(path as FencedPath),
      stat: async () => {
        throw new Error('link_escape');
      },
      readText: async () => '',
      readBytes: async () => new Uint8Array(),
      writeText: async () => {
        throw new Error('link_escape');
      },
      list: async () => [],
      remove: async () => {},
    } as unknown as RootHandle;
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('helper'), folder: '/repo' });
    const store = { readGlobal: async () => undefined, writeGlobal: async () => {} };
    const lessons = new WorkRootLessonFiles(ferrets, { root: () => refusing }, store);
    const sentence =
      "/repo/CLAUDE.md is a link that leads outside the ferret's folder, so Ferretry will not write through it";

    const read = lessons.read('/repo/CLAUDE.md');
    await expect(read).rejects.toBeInstanceOf(LessonsError);
    await expect(read).rejects.toMatchObject({ reason: 'invalid', message: sentence });
    await expect(lessons.write('/repo/CLAUDE.md', 'x')).rejects.toMatchObject({ reason: 'invalid', message: sentence });
    // `exists` is what the git-root walk asks about `.git`: a refused link there is a refusal too.
    await expect(lessons.projectRoot('/repo')).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('keeps the Global document in the plugin’s state, never on disk', async () => {
    const { lessons, global, files } = world({}, []);
    await lessons.write(GLOBAL_LESSONS_FILE, '- Use bun.\n');
    expect(global.text).toBe('- Use bun.\n');
    expect(files.size).toBe(0);
    expect(await lessons.read(GLOBAL_LESSONS_FILE)).toBe('- Use bun.\n');
  });
});
