import { ApiError, type HeldRoot, type KernelPorts } from '@ferretry/kernel/contract';
import type { ProjectFolders } from '../lib/ports.ts';

const refused = (message: string) => new ApiError(422, message, 'project_clone_failed');
const FOLDER_REFUSED = 'The project folder changed or is not allowed. Choose the project folder again.';

/**
 * The existing-project clone holds BOTH parent and destination. mkdir is exclusive even for an empty folder or a link;
 * Git gets only `.` inside the destination descriptor. A swapped pathname never becomes a Git write destination.
 * A failed clone leaves its newly made folder for the owner to inspect; nothing is recursively removed.
 */
export const kernelCloneInto =
  (kernel: Pick<KernelPorts, 'roots' | 'spawn'>): ProjectFolders['gitCloneInto'] =>
  async (url, parent, name, verdict) => {
    const target = `${parent === '/' ? '' : parent}/${name}`;
    const hold = async (path: string): Promise<HeldRoot> => {
      const handle = kernel.roots.root('imports', { subfolder: path });
      const self = handle.resolve('');
      if (!self.ok) throw refused(FOLDER_REFUSED);
      // The saved project is canonical. Any linked/replaced spelling must be chosen again, even if its target is allowed.
      if ((await handle.realPath(self.value)) !== path || (await verdict(path)) !== undefined)
        throw refused(FOLDER_REFUSED);
      const pinned = await handle.pin(self.value, { fence: 'none', write: true });
      try {
        if (pinned.rootReal !== path || (await verdict(pinned.rootReal)) !== undefined) throw refused(FOLDER_REFUSED);
        return pinned;
      } catch (error) {
        await pinned.close();
        throw error;
      }
    };
    let root: HeldRoot | undefined;
    let destination: HeldRoot | undefined;
    try {
      root = await hold(parent);
      // A .git marker appearing since registration must be refused before mkdir too.
      let gitMarker = false;
      try {
        const marker = await root.open('.git');
        gitMarker = true;
        await marker.close();
      } catch {
        /* no readable marker; the route also checks the marker without following a link */
      }
      if (gitMarker) throw refused('This project is itself a repository. Clone beside it.');
      const made = await kernel.spawn.run('mkdir', ['-m', '700', '--', name], { cwd: root.policyCwd });
      if (made.exitCode !== 0) throw refused('The destination already exists or could not be created.');
      const child = await root.open(name, { wantDirectory: true });
      try {
        destination = await hold(target);
        const held = await destination.open('', { wantDirectory: true });
        try {
          const expected = child.identities.at(-1);
          const actual = held.identities.at(-1);
          if (
            expected === undefined ||
            actual === undefined ||
            expected.dev !== actual.dev ||
            expected.ino !== actual.ino
          )
            throw refused(FOLDER_REFUSED);
        } finally {
          await held.close();
        }
      } finally {
        await child.close();
      }
      const done = await kernel.spawn.run('git', ['clone', '--', url, '.'], {
        cwd: destination.policyCwd,
        env: { GIT_ALLOW_PROTOCOL: 'https:ssh' },
      });
      if (done.exitCode !== 0) throw refused('git clone failed. Check Accounts and secrets, then try again.');
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Neither child output nor an exception can echo the supplied address or credentials.
      throw refused('The clone could not be completed. Check the project folder, Accounts and secrets.');
    } finally {
      await destination?.close();
      await root?.close();
    }
  };
