/**
 * The Skills daemon half on the kernel's test host, over a Ferrets fake that knows one ferret working in `/work/app`.
 *
 * The test host's work root is one flat map of files: it answers no directory. The half's own adapter asks for folders,
 * so this wrapper (and only this) answers a folder as the real root does: the first path segment under it.
 */
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { KernelPorts, RootHandle } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import skills from '../../../daemon/index.ts';

export const doc = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`;

const withFolders = (handle: RootHandle): RootHandle => {
  const list = async (path: Parameters<RootHandle['list']>[0]): Promise<readonly string[]> => [
    ...new Set((await handle.list(path)).map(name => name.split('/')[0] as string)),
  ];
  return {
    ...handle,
    list,
    stat: async path =>
      (await handle.stat(path)) ??
      ((await handle.list(path)).length === 0
        ? undefined
        : { kind: 'directory', size: 0, modified: '2026-11-07T12:00:00.000Z' as never, mode: 0o700, links: 1 }),
  } as RootHandle;
};

const folderAware = {
  ...skills,
  build: (given: Parameters<NonNullable<typeof skills.build>>[0]) =>
    skills.build?.({
      ...given,
      kernel: {
        ...given.kernel,
        roots: { ...given.kernel.roots, root: (name, scope) => withFolders(given.kernel.roots.root(name, scope)) },
      } as KernelPorts,
    } as typeof given) as never,
};

/** A host whose ferret `f1` works in `/work/app`, which holds two project skills: `review` and `ship`. */
export async function skillsHost() {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1'), folder: '/work/app' });
  const host = await testHost({ plugins: [folderAware as never], fakes: { ferrets } });
  host.putRoot('work', '.claude/skills/review/SKILL.md', doc('review', 'reviews a diff'));
  host.putRoot('work', '.claude/skills/ship/SKILL.md', doc('ship', 'ships a release'));
  host.putRoot('work', '.claude/skills/notes/readme.md', 'not a skill: no SKILL.md');
  return host;
}
