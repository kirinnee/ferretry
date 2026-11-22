/** A real private folder with a short path, standing in for the plugin's `downloads` root (the kernel's test roots are in memory). */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type { RunFolder } from '../../daemon/features/ssh-keys/agents.ts';

export function tmpRunFolder(): RunFolder & { destroy(): void } {
  const path = mkdtempSync(`${tmpdir()}/b4-`);
  chmodSync(path, 0o700);
  return {
    path,
    isPrivate: async () => (lstatSync(path).mode & 0o077) === 0,
    remove: async name => {
      try {
        unlinkSync(`${path}/${name}`);
      } catch {
        // not there
      }
    },
    publish: async (name, text, mode) => {
      // A name may carry folders (`shims/gh`): made private, as the real root makes them.
      const slash = name.lastIndexOf('/');
      if (slash > 0) mkdirSync(`${path}/${name.slice(0, slash)}`, { recursive: true, mode: 0o700 });
      const temporary = `${path}/${name.slice(0, slash + 1)}.${name.slice(slash + 1)}.new`;
      writeFileSync(temporary, text, { mode });
      chmodSync(temporary, mode);
      renameSync(temporary, `${path}/${name}`);
    },
    emptyDirectory: async (name, mode) => {
      const folder = `${path}/${name}`;
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      chmodSync(folder, 0o700);
      for (const entry of readdirSync(folder)) rmSync(`${folder}/${entry}`, { recursive: true, force: true });
      chmodSync(folder, mode);
    },
    destroy: () => {
      // A folder left at 0500 must be writable again before it can go.
      for (const entry of readdirSync(path)) {
        try {
          chmodSync(`${path}/${entry}`, 0o700);
        } catch {
          // not a folder we narrowed
        }
      }
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/** A test locator: the program names as they are (the supervisor's real one answers an absolute path, `program-locator.ts`). */
export const bareNames = async (name: 'ssh-agent' | 'ssh-add'): Promise<string> => name;
