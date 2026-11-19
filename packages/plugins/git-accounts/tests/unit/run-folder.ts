/** A real private folder with a short path, standing in for the plugin's `downloads` root (the kernel's test roots are in memory). */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
    destroy: () => rmSync(path, { recursive: true, force: true }),
  };
}
